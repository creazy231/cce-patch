# CCE Remote home: active sessions, new messages, usage limits (design)

Date: 2026-11-20 · Status: draft for the user's review.

The user asked:
- "We want to have active sessions at top always."
- "We need a green indicator for sessions that have new messages but weren't read on the web app."
- "A section at the top of the app that shows usage of 5h and usage of week for the current logged-in session. This should be updated every 5 min or when opening the app."

From two layouts they picked **A**: one Active list at the very top, across all windows. The calls made on the user's behalf are listed at the end.

## Intent

Opening CCE Remote should answer three questions at a glance, without scrolling through every VS Code window's list:
1. What is Claude working on, or waiting for me on, anywhere on this Mac?
2. Which sessions have something I haven't read on the phone yet?
3. How much of my 5-hour and weekly Claude limits have I used?

## Goals

- **Active list.** Every session that is running or waiting for the user, from every window, appears in one list at the top of the home screen. Each row names its window. The window lists below show only the rest.
- **New (green).** A session that isn't active and has activity the user hasn't seen on this phone shows a green dot. Opening it on the phone clears it.
- **Usage card.** It sits at the top of the home screen and shows two things for the Claude account that Claude Code on the Mac is logged in to:
  - the 5-hour limit and the weekly limit;
  - for each, how much is used and when it resets.

  It is the same pair of numbers as the "Session (5hr)" and "Weekly (7 day)" bars in Claude Code's own sessions panel.
- **Fresh numbers.** The numbers are refreshed when the app is opened (each connection, and coming back to the foreground) and every 5 minutes while the app is open. They also update whenever Claude Code on the Mac learns new numbers by itself, which happens on every Claude reply.

## Non-goals

- **Syncing read state with VS Code.** Reading a session on the phone doesn't clear VS Code's dot, and reading it in VS Code doesn't clear the phone's green.
- **Sharing read state between phones.** Each phone keeps its own.
- **More than the two limits.** The model-specific weekly limit (Claude Code's third bar), extra usage or credits, and history or graphs are all left out.
- **Usage where Claude Code has no usage meter.**
  - Claude Code older than 2.1.325, for example Cursor's 2.1.220.
  - API-key and third-party-provider logins, which have no such limits.
- **Usage reads while no phone asks.**
- **Notifications about limits.**

## Anti-goals

- **Credentials.** The bridge must not touch the Claude login (Keychain, OAuth tokens) or call Anthropic itself.
- **Read rate.** It must not read usage more than once a minute, nor when no phone asks for it.
- **Lost context.** An active row always names its window.
- **False "new".** A session the user just read on the phone must not turn green because the Mac's list catches up a few seconds later.

## Facts (Claude Code 2.1.325 to 2.1.329, read from the bundle)

- **The usage relay.**
  - Each window's extension provider (the object the bridge's `attach` receives) holds `panelUsageRelay`.
  - Its `merged` field is the window's current numbers: `{five_hour?, seven_day?, seven_day_overage_included?}`, each `{utilization, resetsAt?}`, or `null`.
  - `utilization` is a fraction (0.42 is 42 %). `resetsAt` is in epoch seconds, and when it is missing none was given.
  - An *incoming* window whose reset has already passed is dropped. The relay never expires a window it already holds, so `merged` can keep an ended window for days (over a quiet weekend, say). Claude Code's panel shows such a window as 0 %, with no reset time, and shows a bar only for the windows that are present.
  - `merged` is `null` when nothing is known yet, after a logout, or with a third-party provider. Logout, login, an account change and a third-party provider set it to `null` without sending anything.
- **Updates.**
  - Every update is sent to every Claude webview of the window as `{type:"request", channelId:"", requestId, request:{type:"panel_usage_update", unifiedWindows}}`.
  - It is a partial update. The relay merges it into `merged` before sending, and the webview merges it the same way:
    - `null` removes a window;
    - a window without `resetsAt` doesn't replace one that has it;
    - anything else replaces it.
- **Re-sends.**
  - `seed()` sends `merged` again, unchanged, to one webview each time a webview starts up, and on `request_usage_update`. Every send carries a fresh `requestId`, so copies can't be told apart by id.
  - A real update always makes `merged` a *new object*: the merge builds a new one whenever the update holds any window, even with identical numbers. A re-send leaves the object as it was.
  - So `merged` changing identity is what tells new numbers from old ones sent again.
- **Where new numbers come from:**
  - the CLI's `rate_limit_event` on every turn;
  - one read when the extension starts or logs in;
  - a `get_usage` read.

  `request_usage_update` only sends the cached numbers again and reads nothing.
