import { describe, it, expect } from "vitest";
import {
  anyMaskedReplay,
  armMaskedReplay,
  disarmMaskedReplay,
  maskedReplayFor,
  type MaskedReplayRegistry,
  type MaskedReplaySession,
} from "./maskedReplay";

const session = (cellId: string, startMs: number): MaskedReplaySession => ({
  cellId,
  startMs,
  clock: "24h",
  timezone: "UTC",
});

const A = session("cell-a", 1_000);
const B = session("cell-b", 9_000);
const EMPTY: MaskedReplayRegistry = {};

describe("masked-replay registry", () => {
  it("reports no masked session when empty", () => {
    expect(anyMaskedReplay(EMPTY)).toBeNull();
  });

  it("arms and disarms a single cell", () => {
    const armed = armMaskedReplay(EMPTY, A);
    expect(anyMaskedReplay(armed)).toBe(A);
    expect(anyMaskedReplay(disarmMaskedReplay(armed, "cell-a"))).toBeNull();
  });

  // THE regression this registry exists for. With a single shared slot the
  // sequence below left A masked but the slot empty, so every consuming panel
  // silently went back to printing real dates — fail OPEN, and the previous
  // report wrongly described it as safe.
  it("a second cell leaving does not unmask the first", () => {
    let reg = armMaskedReplay(EMPTY, A);
    reg = armMaskedReplay(reg, B); // B arms second and would have overwritten a single slot
    reg = disarmMaskedReplay(reg, "cell-b"); // B exits / unmounts

    expect(anyMaskedReplay(reg)).not.toBeNull();
    expect(maskedReplayFor(reg, "cell-a")).toBe(A);
    expect(maskedReplayFor(reg, "cell-b")).toBeNull();
  });

  it("the same holds whichever of the two leaves first", () => {
    let reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
    reg = disarmMaskedReplay(reg, "cell-a");
    expect(maskedReplayFor(reg, "cell-b")).toBe(B);
    expect(anyMaskedReplay(reg)).toBe(B);
  });

  it("only unmasks once every cell has left", () => {
    let reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
    reg = disarmMaskedReplay(reg, "cell-a");
    reg = disarmMaskedReplay(reg, "cell-b");
    expect(anyMaskedReplay(reg)).toBeNull();
  });

  it("gives each cell its OWN anchor, not a neighbour's day count", () => {
    const reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
    expect(maskedReplayFor(reg, "cell-a")!.startMs).toBe(1_000);
    expect(maskedReplayFor(reg, "cell-b")!.startMs).toBe(9_000);
  });

  // useSyncExternalStore throws "The result of getSnapshot should be cached" if
  // the snapshot identity churns, so anyMaskedReplay must hand back the STORED
  // object and a no-op disarm must not rebuild the registry.
  it("keeps a stable snapshot identity across repeated reads", () => {
    const reg = armMaskedReplay(EMPTY, A);
    expect(anyMaskedReplay(reg)).toBe(anyMaskedReplay(reg));
  });

  it("disarming an absent cell is an identity no-op", () => {
    const reg = armMaskedReplay(EMPTY, A);
    expect(disarmMaskedReplay(reg, "cell-zzz")).toBe(reg);
  });

  it("re-arming the same cell replaces its entry rather than adding one", () => {
    const moved = session("cell-a", 5_000);
    const reg = armMaskedReplay(armMaskedReplay(EMPTY, A), moved);
    expect(Object.keys(reg)).toEqual(["cell-a"]);
    expect(maskedReplayFor(reg, "cell-a")).toBe(moved);
  });

  // Two masked cells at once. Masking still holds — what changes is the day
  // NUMBER, which no any-cell read can get right: before this, B's bars were
  // labelled from whichever anchor `for...in` reached first, so a session that
  // started three days after its neighbour printed the neighbour's day count as
  // fact. Withholding the anchor is the honest answer.
  describe("two cells masked at once", () => {
    it("withholds the anchor rather than guessing one", () => {
      const reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
      const any = anyMaskedReplay(reg);
      expect(any).not.toBeNull();
      expect(any?.startMs).toBeNull();
    });

    it("still gives each cell its own exact anchor by id", () => {
      const reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
      expect(maskedReplayFor(reg, "cell-a")).toBe(A);
      expect(maskedReplayFor(reg, "cell-b")).toBe(B);
    });

    it("restores the exact anchor as soon as one of them leaves", () => {
      let reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
      expect(anyMaskedReplay(reg)?.startMs).toBeNull();
      reg = disarmMaskedReplay(reg, "cell-b");
      expect(anyMaskedReplay(reg)).toBe(A);
    });

    // Same contract the single-entry path has: useSyncExternalStore throws on a
    // snapshot whose identity changes every read, and the ambiguous value is
    // DERIVED, so it has to be memoised on the registry it came from.
    it("keeps a stable identity across reads", () => {
      const reg = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
      expect(anyMaskedReplay(reg)).toBe(anyMaskedReplay(reg));
    });

    it("re-derives when the registry changes", () => {
      const reg1 = armMaskedReplay(armMaskedReplay(EMPTY, A), B);
      const reg2 = armMaskedReplay(reg1, session("cell-c", 4_000));
      const first = anyMaskedReplay(reg1);
      expect(anyMaskedReplay(reg2)).not.toBe(first);
      expect(anyMaskedReplay(reg2)?.startMs).toBeNull();
    });
  });

  it("never mutates the registry it is given", () => {
    const reg = armMaskedReplay(EMPTY, A);
    armMaskedReplay(reg, B);
    disarmMaskedReplay(reg, "cell-a");
    expect(Object.keys(reg)).toEqual(["cell-a"]);
  });
});
