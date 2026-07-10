import { BellIcon } from "../lib/menuIcons";
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
}

interface AlertTagsProps {
  tags: AlertTagItem[];
  priceTag: { y: number; countdown: string | null } | null;
  precision: number;
}

/**
 * On-chart alert axis tags: a small bell + level pill anchored to each active
 * alert's y position. Pure props-in — no state, no side effects.
 */
export default function AlertTags({ tags, priceTag, precision }: AlertTagsProps) {
  return (
    <>
      {tags.map((t) => {
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
        if (
          !t.selected &&
          priceTag &&
          Math.abs(t.y - priceTag.y) <= (priceTag.countdown ? 20 : 10) + 10
        ) {
          return null;
        }
        return (
        <div key={t.id} className={`alert-tag${t.selected ? " selected" : ""}`} style={{ top: t.y }} title="Price alert">
          {/* Inline SVG bell (currentColor → amber via .at-bell) so the tag stays in
              the monochrome SVG-icon language, not a colored 🔔 emoji. */}
          <span className="at-bell" aria-hidden="true">
            <BellIcon size={11} />
          </span>
          <span className="at-price">{t.level.toFixed(precision)}</span>
        </div>
        );
      })}
    </>
  );
}
