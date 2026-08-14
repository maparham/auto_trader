// Illustrated guide for trend_pullback.py (Trend Pullback).

import { Diagram, Level, Marker } from "./diagram";
import type { StrategyGuide } from "./types";

const pullbackDiagram = (
  <Diagram
    title="Price dipping inside a rising trend while RSI drops below its floor and turns back up: entry on the recovery, stop an ATR multiple below, target an R multiple above"
    viewBox="0 0 640 330"
  >
    {/* price pane */}
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 210 C 120 196, 200 186, 260 176 C 300 170, 330 178, 360 182 C 390 185, 420 168, 480 146 C 530 130, 570 120, 600 114"
      fill="none"
    />
    <path
      className="sgd-line sgd-line--dim"
      d="M 40 230 C 160 214, 300 196, 440 172 C 500 162, 560 152, 600 146"
      fill="none"
    />
    <text className="sgd-label sgd-label--strong" x={44} y={186}>price</text>
    <text className="sgd-label" x={44} y={206}>fast EMA</text>
    <text className="sgd-label" x={44} y={242}>slow EMA (rising)</text>
    <polyline
      className="sgd-price"
      points="40,196 80,184 120,172 160,162 200,152 240,158 280,172 320,188 350,196 370,186 390,170 430,150 470,134 520,116 560,102"
    />
    <text className="sgd-label" x={330} y={214} textAnchor="middle">
      the dip
    </text>
    <Marker x={390} y={170} side="long" />
    <text className="sgd-label sgd-label--strong" x={390} y={150} textAnchor="middle">entry</text>
    <line className="sgd-level sgd-level--entry" x1={390} y1={170} x2={600} y2={170} />
    <line className="sgd-level sgd-level--target" x1={390} y1={104} x2={600} y2={104} />
    <text className="sgd-label" x={398} y={97}>target: an R multiple of the stop distance</text>
    <line className="sgd-level sgd-level--stop" x1={390} y1={214} x2={600} y2={214} />
    <text className="sgd-label" x={398} y={230}>stop: an ATR multiple below entry</text>
    {/* pane separator + alignment guide */}
    <line className="sgd-axis" x1={40} y1={252} x2={600} y2={252} />
    <line className="sgd-guide" x1={390} y1={176} x2={390} y2={302} />
    {/* RSI pane */}
    <text className="sgd-label" x={40} y={270}>RSI(14)</text>
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 282 C 100 277, 160 284, 220 289 C 270 293, 320 305, 352 309 C 372 311, 382 303, 392 296 C 430 282, 500 274, 600 270"
      fill="none"
    />
    <Level x1={40} x2={600} y={301} kind="ref" label="RSI floor" labelBelow />
    <rect className="sgd-zone" x={330} y={301} width={54} height={12} />
    <circle className="sgd-dot" cx={392} cy={296} r={4} />
  </Diagram>
);

export const trendPullback: StrategyGuide = {
  tagline:
    "Buy momentum's dips: an RSI pullback-and-recovery inside a rising trend. Long only.",
  sections: [
    {
      heading: "The idea",
      body: (
        <p>
          In a healthy uptrend, dips are entries, not warnings. This strategy waits for a
          confirmed rising trend, lets the price pull back until short-term momentum (RSI)
          is washed out, and buys the moment momentum turns back up: buying the dip, not
          the peak.
        </p>
      ),
    },
    {
      heading: "The trend filter",
      body: (
        <p>
          A trade is only considered while the fast EMA is above the slow EMA and the slow
          EMA itself is rising (positive slope over the last 5 bars). Both conditions
          together mean the pullback is happening inside a trend that is still alive.
        </p>
      ),
    },
    {
      heading: "The pullback entry",
      body: (
        <>
          <p>
            Entry fires when RSI(14) was below the floor on the previous bar and is
            turning back up on this one. The dip supplied the discount; the turn supplies
            the timing.
          </p>
        </>
      ),
      diagram: pullbackDiagram,
    },
    {
      heading: "Stop, target, early exit",
      body: (
        <p>
          The bracket is volatility-sized: the stop sits an ATR(14) multiple below entry,
          and the target an R multiple of that stop distance above. If the fast EMA falls
          back below the slow EMA before either is hit, the trend is gone and the position
          exits early.
        </p>
      ),
    },
  ],
};
