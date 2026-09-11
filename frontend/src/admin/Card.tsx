import type { ReactNode } from "react";

/** One console panel: heading, optional controls, a last-refreshed stamp, and
 *  a body that shows either the error, the loading line, or the content. */
export default function Card({
  title,
  info,
  controls,
  stamp,
  loading,
  error,
  children,
}: {
  title: string;
  info?: ReactNode;
  controls?: ReactNode;
  stamp: number | null;
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <section className="admin-card">
      <header>
        <h2>{title}</h2>
        {info}
        {controls}
        <span className="stamp">
          {loading ? "loading" : stamp ? new Date(stamp).toLocaleTimeString() : ""}
        </span>
      </header>
      <div className="content">
        {error ? <div className="admin-error">{error}</div> : children}
      </div>
    </section>
  );
}