- **A read on demand.**
  - `comms.relayUsageWindowsFromProcess(query)` reads usage through a running Claude process, with the extension's own timeout and checks. It calls `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})`, which is the CLI's `get_usage` control request and asks Anthropic's usage endpoint.
  - The result is relayed like any other update, so it sends `panel_usage_update` to every webview, even when nothing changed.
  - It never throws: failures and timeouts are only logged.
  - A comms channel's `query` is such a process. Without a channel in the window, there is nothing to read through.
- **Older extensions.** 2.1.220 has neither the relay nor `panel_usage_update`.

## Approaches

**Usage numbers**
1. **Mirror Claude Code's own usage meter (chosen).** The bridge follows each window's relay, and reads on demand through a session's Claude process that is already running. The numbers are identical to what VS Code shows, and no credentials are involved. Limit: a read needs a Claude Code session that is open in some window. Otherwise the phone shows the last numbers and their age.
2. *Call Anthropic's usage endpoint from the bridge, with the OAuth token from the Keychain.* Rejected: the bridge would handle the user's Claude credentials, and macOS would ask for Keychain access for the editor.
3. *Start a short Claude process for each read.* Rejected: it starts a CLI every few minutes, adds seconds of latency, and is more to go wrong.

**Read state**
1. **Each phone keeps it, measured in the Mac's clock (chosen).** The phone remembers up to when it showed each session, and compares that with the session's last activity, which the Mac already sends.
2. *The Mac keeps it per device.* Rejected: new state and protocol on the Mac for little gain. What a phone has shown is that phone's business.

**Active sessions** (the user picked A)
- **A: one list at the top, across all windows.**
- *B: active sessions first within each window's list.* Rejected: with several windows open, active sessions still sit under each window's header, further down the page.

## Design

### Phone protocol (additive; the version stays 1)

- **`welcome.now`** (number, optional): the Mac's clock in epoch ms when it sent the welcome. An older Mac leaves it out.
- **Mac → phone `usage`:**
  ```
  { t: "usage",
    state: "ok" | "none" | "unsupported",
    fiveHour?: { percent: number, resetsAt?: number },   // resetsAt: epoch ms
    week?:     { percent: number, resetsAt?: number },
    at?: number }                                         // epoch ms: when the Mac got these numbers
  ```
  - `ok`: at least one window has numbers. `fiveHour` and `week` come from the window whose numbers are newest. Either may be missing when Claude Code doesn't have it.
  - `none`: some window has the usage meter, but none has numbers. This covers "not yet", a logout, and a login without limits.
  - `unsupported`: no window's Claude Code has the usage meter, or no window is open.
  - **When it's sent:** right after `projects` on every welcome, to the asking phone after every `usage_refresh` (even when nothing changed), and to every connected phone whenever the frame changes.
- **Phone → Mac `usage_refresh`:** `{ t: "usage_refresh" }`, with no id and no ack. An older Mac ignores it (its hub drops unknown frames that have no id).

### Bridge (`remote-bridge/`)

**Window agent (`lib/window-agent.js`)**
- **The reading:** `{ supported: boolean, fiveHour?: {utilization, resetsAt?}, week?: {utilization, resetsAt?}, at?: number }`.
  - It holds a copy of `merged`'s `five_hour` and `seven_day`, with `resetsAt` still in seconds.
  - `supported` means the provider's `panelUsageRelay` is readable. The agent doesn't merge updates itself: the relay is the one source.
  - `at` is when the agent saw `merged` become a new object, that is, a real update (see Facts, "Re-sends"). It is left out for numbers found at start-up, whose age is unknown.
- **Following updates.** The agent looks at `provider.panelUsageRelay.merged` at these moments:
  - after every `panel_usage_update` seen in the `send` wrapper's `request` branch;
  - at every `refreshProject()`, every 15 s while a phone is connected, which is how a logout's `null` gets noticed;
  - in `usageReading()` and `refreshUsage()`.

  What it does with what it finds:
  - The same object as last time: nothing. This covers the copies of one update, and the seed re-sends.
  - A new object: the agent copies the two windows and sets `at = now()`.
  - `null`: the agent clears the windows and `at`.
  - It emits `usage` (the reading) when the reading changed, compared as JSON. So an update that only confirms the same numbers still moves `at`, and is emitted.
- **`usageReading()`** returns the current reading.
- **`refreshUsage()`** returns `{ refreshed: boolean, reason?: 'no_session' | 'not_supported', reading }`.
  - It looks for a channel in a comms' `channels` (not `pendingChannels`) whose `query` has the usage method, on a comms that has `relayUsageWindowsFromProcess`, and prefers channels at rest. It awaits `comms.relayUsageWindowsFromProcess(channel.query)`, bounded by 15 s of its own.
  - `refreshed` means `merged` became a new object during the call.
  - It never throws.
