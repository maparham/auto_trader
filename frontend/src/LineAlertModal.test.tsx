// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { add } = vi.hoisted(() => ({
  add: vi.fn((_a: import("./lib/alertsApi").LineAlert) => Promise.resolve(true)),
}));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addLineAlert: add,
}));

import LineAlertModal from "./LineAlertModal";
import { DEFAULT_ALERT_DEFAULTS } from "./theme";

const draft = {
  epic: "US100", broker: "b", precision: 2, timeframe: "HOUR",
  line: { slope: 0.5, tRef: 9, pRef: 13, t1: 2, p1: 10, t2: 6, p2: 12 },
  link: { scope: "s", instanceId: "TRENDLINES", lineKey: "2:6" },
};

afterEach(cleanup);
beforeEach(() => {
  add.mockReset();
  add.mockResolvedValue(true);
});

describe("LineAlertModal", () => {
  it("creates a line alert with the frozen geometry", async () => {
    const onClose = vi.fn();
    render(<LineAlertModal request={{ mode: "create", draft }} defaults={DEFAULT_ALERT_DEFAULTS}
      now={0} onClose={onClose} />);
    expect(screen.getByText("Trendline (1H)")).toBeTruthy();
    fireEvent.click(screen.getByText("Create"));
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    const a = add.mock.calls[0][0];
    expect(a.kind).toBe("line");
    expect(a.params).toMatchObject({
      timeframe: "HOUR", evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
      anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: draft.link,
    });
    await Promise.resolve();
    expect(onClose).toHaveBeenCalled();
  });

  it("an edit whose alert is gone closes itself", () => {
    const onClose = vi.fn();
    render(<LineAlertModal request={{ mode: "edit", id: "nope" }} defaults={DEFAULT_ALERT_DEFAULTS}
      now={0} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
  });
});
