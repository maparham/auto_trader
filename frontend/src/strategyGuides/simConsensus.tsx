// Illustrated guide for sim_consensus.py (Simulated Consensus).

import { Diagram, Level, Marker } from "./diagram";
import type { StrategyGuide } from "./types";

const CHIP = 30;
const chipXs = [60, 140, 220, 300, 380, 460];
const results: Array<"win" | "loss"> = ["win", "loss", "win", "win", "loss", "win"];

const recordDiagram = (
  <Diagram
    title="A running record of simulated one-to-one longs; the last three completed decide the direction of the next real trade"
    viewBox="0 0 640 200"
  >
    <text className="sgd-label" x={40} y={26}>
      simulated 1:1 longs, replayed in the background
    </text>
    {chipXs.map((cx, i) => (
      <g key={cx}>
        <rect
          className={`sgd-chip sgd-chip--${results[i]}`}
          x={cx - CHIP / 2}
          y={66 - CHIP / 2}
          width={CHIP}
          height={CHIP}
          rx={6}
        />
        <text
          className={`sgd-glyph sgd-glyph--${results[i]}`}
          x={cx}
          y={71}
          textAnchor="middle"
        >
          {results[i] === "win" ? "✓" : "✕"}
        </text>
        <text className="sgd-label" x={cx} y={100} textAnchor="middle">
          {results[i]}
        </text>
      </g>
    ))}
    <rect className="sgd-window" x={276} y={42} width={208} height={68} rx={10} />
    <text className="sgd-label sgd-label--strong" x={380} y={36} textAnchor="middle">
      the last 3: 2 wins
    </text>
    <line className="sgd-arrow" x1={380} y1={112} x2={380} y2={142} />
    <Marker x={380} y={154} side="long" />
    <text className="sgd-label sgd-label--strong" x={396} y={158}>
      open a real long (at least 2 of the last 3 won)
    </text>
    <text className="sgd-label" x={40} y={190}>
      fewer than 2 wins: open a real short instead
    </text>
  </Diagram>
);

const bracketDiagram = (
  <Diagram
    title="The real trade is bracketed one-to-one around its entry: equal stop and target distances"
    viewBox="0 0 640 180"
  >
    <text className="sgd-label" x={40} y={26}>
      real trades chain back to back; the simulated record keeps updating underneath
    </text>
    <polyline className="sgd-price" points="120,112 155,104 178,100 200,98 250,90 300,80 350,72 395,60" />
    <Marker x={200} y={98} side="long" />
    <Level x1={200} x2={600} y={98} kind="entry" label="entry: close of the bar that resolved the last sim" />
    <Level x1={200} x2={600} y={58} kind="target" label="target: real target % above entry" />
    <Level x1={200} x2={600} y={138} kind="stop" label="stop: real stop % below entry" labelBelow />
    <line className="sgd-span" x1={612} y1={58} x2={612} y2={98} />
    <line className="sgd-span" x1={612} y1={98} x2={612} y2={138} />
    <text className="sgd-label" x={620} y={80}>=</text>
    <text className="sgd-label" x={620} y={122}>=</text>
  </Diagram>
);

export const simConsensus: StrategyGuide = {
  tagline:
    "Warm up on simulated longs, then trade with the recent consensus: if the market has been rewarding longs lately, go long; if not, go short.",
  sections: [
    {
      heading: "The idea",
      body: (
        <p>
          Instead of reading indicators, this strategy asks a blunt question: would a
          simple long have worked here recently? It continuously replays simulated 1:1
          longs on the price history and lets their win/loss record vote on the direction
          of the next real trade.
        </p>
      ),
    },
    {
      heading: "The simulated record",
      body: (
        <>
          <p>
            Each simulated long enters at a bar close and wins when the target (+1% by
            default) is reached before the stop (-1%); a bar that touches both counts as a
            loss. The moment one simulated long resolves, the next opens at the close of
            the resolving bar, so the record never has gaps.
          </p>
        </>
      ),
      diagram: recordDiagram,
    },
    {
      heading: "The real trade",
      body: (
        <>
          <p>
            Once at least 3 simulated longs have completed and the strategy is flat, it
            takes a position: a real long if at least 2 of the last 3 simulations won,
            otherwise a real short. The real trade is bracketed around its entry with its
            own stop and target percentages (1:1 by default).
          </p>
          <p>
            Simulated longs keep running in the background the whole time, so real trades
            chain back to back, each one decided by a fresh last-3 record.
          </p>
        </>
      ),
      diagram: bracketDiagram,
    },
  ],
};