- **Remote access off.** Usage is still followed: it is small and needed the moment a phone connects. The agent has no listener then anyway.

**Coordinator (`lib/coordinator.js`)**
- **Forwarding.** The agent's `usage` event goes to the sink:
  - locally, to the hub handle's `usage(reading)`;
  - over a peer link, as `link.notify('usage', reading)`.

  It is always forwarded, like `attention`, and once at bind with `usageReading()`, like `project`.
- **The call.** `callAgent` gets `usage`, which runs `agent.refreshUsage()`.

**Hub (`lib/hub.js`)**
- **Readings.**
  - The `WindowHandle` gets `usage(reading)`, and `attachPeer` maps the peer event `usage` to it.
  - The hub keeps each window's last validated reading and drops it with the window.
- **Validation.**
  - `utilization` must be a finite number from 0 to 10, and becomes `percent` = utilization × 100, rounded to 0.1.
  - `resetsAt` must be a finite number, and becomes ms.
    - A past value is kept, because the phone needs it to show an ended window as 0 % as Claude Code's panel does. It is dropped only when it is absurd: before 2024-01-01 (1 704 067 200 s) or after now + 30 days.
    - A window without a usable `resetsAt` keeps its percent.
  - `at` must be finite and not in the future by more than a minute. Anything else is dropped field by field.
- **The frame.**
  - The `ok` numbers come from the reading with the newest `at`; a reading without `at` counts as oldest.
  - The state follows the rules above.
  - A changed frame (compared as JSON) goes to every authed phone.
- **`usage_refresh`.**
  - While a refresh is in flight, the request joins it.
  - When the last refresh started less than 60 s ago, the hub only sends the current frame to the asker.
  - Otherwise it calls `usage` on the windows whose readings are `supported`, newest reading first, one at a time, each with the call timeout. It stops at the first `refreshed: true`, then sends the current frame to the asker. Other phones get it through the change path.
  - The window call `usage` has a 20 s timeout. A peer of an older bridge answers `unknown_method`, which counts as not refreshed.
- **On welcome,** after `projects`, the current `usage` frame.
- **`welcome.now`.** The welcome frame gains `now: this.now()`.

Peers: an older bridge never sends `usage` and answers the call with `unknown_method`. A newer peer's `usage` events are ignored by an older hub. No version check is needed. The new Mac side still needs `bun run patch.ts` and a reload of every window, as always.

### App (`remote-app/`)

