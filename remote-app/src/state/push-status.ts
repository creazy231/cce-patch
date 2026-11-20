// The Settings status line for notifications on the connected Mac.

import type { PushState } from "./store";

/** What the connected Mac says about this phone's subscription, for the Settings screen. */
export function pushStatusText(push: PushState, macName: string): string {
  if (push.mac === "on") return `${macName}: on`;
  if (push.mac === "unsupported") return `${macName}: this Mac's patch is too old for notifications`;
  if (push.mac === "off" && push.error) {
    if (push.error === "bad_endpoint" || push.error === "bad_keys" || push.error === "bad_request") {
      return `${macName}: refused this iPhone's notification setup (${push.error})`;
    }
    if (push.error === "save_failed") return `${macName}: couldn't save the notification setup`;
    return `${macName}: can't be reached right now`;
  }
  return `${macName}: not set up yet`;
}
