# Merge Undo Snackbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any tab merge, show a bottom-center snackbar with an Undo button that fully restores the pre-merge state (tabs, scopes, content) for 8 seconds.

**Architecture:** `mergeTabInto` (persist.ts) additionally returns the scope pairs it moved; a new `unmergeScopes` performs the inverse content move. App holds one `pendingUndo` snapshot (pre-merge tabs array + activeId + pairs), rendered as a new `Snackbar` component; a structure-signature effect clears it on any structural tab change. Undo = inverse scope move + snapshot restore + the same synchronous workspace persist the merge uses.

**Tech Stack:** React 19 + TypeScript (Vite), vitest, Playwright. Spec: `docs/superpowers/specs/2026-07-03-merge-undo-design.md`.

## Global Constraints

- Work directly on `main`, do NOT push, do NOT kill the user's dev servers.
- A CONCURRENT session has uncommitted work in the repo (currently `frontend/src/App.css`, `frontend/src/ChartCore.tsx`, `frontend/src/ChartLegend.tsx`, deleted `InstrumentDetailsModal.tsx`, untracked `market-info.spec.ts` — may change). NEVER `git add` a file with foreign changes wholesale; for a shared file, stage only your own hunk (recipe in Task 2 Step 6). Check `git status` before staging.
- Copy: snackbar message `Merged into <symbol name> · <TF label>`, action label `Undo`. Plain language, content-sized pill, light-theme-first, follow the existing `.toast` visual idiom (`frontend/src/App.css` ~line 1188).
- Duration 8000 ms; hover pauses the countdown (leave restarts it in full — documented simplification).
- Undo restores the FULL pre-merge snapshot and persists it synchronously (saveLayout + setIsDirty(false) when a named layout is active, else saveScratch) — the same durable rule `mergeTabs` uses.
- Invalidation is signature-based: tab ids + layout kinds + cell ids. Symbol/TF changes must NOT clear the snackbar; structural changes (tab close/add, cell close, detach, layout change, workspace/broker/layout switch) MUST.
- Commands from `frontend/`: unit `npx vitest run src/lib/persist.test.ts`, e2e `npx playwright test e2e/merge-tabs.spec.ts`, types `npx tsc -b` (pre-existing errors live in ChartCore.tsx, historyPaging.test.ts, overlays.test.ts, persist.test.ts, positionLines.test.ts — anything else is yours).

---

### Task 1: mergeTabInto returns the moved scope pairs + `unmergeScopes`

**Files:**
- Modify: `frontend/src/lib/persist.ts` (mergeTabInto ~line 588; add unmergeScopes after it)
- Modify: `frontend/src/App.tsx` (mergeTabs call site, ~line 1095 — adapt to the new return shape only; undo capture is Task 2)
- Test: `frontend/src/lib/persist.test.ts` (merge describe block ~line 565)

**Interfaces:**
- Consumes: existing `copyScopeContent`, `purgeScope`, `purgeTabScope`, `cellScope`.
- Produces: `mergeTabInto(tabs, sourceId, targetId, position?) : { tabs: ChartTab[]; moved: Array<{ from: string; to: string }> } | null` (was `ChartTab[] | null`); `unmergeScopes(pairs: Array<{ from: string; to: string }>): void`.

- [ ] **Step 1: Write the failing round-trip test**

In the `describe("mergeTabInto …")` block of `frontend/src/lib/persist.test.ts`, add:

