// WKWebView (the Tauri shell) treats Backspace, the Mac "Delete" key, as
// history back when focus is outside a text field. The shell's Reload pushes a
// splash entry ahead of the app, so going back reloads an older copy of the
// app. Swallow that default everywhere text editing doesn't need it.
//
// Registered on window, in the bubble phase, so it runs AFTER every document
// and element handler: the chart's Delete handlers bail on defaultPrevented,
// and running first would stop them deleting the selected drawing.

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true;
}

export function onBackspaceKeydown(e: KeyboardEvent): void {
  if (e.key !== "Backspace" || e.defaultPrevented) return;
  if (isEditableTarget(e.target)) return;
  e.preventDefault();
}

export function installBackspaceGuard(target: Window = window): () => void {
  target.addEventListener("keydown", onBackspaceKeydown);
  return () => target.removeEventListener("keydown", onBackspaceKeydown);
}
