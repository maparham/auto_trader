import Tooltip from "../components/Tooltip";
import { BellIcon } from "../lib/menuIcons";

// A frozen-trendline (`line`) alert's bell, on its line just past the last
// bar, not on the axis.
// A type alias, not an interface: stableArray needs the implicit index signature.
export type LineAlertBellTag = { id: string; x: number; y: number };

interface Props {
  bells: LineAlertBellTag[];
  onDoubleClick: (id: string) => void;
}

/**
 * On-chart bells for frozen-trendline alerts, at the end of the alert's
 * dashed line rather than on the price axis. A double click opens the edit
 * dialog. Pure props-in, like AlertTags.
 */
export default function TrendlineAlertBells({ bells, onDoubleClick }: Props) {
  return (
    <>
      {bells.map((b) => (
        <Tooltip key={b.id} asChild content="Trendline alert">
          <button
            type="button"
            className="tl-alert-bell"
            style={{ left: b.x, top: b.y }}
            aria-label="Trendline alert"
            // Enter/Space on the focused bell (a click with no pointer
            // detail) edits too; a mouse edits on double click only.
            onClick={(e) => {
              if (e.detail === 0) onDoubleClick(b.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onDoubleClick(b.id);
            }}
          >
            <BellIcon size={13} />
          </button>
        </Tooltip>
      ))}
    </>
  );
}
