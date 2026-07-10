// Pure resolution of an "Expires" dropdown choice into an epoch-ms timestamp
// (or null = Good-Till-Cancelled). Relative durations resolve against a passed-in
// `nowMs` so this stays deterministic and testable; the caller passes Date.now().

export type ExpiryUnit = "minutes" | "hours" | "days";
export type ExpiryPreset = "endOfDay" | "endOfWeek" | "d30" | "d60" | "d90";

export type ExpiryChoice =
  | { kind: "gtc" }
  | { kind: "preset"; preset: ExpiryPreset }
  | { kind: "relative"; amount: number; unit: ExpiryUnit }
  | { kind: "absolute"; atMs: number };

export const EXPIRY_PRESETS: { value: ExpiryPreset; label: string }[] = [
  { value: "endOfDay", label: "End of day" },
  { value: "endOfWeek", label: "End of week" },
  { value: "d30", label: "30 days" },
  { value: "d60", label: "60 days" },
  { value: "d90", label: "90 days" },
];

const UNIT_MS: Record<ExpiryUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function presetMs(preset: ExpiryPreset, nowMs: number): number {
  const d = new Date(nowMs);
  switch (preset) {
    case "endOfDay": {
      // Next UTC midnight after now.
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    }
    case "endOfWeek": {
      // Next UTC Monday 00:00 (getUTCDay: 0=Sun..6=Sat).
      const dow = d.getUTCDay();
      const daysToMon = ((8 - dow) % 7) || 7;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMon);
    }
    case "d30":
      return nowMs + 30 * UNIT_MS.days;
    case "d60":
      return nowMs + 60 * UNIT_MS.days;
    case "d90":
      return nowMs + 90 * UNIT_MS.days;
  }
}

export function resolveExpiry(choice: ExpiryChoice, nowMs: number): number | null {
  switch (choice.kind) {
    case "gtc":
      return null;
    case "preset":
      return presetMs(choice.preset, nowMs);
    case "relative":
      return nowMs + choice.amount * UNIT_MS[choice.unit];
    case "absolute":
      return choice.atMs;
  }
}

/** Epoch ms → UTC ISO string for the API, or null to omit the field. */
export function expiryToApi(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** null (GTC) is valid; a concrete expiry must be strictly in the future. */
export function isValidExpiry(ms: number | null, nowMs: number): boolean {
  return ms == null || ms > nowMs;
}
