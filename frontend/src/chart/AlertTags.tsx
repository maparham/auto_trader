import { useState } from "react";
import Tooltip from "../components/Tooltip";
import FiredAlertMenu from "./FiredAlertMenu";
import { firedText } from "../lib/timeFormat";
import { BellIcon } from "../lib/menuIcons";
import { fmtPrice } from "../lib/priceFormat";
import type { AlertCondition, AlertTrigger } from "../lib/persist";

export interface AlertTagItem {
  id: string;
  y: number;
  level: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  expiresAt: number | null;
  hovered: boolean;
  active: boolean;
  selected: boolean;
  /** A fired "once" alert shown from History: a gray tag that re-arms. */
  firedAt?: number;
}

interface AlertTagsProps {
  tags: AlertTagItem[];
  priceTag: { y: number; countdown: string | null; w?: number } | null;
  precision: number;
  /** Price-axis column width: a fired tag fills it, its bell sits just outside. */
  axisW?: number;
  onRearm?: (id: string) => void;
  onHide?: (id: string) => void;
}

/** True when a tag at `y` would overlap the live price pill: half the pill
 *  (20px with countdown, else 10) plus half an alert tag (10). */
function overlapsPrice(y: number, priceTag: { y: number; countdown: string | null }): boolean {
  return Math.abs(y - priceTag.y) <= (priceTag.countdown ? 20 : 10) + 10;
}

/**
 * On-chart alert axis tags: a small bell + level pill anchored to each active
 * alert's y position. Pure props-in — no state, no side effects.
 */
export default function AlertTags({ tags, priceTag, precision, axisW, onRearm, onHide }: AlertTagsProps) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  return (
    <>
      {tags.map((t) => {
        // A fired tag sits where the price crossed it, which is usually the
        // live-price row. Its level fills the axis column (under the price pill
        // there, which shows that price anyway) and its bell always sits just
        // outside the axis, so the bell stays visible and never jumps.
        if (t.firedAt != null) {
          return (
            <div key={t.id} className="alert-tag fired" style={{ top: t.y, width: axisW || undefined }}>
              {/* Only the bell takes the mouse, so the rest of the tag never
                  blocks a drag on the price axis. */}
              <Tooltip asChild content={["Price alert", firedText(t.firedAt), "Double click to re-arm"]}>
                <span
                  className="at-bell"
                  role="button"
                  tabIndex={0}
                  aria-label={`Price alert, ${firedText(t.firedAt).toLowerCase()}`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onRearm?.(t.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRearm?.(t.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ id: t.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <BellIcon size={11} />
                </span>
              </Tooltip>
              <span className="at-price">{fmtPrice(t.level, precision)}</span>
            </div>
          );
        }
        // Hide an alert's axis tag when it shares the live-price row and isn't
        // selected: the live price pill owns that row on hover/idle. The alert tag
        // is WIDER than the price pill (its bell protrudes left), so even at a lower
        // z-index its left edge shows past the pill and reads as overlapping it. This
        // is the counterpart to redraw()'s rule that hides the price pill when an
        // alert IS selected on that row — together: not-selected ⇒ price wins the row,
        // selected ⇒ the alert wins it. (When the alert is selected and overlaps,
        // priceTag is already null, so the band test below is moot.) The band matches
        // redraw's priceObscured: half the price pill (40px with countdown, else 20)
        // plus half an alert tag (10).
        if (!t.selected && priceTag && overlapsPrice(t.y, priceTag)) {
          return null;
        }
        return (
          <Tooltip key={t.id} asChild content="Price alert">
            <div className={`alert-tag${t.selected ? " selected" : ""}`} style={{ top: t.y }}>
              {/* Inline SVG bell (currentColor → amber via .at-bell) so the tag stays in
                  the monochrome SVG-icon language, not a colored 🔔 emoji. */}
              <span className="at-bell" aria-hidden="true">
                <BellIcon size={11} />
              </span>
              <span className="at-price">{fmtPrice(t.level, precision)}</span>
            </div>
          </Tooltip>
        );
      })}
      {menu && (
        <FiredAlertMenu
          x={menu.x}
          y={menu.y}
          onRearm={() => onRearm?.(menu.id)}
          onHide={() => onHide?.(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
