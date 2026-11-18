import { useState } from "react";
import { createPortal } from "react-dom";
import ContextMenu from "../ContextMenu";
import Tooltip from "../components/Tooltip";
import { BellIcon, MenuIcons } from "../lib/menuIcons";
import FiredAlertMenu from "./FiredAlertMenu";
import { firedText } from "../lib/timeFormat";

// An alert's bell on the curve it watches, just past the last bar, not on the
// axis: a frozen-trendline (`line`) alert's dashed line, or the indicator line
// of a "price crosses the curve" indicator alert (`indicator`).
// A type alias, not an interface: stableArray needs the implicit index signature.
// `firedAt` marks a fired "once" alert shown from History (a gray bell).
export type AlertCurveBellTag = { id: string; x: number; y: number; kind: "line" | "indicator"; firedAt?: number };

const LABEL = { line: "Trendline alert", indicator: "Indicator alert" } as const;

interface Props {
  bells: AlertCurveBellTag[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRearm?: (id: string) => void;
  onHide?: (id: string) => void;
}

/**
 * On-chart bells for trendline and indicator-curve alerts, at the end of the
 * curve the alert watches rather than on the price axis. A double click opens the edit
 * dialog; a right click opens an Edit / Delete menu. Pure props-in, like
 * AlertTags.
 */
export default function AlertCurveBells({ bells, onEdit, onDelete, onRearm, onHide }: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; fired: boolean } | null>(null);
  return (
    <>
      {bells.map((b) => {
        const fired = b.firedAt != null;
        // A fired bell re-arms where a live one edits.
        const act = (id: string) => (fired ? onRearm?.(id) : onEdit(id));
        const label = fired ? `${LABEL[b.kind]}, ${firedText(b.firedAt!).toLowerCase()}` : LABEL[b.kind];
        return (
          <Tooltip
            key={b.id}
            asChild
            content={fired ? [LABEL[b.kind], firedText(b.firedAt!), "Double click to re-arm"] : LABEL[b.kind]}
          >
            <button
              type="button"
              className={`tl-alert-bell${fired ? " fired" : ""}`}
              style={{ left: b.x, top: b.y }}
              aria-label={label}
              // Enter/Space on the focused bell (a click with no pointer
              // detail) acts too; a mouse acts on double click only.
              onClick={(e) => {
                if (e.detail === 0) act(b.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                act(b.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ id: b.id, x: e.clientX, y: e.clientY, fired });
              }}
            >
              <BellIcon size={13} />
            </button>
          </Tooltip>
        );
      })}
      {menu?.fired && (
        <FiredAlertMenu
          x={menu.x}
          y={menu.y}
          onRearm={() => onRearm?.(menu.id)}
          onHide={() => onHide?.(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
      {/* Portaled: the bells live in .pane-clip, whose pointer-events:none
          and overflow:hidden would make the menu dead and cut it off. */}
      {menu && !menu.fired && createPortal(
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
