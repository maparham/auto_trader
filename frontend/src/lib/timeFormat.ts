// Time-axis timestamp formatting for the chart.
//
// klinecharts has no `styles.xAxis` date-format field; the only lever is
// `chart.setCustomApi({ formatDate })`. The library calls formatDate with a
// small set of canonical format strings depending on zoom granularity:
//   XAxis:     'HH:mm' | 'MM-DD' | 'YYYY-MM' | 'YYYY' | 'YYYY-MM-DD HH:mm'
//   Crosshair: 'YYYY-MM-DD HH:mm'   (the label riding the time axis on hover)
//   Tooltip:   'YYYY-MM-DD HH:mm'   (OHLC tooltip)
// We re-render those buckets per the user's clock + date-format choice, applying
// to every type so the hover label stays consistent with the ticks.
//
// The library's tick-granularity boundary detection compares formatDate()
// outputs for equality (e.g. does this tick's year differ from the previous
// tick's), so this stays correct as long as output is a pure function of
// (timestamp, format) — which it is. The default preset (24h + Y-M-D) is
// byte-for-byte identical to klinecharts' built-in formatter.

export type Clock = "24h" | "12h";
// ymd/dmy/mdy = numeric orders; med = textual "Jul 10 '26". An optional weekday
// prefix ("Fri …") is orthogonal — see makeFormatDate's showWeekday.
export type DateFormat = "ymd" | "dmy" | "mdy" | "med";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Parts {
  YYYY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  ss: string;
}

// Mirrors klinecharts' built-in part extraction (incl. the hour '24' -> '00'
// quirk from Intl.DateTimeFormat with hour12:false).
function extract(dtf: Intl.DateTimeFormat, ts: number): Parts {
  const p: Parts = { YYYY: "", MM: "", DD: "", HH: "", mm: "", ss: "" };
  for (const { type, value } of dtf.formatToParts(new Date(ts))) {
    switch (type) {
      case "year":
        p.YYYY = value;
        break;
      case "month":
        p.MM = value;
        break;
      case "day":
        p.DD = value;
        break;
      case "hour":
        p.HH = value === "24" ? "00" : value;
        break;
      case "minute":
        p.mm = value;
        break;
      case "second":
        p.ss = value;
        break;
    }
  }
  return p;
}

// Weekday abbreviation for the date Y/M/D resolve to. They're already in the
// axis timezone, so UTC-midnight of that date gives the right weekday.
function weekday(p: Parts): string {
  return WEEKDAYS[new Date(Date.UTC(+p.YYYY, +p.MM - 1, +p.DD)).getUTCDay()];
}

function renderDate(p: Parts, fmt: string, format: DateFormat, showWeekday: boolean): string {
  const wantY = fmt.includes("YYYY");
  const wantM = fmt.includes("MM");
  const wantD = fmt.includes("DD");
  if (!wantY && !wantM && !wantD) return "";
  // Weekday only makes sense at day granularity (not month/year ticks). When on,
  // it prefixes every format the same way ("Fri 2026-07-10", "Fri Jul 10 '26").
  const wd = showWeekday && wantD ? `${weekday(p)} ` : "";
  if (format === "med") {
    // Textual order — by granularity bucket: day -> "Jul 10", month -> "Jul '26",
    // year -> "2026". Weekday prefix (when on) makes day -> "Fri Jul 10".
    const mon = MONTHS[+p.MM - 1] ?? p.MM;
    const yr = `'${p.YYYY.slice(-2)}`;
    if (wantD) {
      const day = `${mon} ${+p.DD}`;
      return wd + (wantY ? `${day} ${yr}` : day);
    }
    if (wantM) return `${mon} ${yr}`;
    return p.YYYY;
  }
  if (format === "ymd") {
    // Hyphen-joined ISO order — matches klinecharts' default exactly (weekday off).
    return wd + [wantY && p.YYYY, wantM && p.MM, wantD && p.DD].filter(Boolean).join("-");
  }
  const seq =
    format === "dmy"
      ? [wantD && p.DD, wantM && p.MM, wantY && p.YYYY]
      : [wantM && p.MM, wantD && p.DD, wantY && p.YYYY];
  return wd + seq.filter(Boolean).join("/");
}

function renderTime(p: Parts, fmt: string, clock: Clock): string {
  if (!fmt.includes("HH")) return "";
  const withSec = fmt.includes("ss");
  if (clock === "24h") {
    return withSec ? `${p.HH}:${p.mm}:${p.ss}` : `${p.HH}:${p.mm}`;
  }
  const h24 = parseInt(p.HH, 10);
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const base = withSec ? `${h12}:${p.mm}:${p.ss}` : `${h12}:${p.mm}`;
  return `${base} ${suffix}`;
}

// Builds a klinecharts FormatDate function for the chosen clock + date format.
export function makeFormatDate(clock: Clock, format: DateFormat, showWeekday = false) {
  return (dtf: Intl.DateTimeFormat, ts: number, fmt: string): string => {
    const p = extract(dtf, ts);
    const date = renderDate(p, fmt, format, showWeekday);
    const time = renderTime(p, fmt, clock);
    return date && time ? `${date} ${time}` : date || time;
  };
}
