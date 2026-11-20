// Claude Code's usage meter, as the Mac sends it (the `usage` frame): checked here before the screens see it.

import type { UsageFrame, UsageLimit } from "./protocol";

const STATES = new Set<UsageFrame["state"]>(["ok", "none", "unsupported"]);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

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
  return out;
}
