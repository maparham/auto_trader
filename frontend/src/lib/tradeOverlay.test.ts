// jsdom, not the suite's default node env: this module imports klinecharts,
// which touches `window` at import time.
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import type { OverlayFigure } from "klinecharts";
import { tradeBox } from "./tradeOverlay";
import { setAccountSnapshot } from "./accountSnapshot";
import { UP, DOWN } from "./chartTheme";
import { hexToRgba } from "./lineStyle";

afterEach(() => setAccountSnapshot(null));

const PANE = { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 };

// A 1:2 long drawn from x=100 to x=300: entry 100 @ y=200, target 102 @ y=100,
// stop 99 @ y=250.
const LONG_COORDS = [
  { x: 100, y: 200 },
  { x: 300, y: 100 },
  { x: 300, y: 250 },
];
const LONG_POINTS = [
  { timestamp: 1_000_000, value: 100, dataIndex: 0 },
  { timestamp: 1_600_000, value: 102, dataIndex: 10 },
  { timestamp: 1_600_000, value: 99, dataIndex: 10 },
];

function paint(
  template: typeof tradeBox,
  over: {
    coordinates?: Array<{ x: number; y: number }>;
    points?: typeof LONG_POINTS;
    trade?: Record<string, unknown>;
    bounding?: typeof PANE;
  } = {},
): OverlayFigure[] {
  return template.createPointFigures!({
    overlay: {
      points: over.points ?? LONG_POINTS,
      extendData: { trade: over.trade },
    },
    coordinates: over.coordinates ?? LONG_COORDS,
    bounding: over.bounding ?? PANE,
    chart: {
      getSymbol: () => ({ pricePrecision: 2 }),
      // 20 hourly bars starting at the entry's timestamp.
      getDataList: () =>
        Array.from({ length: 20 }, (_, i) => ({ timestamp: 1_000_000 + i * 60_000 })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as OverlayFigure[];
}

type Rect = { attrs: { x: number; y: number; width: number; height: number }; styles?: { color?: string } };

function rects(figures: OverlayFigure[]): Rect[] {
  return figures.filter((f) => f.type === "rect") as unknown as Rect[];
}
function texts(figures: OverlayFigure[]): string[] {
  return figures
    .filter((f) => f.type === "text")
    .map((f) => (f as unknown as { attrs: { text: string } }).attrs.text);
}
// The zone rect painted in the given theme colour (reward = up, risk = down).
function zone(figures: OverlayFigure[], color: string): Rect | undefined {
  return byColor(rects(figures), color);
}

// The zone rect painted in a given theme colour, among already-extracted rects.
// Zones carry their alpha as rgba (not a hex suffix), so match the same way the
// template builds it — that is what keeps the fill valid for any colour format.
function byColor(rs: Rect[], color: string): Rect | undefined {
  const want = hexToRgba(color, 0.15);
  return rs.find((r) => r.styles?.color === want);
}

describe("trade overlay zones", () => {
  it("spans the reward zone from the entry to the target, across the drawing width", () => {
    const r = zone(paint(tradeBox), UP)!;
    expect(r.attrs.x).toBe(100);
    expect(r.attrs.width).toBe(200);
    expect(r.attrs.y).toBe(100); // target is the top edge for a long
    expect(r.attrs.height).toBe(100);
  });

  it("spans the risk zone from the entry to the stop", () => {
    const r = zone(paint(tradeBox), DOWN)!;
    expect(r.attrs.y).toBe(200);
    expect(r.attrs.height).toBe(50);
  });

  it("keeps reward green and risk red for a short, where the levels are mirrored", () => {
    // A short is the same drawing with the levels mirrored: target BELOW the
    // entry (y=250), stop above (y=100). One tool draws both.
    const figures = paint(tradeBox, {
      coordinates: [{ x: 100, y: 200 }, { x: 300, y: 250 }, { x: 300, y: 100 }],
      points: [
        { timestamp: 1_000_000, value: 100, dataIndex: 0 },
        { timestamp: 1_600_000, value: 98, dataIndex: 10 },
        { timestamp: 1_600_000, value: 101, dataIndex: 10 },
      ],
    });
    expect(zone(figures, UP)!.attrs.y).toBe(200); // reward runs down from the entry
    expect(zone(figures, UP)!.attrs.height).toBe(50);
    expect(zone(figures, DOWN)!.attrs.y).toBe(100); // risk runs up to the stop
  });

  it("previews the trade mid-draw, before the stop anchor exists", () => {
    // Two clicks place entry and target; the stop point is added on draw-end. A
    // template that waited for it would leave the user dragging out an invisible
    // box, so the preview mirrors the risk zone at the 1:2 default it will get.
    const figures = paint(tradeBox, {
      coordinates: LONG_COORDS.slice(0, 2),
      points: LONG_POINTS.slice(0, 2),
    });
    expect(zone(figures, UP)!.attrs.height).toBe(100);
    const risk = zone(figures, DOWN)!;
    expect(risk.attrs.y).toBe(200);
    expect(risk.attrs.height).toBe(50); // half the reward, in pixels
  });

  it("nests the zones when both legs fall on one side of the entry", () => {
    // Dragging the target across the entry (without the stop following) puts
    // reward and risk on the SAME side, where they overlap. Painted in a fixed
    // order the later rect buries the earlier one entirely; the bigger zone has
    // to go down first so the smaller nests inside it and both stay readable.
    // Target 0.5 below the entry, stop a full 1 below: risk is the bigger zone.
    const crossed = [{ x: 100, y: 200 }, { x: 300, y: 225 }, { x: 300, y: 250 }];
    const painted = rects(paint(tradeBox, { coordinates: crossed }));
    expect(painted[0].attrs.height).toBeGreaterThanOrEqual(painted[1].attrs.height);
    expect(byColor(painted, DOWN)!.attrs.height).toBe(50); // risk, drawn first
    expect(byColor(painted, UP)!.attrs.height).toBe(25); // reward, nested on top
  });

  it("is inert with a single anchor", () => {
    expect(paint(tradeBox, { coordinates: LONG_COORDS.slice(0, 1) })).toEqual([]);
  });
});

describe("trade overlay legs collapsed onto the entry", () => {
  // A stop dragged onto the entry has no risk to draw. The zero-height rect is
  // invisible either way, but its dashed line and "−0.00%" pill are not — they
  // sit on the entry line claiming a level the trade does not have.
  const collapsed = [{ x: 100, y: 200 }, { x: 300, y: 100 }, { x: 300, y: 200 }];
  const collapsedPoints = [
    { timestamp: 1_000_000, value: 100, dataIndex: 0 },
    { timestamp: 1_600_000, value: 102, dataIndex: 10 },
    { timestamp: 1_600_000, value: 100, dataIndex: 10 },
  ];
  const painted = () => paint(tradeBox, { coordinates: collapsed, points: collapsedPoints });

  it("draws no risk zone, line or pill when the stop sits on the entry", () => {
    const figures = painted();
    expect(byColor(rects(figures), DOWN)).toBeUndefined();
    expect(texts(figures).some((t) => t.includes("0.00%"))).toBe(false);
    const dashed = figures.filter(
      (f) => f.type === "line" && (f as unknown as { styles?: { style?: string } }).styles?.style === "dashed",
    );
    expect(dashed).toHaveLength(1); // the target's, not the stop's
  });

  it("still draws the reward side, which is a real level", () => {
    expect(byColor(rects(painted()), UP)).toBeDefined();
    expect(texts(painted())).toContain("+2.00%");
  });
});

describe("trade overlay caption", () => {
  // `drawing.add` documents "text sets the label" and placeDrawing stores it on
  // extendData.text for every drawing — a template that ignores it reports
  // success to an agent while rendering nothing.
  it("renders the drawing's text label", () => {
    const figures = tradeBox.createPointFigures!({
      overlay: { points: LONG_POINTS, extendData: { text: "A+ setup" } },
      coordinates: LONG_COORDS,
      bounding: PANE,
      chart: {
        getSymbol: () => ({ pricePrecision: 2 }),
        getDataList: () => [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as OverlayFigure[];
    expect(texts(figures)).toContain("A+ setup");
  });

  it("draws no caption when there is none", () => {
    expect(texts(paint(tradeBox))).toEqual(["R:R 1:2.00", "+2.00%", "−1.00%"]);
  });
});

describe("trade overlay interaction discipline", () => {
  it("leaves the zone rects hit-testable, so the body selects and drags the drawing", () => {
    expect(rects(paint(tradeBox)).every((r) => !("ignoreEvent" in r))).toBe(true);
  });

  it("keeps every label out of hit-testing, so pills never swallow a drag", () => {
    const labels = paint(tradeBox).filter((f) => f.type === "text");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((f) => f.ignoreEvent === true)).toBe(true);
  });
});

describe("trade overlay labels", () => {
  it("shows R:R at the entry and the two percentages by default", () => {
    expect(texts(paint(tradeBox))).toEqual(["R:R 1:2.00", "+2.00%", "−1.00%"]);
  });

  it("adds the money figures once an account is connected and the group is on", () => {
    setAccountSnapshot({ balance: 10_000, currency: "USD" });
    expect(texts(paint(tradeBox, { trade: { showMoney: true } }))).toContain("+200.00 USD");
  });

  it("counts the span in loaded bars, which a rehydrated drawing has no dataIndex for", () => {
    // Persisted points carry only {timestamp, value}: reading dataIndex off them
    // reported every reloaded trade as "0 bars".
    const noIndex = LONG_POINTS.map(({ timestamp, value }) => ({ timestamp, value, dataIndex: 0 }));
    expect(
      texts(paint(tradeBox, { points: noIndex, trade: { showDuration: true } })),
    ).toContain("10 bars, 10m");
  });

  it("flips the level pills inside the pane when the drawing runs to the right edge", () => {
    const wide = [{ x: 600, y: 200 }, { x: 795, y: 100 }, { x: 795, y: 250 }];
    const pill = paint(tradeBox, { coordinates: wide })
      .filter((f) => f.type === "text")
      .map((f) => f as unknown as { attrs: { x: number; align: string; text: string } })
      .find((f) => f.attrs.text === "+2.00%")!;
    expect(pill.attrs.align).toBe("right");
    expect(pill.attrs.x).toBeLessThan(795);
  });

  it("stacks a multi-line stop label upwards when it would run off the pane bottom", () => {
    setAccountSnapshot({ balance: 10_000, currency: "USD" });
    // Stop at y=395 in a 400px pane: a second line 14px below would be cut off.
    const low = [{ x: 100, y: 300 }, { x: 300, y: 100 }, { x: 300, y: 395 }];
    const ys = paint(tradeBox, { coordinates: low, trade: { showMoney: true } })
      .filter((f) => f.type === "text")
      .map((f) => f as unknown as { attrs: { y: number; text: string } })
      .filter((f) => f.attrs.text.includes("USD") || f.attrs.text.startsWith("−"))
      .map((f) => f.attrs.y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(400);
  });

  it("clamps the R:R pill below the pane top for an entry drawn at the very top", () => {
    const high = [{ x: 100, y: 2 }, { x: 300, y: 0 }, { x: 300, y: 40 }];
    const rr = paint(tradeBox, { coordinates: high })
      .filter((f) => f.type === "text")
      .map((f) => f as unknown as { attrs: { y: number; text: string } })
      .find((f) => f.attrs.text.startsWith("R:R"))!;
    expect(rr.attrs.y).toBeGreaterThanOrEqual(10);
  });
});

describe("registration", () => {
  it("puts both names in klinecharts' supported list, so the sidebar shows them", async () => {
    // DrawSidebar filters DRAW_TOOLS by getSupportedOverlays(); an unregistered
    // tool doesn't error, it just silently never appears in the menu.
    const { registerCustomOverlays } = await import("./customOverlays");
    const { getSupportedOverlays } = await import("klinecharts");
    registerCustomOverlays();
    const supported = new Set(getSupportedOverlays());
    expect(supported.has("tradeBox")).toBe(true);
  });
});

describe("trade overlay off-pane level lines", () => {
  // The level lines are UNCONDITIONALLY dashed; a saved trade panned far away
  // must not stroke a dashed line of arbitrary length every frame (klinecharts
  // does not cull overlays or clip its line figure).
  it("clamps the dashed level lines to the pane", () => {
    const figures = paint(tradeBox, {
      coordinates: [
        { x: -60_000, y: 200 },
        { x: 300, y: 100 },
        { x: 300, y: 250 },
      ],
    });
    const lines = figures.filter((f) => f.type === "line") as unknown as Array<{
      attrs: { coordinates: Array<{ x: number }> };
    }>;
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines)
      for (const c of l.attrs.coordinates) expect(Math.abs(c.x)).toBeLessThan(10_000);
  });

  it("emits no level lines when the whole trade sits off-pane", () => {
    const figures = paint(tradeBox, {
      coordinates: [
        { x: -60_000, y: 200 },
        { x: -50_000, y: 100 },
        { x: -50_000, y: 250 },
      ],
    });
    expect(figures.some((f) => f.type === "line")).toBe(false);
  });
});