```ts
  it("returns the moved scope pairs, and unmergeScopes round-trips content (edits made after the merge survive undo)", () => {
    P.saveDrawings(P.primaryCellScope("s"), "US100", [{ name: "x", points: [{ value: 1 }] }]);
    const prev = [tab("s", 1), tab("d", 1)];
    const res = P.mergeTabInto(prev, "s", "d")!;
    expect(res.moved).toEqual([{ from: P.primaryCellScope("s"), to: P.cellScope("d", "s-c0") }]);
    // Edit made AFTER the merge under the NEW scope — must travel back on undo.
    P.saveDrawings(P.cellScope("d", "s-c0"), "US100", [
      { name: "x", points: [{ value: 1 }] },
      { name: "y", points: [{ value: 2 }] },
    ]);
    P.unmergeScopes(res.moved);
    expect(P.loadDrawings(P.primaryCellScope("s"), "US100")).toHaveLength(2);
    expect(P.loadDrawings(P.cellScope("d", "s-c0"), "US100")).toHaveLength(0);
    // The pre-merge array is untouched (immutable input) — the caller's
    // snapshot restore is a plain array swap.
    expect(prev.map((t) => t.id)).toEqual(["s", "d"]);
    expect(prev[0].cells[0].scope).toBe(P.primaryCellScope("s"));
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: FAIL — `res.moved` undefined / `unmergeScopes` not a function.

- [ ] **Step 3: Implement in persist.ts**

Change `mergeTabInto`'s signature and returns (the body is otherwise unchanged — keep the lockPeriod and sync-flag logic exactly as is):

```ts
export function mergeTabInto(
  tabs: ChartTab[],
  sourceId: string,
  targetId: string,
  position: "before" | "after" = "after",
): { tabs: ChartTab[]; moved: Array<{ from: string; to: string }> } | null {
```

Inside, collect the pairs while re-scoping (this replaces the existing `moved` cell map — note the extra `movedScopes.push`):

```ts
  const movedScopes: Array<{ from: string; to: string }> = [];
  const moved: ChartCell[] = src.cells.map((c) => {
    const scope = cellScope(targetId, c.id);
    copyScopeContent(c.scope, scope);
    movedScopes.push({ from: c.scope, to: scope });
    return lockPeriod ? { ...c, scope, period: lockPeriod } : { ...c, scope };
  });
```

And the return:

```ts
  return {
    tabs: tabs.filter((t) => t.id !== sourceId).map((t) => (t.id === targetId ? merged : t)),
    moved: movedScopes,
  };
```

Add after `mergeTabInto`:

```ts
// Inverse of the scope moves a merge performed: content travels BACK to the
// old scopes (carrying any edits made since the merge) and the merged-in
// scopes are purged. Restoring the tab array itself is the caller's job — it
// holds the pre-merge snapshot (mergeTabInto never mutates its input).
export function unmergeScopes(pairs: Array<{ from: string; to: string }>): void {
  for (const { from, to } of pairs) {
    copyScopeContent(to, from);
    purgeScope(to);
  }
}
```

- [ ] **Step 4: Adapt the existing merge tests and the App call site**

In `persist.test.ts`, every existing `mergeTabInto(...)` result is now the object. Mechanical rewrite, e.g.:

```ts
    const out = P.mergeTabInto([tab("s", 1), tab("d", 1)], "s", "d")!.tabs;
```

(keep each test's assertions unchanged; only insert `.tabs`). The over-cap test's `expect(P.mergeTabInto(...)).toBeNull()` stays as is.

In `frontend/src/App.tsx`'s `mergeTabs`, replace the loop body's first two lines:

```ts
      const res = mergeTabInto(next, srcId, targetId, position);
      if (!res) continue; // over-cap sources are UI-disabled; skip defensively
      next = res.tabs;
```

- [ ] **Step 5: Run tests + types**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts` → all pass (43).
Run: `npx tsc -b` → no NEW errors (pre-existing list in Global Constraints).
Run: `npx playwright test e2e/merge-tabs.spec.ts` → 6 passed (behavior unchanged).

- [ ] **Step 6: Commit (check `git status` first — stage ONLY these three files)**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/persist.test.ts frontend/src/App.tsx
git commit -m "feat(tabs): mergeTabInto reports moved scope pairs + unmergeScopes inverse"
```

If `git status` shows foreign changes inside App.tsx (another session edits it live), use the hunk-staging recipe from Task 2 Step 6 for App.tsx instead of a whole-file add.

---

### Task 2: pendingUndo state + Snackbar component + invalidation + e2e

**Files:**
- Create: `frontend/src/Snackbar.tsx`
- Modify: `frontend/src/App.tsx` (state near other useState ~line 314 area; mergeTabs; render block near the toasts/modals at the bottom)
- Modify: `frontend/src/App.css` (after the `.toast` rules ~line 1199)
- Test: `frontend/e2e/merge-tabs.spec.ts` (append)

**Interfaces:**
- Consumes: `unmergeScopes`, the new `mergeTabInto` return shape (Task 1); existing `saveLayout`/`saveScratch`/`setIsDirty`/`Workspace` already used inside `mergeTabs`.
- Produces: `Snackbar({ message, actionLabel, onAction, onDismiss, duration? })` — reusable transient action pill.

- [ ] **Step 1: Snackbar component**

Create `frontend/src/Snackbar.tsx`:

```tsx
// TV-style transient snackbar (bottom-center): message + accent action + ✕.
// Auto-dismisses after `duration` ms. Hovering pauses the countdown; leaving
// restarts it in full (simple, and indistinguishable from a true pause at
// this duration).

import { useEffect, useRef, useState } from "react";

interface Props {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  duration?: number;
}

export default function Snackbar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  duration = 8000,
}: Props) {
  const [hovered, setHovered] = useState(false);
  // The timeout must always call the LATEST onDismiss without restarting the
  // countdown when the parent re-renders with a new closure.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (hovered) return;
    const t = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [hovered, duration]);
  return (
    <div
      className="snackbar"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="snackbar-msg">{message}</span>
      <button type="button" className="snackbar-action" onClick={onAction}>
        {actionLabel}
      </button>
      <button type="button" className="snackbar-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
```

- [ ] **Step 2: App state, capture, undo, invalidation**

Import `Snackbar` and add `unmergeScopes` to the persist import. Near the other workspace state (`isDirty` etc.):

```ts
  // One-shot undo offer for the last merge: the pre-merge snapshot plus the
  // scope moves to reverse. Cleared by time (Snackbar), by undo/dismiss, or by
  // the structure-signature effect below when anything structural changes.
  const [pendingUndo, setPendingUndo] = useState<{
    prevTabs: ChartTab[];
    prevActiveId: string;
    pairs: Array<{ from: string; to: string }>;
    label: string;
    sigAfter: string;
  } | null>(null);

  // Structural fingerprint: tab ids + layout kinds + cell ids. Symbol/TF
  // changes don't alter it (undo must survive them); close/add/detach/layout
  // changes and workspace/broker switches do.
  const structureSig = (ts: ChartTab[]) =>
    ts.map((t) => `${t.id}:${t.layout}:${t.cells.map((c) => c.id).join(",")}`).join("|");

  useEffect(() => {
    if (pendingUndo && structureSig(tabs) !== pendingUndo.sigAfter) setPendingUndo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);
```

In `mergeTabs`, capture before the loop and collect pairs (full replacement of the function — it builds on Task 1's shape):

```ts
  const mergeTabs = (
    targetId: string,
    sourceIds: string[],
    position: "before" | "after" = "after",
  ) => {
    const prevTabs = tabs;
    const prevActiveId = activeId;
    // Label = the TARGET's pre-merge lead chart (after the merge its
    // activeCellId points at the merged-in cell, which would mislabel).
    const dst = tabs.find((t) => t.id === targetId);
    const lead = dst ? (dst.cells.find((c) => c.id === dst.activeCellId) ?? dst.cells[0]) : null;
    const pairs: Array<{ from: string; to: string }> = [];
    let next = tabs;
    for (const srcId of sourceIds) {
      const res = mergeTabInto(next, srcId, targetId, position);
      if (!res) continue; // over-cap sources are UI-disabled; skip defensively
      next = res.tabs;
      pairs.push(...res.moved);
      clearAlignAnchor(srcId); // same leak-guard closeTab applies
    }
    if (next === tabs) return;
    // (existing synchronous-persist block stays exactly as is)
    const ws: Workspace = { tabs: next, activeTabId: "" };
    if (activeLayoutId && layoutName != null) {
      saveLayout(activeLayoutId, layoutName, ws);
      setIsDirty(false);
    } else {
      saveScratch(ws);
    }
    setTabs(next);
    setActiveId(targetId);
    setPendingUndo({
      prevTabs,
      prevActiveId,
      pairs,
      label: lead ? `Merged into ${lead.symbol.name} · ${lead.period.label}` : "Tabs merged",
      sigAfter: structureSig(next),
    });
  };

  // Full inverse of the last merge: content moves back to the old scopes
  // (carrying post-merge edits), the snapshot tab array is restored, and the
  // workspace is persisted with the same durable rule the merge used.
  const undoMerge = () => {
    const u = pendingUndo;
    if (!u) return;
    setPendingUndo(null); // before setTabs — the sig effect must not race it
    unmergeScopes(u.pairs);
    const ws: Workspace = { tabs: u.prevTabs, activeTabId: "" };
    if (activeLayoutId && layoutName != null) {
      saveLayout(activeLayoutId, layoutName, ws);
      setIsDirty(false);
    } else {
      saveScratch(ws);
    }
    setTabs(u.prevTabs);
    setActiveId(u.prevActiveId);
  };
```

Render, next to the other floating UI at the bottom of App's JSX:

```tsx
      {pendingUndo && (
        <Snackbar
          message={pendingUndo.label}
          actionLabel="Undo"
          onAction={undoMerge}
          onDismiss={() => setPendingUndo(null)}
        />
      )}
```

- [ ] **Step 3: CSS**

Append to `frontend/src/App.css` right after the `.toast.show` rule (~line 1199):

```css
/* Bottom-center transient snackbar (merge undo) — same idiom as the toasts. */
.snackbar {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 3000;
  display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px;
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px; box-shadow: 0 8px 28px var(--shadow);
}
.snackbar-action {
  border: none; background: transparent; color: var(--accent); font-weight: 600;
  font-size: 13px; padding: 4px 8px; border-radius: 5px; cursor: pointer;
}
.snackbar-action:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.snackbar-close {
  border: none; background: transparent; color: var(--text-faint); font-size: 15px;
  padding: 2px 6px; cursor: pointer; border-radius: 5px;
}
.snackbar-close:hover { color: var(--text); }
```

- [ ] **Step 4: e2e tests**

Append to `frontend/e2e/merge-tabs.spec.ts`:

```ts
test("Undo restores the pre-merge tabs with content back under the old scope", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();
  await page.locator(".merge-menu .merge-row", { hasText: "OIL_CRUDE" }).click();
  await page.locator(".merge-menu .merge-confirm").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);

  await expect(page.locator(".snackbar")).toContainText("Merged into US100 · 1H");
  await page.locator(".snackbar-action", { hasText: "Undo" }).click();

  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await expect(page.locator(".chart-cell")).toHaveCount(1);
  await expect(page.locator(".snackbar")).toHaveCount(0);
  // Content moved back: drawing under t2's original scope, merged scope purged,
  // and the restored workspace persisted (synchronous rule).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        return {
          tabCount: ws?.tabs?.length,
          restored: localStorage.getItem("auto-trader.tab.t2.drawings.OIL_CRUDE") != null,
          purged: localStorage.getItem("auto-trader.tab.t1.cell.t2-c0.drawings.OIL_CRUDE") == null,
        };
      }),
    )
    .toEqual({ tabCount: 2, restored: true, purged: true });
});

