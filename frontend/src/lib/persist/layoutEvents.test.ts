import { describe, it, expect, vi } from "vitest";
import {
  emitLayoutChanged,
  onLayoutChanged,
  withLayoutEventsSuppressed,
} from "./layoutEvents";

describe("layoutEvents", () => {
  it("notifies subscribers with the scope", () => {
    const cb = vi.fn();
    const off = onLayoutChanged(cb);
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledWith("cell-1");
    off();
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("suppresses emits inside withLayoutEventsSuppressed (incl. nested)", () => {
    const cb = vi.fn();
    const off = onLayoutChanged(cb);
    withLayoutEventsSuppressed(() => {
      withLayoutEventsSuppressed(() => emitLayoutChanged("cell-1"));
      emitLayoutChanged("cell-1");
    });
    expect(cb).not.toHaveBeenCalled();
    emitLayoutChanged("cell-1");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });
});
