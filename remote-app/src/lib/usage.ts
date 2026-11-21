// Claude Code's usage meter, as the Mac sends it (the `usage` frame): checked here before the screens see it.

import type { UsageFrame, UsageLimit } from "./protocol";
import { hasInvisible } from "./text";

const STATES = new Set<UsageFrame["state"]>(["ok", "none", "unsupported"]);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The longest an email address can be. The account tells accounts apart, so one with control, bidi or invisible
 * characters (which could make it show as another address) is refused, not cleaned.
 */
const ACCOUNT_MAX = 254;

const isAccount = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= ACCOUNT_MAX && !hasInvisible(value);

function usageLimit(value: unknown): UsageLimit | null {
  if (!value || typeof value !== "object") return null;
  const { percent, resetsAt } = value as Record<string, unknown>;
  if (!isNumber(percent) || percent < 0 || percent > 1000) return null;
  return isNumber(resetsAt) && resetsAt > 0 ? { percent, resetsAt } : { percent };
}

/** A `usage` frame with only what is valid in it; null when it isn't one (another frame, an unknown state). */
export function parseUsageFrame(value: unknown): UsageFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (frame.t !== "usage" || !STATES.has(frame.state as UsageFrame["state"])) return null;
  const out: UsageFrame = { t: "usage", state: frame.state as UsageFrame["state"] };
  const fiveHour = usageLimit(frame.fiveHour);
  const week = usageLimit(frame.week);
  if (fiveHour) out.fiveHour = fiveHour;
  if (week) out.week = week;
  if (isNumber(frame.at) && frame.at > 0) out.at = frame.at;
  if (isAccount(frame.account)) out.account = frame.account;
  return out;
}

// ---- how the home screen shows it ----------------------------------------------------------------------

export interface UsageRow {
  key: "fiveHour" | "week";
  label: "5-hour" | "Week";
  /** Whole percent as shown; 0 once the limit has reset. */
  percent: number;
  /** "resets 14:30" or "resets Mon 09:00"; null when the time is unknown or has passed. */
  resetText: string | null;
  tone: "ok" | "warn" | "danger";
}

/** How a shown percent looks: warn from 80, danger from 95. */
function toneOf(percent: number): UsageRow["tone"] {
  return percent >= 95 ? "danger" : percent >= 80 ? "warn" : "ok";
}

/**
 * The card's rows, five-hour first, one per limit the frame has. A limit whose reset time has passed (on the Mac's
 * clock) shows 0 % without a time, as Claude Code's own usage meter does.
 */
export function usageRows(frame: UsageFrame, macNow: number, locale?: string): UsageRow[] {
  const rows: UsageRow[] = [];
  const add = (key: UsageRow["key"], label: UsageRow["label"], limit: UsageLimit | undefined) => {
    if (!limit) return;
    const ended = limit.resetsAt !== undefined && limit.resetsAt <= macNow;
    const percent = ended ? 0 : Math.round(limit.percent);
    rows.push({ key, label, percent, resetText: ended || limit.resetsAt === undefined ? null : resetText(limit.resetsAt, macNow, locale), tone: toneOf(percent) });
  };
  add("fiveHour", "5-hour", frame.fiveHour);
  add("week", "Week", frame.week);
  return rows;
}

/** "resets 14:30" on the same day as `macNow`, else "resets Mon 09:00", in the phone's time zone and locale. */
export function resetText(resetsAt: number, macNow: number, locale?: string): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date(macNow).toDateString()) return `resets ${time}`;
  return `resets ${at.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/** How old the numbers are: "Updated just now", "Updated 3 min ago", "Updated 2 h ago", "Updated 3 d ago". */
export function updatedText(at: number, macNow: number): string {
  const age = macNow - at;
  if (age < 60_000) return "Updated just now";
  if (age < 3_600_000) return `Updated ${Math.floor(age / 60_000)} min ago`;
  if (age < 86_400_000) return `Updated ${Math.floor(age / 3_600_000)} h ago`;
  return `Updated ${Math.floor(age / 86_400_000)} d ago`;
}