**Home, top to bottom**
1. The top bar and the hero (the Mac's name and the summary line) stay as they are.
2. **The usage card**, from the first `usage` frame of a connection on. It keeps showing the last frame while reconnecting, and changing to another Mac clears it.
   - It has two rows, "5-hour" and "Week". Each has a bar, a whole-number percent and a reset time in the phone's locale and time zone: "resets 14:30" today, "resets Mon 09:00" on another day.
   - A row appears only for a limit the frame has, as in Claude Code's panel.
   - A reset that has passed shows 0 % and no time, as in Claude Code's panel. This is checked against `macNow()` at each render, so a card left open zeroes by itself. The bar uses the accent colour, the waiting orange from 80 %, and the danger colour from 95 %.
   - A last line, "Updated 3 min ago", shows the age (measured in the Mac's clock, see below). It is left out without `at`.
   - With `none` it says: "No usage numbers yet. They show up once Claude Code has run a session on this Mac."
   - With `unsupported` it says: "Update Claude Code on this Mac to see usage here."
   - With an older Mac (no `usage` frame) there is no card.
3. **The connection banner** stays as it is.
4. **Active**, only when at least one session is active.
   - It holds every `waiting` session and then every `running` session from all windows, each group with the latest `lastModified` first.
   - Its heading is "Active". A row has the window list's look, and its second line starts with the window's name.
5. **The window sections**, each with only its sessions that aren't active, in the Mac's order. A window whose sessions are all active shows one muted line: "All active, see above."

**Dots and labels**
- `waiting` (orange) and `running` (blue) stay as they are.
- Any other session is green when it's new on this phone, and otherwise the grey ring.
- The Mac's own `unread` state is shown like `idle` everywhere in the app (Home and the session screen's header), because the phone's read state replaces it. The green state's label is "New".
- The summary line: "2 need you · 1 running · 3 new · 4 windows".

**Read state (per phone, per Mac)**
- **The Mac's clock.** The skew is `welcome.now − Date.now()`, taken when the welcome arrives; 0 without `now`. `macNow()` = `Date.now()` + skew.
- **Storage.**
  - Each Mac gets `{ baseline, seen: { [sessionId]: macMs } }` in localStorage, under a key per Mac.
  - It holds at most 500 sessions; the smallest `seen` values go first.
  - Removing the Mac deletes it, and storage failures fall back to memory, as `macs.ts` does.
- **The baseline.** The first `projects` frame for a Mac without a record sets `baseline = macNow()`, so nothing is green right after the update.
- **Seen.** While the session screen shows session S, the phone keeps `seen[S] = macNow()`. "Shows" means all of these hold:
  - the route is S;
  - the connection is open;
  - S's snapshot has arrived;
  - the page is visible.

  It is refreshed on every frame for S and every `projects` frame. It is set once more when any of those stops being true: leaving, hiding, disconnecting.
- **New.** S is not active, and `S.lastModified > (seen[S] ?? baseline) + 2000`. The 2 s cover the error of the clock estimate.
- **The demo** (`?demo`) uses the same logic on its fixtures, and shows a usage card from fixture numbers.

**Refresh**
- `usage_refresh` goes out:
  - after every welcome;
  - every 5 minutes while the connection is open and the page is visible;
  - when the page becomes visible again and the last request was at least 60 s ago.
- Nothing goes out while the page is hidden.

### Docs

The following change with the code:
- `remote-app/README.md`, for the home screen;
- the protocol section of `docs/superpowers/specs/2026-11-19-phone-remote-design.md`, for `welcome.now`, `usage` and `usage_refresh`;
- `CLAUDE.md`, where it lists what the hub and window agent do.

## Testing

**Bridge** (`bun test remote-bridge/test`, fake provider and comms):
- **Window agent.**
  - A `panel_usage_update` with a new `merged` object changes the reading and emits `usage` once. Its copies to other webviews don't emit again.
  - A seed re-send (the same object) changes nothing, and its `at` stays.
  - A real update with identical numbers moves `at`.
  - `merged` turning `null` is noticed at the next `refreshProject()`.
  - Without a readable relay, `supported` is false.
  - `refreshUsage` through a fake channel query covers refreshed, `no_session`, `not_supported` and a timeout.
- **Coordinator.** `usage` is forwarded both locally and over a peer link, the call is mapped, and the reading is sent at bind.
- **Hub.**
  - A `usage` frame follows the welcome.
  - The newest reading wins.
  - Validation and clamping hold, and a past `resetsAt` is kept.
  - It sends `none` and `unsupported`.
  - A change goes to every phone.
  - `usage_refresh`: requests join one in flight, the 60 s throttle holds, and the windows are called in order until one has refreshed.
  - A window removed drops its reading.

**App** (`bun test test` in `remote-app`):
- **Read state.**
  - The baseline: nothing is new at first.
  - New after activity, and cleared by viewing.
  - Seen is committed on leaving, hiding and disconnecting.
  - The skew is applied.
  - The cap holds, and removing a Mac deletes the record.
- **Home order.**
  - The Active list holds waiting then running, across windows, each group newest first.
  - Window lists leave out active sessions.
  - It shows "All active, see above."
- **Usage.**
  - The frame is parsed.
  - The card's states and the passed-reset rule hold (against `macNow()`), and only present limits get a row.
  - The refresh goes out on welcome, every 5 min while visible, on becoming visible after 60 s, and never while hidden.
- `npm run build` type-checks.

## Left to the builder

- The exact layout, spacing and CSS of the usage card and the Active heading, within the app's style (`tokens.css`, `home.css`), and its accessibility labels.
- Internal names beyond the protocol and the method names above.
- How the demo's fixtures show usage and new sessions.

## Calls made on the user's behalf (please check)

1. **Green replaces VS Code's "Done" in the app.** Green now means "new on this phone", and the Mac's `unread` shows as idle. Two different greens would be confusing.
2. **"Active" means running or waiting for you.** "New" sessions stay in their window lists, and are green there.
3. **Only the two limits the user named.** The model-specific weekly bar is left out (easy to add later).
4. **The usage card sits below the Mac's name and the summary,** above everything else.
5. **Numbers update on their own too,** whenever Claude Code on the Mac learns new ones, not only every 5 minutes.
6. **No reads more than once a minute, and none without a phone asking.**
7. **Without an open Claude Code session on the Mac,** the card shows the last numbers and their age instead of fresh ones.
8. **"Updated … ago" counts only real updates.** Claude Code re-sending old numbers (when a Claude tab opens) doesn't count. A reply or refresh that confirms the same numbers does.
9. **An ended limit shows 0 % with no reset time,** exactly as Claude Code's panel does, and a limit Claude Code doesn't report has no row.
