// Instrument icon: the real Capital.com logo where it exists, falling back to a
// colored letter-glyph (the epic's first character) otherwise.
//
// Coverage is partial (popular instruments hit; the long tail misses), so misses
// are the norm, not an exception. Three things keep that from becoming a request
// flood / broken-image mess on a 4000-row catalogue:
//   - loading="lazy": only near-viewport rows ever fetch.
//   - candidate paths (feed.logoCandidates): stocks live on two CDN paths; we try
//     them in order and only fall back to the glyph after the LAST one fails.
//   - a module-level failed-epic Set: a known miss renders the glyph with zero
//     requests on re-scroll / re-open (S3's 403s carry no cache-control, so the
//     browser won't dedupe them — this Set is what prevents the refetch).

import { useState } from "react";
import { logoCandidates } from "./lib/feed";

// Epics whose every candidate URL has already 404/403'd this session.
const failedEpics = new Set<string>();

interface Props {
  epic: string;
  type?: string | null;
  className?: string; // wrapper class (e.g. "ss-icon" for the modal row)
}

export default function SymbolIcon({ epic, type, className = "ss-icon" }: Props) {
  const candidates = logoCandidates(epic, type);
  // Index of the candidate URL we're currently trying. Past the end = give up.
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // Reset when the symbol changes (component reused for a new epic).
  const [shownEpic, setShownEpic] = useState(epic);
  if (shownEpic !== epic) {
    setShownEpic(epic);
    setIdx(0);
    setLoaded(false);
  }

  const giveUp = failedEpics.has(epic) || idx >= candidates.length;

  return (
    <span className={className} aria-hidden="true">
      {/* Glyph base layer: always present, covered by the logo once it loads. */}
      {!loaded && <span className={`${className}-glyph`}>{epic.slice(0, 1)}</span>}
      {!giveUp && (
        <img
          className={`${className}-img`}
          src={candidates[idx]}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            // Try the next candidate path; only give up (and cache the miss)
            // once every candidate has failed.
            if (idx + 1 < candidates.length) {
              setIdx(idx + 1);
            } else {
              failedEpics.add(epic);
              setIdx(idx + 1); // -> giveUp, glyph stays
            }
          }}
        />
      )}
    </span>
  );
}
