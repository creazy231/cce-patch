# Home: Active list, New dots and usage card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CCE Remote's home screen gets three things:
- one Active list across all windows;
- a green "New" dot driven by the phone's own read state;
- a card with the Claude account's 5-hour and weekly usage, as Claude Code on the Mac reports it.

**Architecture:**
- **Window agent.** It follows Claude Code's usage relay (`provider.panelUsageRelay`) and can refresh it through a running session's Claude process.
- **Coordinator.** It carries readings and refresh calls between the windows and the hub.
- **Hub.** It validates readings, sends `usage` frames and answers `usage_refresh`.
- **App.** It parses the frame, schedules refreshes, keeps read state per Mac (measured in the Mac's clock via `welcome.now`), and renders the new Home.

**Tech Stack:** plain CommonJS on Node built-ins (inside the VS Code extension host); Preact + TypeScript + Vite; `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-20-home-active-new-usage-design.md`. Read it first. Its Facts section describes the extension internals this plan relies on.

## Global Constraints

- **Public repo.** No private data in code, tests, docs or commit messages: no names, e-mail addresses, host or tailnet names, machine paths.
- **Bridge files.** `// @ts-check`, `'use strict'`, plain CommonJS, Node built-ins only, no dependencies. Every read of the extension's objects goes through `guard()`. Nothing the agent does may throw into the host.
- **App.** No new dependencies. Nothing is loaded from third-party origins.
- **Protocol.** The phone protocol stays version 1. Every change is additive: `welcome.now`, `usage`, `usage_refresh`.
- **Exact values:**

  | What | Value |
  |---|---|
  | App refresh, while open and visible | every 300 000 ms (checked by a 30 000 ms timer) |
  | App refresh on becoming visible | only when ≥ 60 000 ms have passed since the last request |
  | Hub refresh, at most | every 60 000 ms (`limits.usageRefreshMinMs`) |
  | Window call `usage` timeout | 20 000 ms |
  | Agent read bound | 15 000 ms (`usageReadMs`) |
  | Read tolerance | 2 000 ms |
  | Read-state cap | 500 sessions per Mac |
  | `utilization` accepted | 0 to 10 |
  | Mac's `percent` | utilization × 100, rounded to 0.1 |
  | Phone's percent | a whole number |
  | `resetsAt` kept | 1 704 067 200 s (2024-01-01) to now + 30 days |
  | `at` rejected | more than 60 000 ms in the future |
  | Tones | warn from 80, danger from 95 (on the shown percent) |

- **Exact copy:**
  - "Active"
  - "All active, see above."
  - "New"
  - "5-hour", "Week"
  - "resets 14:30", "resets Mon 09:00"
  - "Updated just now", "Updated 3 min ago", "Updated 2 h ago", "Updated 3 d ago"
  - "No usage numbers yet. They show up once Claude Code has run a session on this Mac."
  - "Update Claude Code on this Mac to see usage here."
  - The summary parts: "N need(s) you", "N running", "N new", "N window(s)"
- **Commits.**
  - A gitmoji subject as in `git log` (🔧 feature, 📝 docs).
  - The body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - `git add` takes explicit paths (zsh doesn't word-split a variable).
- **Test commands.** `bun test remote-bridge/test` from the repo root. `cd remote-app && bun test test && npm run build`, where the build type-checks.
- **Hands off.** Never run `tailscale serve/up/down`. Never patch, reload or close the user's running editors.

## Review Focus

1. **The phone's clock is off by minutes.** "New" and "Updated … ago" use `macNow()`, so a fast phone neither marks everything new nor shows a negative age ("Updated just now"). Pinned by Task 5 "a phone clock that runs ahead" and Task 7 "updatedText".
2. **A Mac with an older bridge** (no `usage` frame, no `welcome.now`). There is no card, read state works with a skew of 0, and the ignored `usage_refresh` shows no error. Pinned by Task 7 "no usage frame: no card, no toast".
3. **Switching Macs.** The card and the read state of one Mac never show on the other. Pinned by Task 5 "each Mac has its own read state" and Task 7 "switching Macs clears the card".
4. **localStorage that is missing or throws** (private browsing, quota). Read state works in memory without exceptions. Pinned by Task 5 "a storage that throws".
5. **An older peer window answers `usage` with `unknown_method`.** The hub moves on to the next window, and the phone still gets its frame. Pinned by Task 2 "an older window's unknown_method doesn't stop the refresh".

---

### Task 1: The window agent follows and refreshes Claude Code's usage

**Files:**
- Modify: `remote-bridge/lib/window-agent.js`:
  - the header comment's Events list;
  - `AGENT_LIMITS`, the constructor;
  - `_fromHost` (the `request` case), `refreshProject()`;
  - new methods.
- Modify: `remote-bridge/test/fake-extension.ts` (the usage relay and the read path, as the host does it).
- Test: `remote-bridge/test/window-agent.test.ts` (a new `describe("usage")`).

**Interfaces:**
- Produces:
  - `/** @typedef {{ utilization: number, resetsAt?: number }} UsageWindow */`. `utilization` is a fraction; `resetsAt` is in epoch seconds.
  - `/** @typedef {{ supported: boolean, fiveHour?: UsageWindow, week?: UsageWindow, at?: number }} UsageReading */`. `at` is in epoch ms, from `this.now()`.
  - `agent.usageReading(): UsageReading` returns a copy.
  - `agent.refreshUsage(): Promise<{ refreshed: boolean, reason?: 'no_session' | 'not_supported', reading: UsageReading }>`. It never rejects.
  - The event `'usage'` with `(reading: UsageReading)`.
  - The constructor option `usageReadMs` (default `AGENT_LIMITS.usageReadMs` = `15_000`).

- [ ] **Step 1: Model the host's usage relay in `fake-extension.ts`** (from 2.1.329; keep the file's header comment true).
  - **`export class FakeUsageRelay`:**
    - `merged: Record<string, any> | null = null`.
    - `broadcast(allComms: Set<FakeComms>, update)` sets `this.merged = mergeWindows(this.merged, update)`, then calls `comms.sendPanelUsageUpdate(update)` for each comms.
    - `seed(comms)` calls `comms.sendPanelUsageUpdate(this.merged)` when `merged !== null`.
  - **`mergeWindows`** is the host's `e9e`, exactly:
    ```ts
    function mergeWindows(prev: Record<string, any> | null, update: Record<string, any> | null | undefined) {
      if (!update) return prev;
      const next: Record<string, any> = { ...prev };
      let changed = false;
      for (const key of ["five_hour", "seven_day", "seven_day_overage_included"]) {
        const w = update[key];
        if (w === null) {
          if (next[key] !== undefined) (delete next[key], (changed = true));
          continue;
        }
        if (!w || (w.resetsAt === undefined && next[key]?.resetsAt !== undefined)) continue;
        next[key] = w;
        changed = true;
      }
      if (!changed) return prev;
      return Object.keys(next).length === 0 ? null : next;
    }
    ```
  - **`createFakeProvider({ usage = false } = {})`.** With `usage`, the provider gets `panelUsageRelay: new FakeUsageRelay()`. `export function wireUsage(provider)` sets every comms' `onRateLimitWindows` to `(w) => provider.panelUsageRelay.broadcast(provider.allComms, w)`.
  - **`FakeComms`:**
    - `onRateLimitWindows?: (windows: Record<string, any>) => void`.
    - `usageReadTimeoutMs = 10_000`.
    - `sendPanelUsageUpdate(windows)` calls `this.send({ type: "request", channelId: "", requestId: nextRequestId(), request: { type: "panel_usage_update", unifiedWindows: windows } })`.
    - `async relayUsageWindowsFromProcess(query)`:
      1. It awaits `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` for at most `usageReadTimeoutMs`. On a timeout it logs the warning "usage meter read timed out" and returns.
      2. It converts `result.rate_limits` like the host's `t9e`. For `five_hour` and `seven_day`, `{ utilization: u / 100, resetsAt: Math.round(Date.parse(resets_at) / 1000) }`. With `resets_at: null` it is just `{ utilization: u / 100 }`. A window is dropped when `u` isn't finite or the reset has passed.
      3. It calls `this.onRateLimitWindows?.(windows)` when at least one window is left.
      4. It catches everything, as a logged warning.
  - **`FakeChannel.query?`:** `{ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<any> }`.

- [ ] **Step 2: Write the failing tests** in `describe("usage")`.
  - **Setup.** Extend `windowWith`'s `Options` with `usage?: boolean` and `usageReadMs?: number`. `usage` builds the provider with `createFakeProvider({ usage: true })`, calls `wireUsage(provider)` after the comms are added, and passes `usageReadMs` on. `W = { utilization: 0.5, resetsAt: 2_000_000_000 }`. The clock is `let t = 5_000; now: () => t`.
  - **"numbers found at start are the reading, without at":** set `provider.panelUsageRelay.merged = { five_hour: W }` before `agent.start()` (use `before`). Then `expect(agent.usageReading()).toEqual({ supported: true, fiveHour: W })`.
  - **"a real update becomes the reading with at, and emits once":**
    - Call `relay.broadcast(provider.allComms, { five_hour: W, seven_day: { utilization: 0.1, resetsAt: 2_000_100_000 } })`.
    - Exactly one `usage` event, whose reading is `{ supported: true, fiveHour: W, week: { utilization: 0.1, resetsAt: 2_000_100_000 }, at: 5_000 }`.
    - Both comms got the send.
  - **"a seed re-send changes nothing":** after that update, set `t = 9_000` and call `relay.seed(sidebar)`. No new event, and `usageReading().at` stays `5_000`.
  - **"an update with the same numbers moves at":** at `t = 9_000`, broadcast the same windows. One more event, with `at: 9_000`.
  - **"a logout's null is noticed at the next refreshProject":** after an update, set `relay.merged = null` (nothing sent), then `await agent.refreshProject()`. The last event's reading is `{ supported: true }`.
  - **"without a relay, usage is unsupported":** on a provider without `usage`:
    - `usageReading()` is `{ supported: false }`;
    - `await agent.refreshUsage()` is `{ refreshed: false, reason: "not_supported", reading: { supported: false } }`.
  - **"refreshUsage reads through a running channel":**
    - Give `sidebar.channels.get("c1")` a `query` that records its argument and resolves `{ rate_limits: { five_hour: { utilization: 42, resets_at: "2033-05-18T03:33:20Z" } } }`.
    - The result has `refreshed: true` and `reading.fiveHour` equal to `{ utilization: 0.42, resetsAt: 2_000_000_000 }`.
    - The query got `{ skipBehaviors: true }`.
  - **"a channel at rest is preferred":** c1 has `atRest = false`, c2 has `atRest = true`, and both have a query. Only c2's query is called.
  - **"no running channel: no_session":** with no channel query, the result is `{ refreshed: false, reason: "no_session" }` (the reading included).
  - **"a read that never answers ends after usageReadMs":** the query never settles and `usageReadMs` is 50. The result comes within 1 s with `refreshed: false` and no `reason`.
  - **"a read without numbers is not refreshed":** the query resolves `{ rate_limits: null }`, and `refreshed` is `false`.

- [ ] **Step 3: Run** `bun test remote-bridge/test/window-agent.test.ts`. Expected: the new tests FAIL (`usageReading` is not a function).

- [ ] **Step 4: Implement it in `window-agent.js`.**
  - **Limits.** `AGENT_LIMITS.usageReadMs: 15_000` (with a comment), and the constructor option `usageReadMs`.
  - **State.** `_usageRef` (a private sentinel until the first look), `_usage: UsageReading`, and `_usageJson`.
  - **`_lookAtUsage()`:**
    1. `relay = guard(() => this.provider.panelUsageRelay)`. When it isn't an object, the reading is `{ supported: false }`.
    2. Otherwise `merged = guard(() => relay.merged)`. When it is the same object as `_usageRef`, return.
    3. A non-null record: copy `five_hour` → `fiveHour` and `seven_day` → `week`. A window is copied only when `utilization` is a finite number, and its `resetsAt` only when that is a finite number. Set `at = this.now()`, except on the first look.
    4. `null` or anything else: the reading is `{ supported: true }`.
    5. Remember the ref. Emit `usage` through `_emitSafe` when the JSON changed.
  - **`_fromHost` `request`.** When `message.request?.type === 'panel_usage_update'`, call `_lookAtUsage()` and return `false` (it isn't a prompt).
  - **`refreshProject()`.** It calls `_lookAtUsage()` first.
  - **`usageReading()`.** It calls `_lookAtUsage()` and returns a copy.
  - **`refreshUsage()`.** Per the spec:
    1. **Candidates** come from `_allChannels()`: a `channel.query` with the usage method, on a comms that has the function `relayUsageWindowsFromProcess`. Channels with `atRest === true` come first.
    2. **No candidate.** The reason is `not_supported` when no relay is readable or no comms has the method, and `no_session` otherwise.
    3. **The read.** Remember the ref, then race `comms.relayUsageWindowsFromProcess(channel.query)` against `usageReadMs`, using an unref'd timer.
    4. **The answer.** Call `_lookAtUsage()`. `refreshed` is true when the ref changed and the reading has a window.
    5. Everything is caught.
  - **The header comment.** Add `'usage' (reading)` to the Events list.

- [ ] **Step 5: Run** `bun test remote-bridge/test/window-agent.test.ts`, then `bun test remote-bridge/test`. Expected: PASS, 0 fail.

- [ ] **Step 6: Commit.**
  ```bash
  git add remote-bridge/lib/window-agent.js remote-bridge/test/fake-extension.ts remote-bridge/test/window-agent.test.ts
  git commit -m "🔧 Follow Claude Code's usage meter in each window"
  ```

### Task 2: The hub sends usage frames and answers usage_refresh

**Files:**
- Modify: `remote-bridge/lib/hub.js`:
  - the header protocol comment;
  - `DEFAULT_CALL_TIMEOUTS_MS`, `Limits`/`DEFAULT_LIMITS`;
  - the `Window` and `WindowHandle` typedefs;
  - `addWindow`, `attachPeer`, `_removeWindow`;
  - the phone frame switch, the welcome.
- Modify: `docs/superpowers/specs/2026-11-19-phone-remote-design.md` (the protocol section: `welcome.now`, `usage`, `usage_refresh`).
- Modify: `CLAUDE.md` (the `remote-bridge/` paragraph: the hub also relays Claude Code's usage meter).
- Test: `remote-bridge/test/hub.test.ts` (a new `describe("usage")`).

**Interfaces:**
- Consumes: the `UsageReading` shape from Task 1, and a window call `usage` answering `{ refreshed, reason?, reading }`.
- Produces:
  - `WindowHandle.usage(reading: unknown): void`;
  - the peer event name `'usage'`, with the reading as data;
  - `hub.usageFrame(): { t: 'usage', state: 'ok' | 'none' | 'unsupported', fiveHour?: { percent: number, resetsAt?: number }, week?: …, at?: number }`, with `resetsAt` in ms;
  - phone frames: `usage`, `usage_refresh`, `welcome.now`;
  - `DEFAULT_CALL_TIMEOUTS_MS.usage = 20_000`;
  - `limits.usageRefreshMinMs` (default `60_000`).

- [ ] **Step 1: Write the failing tests** in `describe("usage")`, using `startHub`, `pairedPhone`, `nextFrame` and `fakeWindow`.
  - `R = Math.floor(Date.now() / 1000) + 3_600` is an hour ahead, so inside the hub's "now + 30 days" check.
  - A reading helper is `reading(at?, u = 0.42, resetsAt = R)` = `{ supported: true, fiveHour: { utilization: u, resetsAt }, ...(at !== undefined && { at }) }`.
  - **"the welcome carries the Mac's clock, and a usage frame follows projects":** `welcome.now` is a number. With no windows, the next frames are `projects`, then `usage` with `{ t: "usage", state: "unsupported" }`.
  - **"a window's reading becomes the frame, converted":**
    - `handle.usage(reading(1_000))` sends every phone `{ t: "usage", state: "ok", fiveHour: { percent: 42, resetsAt: R * 1000 }, at: 1_000 }`.
    - `utilization` 0.4567 gives `percent` 45.7.
  - **"the newest reading wins, and one without at counts as oldest":** window w1 has `reading(5_000, 0.1)` and w2 has `reading(undefined, 0.9)`, so the frame shows 10. Then w2 gets `reading(6_000, 0.9)`, and the frame shows 90.
  - **"states: none when supported without numbers, unsupported without support":**
    - `{ supported: true }` gives `state: "none"`;
    - `{ supported: false }` gives `unsupported`;
    - removing the window gives `unsupported` again, sent to the phone.
  - **"validation":** each case checked against `hub.usageFrame()`:
    - `utilization` 11 drops that limit;
    - `utilization` "x" drops it;
    - a `resetsAt` of 1_600_000_000 (2020) drops only `resetsAt`;
    - `resetsAt` = now/1000 + 31 days drops only `resetsAt`;
    - a past `resetsAt` of now/1000 − 86_400 (yesterday) is kept, in ms;
    - `at` = now + 61_000 drops `at`;
    - a non-object reading is ignored.
  - **"an unchanged reading sends nothing":** the same reading twice. A `roundTrip(phone)` shows no second `usage` frame.
  - **"usage_refresh: the windows are asked newest first until one refreshed, and the asker gets the frame":**
    - w1 answers `{ refreshed: false, reason: "no_session", reading: reading(2_000) }`. w2 answers `{ refreshed: true, reading: reading(9_000, 0.5) }`. w3 is asked never.
    - The readings are w2 at 3_000, w1 at 2_000 and w3 at 1_000. The phone sends `{ t: "usage_refresh" }`.
    - The calls are `usage` to w2 only (it refreshed first).
    - The phone gets a `usage` frame with percent 50.
  - **"an older window's unknown_method doesn't stop the refresh":**
    - w1's handler throws `Object.assign(new Error("unknown_method"), { code: "unknown_method" })`, and w2 refreshes.
    - Both are called, w1 first (the newer reading), and the phone gets the frame.
  - **"a refresh in flight is joined, and within usageRefreshMinMs the hub only answers":**
    - The setup is `limits: { usageRefreshMinMs: 60_000 }`, and w1's handler waits on a `deferred`.
    - Two phones each send `usage_refresh`. One `usage` call is made. After `resolve`, both phones get a frame.
    - A third `usage_refresh` makes no call and is still answered with a frame.
  - **"a phone that never asks gets no refresh":** connecting alone makes no `usage` call.

- [ ] **Step 2: Run** `bun test remote-bridge/test/hub.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it in `hub.js`.**
  - **The Window record.** `Window.usage` is the validated view or `null`, set by `_setUsage(win, reading)` from `handle.usage` and from the peer event `usage` in `attachPeer`. `_removeWindow` drops it and sends a changed frame.
  - **`usageView(reading, nowMs)`,** at module level: the spec's validation, giving `{ supported, fiveHour?: { percent, resetsAt? }, week?, at? }`.
  - **`usageFrame()`:**
    1. No window has `usage.supported`: the frame is `{ t: 'usage', state: 'unsupported' }`.
    2. None of the supported readings has a limit: `{ t: 'usage', state: 'none' }`.
    3. Otherwise `ok`, from the reading with the largest `at` (no `at` = `-Infinity`; on a tie, the first window).
  - **Changes.** After every `_setUsage` and `_removeWindow`, the frame's JSON is compared with the last one sent. A changed frame goes to every authed phone.
  - **The welcome.** It gets `now: this._now()` (the hub's `now` option). After the projects line it sends `usageFrame()`.
  - **`case 'usage_refresh'`** calls `this._onUsageRefresh(phone)`:
    1. It joins `this._usageRefresh` when that exists.
    2. Otherwise, when `performance.now() - this._usageRefreshAt < limits.usageRefreshMinMs`, it sends the frame and returns.
    3. Otherwise it records the time and runs the windows. Those with a supported reading go in order of `at`, descending. Each is called with `_callWindow(win, 'usage', {})`. An answer's `reading` (when it is a record) goes through `_setUsage`. The loop stops at `refreshed === true`. Errors are caught, and `unknown_method` is not logged as a failure.
    4. Finally it sends `usageFrame()` to the phone, if that phone is still open.
  - **Limits.** `DEFAULT_CALL_TIMEOUTS_MS.usage = 20_000`, and `usageRefreshMinMs: 60_000` in `DEFAULT_LIMITS` with its line in the Limits comment.
  - **The header protocol comment.** It lists `usage_refresh` among the frames after hello, and says that `welcome` + `projects` + `usage` are sent on hello.

- [ ] **Step 4: Update the docs.**
  - In the phone-remote design spec's protocol section, add `welcome.now`, the `usage` frame (its shape, its states, when it is sent) and `usage_refresh`, worded as in the 2026-11-20 spec.
  - In `CLAUDE.md`'s `remote-bridge/` paragraph, add one sentence: the hub relays Claude Code's usage meter (5-hour and weekly) to phones, and the window agents read it from the extension's own relay.

- [ ] **Step 5: Run** `bun test remote-bridge/test`. Expected: PASS, 0 fail.

- [ ] **Step 6: Commit.**
  ```bash
  git add remote-bridge/lib/hub.js remote-bridge/test/hub.test.ts docs/superpowers/specs/2026-11-19-phone-remote-design.md CLAUDE.md
  git commit -m "🔧 Send Claude Code's usage to phones and refresh it on request"
  ```

### Task 3: The coordinator carries usage between agent, peers and hub

**Files:**
- Modify: `remote-bridge/lib/coordinator.js`:
  - `callAgent`;
  - the sinks in the hub role (around line 1007) and the peer role (around line 1039);
  - `_bind`.
- Test: `remote-bridge/test/coordinator.test.ts` (a new `describe("usage")`).

**Interfaces:**
- Consumes:
  - Task 1's `agent.usageReading()`, `agent.refreshUsage()` and its `usage` event;
  - Task 2's `WindowHandle.usage`, the peer event `'usage'` and the call `usage`.
- Produces: the sinks get `usage(reading)`, and `callAgent(agent, 'usage')` returns `await agent.refreshUsage()`.

- [ ] **Step 1: Write the failing tests.**
  - **"callAgent maps usage to refreshUsage":** a stub `{ refreshUsage: async () => ({ refreshed: true, reading: { supported: true } }) }`. Then `await callAgent(stub, "usage", {})` equals `{ refreshed: true, reading: { supported: true } }`.
  - **"readings from the hub's own window and from a peer reach the hub":**
    - Use `hubAndPeer({ createHub })`, collecting the hub as the attention tests do.
    - `a.agent.emit("usage", { supported: true, fiveHour: { utilization: 0.2, resetsAt: 2_000_000_000 }, at: 1_000 })`. Then `hubs[0].usageFrame()` has `state: "ok"` and `fiveHour.percent` 20.
    - `b.agent.emit("usage", { …utilization: 0.7…, at: 2_000 })`. Then, eventually, `fiveHour.percent` is 70.
  - **"a window's reading reaches the hub when it binds":** in `beforePeer`, stub `b.agent.usageReading = () => ({ supported: true, week: { utilization: 0.3 }, at: 5_000 })`. Once b is a peer, `hubs[0].usageFrame().week` eventually equals `{ percent: 30 }`.

- [ ] **Step 2: Run** `bun test remote-bridge/test/coordinator.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it.**
  - `callAgent` gets `case 'usage': return await agent.refreshUsage();`.
  - The hub sink gets `usage: (reading) => window.usage(reading)`.
  - The peer sink gets `usage: (reading) => link.notify('usage', reading)`, always, like `attention`.
  - `_bind` gets an `onUsage` listener, guarded like `onAttention`. It is added and removed with the others. Right after the first `onProject(agent.project())`, it calls `onUsage(agent.usageReading())` when the agent has that function.
  - Add `usage` to the sink's JSDoc shape.

- [ ] **Step 4: Run** `bun test remote-bridge/test`. Expected: PASS, 0 fail.

- [ ] **Step 5: Commit.**
  ```bash
  git add remote-bridge/lib/coordinator.js remote-bridge/test/coordinator.test.ts
  git commit -m "🔧 Carry usage readings and refreshes between windows and the hub"
  ```

### Task 4: The app speaks the usage protocol

**Files:**
- Modify: `remote-app/src/lib/protocol.ts`, `remote-app/src/lib/client.ts`, `remote-app/src/state/source.ts`, `remote-app/src/state/demo-source.ts`, `remote-app/src/lib/demo.ts`.
- Create: `remote-app/src/lib/usage.ts`, holding `parseUsageFrame` only (Task 7 adds the display helpers).
- Test: `remote-app/test/client.test.ts`, `remote-app/test/demo.test.ts`, `remote-app/test/usage.test.ts` (new). In `remote-app/test/store.test.ts`, `FakeSource` gets `usageRefresh()` recording a call.

**Interfaces:**
- Produces:
  - In `protocol.ts`:
    - `export interface UsageLimit { percent: number; resetsAt?: number }`, with `resetsAt` in epoch ms;
    - `export interface UsageFrame { t: "usage"; state: "ok" | "none" | "unsupported"; fiveHour?: UsageLimit; week?: UsageLimit; at?: number }`;
    - `WelcomeFrame.now?: number`;
    - `ClientMsg` gets `| { t: "usage_refresh" }`, and `ServerMsg` gets `| UsageFrame`.
  - `parseUsageFrame(value: unknown): UsageFrame | null`. It returns `null` unless `t === "usage"` and `state` is one of the three. It keeps a limit only when `percent` is finite and 0 to 1000, `resetsAt` only when it is finite and > 0, and `at` only when it is finite and > 0.
  - `ClientEvents.usage: UsageFrame`.
  - `RemoteClient.usageRefresh(): void` sends `{ t: "usage_refresh" }` only while open.
  - `Source.usageRefresh(): void`.
  - `demoUsage(now: number): UsageFrame` in `lib/demo.ts`: `{ t: "usage", state: "ok", fiveHour: { percent: 42, resetsAt: now + 2h13m }, week: { percent: 18, resetsAt: now + 3 days }, at: now }`.

- [ ] **Step 1: Write the failing tests.**
  - **`usage.test.ts`, "parseUsageFrame keeps what is valid":**
    - A full frame round-trips.
    - `{ t: "usage", state: "maybe" }` gives `null`.
    - `{ t: "projects" }` gives `null`.
    - A limit with `percent: -1` or `"x"` is dropped.
    - `resetsAt: 0` drops only `resetsAt`.
    - `at: NaN` is dropped.
  - **`client.test.ts`, "a usage frame reaches the listeners; a malformed one doesn't":** after the handshake, `receive({ t: "usage", state: "ok", fiveHour: { percent: 42 } })` gives one `usage` event, and `receive({ t: "usage", state: 7 })` gives none.
  - **`client.test.ts`, "usageRefresh sends usage_refresh only while open":** before the welcome nothing is sent. After it, the last sent frame is `{ t: "usage_refresh" }`.
  - **`demo.test.ts`, "the demo sends usage after connecting and on usageRefresh":** at speed 0, `connect()` gives a `usage` event with `state: "ok"`, and `usageRefresh()` gives another.

- [ ] **Step 2: Run** `cd remote-app && bun test test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it.**
  - The client's `onFrame` gets `case "usage"`, which parses the frame and emits it when valid.
  - `usageRefresh()` sends the frame through `sendFrame`.
  - `DemoSource`:
    - emits `demoUsage(Date.now())` right after `projects` in `connect()`;
    - its `usageRefresh()` emits one through `later(…, 120)` while open.

- [ ] **Step 4: Run** `cd remote-app && bun test test && npm run build`. Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit.**
  ```bash
  git add remote-app/src/lib/protocol.ts remote-app/src/lib/client.ts remote-app/src/state/source.ts remote-app/src/state/demo-source.ts remote-app/src/lib/demo.ts remote-app/src/lib/usage.ts remote-app/test/client.test.ts remote-app/test/demo.test.ts remote-app/test/usage.test.ts remote-app/test/store.test.ts
  git commit -m "🔧 Teach CCE Remote the usage frames"
  ```

### Task 5: Read state on the phone ("new")

**Files:**
- Create: `remote-app/src/lib/readstate.ts`.
- Modify: `remote-app/src/state/store.ts`:
  - `StoreOptions`, `AppState`;
  - the welcome, projects, snapshot, message and pending handlers;
  - `applyRoute`, `onState`, `onVisibility`;
  - `connectTo`, `removeMac`.
- Test: `remote-app/test/readstate.test.ts` (new), and `remote-app/test/store.test.ts` (a new `describe("new on this phone")`).

**Interfaces:**
- Produces:
  - `export interface ReadState { baseline: number; seen: Record<string, number> }`. Both are Mac-clock epoch ms.
  - `READ_TOLERANCE_MS = 2_000` and `READ_CAP = 500`. The storage key is `cce-remote:read:${macId}`.
  - `loadReadState(macId: string, storage?: StorageLike): ReadState | null`. Foreign or corrupt data gives `null`, and so does a storage that throws.
  - `saveReadState(macId: string, state: ReadState, storage?: StorageLike): void`. It never throws. It writes at most `READ_CAP` entries, dropping the smallest `seen` values first.
  - `forgetReadState(macId: string, storage?: StorageLike): void`.
  - `markSeen(state: ReadState, sessionId: string, at: number): ReadState`. It keeps the larger time, and returns the same object when nothing changed.
  - `isNew(session: SessionSummary, state: ReadState | null): boolean`. That is `state !== null && session.state !== "waiting" && session.state !== "running" && session.lastModified > (state.seen[session.id] ?? state.baseline) + READ_TOLERANCE_MS`.
  - `StoreOptions.now?: () => number`, the phone's clock (default `Date.now`).
  - `AppState.read: ReadState | null`, for the selected Mac.
  - `Store.macNow(): number`, which is `now() + skew`.
  - The default storage is `globalThis.localStorage` read inside try/catch. The demo never loads or saves (memory only).

- [ ] **Step 1: Write the failing tests.**
  - **`readstate.test.ts`:**
    - "nothing is new without a read state";
    - "new after the baseline, unless seen, with 2 s tolerance". With baseline 1_000, `lastModified` 3_000 is not new and 3_001 is new. Then `seen: { s1: 10_000 }` makes 12_000 not new and 12_001 new;
    - "waiting and running are never new";
    - "markSeen keeps the larger time and returns the same object when unchanged";
    - "save keeps the 500 most recently seen": with 600 entries, the 100 smallest are gone after the round trip;
    - "load ignores foreign data; forget removes it";
    - "a storage that throws": `getItem` and `setItem` throw, `load` gives `null`, and `save` doesn't throw.
  - **`store.test.ts`, `describe("new on this phone")`.** Use `linkedStore()` with `now: () => phoneNow`. Set `document.visibilityState = "visible"` and fire `visibilitychange` where the page must count as visible. `projectsWith(lastModified)` is one project `p1` whose session `s1` is in state `"idle"`. `isNew` is imported from readstate.
    - **"the first projects set the baseline: nothing is new":** `welcome` with `now: 50_000` while `phoneNow` is 50_000. `fake.emit("projects", projectsWith(49_000))`. Then `store.state.read.baseline` is 50_000, and `isNew` is false.
    - **"activity after the baseline makes a session new; viewing it clears it":**
      1. Projects with 60_000 make s1 new.
      2. Open s1 (visible, connected) with a snapshot at `phoneNow` 61_000. Projects with 60_500 leave it not new.
      3. Go home at 62_000, so `seen.s1` is 62_000.
      4. Projects with 63_000 make it not new (within tolerance); with 64_001, it is new.
    - **"seen is kept up to the moment the session stops showing":** each case reads `seen.s1` afterwards. While viewing s1 at `phoneNow` 70_000:
      - hiding the page (visibilityState "hidden" + event) gives `seen.s1` 70_000;
      - after showing it again, `fake.emit("state", "offline")` at 80_000 gives 80_000;
      - while hidden, a `msg` frame doesn't move it.
    - **"a phone clock that runs ahead":** `phoneNow` is 1_600_000 and `welcome.now` is 1_000_000. The baseline becomes 1_000_000, and a session with `lastModified` 1_060_000 is new.
    - **"each Mac has its own read state":**
      - After Mac A's baseline, switch to B: `store.state.read` is `null` until B's first projects.
      - Switch back to A, and A's baseline is loaded.
      - `removeMac("a")` removes `cce-remote:read:a` from `localStorage`.
    - **"the demo keeps read state in memory only":** with a demo store, after projects, no `cce-remote:read:` key exists in `localStorage`.

- [ ] **Step 2: Run** `cd remote-app && bun test test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it.**
  - **`readstate.ts`.** As in Interfaces.
  - **Store: the clock.** `private skew = 0`, set at the start of `onWelcome` from a finite `frame.now` (`frame.now - this.now()`), else 0. `connectTo` resets it to 0.
  - **Store: the Mac's record.**
    - `connectTo` loads `read` for the new Mac (`null` in the demo).
    - The `projects` handler creates `{ baseline: macNow(), seen: {} }` when `read` is `null`, and saves it (not in the demo).
    - `removeMac` calls `forgetReadState(id)`.
  - **Store: `viewing(requireVisible: boolean): string | null`.** It gives the session id when all of these hold:
    - `route.name === "session"`;
    - `view.loaded`;
    - `view.session === route.session`;
    - `conn === "open"`;
    - the page is visible (only when `requireVisible` is set).
  - **Store: `noteSeen()`.** It calls `markSeen(read, id, macNow())` for `viewing(true)`, saves, and sets `read` when it changed. It runs:
    - after `onSnapshot`, `onMessage` and `onPending`;
    - after every `projects` frame;
    - when the page becomes visible.
  - **Store: the moment it stops showing.** The stop counts as seen at these three call sites:
    - **`applyRoute`:** before leaving a session route, `noteSeen()`.
    - **`onVisibility` turning hidden:** `markSeen` for `viewing(false)`, since the page was visible until now.
    - **`onState` leaving `"open"`:** `noteSeen()` before the state is set.

- [ ] **Step 4: Run** `cd remote-app && bun test test && npm run build`. Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit.**
  ```bash
  git add remote-app/src/lib/readstate.ts remote-app/src/state/store.ts remote-app/test/readstate.test.ts remote-app/test/store.test.ts
  git commit -m "🔧 Remember on the phone what was read, in the Mac's clock"
  ```

### Task 6: Home has an Active list and New dots

**Files:**
- Create: `remote-app/src/state/home.ts`.
- Modify:
  - `remote-app/src/components/Home.tsx`;
  - `remote-app/src/components/ui.tsx` (`StatusDot`);
  - `remote-app/src/state/format.ts` (labels);
  - `remote-app/src/components/Session.tsx` (the header dot);
  - `remote-app/src/styles/base.css` (`.dot-unread` → `.dot-new`);
  - `remote-app/src/styles/home.css` (`.s-unread` → `.s-new`, the Active section, the all-active note).
- Test: `remote-app/test/home.test.ts` (new), and `remote-app/test/format.test.ts` if it covers `STATE_LABEL`.

**Interfaces:**
- Consumes: Task 5's `ReadState`, `isNew`, `AppState.read`.
- Produces:
  - `export type DotState = "waiting" | "running" | "new" | "idle"`, in `format.ts`.
  - `DOT_LABEL: Record<DotState, string>`, which is `{ waiting: "Needs you", running: "Running", new: "New", idle: "Idle" }`. It replaces `STATE_LABEL`.
  - `sessionDot(state: SessionState): DotState`. Waiting and running pass through; `unread` and `idle` become `idle`.
  - In `home.ts`:
    - `dotState(session: SessionSummary, read: ReadState | null): DotState`. It is waiting or running as reported, else `"new"` when `isNew`, else `"idle"`.
    - `export interface ActiveRow { project: Project; session: SessionSummary }`;
    - `export interface WindowSection { project: Project; sessions: SessionSummary[]; allActive: boolean }`;
    - `homeSections(projects: readonly Project[]): { active: ActiveRow[]; windows: WindowSection[] }`;
    - `tally(projects: readonly Project[], read: ReadState | null): { waiting: number; running: number; new: number }`.
  - `StatusDot({ state: DotState; label?: boolean })`.

- [ ] **Step 1: Write the failing tests** in `home.test.ts`.
  - **"active sessions from every window, waiting first, each group newest first":** projects A have `[s1 running 100, s2 idle 900]` and B has `[s3 waiting 50, s4 running 300]`. `active` is `[s3, s4, s1]`, each with its project.
  - **"window lists keep only the rest, in the Mac's order":** A's sessions become `[s2]`. B has `sessions: []` and `allActive: true`.
  - **"a window without sessions is not all active":** `{ sessions: [], allActive: false }`.
  - **"dots":**
    - waiting and running are reported as they are;
    - the Mac's `unread` without new activity gives `idle`;
    - with `lastModified` past the baseline + 2 s, it gives `new`.
  - **"the tally counts new on this phone":** it equals `{ waiting: 1, running: 2, new: 1 }` on a fixture.
  - **"the same session in two windows shows once per window":** s1 is running in A and in B. `active` has two rows, with different projects.
  - **`sessionDot`:** `sessionDot("unread")` is `"idle"`, and `sessionDot("running")` is `"running"`.

- [ ] **Step 2: Run** `cd remote-app && bun test test/home.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement it.**
  - **`home.ts` and the `format.ts` labels.** As in Interfaces. Active means `state` is `"waiting"` or `"running"`.
  - **`Home.tsx`:**
    - It computes `homeSections(projects)` and `tally(projects, state.read)` with `useMemo`.
    - The order: hero; usage card slot (Task 7; leave a comment marker here, no placeholder UI); `ConnectionBanner`; the Active section; the window sections.
  - **The Active section.**
    - It is shown only when `active.length > 0`.
    - It is a `<section class="project active-list" aria-label="Active">` with heading `<h2 class="project-name">Active</h2>`.
    - It has a `<ul class="group">` of rows, keyed `${project.id}|${session.id}`.
    - A row is `SessionRow`, extended with an optional `windowName`, which comes first in the second line (the line then always shows).
  - **The window sections.**
    - A section renders its `WindowSection.sessions`.
    - With `allActive`, there is one `<div class="group group-note"><p>All active, see above.</p></div>` in place of "No sessions yet."
    - The `claudeOpen === false` note stays as it is.
  - **The summary.** It shows "N need(s) you", "N running" and "N new" from `tally`, plus the window count. `.summary-part.s-new` uses the green ink.
  - **`SessionRow`.** It passes `dotState(session, read)` to `StatusDot`, and `data-state` takes that value too. The memoised `ProjectSection` gets `read` as a prop, so a change of read state re-renders it.
  - **`Session.tsx`.** The header uses `sessionDot(sessionState)` for the dot and `DOT_LABEL` for the text.
  - **CSS.** `.dot-new` uses `--unread`; `.s-new` replaces `.s-unread`. `.active-list` gets the same look as a window section, with no menu button.

- [ ] **Step 4: Run** `cd remote-app && bun test test && npm run build`. Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit.**
  ```bash
  git add remote-app/src/state/home.ts remote-app/src/components/Home.tsx remote-app/src/components/ui.tsx remote-app/src/state/format.ts remote-app/src/components/Session.tsx remote-app/src/styles/base.css remote-app/src/styles/home.css remote-app/test/home.test.ts
  git commit -m "🔧 Put active sessions on top and mark what's new on the phone"
  ```
  Also add `remote-app/test/format.test.ts` if it changed.

### Task 7: The usage card and its refresh schedule

**Files:**
- Modify: `remote-app/src/lib/usage.ts` (display helpers), `remote-app/src/state/store.ts` (usage state, refresh schedule), `remote-app/src/components/Home.tsx` (renders the card), `remote-app/src/styles/home.css` (the card), `remote-app/README.md` (the home screen).
- Create: `remote-app/src/components/UsageCard.tsx`.
- Test: `remote-app/test/usage.test.ts`, and `remote-app/test/store.test.ts` (a new `describe("usage")`).

**Interfaces:**
- Consumes:
  - Task 4's `UsageFrame`, `parseUsageFrame`, `Source.usageRefresh()` and `ClientEvents.usage`;
  - Task 5's `Store.macNow()` and `StoreOptions.now`.
- Produces:
  - `export interface UsageRow { key: "fiveHour" | "week"; label: "5-hour" | "Week"; percent: number; resetText: string | null; tone: "ok" | "warn" | "danger" }`;
  - `usageRows(frame: UsageFrame, macNow: number, locale?: string): UsageRow[]`. It has one row per limit present, five-hour first. A passed reset (`resetsAt <= macNow`) gives percent 0 and `resetText` null. Otherwise percent is `Math.round(percent)`. The tone uses ≥ 95 for danger and ≥ 80 for warn.
  - `resetText(resetsAt: number, macNow: number, locale?: string): string`. It is "resets HH:MM" on the same local date as `macNow`, else "resets Ddd HH:MM". It uses `toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })` and `toLocaleDateString(locale, { weekday: "short" })`.
  - `updatedText(at: number, macNow: number): string`:
    - under 60 s, including negative: "Updated just now";
    - under 60 min: "Updated N min ago";
    - under 24 h: "Updated N h ago";
    - else "Updated N d ago";

    with whole numbers rounded down.
  - `AppState.usage: UsageFrame | null`.
  - `Store.usageTick(): void`. This is the 30 s timer's body, public so tests can call it.
  - `USAGE_REFRESH_MS = 300_000`, `USAGE_VISIBLE_MIN_MS = 60_000`.
  - `UsageCard({ usage, macNow }: { usage: UsageFrame; macNow: number })`.

- [ ] **Step 1: Write the failing tests.** `L = "en-GB"`, and dates are built with the local-time constructor, so the time zone doesn't matter.
  - **`usage.test.ts`, "usageRows":**
    - a frame with both limits gives the labels `["5-hour", "Week"]`;
    - 42.4 gives 42;
    - the tones at 79.9, 80, 94.9 and 95 are `ok`, `warn`, `warn`, `danger`;
    - a five-hour limit whose `resetsAt` is before `macNow` gives percent 0 and `resetText` null;
    - a frame with only `week` gives one row.
  - **`usage.test.ts`, "resetText":** `macNow` is `new Date(2026, 10, 20, 9, 0)`.
    - `resetsAt = new Date(2026, 10, 20, 14, 30)` gives "resets 14:30";
    - `new Date(2026, 10, 23, 9, 0)` gives "resets Mon 09:00", since 2026-11-23 is a Monday.
  - **`usage.test.ts`, "updatedText":**
    - `(1_000, 1_000)` gives "Updated just now";
    - `(61_000, 1_000)` gives "Updated just now", because a future `at` reads as just now;
    - `(0, 3 * 60_000)` gives "Updated 3 min ago";
    - `(0, 2 * 3_600_000)` gives "Updated 2 h ago";
    - `(0, 3 * 86_400_000)` gives "Updated 3 d ago".
  - **`store.test.ts`, `describe("usage")`.** Use `now: () => phoneNow`, and make the page visible unless a test says otherwise.
    - **"a usage frame becomes state.usage":** `fake.emit("usage", frame)` makes `store.state.usage` equal `frame`.
    - **"usage_refresh goes out after every welcome":** two welcomes give `fake.count("usageRefresh") === 2`.
    - **"every 5 minutes while open and visible":**
      - after the welcome at `phoneNow` 0, `usageTick()` at 299_999 sends nothing new;
      - at 300_000, it sends one;
      - while hidden, at 900_000, it sends none.
    - **"becoming visible sends one after 60 s, not before":** the last request was at 0.
      - Becoming visible at 59_999 sends none.
      - Becoming visible again at 60_000 sends one.
    - **"switching Macs clears the card":** with `linkedStore()`, A gets a usage frame. After `switchMac("b")`, `store.state.usage` is `null`.
    - **"no usage frame: no card, no toast":** a welcome without any usage frame leaves `store.state.usage` `null` and `store.state.toasts` empty.

- [ ] **Step 2: Run** `cd remote-app && bun test test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it.**
  - **The helpers in `usage.ts`.** As in Interfaces.
  - **Store: the frame.** A `usage` listener in `useSource` sets `usage`. `connectTo` sets `usage: null`. Reconnecting the same Mac keeps the last frame.
  - **Store: the requests.**
    - `private usageAskedAt = -Infinity`, and `private askUsage()` calls `this.source?.usageRefresh()` and records `now()`.
    - Call `askUsage()` first thing in `onWelcome`, next to setting the skew, before the notification logic and its early return.
  - **Store: the timer.**
    - `start()` sets an interval of 30 000 ms that calls `usageTick()`, and `stop()` clears it.
    - `usageTick()` asks when `conn === "open"`, the page is visible and `now() - usageAskedAt >= USAGE_REFRESH_MS`.
    - `onVisibility` turning visible asks when `conn === "open"` and `now() - usageAskedAt >= USAGE_VISIBLE_MIN_MS`.
  - **`UsageCard.tsx`:**
    - `ok`: the rows. Each has a label, a bar (`<div class="usage-bar"><span style={{width: `${min(percent,100)}%`}} /></div>` with `role="meter"`, `aria-valuenow` and `aria-valuemin`/`max`), a percent, and the reset text. Then the updated line when `at` is present.
    - `none` and `unsupported`: their exact copy, in a muted line.
  - **`Home.tsx`.** It renders `<UsageCard usage={state.usage} macNow={store.macNow()} />` at the slot from Task 6, when `state.usage` is set. The existing `useNow(30_000)` re-renders Home, so the card's ages and passed resets stay current.
  - **CSS** in `home.css`: the card as a `group`-style block. Bar colours: the accent, `--waiting` for warn, `--danger` for danger. Tabular numbers.
  - **`README.md`.** Describe the home screen: the usage card (where its numbers come from, the refresh and its limits, the Claude Code ≥ 2.1.325 floor), the Active list, and the green "New" (this phone's read state).

- [ ] **Step 4: Run** `cd remote-app && bun test test && npm run build`. Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit.**
  ```bash
  git add remote-app/src/lib/usage.ts remote-app/src/state/store.ts remote-app/src/components/UsageCard.tsx remote-app/src/components/Home.tsx remote-app/src/styles/home.css remote-app/README.md remote-app/test/usage.test.ts remote-app/test/store.test.ts
  git commit -m "🔧 Show the 5-hour and weekly usage on the home screen"
  ```
