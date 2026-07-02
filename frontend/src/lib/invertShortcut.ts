// TradingView's "invert scale" shortcut is Alt+I (Option+I on Mac). On macOS,
// Option+I is a DEAD KEY (circumflex accent): e.key comes through as "Dead",
// never "i" — so the match uses the physical e.code instead. Plain Alt only:
// Ctrl/Cmd/Shift chords belong to other shortcuts.
export function isInvertShortcut(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyI";
}
