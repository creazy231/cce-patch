// The usage card on the home screen: Claude Code's 5-hour and weekly limits on the Mac (the account it is logged
// in to), as its own usage meter shows them, with when each resets and how old the numbers are.

import type { UsageFrame } from "../lib/protocol";
import { updatedText, usageRows } from "../lib/usage";

const NONE = "No usage numbers yet. They show up once Claude Code has run a session on this Mac.";
const UNSUPPORTED = "Update Claude Code on this Mac to see usage here.";

export function UsageCard({ usage, macNow }: { usage: UsageFrame; macNow: number }) {
  const rows = usage.state === "ok" ? usageRows(usage, macNow) : [];
  if (rows.length === 0) {
    return (
      <section class="usage-card" aria-label="Usage">
        <p class="usage-note">{usage.state === "unsupported" ? UNSUPPORTED : NONE}</p>
      </section>
    );
  }
  return (
    <section class="usage-card" aria-label="Usage">
      {rows.map((row) => (
        <div key={row.key} class={`usage-row tone-${row.tone}`}>
          <div class="usage-line">
            <span class="usage-label">{row.label}</span>
            <span class="usage-percent">{row.percent}%</span>
          </div>
          <div class="usage-bar" role="meter" aria-label={`${row.label} limit used`} aria-valuenow={row.percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.min(row.percent, 100)}%` }} />
          </div>
          {row.resetText && <span class="usage-reset">{row.resetText}</span>}
        </div>
      ))}
      {usage.at !== undefined && <p class="usage-updated">{updatedText(usage.at, macNow)}</p>}
    </section>
  );
}