test("snackbar disappears on a structural tab change instead of offering a stale undo", async ({ page }) => {
  await seedThreeTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Merge t3 (GOLD) into t1 via the checklist, then close t2 — a structural
  // change unrelated to the merge. The undo snapshot is stale → snackbar gone.
  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();
  await page.locator(".merge-menu .merge-row", { hasText: "GOLD" }).click();
  await page.locator(".merge-menu .merge-confirm").click();
  await expect(page.locator(".snackbar")).toBeVisible();

  await page.locator(".tab-bar .tab", { hasText: "OIL_CRUDE" }).locator(".tab-close").click();
  await expect(page.locator(".snackbar")).toHaveCount(0);
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
});

test("snackbar auto-dismisses after 8s and the merge stays", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();
  await page.locator(".merge-menu .merge-row", { hasText: "OIL_CRUDE" }).click();
  await page.locator(".merge-menu .merge-confirm").click();
  await expect(page.locator(".snackbar")).toBeVisible();

  await expect(page.locator(".snackbar")).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
});
```

- [ ] **Step 5: Run everything**

Run: `cd frontend && npx playwright test e2e/merge-tabs.spec.ts` → 9 passed.
Run: `npx vitest run` → all pass.
Run: `npx tsc -b` → no new errors.

- [ ] **Step 6: Commit — App.css is FOREIGN-MODIFIED; stage only your hunk**

`git add frontend/src/App.css` would sweep another session's uncommitted work. Stage the snackbar hunk alone:

```bash
cd /Users/mahmoudparham/auto_trader
python3 - <<'EOF'
import subprocess
diff = subprocess.run(["git", "diff", "-U3", "--", "frontend/src/App.css"],
                      capture_output=True, text=True, cwd=".").stdout
lines = diff.splitlines(keepends=True)
idx = [i for i, l in enumerate(lines) if l.startswith("@@")]
header = lines[:idx[0]]
hunks = [lines[i:(idx[j+1] if j+1 < len(idx) else len(lines))] for j, i in enumerate(idx)]
mine = [h for h in hunks if ".snackbar" in "".join(h)]
assert len(mine) == 1, f"expected exactly 1 snackbar hunk, got {len(mine)}"
open("/tmp/snackbar.patch", "w").write("".join(header + mine[0]))
EOF
git apply --cached /tmp/snackbar.patch
git add frontend/src/Snackbar.tsx frontend/src/App.tsx frontend/e2e/merge-tabs.spec.ts
git status --short   # verify: App.css shows MM (yours staged, theirs not); no foreign files staged
git commit -m "feat(tabs): merge-undo snackbar — 8s bottom-center Undo restoring the pre-merge workspace"
```

If App.tsx also shows foreign modifications at commit time, apply the same recipe with a predicate matching `pendingUndo`.
