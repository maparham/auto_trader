// The one place a REPLAY timestamp becomes a label.
//
// A blind session's whole promise is that nothing on screen says WHEN it is —
// and the report card's date reveal is the single, deliberate exception to that.
// Which means the masked label and the real one are a matched pair: the reveal
// is the user's only chance to reconcile "Day 4 09:30" with a real moment, and
// it can only do that if both were extracted from the same fields, in the same
// zone, through the same template.
//
// They used to be two hand-built formatters sitting next to each other in
// ChartCore, which made that pairing a convention rather than a fact: the
// options could drift field by field, and — worse — the card could be handed the
// MASKED formatter by a one-word edit at its call site and go on rendering
// "Day 4 09:30 to Day 4 15:30" with every test still green. Building both here,
// from one input, is what makes the pairing structural, and what gives it a seam
// small enough to unit-test (replayFormat.test.ts asserts that `real` really is
// a real date and `cursor` really is masked).
import { browserTimezone } from "../chart/chartPainters";
import { makeFormatDate, makeMaskedFormatDate, type Clock, type DateFormat } from "./timeFormat";

// The template klinecharts hands its own formatDate for a crosshair label. Ours
// mirror it so a replay label reads exactly like the axis label above it.
const TEMPLATE = "YYYY-MM-DD HH:mm";

// The fields makeFormatDate / makeMaskedFormatDate extract from. Mirrors the dtf
// klinecharts constructs internally (same options), so our labels and the
// chart's own agree.
const DTF_OPTS: Intl.DateTimeFormatOptions = {
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

export interface ReplayFormatterOpts {
  clock: Clock;
  dateFormat: DateFormat;
  showWeekday: boolean;
  /** IANA zone; "" means browser local. */
  timezone: string;
  /** The session anchor a MASKED session counts "Day N" from, or null when the
   * session shows real dates (unmasked, or no session at all). */
  maskAnchorMs: number | null;
}

export interface ReplayFormatters {
  /** In-session labels: the pill's cursor readout and the ticket's "return to".
   * MASKED whenever the session is, so neither can be the thing that leaks. */
  cursor(ms: number): string;
  /** The report card's date reveal. ALWAYS a real date, even for a masked
   * session: unmasking is the entire point of the card. */
  real(ms: number): string;
}

export function makeReplayFormatters(o: ReplayFormatterOpts): ReplayFormatters {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en", { ...DTF_OPTS, timeZone: o.timezone || browserTimezone() });
  } catch {
    // An invalid saved timezone makes the constructor throw. Degrade to empty
    // labels rather than taking the whole cell down with it — a session with no
    // readout is recoverable, a crashed chart is not. Empty is also the SAFE
    // direction: it can only ever say less about when the session is.
    const blank = () => "";
    return { cursor: blank, real: blank };
  }
  const real = makeFormatDate(o.clock, o.dateFormat, o.showWeekday);
  const masked = o.maskAnchorMs != null ? makeMaskedFormatDate(o.maskAnchorMs, o.clock) : null;
  const apply = (fmt: ReturnType<typeof makeFormatDate>, ms: number) =>
    fmt({ dateTimeFormat: dtf, timestamp: ms, template: TEMPLATE, type: "crosshair" });
  return {
    cursor: (ms: number) => apply(masked ?? real, ms),
    real: (ms: number) => apply(real, ms),
  };
}
