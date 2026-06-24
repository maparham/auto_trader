// Shared timezone catalogue + offset formatting, used by the app Settings modal
// (chart axis timezone) and the Prev HL indicator's per-instance timezone override.
// Kept out of a component file so Fast Refresh stays happy (react-refresh wants
// component modules to export only components).

// Curated TradingView-style timezone list. "" follows the browser's local zone.
export const TIMEZONES: { value: string; label: string }[] = [
  { value: "", label: "Browser time" },
  { value: "UTC", label: "UTC" },
  { value: "Pacific/Honolulu", label: "Honolulu" },
  { value: "America/Anchorage", label: "Anchorage" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Athens", label: "Athens" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Tehran", label: "Tehran" },
  { value: "Asia/Kolkata", label: "Kolkata" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Asia/Hong_Kong", label: "Hong Kong" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
];

// Current UTC offset of a zone, formatted "+05:30" (DST-aware), e.g. "(UTC+09:00)".
// Empty string for "Browser time" (its offset is whatever the local zone is).
export function offsetLabel(tz: string): string {
  if (!tz) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // longOffset yields "GMT+9" / "GMT+05:30" / "GMT" (UTC) — normalize.
    if (name === "GMT") return "(UTC)";
    return `(${name.replace("GMT", "UTC")})`;
  } catch {
    return "";
  }
}
