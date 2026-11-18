import { createPortal } from "react-dom";
import ContextMenu from "../ContextMenu";
import { MenuIcons } from "../lib/menuIcons";
import { ago } from "../lib/timeFormat";

interface Props {
  x: number;
  y: number;
  onRearm: () => void;
  onHide: () => void;
  onClose: () => void;
}

/** Right-click menu of a fired alert's gray bell. Portaled: bells live in
 * .pane-clip, whose pointer-events:none and overflow:hidden would make the
 * menu dead and cut it off. */
export default function FiredAlertMenu({ x, y, onRearm, onHide, onClose }: Props) {
  return createPortal(
    <ContextMenu
      x={x}
      y={y}
      className="compact"
      onClose={onClose}
      items={[
        { label: "Re-arm", icon: MenuIcons.bell, onClick: onRearm },
        { label: "Hide", icon: MenuIcons.remove, onClick: onHide },
      ]}
    />,
    document.body,
  );
}

/** "Fired 2h ago", for a gray bell's tooltip and label. */
export function firedText(firedAt: number, now = Date.now()): string {
  return `Fired ${ago(firedAt, now)}`;
}
