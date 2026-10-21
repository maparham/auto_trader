import { useState } from "react";
import { createPortal } from "react-dom";
import ContextMenu from "../ContextMenu";
import Tooltip from "../components/Tooltip";
import { BellIcon, MenuIcons } from "../lib/menuIcons";

// A frozen-trendline (`line`) alert's bell, on its line just past the last
// bar, not on the axis.
// A type alias, not an interface: stableArray needs the implicit index signature.
export type LineAlertBellTag = { id: string; x: number; y: number };

interface Props {
  bells: LineAlertBellTag[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * On-chart bells for frozen-trendline alerts, at the end of the alert's
 * dashed line rather than on the price axis. A double click opens the edit
 * dialog; a right click opens an Edit / Delete menu. Pure props-in, like
 * AlertTags.
 */
export default function TrendlineAlertBells({ bells, onEdit, onDelete }: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
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
