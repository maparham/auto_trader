// Pure text helpers for the Assistant panel: the reply's block structure
// (paragraphs and lists) and the collapsed "Changed" labels.

export type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•·]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/** Split a reply into paragraphs and bullet/numbered lists. A list item
 * starts at a "- ", "• ", "· " or "1. " line; a blank line ends a block. */
export function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const last = blocks[blocks.length - 1];
    if (!line.trim()) { blocks.push({ kind: "p", lines: [] }); continue; }
    const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
    if (kind) {
      const item = line.replace(kind === "ul" ? BULLET : NUMBERED, "");
      if (last?.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (last?.kind === "p") last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : true));
}

/** Collapse runs of identical change labels: two "Drew a ray" read as
 * "Drew 2 rays", anything else as "label (×2)". */
export function collapseLabels(labels: string[]): string[] {
  const out: { label: string; n: number }[] = [];
  for (const l of labels) {
    const last = out[out.length - 1];
    if (last?.label === l) last.n++;
    else out.push({ label: l, n: 1 });
  }
  return out.map(({ label, n }) => {
    if (n === 1) return label;
    const m = /^(Drew|Removed) an? (.+)$/.exec(label);
    return m ? `${m[1]} ${n} ${m[2]}s` : `${label} (×${n})`;
  });
}
