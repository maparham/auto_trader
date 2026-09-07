// Which built-in ChartCore chrome the mobile compact mode suppresses (spec §2).
export interface CompactHides {
  rangeBar: boolean;
  replay: boolean;
  detachedPill: boolean;
  cacheStats: boolean;
}

export function compactHides(compact: boolean | undefined): CompactHides {
  const on = compact === true;
  return { rangeBar: on, replay: on, detachedPill: on, cacheStats: on };
}
