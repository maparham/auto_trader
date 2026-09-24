// The Costs tab: per-trade costs, the broker-prefilled instrument costs, and
// the reference-baselines toggle.
import InfoTip from "../components/InfoTip";
import NumberField from "../components/NumberField";
import Tooltip from "../components/Tooltip";
import type { CostProfile } from "../api";
import type { BacktestConfig, Costs, SlippageModel } from "../lib/backtestConfig";
import { Section } from "./Section";
import { blockNegKeys, clampPosOnBlur, cleanNumInput } from "./shared";
import type { useInstrumentCosts } from "./useInstrumentCosts";

type InstrumentCosts = ReturnType<typeof useInstrumentCosts>;

export function CostsSection({
  cfg,
  setCfg,
  setCosts,
  setInstrumentCost,
  refetchCosts,
  costProfile,
}: {
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setCosts: (patch: Partial<Costs>) => void;
  setInstrumentCost: InstrumentCosts["setInstrumentCost"];
  refetchCosts: InstrumentCosts["refetchCosts"];
  costProfile: CostProfile | null;
}) {
  return (
    <>
      <Section
        title="Costs"
        info="Per-trade assumptions applied to every fill: position size, commission, slippage, and the starting balance the equity curve builds from."
      >
        <div className="bt-costs-grid">
          <label className="bt-field">
            <span className="bt-field-label">
              Quantity
              <InfoTip text="Units bought or sold per trade." />
            </span>
            <input
              type="number"
              min={0}
              step="any"
              value={cfg.costs.quantity}
              onKeyDown={blockNegKeys}
              onChange={(e) => setCosts({ quantity: Number(cleanNumInput(e.currentTarget)) })}
              onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setCosts({ quantity: n }))}
            />
          </label>
          <label className="bt-field">
            <span className="bt-field-label">
              Commission/side
              <InfoTip text="Flat cost charged on each entry and each exit, so a round trip pays it twice." />
            </span>
            <input
              type="number"
              min={0}
              step="any"
              value={cfg.costs.commissionPerSide}
              onChange={(e) => setCosts({ commissionPerSide: Number(cleanNumInput(e.currentTarget)) })}
            />
          </label>
          {/* These fields carry an InfoTip button inside the label, which a
              wrapping <label> would associate with instead of the input, so
              they use a div + explicit aria-label on the control. */}
          <div className="bt-field">
            <span className="bt-field-label">
              Slippage
              <InfoTip text="Price penalty on every fill, in the instrument's price units: you buy a bit higher and sell a bit lower." />
            </span>
            <NumberField
              ariaLabel="Slippage"
              value={cfg.costs.slippage.value}
              onChange={(n) => setInstrumentCost({ slippage: { ...cfg.costs.slippage, value: n } })}
            />
          </div>
          <div className="bt-field">
            <span className="bt-field-label">
              Slippage model
              <InfoTip text="Fixed charges the same slippage on every fill. ATR-scaled adds a multiple of ATR(14) of the fill bar, so fast markets cost more." />
            </span>
            <select
              aria-label="Slippage model"
              value={cfg.costs.slippage.kind}
              onChange={(e) =>
                setInstrumentCost({ slippage: { ...cfg.costs.slippage, kind: e.currentTarget.value as SlippageModel["kind"] } })
              }
            >
              <option value="fixed">Fixed</option>
              <option value="atr">ATR-scaled</option>
            </select>
          </div>
          {cfg.costs.slippage.kind === "atr" && (
            <div className="bt-field">
              <span className="bt-field-label">
                x ATR
                <InfoTip text="Per-fill slippage is base + multiplier x ATR(14) of the bar, so fast markets cost more." />
              </span>
              <NumberField
                ariaLabel="Slippage ATR multiplier"
                value={cfg.costs.slippage.atrMult}
                onChange={(n) => setInstrumentCost({ slippage: { ...cfg.costs.slippage, atrMult: n } })}
              />
            </div>
          )}
          <label className="bt-field">
            <span className="bt-field-label">
              Starting cash
              <InfoTip text="Opening account balance the equity curve and return % build from." />
            </span>
            <input
              type="number"
              min={0}
              step="any"
              value={cfg.costs.startingCash}
              onKeyDown={blockNegKeys}
              onChange={(e) => setCosts({ startingCash: Number(cleanNumInput(e.currentTarget)) })}
              onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setCosts({ startingCash: n }))}
            />
          </label>

          {/* Instrument costs: broker-prefilled per-epic spread and financing.
              A full-width sub-heading and source note bracket the fields. */}
          <div className="bt-costs-subhead" style={{ gridColumn: "1 / -1" }}>
            Instrument costs
          </div>
          <div className="bt-field">
            <span className="bt-field-label">
              Spread
              <InfoTip text="Full bid/ask spread in price units. Buys fill half a spread above the mid, sells half below." />
            </span>
            <NumberField
              ariaLabel="Spread"
              value={cfg.costs.spread}
              onChange={(n) => setInstrumentCost({ spread: n })}
            />
          </div>
          <div className="bt-field">
            <span className="bt-field-label">
              Long %/night
              <InfoTip text="Charged per night a position is held (21:00 UTC rollover), as a percent of entry notional. Positive is a cost, negative a credit. Enter your broker's rate; fees are not fetched automatically." />
            </span>
            <NumberField
              ariaLabel="Long %/night"
              signed
              value={cfg.costs.finLongDailyPct}
              onChange={(n) => setInstrumentCost({ finLongDailyPct: n })}
            />
          </div>
          <div className="bt-field">
            <span className="bt-field-label">
              Short %/night
              <InfoTip text="Charged per night a position is held (21:00 UTC rollover), as a percent of entry notional. Positive is a cost, negative a credit. Enter your broker's rate; fees are not fetched automatically." />
            </span>
            <NumberField
              ariaLabel="Short %/night"
              signed
              value={cfg.costs.finShortDailyPct}
              onChange={(n) => setInstrumentCost({ finShortDailyPct: n })}
            />
          </div>
          <div className="bt-costs-source" style={{ gridColumn: "1 / -1" }}>
            <span className="bt-costs-source-note">
              {costProfile?.source === "broker" ? "from broker quote" : "manual"}
            </span>
            <Tooltip content="Refetch spread from the broker">
              <button type="button" className="icon-btn bt-costs-refetch" aria-label="Refetch from broker" onClick={refetchCosts}>
                ↻
              </button>
            </Tooltip>
          </div>
        </div>
      </Section>

      {/* Baselines ride the Costs pane rather than a tab of their own: they
          are a per-run option, and the toggle is one row. Off by default
          because every kind is another full engine pass over the window. */}
      <Section
        title="Baselines"
        info={[
          "Optional reference runs over the same window and costs, shown under the results so the strategy can be read against them.",
          "Single runs only. Walk-forward folds always score against their own fold baselines, whatever this is set to.",
        ]}
      >
        <label className="al-row bt-mask-toggle">
          <input
            type="checkbox"
            checked={cfg.runBaselines === true}
            // Never store `false`: backtestConfigEquals compares an absent
            // optional field unequal to a present one, so writing the flag
            // off would mark every preset saved before this dirty. Off
            // deletes the key instead.
            onChange={(e) => setCfg({ ...cfg, runBaselines: e.target.checked ? true : undefined })}
          />
          <span>Run reference baselines</span>
          <InfoTip
            text={[
              "Reference runs the result is compared against: always-in, buy and hold, the reversed strategy, and hindsight-corrected entries.",
              "Off by default: each one is another full pass over the window, so the run takes longer.",
            ]}
          />
        </label>
      </Section>
    </>
  );
}
