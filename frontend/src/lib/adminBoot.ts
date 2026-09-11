// The admin console is a separate top-level screen reached at /admin. Pages
// and the vite dev server both serve index.html for unmatched paths, so this
// pathname check is the whole router.
export function shouldBootAdmin(pathname: string = window.location.pathname): boolean {
  return pathname.replace(/\/+$/, "") === "/admin";
}
