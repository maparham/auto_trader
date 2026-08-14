// Illustrated guide for bb_regime_breakout.py (BB Regime Breakout).

import { Diagram, Level, Marker, Span } from "./diagram";
import type { StrategyGuide } from "./types";

const squeezeDiagram = (
  <Diagram
    title="Bollinger band width falling below its squeeze percentile, then expanding on the breakout"
    viewBox="0 0 640 180"
  >
    <text className="sgd-label" x={40} y={28}>
      Bollinger band width (upper minus lower, over middle), bar by bar
    </text>
    <line className="sgd-axis" x1={40} y1={148} x2={600} y2={148} />
    {/* width history: drifts down into the squeeze, then expands on the break */}
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 62 C 120 72, 180 96, 240 112 C 280 122, 302 126, 322 121 C 360 111, 410 62, 450 42 C 500 30, 550 26, 600 25"
      fill="none"
    />
    <line className="sgd-level sgd-level--ref" x1={40} y1={108} x2={600} y2={108} />
    <text className="sgd-label" x={44} y={100}>
      squeeze percentile of the lookback history
    </text>
    <rect className="sgd-zone" x={252} y={40} width={84} height={108} />
    <Span x1={252} x2={336} y={166} label="squeeze: width at or below the percentile" />
    <text className="sgd-label" x={392} y={78}>
      <tspan x={392} dy={0}>expansion: width above the squeeze width</tspan>
      <tspan x={392} dy={14}>by the minimum %, and rising bar over bar</tspan>
    </text>
  </Diagram>
);

const breakoutDiagram = (
  <Diagram
    title="Price consolidating in a range while the bands squeeze, then breaking out above the range: entry above the range high, stop at the far edge, target at a multiple of the risk"
    viewBox="0 0 640 300"
  >
    {/* Bollinger bands: converging through the squeeze, flaring on the break */}
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 120 C 140 128, 230 134, 300 138 C 340 140, 380 105, 430 58"
      fill="none"
    />
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 222 C 140 214, 230 205, 300 200 C 340 198, 375 228, 415 250"
      fill="none"
    />
    <text className="sgd-label" x={44} y={112}>upper band</text>
    <text className="sgd-label" x={44} y={236}>lower band</text>
    {/* consolidation range */}
    <rect className="sgd-zone" x={110} y={150} width={190} height={35} />
    <line className="sgd-level sgd-level--ref" x1={110} y1={150} x2={300} y2={150} />
    <line className="sgd-level sgd-level--ref" x1={110} y1={185} x2={300} y2={185} />
    <text className="sgd-label" x={114} y={146}>range high</text>
    <text className="sgd-label" x={114} y={197}>range low</text>
    {/* price: sideways chop, then the confirmed break */}
    <polyline
      className="sgd-price"
      points="40,178 65,162 85,175 105,158 125,172 145,156 165,180 185,164 205,178 225,158 245,174 265,157 285,170 300,165 312,152 322,143 336,136 356,124 380,110 405,96 435,84"
    />
    <Marker x={322} y={143} side="long" />
    {/* trade levels */}
    <Level x1={322} x2={600} y={143} kind="entry" label="entry: confirmed close beyond the range" />
    <Level x1={322} x2={600} y={185} kind="stop" label="stop: slid across the range by stop depth" labelBelow />
    <Level x1={322} x2={600} y={59} kind="target" label="target: target_r times the risk, beyond entry" />
    {/* risk bracket */}
    <line className="sgd-span" x1={612} y1={143} x2={612} y2={185} />
    <text className="sgd-label" x={620} y={168}>R</text>
    {/* bar spans */}
    <Span x1={200} x2={300} y={282} label="squeeze" />
    <Span x1={300} x2={380} y={282} label="breakout window" />
  </Diagram>
);

export const bbRegimeBreakout: StrategyGuide = {
  tagline:
    "A trend and regime breakout on 20-period, 3-deviation Bollinger Bands (after Anthony Crudele). Band width classifies the regime; trades fire only on the consolidation-to-trend transition.",
  sections: [
    {
      heading: "The idea",
      body: (
        <>
          <p>
            Markets alternate between quiet consolidation and directional trends. This
            strategy uses the width of the Bollinger Bands to tell the two regimes apart:
            narrow bands mean consolidation, expanding bands mean a trend is starting. It
            never trades inside the quiet phase (the middle of a consolidation is noise)
            and instead waits for the moment the market transitions from squeeze to trend.
          </p>
        </>
      ),
    },
    {
      heading: "The squeeze",
      body: (
        <>
          <p>
            Band width is measured against its own recent history (the squeeze lookback).
            When it sits at or below the squeeze percentile of that history, the market is
            consolidating. Two extra checks keep the squeeze honest: the price range over
            the range lookback must stay relatively sideways (its height capped as a % of
            price), and that range defines the edges that a breakout must clear.
          </p>
        </>
      ),
      diagram: squeezeDiagram,
    },
    {
      heading: "The breakout trade",
      body: (
        <>
          <p>
            The transition to trend needs two things at once: band width expanding (above
            the squeeze width by a minimum %, and rising bar over bar) and price closing
            beyond the consolidation range high or low for the confirming bar(s). Both
            must happen within a limited window after the squeeze ends: late breaks are
            not chased.
          </p>
          <p>
            Entry is in the breakout direction while flat, and only inside that window. A
            stop-out may re-enter while the window lasts; once the window closes, the move
            is never chased.
          </p>
        </>
      ),
      diagram: breakoutDiagram,
    },
    {
      heading: "Stop and target",
      body: (
        <>
          <p>
            The stop is anchored to the prior consolidation range: the stop depth
            parameter slides it from the broken edge (0.0) all the way to the far edge of
            the range (1.0, the default drawn above). The distance from entry to stop is
            the risk R; the target sits target_r times that risk beyond entry.
          </p>
        </>
      ),
    },
    {
      heading: "The regime kill switch (optional)",
      body: (
        <>
          <p>
            Breakout entries suffer most in grinding markets, where price travels a long
            path but goes nowhere. The optional kill switch measures this with the Kaufman
            efficiency ratio over the ER lookback: the net move divided by the total path
            traveled, near 1 in a clean trend and near 0 in chop. While the ratio sits
            below the minimum efficiency ratio, new entries are skipped; everything else
            is unchanged.
          </p>
          <p>
            At the default of 0 the gate is disabled and the strategy behaves exactly as
            described above. Both knobs are sweepable, so an optimizer (or a walk-forward
            fold) can decide whether a given market rewards turning it on.
          </p>
        </>
      ),
    },
  ],
};
