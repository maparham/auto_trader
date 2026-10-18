// The live-price pill and the bid/ask pills on the price axis.
//
// Their y moves on every frame of a zoom or pan (the eased price scale shifts
// the last close), and as ChartCore state each move committed the whole cell
// tree: legends, toolbar, every tooltip. The redraw loop now writes them into
// Signals, and only the components reading those signals re-render. Same idea
// as GoLivePill owning its own label.
import type { ReactNode } from "react";
import type { Signal } from "../lib/signals";
import { useSignalValue } from "../lib/signalHooks";
import { fmtPrice } from "../lib/priceFormat";
import { hexToRgba } from "../lib/lineStyle";
import type { BidAskStyle } from "../theme";

export type PriceTag = {
  y: number;
  price: number;
  countdown: string | null;
  w: number; // price-axis column width, so the pill fits inside it
  // Last candle's body direction, so the pill matches the dotted last-price
  // line's up/down color (TradingView keeps the line and its label one color).
  dir: "up" | "down";
} | null;
export type BaTag = { y: number; price: number; w: number } | null;

/** Render-prop bridge for children that take the price tag as a plain prop. */
export function WithPriceTag({ sig, children }: { sig: Signal<PriceTag>; children: (tag: PriceTag) => ReactNode }) {
  return <>{children(useSignalValue(sig))}</>;
}

interface Props {
  priceTag: Signal<PriceTag>;
  bidTag: Signal<BaTag>;
  askTag: Signal<BaTag>;
  live: boolean;
  lastPrice: number | null;
  precision: number;
  bidAskStyle: BidAskStyle;
}

export default function AxisPriceTags({ priceTag: priceSig, bidTag: bidSig, askTag: askSig, live, lastPrice, precision, bidAskStyle }: Props) {
  const priceTag = useSignalValue(priceSig);
  const bidTag = useSignalValue(bidSig);
  const askTag = useSignalValue(askSig);
  return (
    <>
      {priceTag && (
        <div
          className={`price-tag ${live ? `live ${priceTag.dir}` : "stale"}`}
          style={{ top: priceTag.y, width: priceTag.w }}
        >
          <span className="pt-price">
            {fmtPrice(lastPrice ?? priceTag.price, precision)}
          </span>
          {priceTag.countdown && <span className="pt-cd">{priceTag.countdown}</span>}
        </div>
      )}

      {/* Live ask (buy) and bid (sell) axis labels, TradingView two-tone: a solid
          colored side tag + the price on a light tint of the same color. Colors
          come from the global bid/ask style (labels stay opaque; opacity is for
          the lines only). */}
      {askTag && (
        <div className="ba-tag" style={{ top: askTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.askColor }}>Ask</span>
          <span
            className="ba-price"
            style={{ width: askTag.w, background: hexToRgba(bidAskStyle.askColor, 0.16), color: bidAskStyle.askColor }}
          >
            {fmtPrice(askTag.price, precision)}
          </span>
        </div>
      )}
      {bidTag && (
        <div className="ba-tag" style={{ top: bidTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.bidColor }}>Bid</span>
          <span
            className="ba-price"
            style={{ width: bidTag.w, background: hexToRgba(bidAskStyle.bidColor, 0.16), color: bidAskStyle.bidColor }}
          >
            {fmtPrice(bidTag.price, precision)}
          </span>
        </div>
      )}
    </>
  );
}
