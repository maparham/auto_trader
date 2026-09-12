import {
  exitImpersonation,
  impersonatedEmail,
  impersonatedUserId,
} from "../lib/impersonation";

/** Pinned across the top while an admin is viewing the app as another user.
 *  Pure client state on purpose: is_admin is false for the duration, so
 *  /api/admin/* refuses this session and the exit cannot ask the server. */
export default function ImpersonationBanner() {
  const id = impersonatedUserId();
  if (!id) return null;
  const who = impersonatedEmail() ?? id;
  return (
    <div className="impersonation-banner" role="status">
      <span>
        Viewing as <strong>{who}</strong>, read-only
      </span>
      <button type="button" onClick={() => exitImpersonation()}>
        Exit
      </button>
    </div>
  );
}
