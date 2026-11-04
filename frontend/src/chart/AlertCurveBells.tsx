import { useState } from "react";
import { createPortal } from "react-dom";
import ContextMenu from "../ContextMenu";
import Tooltip from "../components/Tooltip";
import { BellIcon, MenuIcons } from "../lib/menuIcons";

// An alert's bell on the curve it watches, just past the last bar, not on the
// axis: a frozen-trendline (`line`) alert's dashed line, or the indicator line
// of a "price crosses the curve" indicator alert (`indicator`).
// A type alias, not an interface: stableArray needs the implicit index signature.
export type AlertCurveBellTag = { id: string; x: number; y: number; kind: "line" | "indicator" };

const LABEL = { line: "Trendline alert", indicator: "Indicator alert" } as const;

interface Props {
  bells: AlertCurveBellTag[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * On-chart bells for trendline and indicator-curve alerts, at the end of the
 * curve the alert watches rather than on the price axis. A double click opens the edit
 * dialog; a right click opens an Edit / Delete menu. Pure props-in, like
 * AlertTags.
 */
export default function AlertCurveBells({ bells, onEdit, onDelete }: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  return (
    <>
      {bells.map((b) => (
        <Tooltip key={b.id} asChild content={LABEL[b.kind]}>
          <button
            type="button"
            className="tl-alert-bell"
            style={{ left: b.x, top: b.y }}
            aria-label={LABEL[b.kind]}
            // Enter/Space on the focused bell (a click with no pointer
            // detail) edits too; a mouse edits on double click only.
            onClick={(e) => {
              if (e.detail === 0) onEdit(b.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEdit(b.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ id: b.id, x: e.clientX, y: e.clientY });
            }}
          >
            <BellIcon size={13} />
          </button>
        </Tooltip>
      ))}
      {/* Portaled: the bells live in .pane-clip, whose pointer-events:none
          and overflow:hidden would make the menu dead and cut it off. */}
      {menu && createPortal(
        <ContextMenu
          x={menu.x}
          y={menu.y}
          className="compact"
          onClose={() => setMenu(null)}
          items={[
            { label: "Edit", icon: MenuIcons.pencil, onClick: () => onEdit(menu.id) },
            { label: "Delete", icon: MenuIcons.remove, danger: true, onClick: () => onDelete(menu.id) },
          ]}
        />,
        document.body,
      )}
    </>
  );
}
