import { CANDLE_FIELDS, INDICATORS, WRAPPERS, CROSSES, TIMEFRAMES } from "../lib/expr/catalog";
import Tooltip from "./Tooltip";

export default function RulePalette({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div className="rule-palette">
      {/* Candle section */}
      <div className="rule-palette-group">
        <h3>Candle</h3>
        <div className="rule-palette-items">
          {CANDLE_FIELDS.map((field) => (
            <button
              key={field}
              onClick={() => onInsert(`candle.${field}`)}
            >
              {field}
            </button>
          ))}
        </div>
      </div>

      {/* Indicators section */}
      <div className="rule-palette-group">
        <h3>Indicators</h3>
        <div className="rule-palette-items">
          {INDICATORS.map((entry) => (
            <Tooltip key={entry.name} content={entry.detail}>
              <button
                onClick={() => onInsert(entry.insert)}
              >
                {entry.signature}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Wrappers section */}
      <div className="rule-palette-group">
        <h3>Wrappers</h3>
        <div className="rule-palette-items">
          {WRAPPERS.map((entry) => (
            <Tooltip key={entry.name} content={entry.detail}>
              <button
                onClick={() => onInsert(entry.insert)}
              >
                {entry.signature}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Crosses section */}
      <div className="rule-palette-group">
        <h3>Crosses</h3>
        <div className="rule-palette-items">
          {CROSSES.map((entry) => (
            <Tooltip key={entry.name} content={entry.detail}>
              <button
                onClick={() => onInsert(entry.insert)}
              >
                {entry.signature}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Timeframes section */}
      <div className="rule-palette-group">
        <h3>Timeframes</h3>
        <div className="rule-palette-items">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.alias}
              onClick={() => onInsert(`@${tf.alias}`)}
            >
              {tf.alias}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
