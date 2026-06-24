# Price-Alert Architecture Redesign — Stable Identity + Per-Alert Baseline

Status: **Implemented** (2026-06-24)
Scope: `frontend/src/lib/{persist,overlays,alertEngine}.ts` (+ tests)

> Note on the plan vs. what shipped: the original plan (below, kept for context)
> proposed typed `created/moved/removed` events flowing overlay → engine. The
> shipped design instead has the **engine self-detect** moves by diffing a per-id
> signature each tick. Reason: alerts also sync between tabs/devices, where
> `/ws/state` writes `localStorage` directly and never goes through the overlay
> layer — a typed overlay→engine event would miss those moves and reintroduce the
> spurious fire on the receiving tab. The engine already re-reads storage every
> tick, so a storage-diff is both cheaper and strictly more robust. `bumpAlerts()`
> is kept as-is for its real job (feed re-sync + sidebar refresh). The stable `id`
> is still the backbone — it is what lets the engine tell "same alert moved" from
> "different alert."

## The problem (one paragraph)

A price alert lives in three places at once — the **chart overlay** (the
draggable line, which has a stable overlay id), the **alertEngine** (background
firing authority, holds runtime arming state), and **storage** (localStorage,
`SavedAlert[]`). They are joined only by **value equality**: `SavedAlert` has no
id, and the engine identifies an alert by its content
(`armKey = scope|epic|level|condition|trigger`, `alertEngine.ts:48`). So the
moment a value changes — e.g. dragging the line to a new level — the alert's
identity changes: the old key is forgotten, a new key appears defaulting to
`armed=true` (`alertEngine.ts:138`). Combined with a single per-epic price
baseline (`feed.prev`, `alertEngine.ts:42`) shared across all levels, moving a
level *across* the stale baseline manufactures a crossing with no price motion →
a `once` alert fires → `remove:true` → `saveAlerts([])` → **irreversible data
loss**. The only channel from overlay to engine is the contentless
`bumpAlerts()`, so the engine can never react to a *move* specifically — contrast
`setPriceSide` (`alertEngine.ts:63`), the one typed event that correctly resets
`prev`. The asymmetry is the bug.

### Three root causes
1. **No shared identity.** `SavedAlert` carries no id; identity is reconstructed
   from content every tick (`loadAlerts(...).map(normalizeAlert)`). Editing a
   value = a different alert.
2. **Contentless signalling.** `bumpAlerts()` says *that* something changed,
   never *what*. No created/moved/removed vocabulary.
3. **Wrong baseline shape.** "Did price cross *this level*" is a per-alert
   question answered with a per-epic price baseline. Category mismatch.

> Note: `OverlayManager.alertArmed` (`overlays.ts:90`) is written but never read
> and never persisted — it is dead code, not part of the firing path. The only
> firing authority is `alertEngine`.

## Architecture as built

- **One id per alert, shared by all three layers.** Generated once at creation
  (`newAlertId`), carried on the overlay (`OverlayManager.alertIds`: klinecharts
  overlay id → stable id), persisted in `SavedAlert.id`.
- **Per-alert crossing baseline + arming**, keyed by `scope|epic|id` in the
  engine (`baseline`, `armed`, `sig` maps) — replacing the single per-epic
  `feed.prev` and the content-based `armKey`.
- **Engine-side move detection.** Each tick the engine diffs `alertSig =
  level|condition|trigger` against the last-seen signature for that id. On a
  change it resets that alert's baseline (so the relocated level needs two fresh
  samples before it can read as a cross) and re-arms it. Only that one alert is
  affected; a first sighting is not treated as a move (it's a new alert, already
  protected by the same two-sample guard).
- `reconcileAlerts` matches on-chart lines to saved rows **by id**, not by level.
- `bumpAlerts()` / `alertsChanged` unchanged (feed re-sync + sidebar refresh).

### Data model

```ts
interface SavedAlert {
  id: string;          // NEW — stable identity across overlay / engine / storage
  level: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt?: number | null;
  notify?: AlertNotifyChannels;
}
```

Engine state, all keyed by `stateKey = scope|epic|id`:
- `armed: Map<string, boolean>`
- `baseline: Map<string, number | null>`  ← replaces the single per-epic `feed.prev`
- `sig: Map<string, string>`  ← last-seen `level|condition|trigger`, for move detection

### Move detection (engine-side, per tick)

No typed events. In `onTick`, for each alert (`alertEngine.ts`):

```ts
const sig = `${a.level}|${a.condition}|${a.trigger}`;
const prevSig = this.sig.get(key);
if (prevSig !== undefined && prevSig !== sig) {
  this.baseline.set(key, null); // moved/reconfigured → re-seed (no cross off stale sample)
  this.armed.set(key, true);    // an edited alert may fire again
}
this.sig.set(key, sig);
const prev = this.baseline.get(key) ?? null; // per-alert prev sample
this.baseline.set(key, price);
// ...evaluateAlert(prev, price, a.level, { ...armed })
```

- A **first sighting** (`prevSig === undefined`) is NOT a move — new alert, armed,
  empty baseline, protected by the existing two-sample guard.
- Catches moves from **any** source — drag, modal-edit, or a remote `/ws/state`
  sync that wrote storage directly. (A typed overlay→engine event would miss the
  last one.)
- `setPriceSide` now also `baseline.clear()`s (per-alert baselines don't reset
  just by reopening the feed), so a bid/mid/ask flip still can't read as a cross.

### Migration (id-less existing alerts)

`normalizeAlert` backfills `id` for any alert lacking one, **deterministically
from content** (`legacyAlertId`, a djb2 hash of `level|condition|trigger|message|
expiresAt`). Deterministic backfill is safe ONLY because it is generate-once:
every reader (engine via `loadAlerts`, overlay via `rehydrate`) independently
derives the SAME id for the same stored row, so they agree until the next
`persist()` writes the id out explicitly and locks it. Thereafter the `id` field
is present and the hash is never consulted again — so a later edit keeps the id.
New alerts use `newAlertId()` (a uuid), never content-derived.

## What shipped (each step independently reviewable)

1. **`persist.ts`** — `SavedAlert.id`; `newAlertId()`, `legacyAlertId()`;
   `normalizeAlert` backfills.
2. **`overlays.ts`** — `alertIds` map (overlay id → stable id); `addAlert` mints,
   `rehydrate` carries, `persist` writes, `reconcileAlerts` matches by id.
   Removed the dead `alertArmed` map (written, never read).
3. **`alertEngine.ts`** — `stateKey`/`alertSig`; `armed`/`baseline`/`sig` maps;
   per-alert baseline + signature move-detection; `setPriceSide`/`stop` clear the
   new maps; `forget(key)` on fire/expiry.
4. **Tests** — `alertEngine.test.ts` mock backfills id + regression test
   ("does not fire when a level MOVES across the stale baseline"); `persist.test.ts`
   literal gets an id. Full unit suite green (75 tests).

`alertEval.ts` unchanged (already pure). `App.tsx` / `ChartCore.tsx` unchanged
(the signal flow is the same; only what the engine does with it changed).
