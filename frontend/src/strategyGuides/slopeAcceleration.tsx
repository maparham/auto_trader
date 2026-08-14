// Illustrated guide for slope_acceleration.py (Slope Acceleration).

import { Diagram, Level, Marker } from "./diagram";
import type { StrategyGuide } from "./types";

const slopeDiagram = (
  <Diagram
    title="An EMA whose slope steepens between two measurement windows: entry when the slope is both above the minimum and accelerating, exit when it flattens"
    viewBox="0 0 640 250"
  >
    <text className="sgd-label" x={40} y={26}>
      long only: enter when the trend is accelerating, not merely present
    </text>
    {/* the EMA: rises, steepens, then flattens out */}
    <path
      className="sgd-line sgd-line--accent"
      d="M 40 205 C 120 198, 200 185, 280 158 C 340 136, 390 100, 440 78 C 490 58, 545 50, 600 48"
      fill="none"
    />
    {/* earlier window chord: shallow slope */}
    <line className="sgd-chord" x1={140} y1={195} x2={220} y2={181} />
    <text className="sgd-label" x={180} y={214} textAnchor="middle">
      slope one window earlier
    </text>
    {/* current window chord: visibly steeper */}
    <line className="sgd-chord" x1={330} y1={132} x2={410} y2={93} />
    <text className="sgd-label" x={310} y={122} textAnchor="end">
      <tspan x={310} dy={0}>slope now: above the minimum,</tspan>
      <tspan x={310} dy={14}>and steeper by more than the margin</tspan>
    </text>
    <Marker x={410} y={93} side="long" label="entry" />
    <Level x1={410} x2={600} y={135} kind="stop" label="ATR stop: disaster protection only" labelBelow />
    {/* the exit: slope fades */}
    <circle className="sgd-dot" cx={560} cy={49} r={5} />
    <text className="sgd-label sgd-label--strong" x={600} y={84} textAnchor="end">
      <tspan x={600} dy={0}>exit: slope fades</tspan>
      <tspan x={600} dy={14}>below the exit threshold</tspan>
    </text>
  </Diagram>
);

export const slopeAcceleration: StrategyGuide = {
  tagline:
    "Enter when the trend is accelerating, not merely present. Long only: the flattening slope, not a target, is the exit.",
  sections: [
    {
      heading: "The idea",
      body: (
        <p>
          A rising EMA says there is a trend; a rising EMA that is rising faster than
          before says the trend is gathering strength. This strategy only wants the second
          case. It measures the slope of the EMA (in percent per bar) over the last slope
          window, and compares it with the same slope one window earlier.
        </p>
      ),
    },
    {
      heading: "Slope and acceleration",
      body: (
        <>
          <p>
            Entry requires both conditions at once: the current slope is above the minimum
            slope, and it exceeds the earlier window's slope by more than the acceleration
            margin. A steady trend that is no longer speeding up does not qualify.
          </p>
        </>
      ),
      diagram: slopeDiagram,
    },
    {
      heading: "Exit and protection",
      body: (
        <>
          <p>
            There is no profit target: the position is held while the trend keeps its
            energy, and closed when the slope flattens below the exit threshold. An
            ATR(14) stop rides along underneath purely as disaster protection against a
            sudden reversal that is faster than the slope reading.
          </p>
        </>
      ),
    },
  ],
};
