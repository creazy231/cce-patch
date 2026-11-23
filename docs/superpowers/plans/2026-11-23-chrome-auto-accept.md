# Claude in Chrome Auto-Accept — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in switch in the Connection tab. While it is on, the bridge answers Claude in Chrome's permission prompts in VS Code for the user. Both kinds are covered (tool prompts and the site card), and the site card gets "always allow this site" for the session. Nothing else changes.

**Architecture:**
- The flag is `chromeAutoAccept` in `~/.cce-remote/state.json`.
- Each window's coordinator holds it in memory: read at start, by `status()` and by the watcher, and set by `setChromeAutoAccept`.
- `bridge.js` gives the window agent a getter for it.
- The agent's `_fromHost` swallows a matching `tool_permission_request` and injects the answer through the original `fromClient` on the next microtask.
- The Connection tab sends `cce_remote_set_chrome_auto_accept`.

**Tech Stack:** Plain CommonJS bridge (Node built-ins only), `bun test`; the tab's runtime is plain ES2019 on the fake DOM.

**Spec:** `docs/superpowers/specs/2026-11-23-chrome-auto-accept-design.md`

## Global Constraints

- **Off unless `chromeAutoAccept === true`.** A getter that is missing, throws, or returns anything but `true` means off.
- **Scope.** Only `request.type === 'tool_permission_request'` whose `toolName` starts with `mcp__claude-in-chrome__`, read by `classifyPending` as kind `tool`.
- **"Always" only for session-only Claude in Chrome rules.** `canAlwaysAllow` must hold, and every suggestion must be `addRules` / `allow` / `session`, with each rule either `ClaudeInChromeDomain` with a `ruleContent`, or a `mcp__claude-in-chrome__` tool. Anything else gets a plain allow. Never a mode change, never a settings file.
- **Swallowed prompts never reach the phone** (no pending, no attention). If the answer can't go out, the prompt goes to VS Code (original `send`) and to the phone after all.
- **The phone can't change the switch.** Only the Connection tab's `cce_remote_set_chrome_auto_accept` can.
- **Copy, verbatim:**
  - heading "Claude in Chrome";
  - status line "Auto-accept is on" / "Auto-accept is off";
  - muted line "Claude in Chrome's permission prompts are answered for you in every VS Code window." / "You confirm Claude in Chrome's permission prompts yourself.";
  - buttons "Turn on auto-accept" / "Turn off auto-accept", and "Saving…" while busy;
  - hint "Only Claude in Chrome's prompts are answered, and each site is allowed for the rest of its session. A web page Claude reads could then steer it without you seeing a prompt."

### Task 1: Window agent answers Claude in Chrome prompts

**Files:** `remote-bridge/lib/window-agent.js`, `remote-bridge/test/window-agent.test.ts`

- [ ] Fixtures: `chromeNavigate` (tool prompt, a `localSettings` suggestion) and `chromeSite` (the site card: a session `ClaudeInChromeDomain` suggestion, with a reason).
- [ ] Failing tests (`describe("Claude in Chrome auto-accept")`):
  - **On, tool prompt:** a plain allow goes to the host; VS Code (`sent`) never gets the request; no pending or attention event; one log line.
  - **On, site card:** the suggestion goes back (always), and the log names the site.
  - **Off:** no getter, `() => false`, or a getter that throws. The prompt reaches VS Code and the phone as before.
  - **Other prompts with the switch on:** Bash, a look-alike server name (`mcp__claude-in-chrome-x__navigate`), AskUserQuestion, `user_dialog_request`. All reach VS Code.
  - **Plain allow instead of always** for:
    - a `setMode` session suggestion;
    - a session rule for another tool;
    - `ClaudeInChromeDomain` without `ruleContent`;
    - `suppressAlwaysAllowRule`;
    - a plugin prompt.
  - **The getter is read per prompt:** switched off, the next prompt is VS Code's.
  - **The answer can't go out** (fromClient throws): the prompt reaches VS Code and the phone, and the log says why.
- [ ] Implement:
  - constants `CHROME_TOOL_PREFIX`, `CHROME_SITE_RULE`;
  - the property `chromeAutoAccept = null`;
  - `_autoAcceptChrome(comms, message)`, called in `_fromHost` before `_onRequest`;
  - `chromeOnlyForSession(pending)` and `chromeSiteOf(suggestions)`.
- [ ] Run `bun test remote-bridge/test/window-agent.test.ts` and commit.

### Task 2: Coordinator holds and writes the switch

**Files:** `remote-bridge/lib/coordinator.js`, `remote-bridge/lib/store.js` (typedef only), `remote-bridge/test/coordinator.test.ts`

- [ ] Failing tests:
  - **Off without a file:** `setChromeAutoAccept(true)` writes the file; `chromeAutoAccept()` is true at once; `status().chromeAutoAccept` is true; remote access stays off.
  - **Turning it off** writes `false`.
  - **A non-boolean** rejects `bad_value` and writes nothing.
  - **A value other than `true`** in the file (`"yes"`) is off.
  - **Another window's write** reaches this one through the watcher.
  - **An unreadable file** keeps the last value; a missing one is off.
- [ ] Implement:
  - `this._chromeAutoAccept`, set in `_read()` (ok → the value, missing → false, unreadable → unchanged) and in `_onState`;
  - `chromeAutoAccept()`;
  - `async setChromeAutoAccept(on)`;
  - `chromeAutoAccept` in `status()` and the `ConnectionStatus` typedef;
  - `chromeAutoAccept?: boolean` in the store's `State` typedef.
- [ ] Run `bun test remote-bridge/test/coordinator.test.ts` and commit.

### Task 3: Request, wiring and the Connection tab

**Files:** `remote-bridge/lib/connection-ui.js`, `remote-bridge/bridge.js`, `remote-bridge/webview-runtime.js`, `remote-bridge/install.ts` (CSS, if needed), and the tests `connection-ui.test.ts`, `bridge.test.ts`, `webview-runtime.test.ts`

- [ ] Failing tests:
  - **connection-ui:** `cce_remote_set_chrome_auto_accept` with `on: true` / `false` calls the coordinator and answers with a status. A non-boolean answers with an error and calls nothing.
  - **bridge:** the agent's `chromeAutoAccept` follows the state file's flag through the coordinator, and is null after detach.
  - **tab, off:**
    - the section shows "Auto-accept is off";
    - "Turn on auto-accept" sends `{type, on: true}` and shows "Saving…" while it runs;
    - on: "Turn off auto-accept" sends `on: false`;
    - the section is there with remote access off and on;
    - no section when the status lacks `chromeAutoAccept`.
- [ ] Implement:
  - the `connection-ui` case;
  - in `bridge.js`: `agent.chromeAutoAccept = () => entry.coordinator.chromeAutoAccept()`, cleared in `detach`;
  - `chromeSection()` in the runtime, appended to `bottom` after the devices.
- [ ] Run the three test files and commit.

### Task 4: Docs, full suites, patch dry run

- [ ] Update `README.md`: the user-facing switch and its risk.
- [ ] Update `CLAUDE.md`: a sentence in the remote-bridge paragraph and in `webview-runtime.js`.
- [ ] Update the phone-remote spec: the Connection tab section and the `cce_remote_*` list.
- [ ] Run `bun test remote-bridge/test`, `bun test claude-commit/test`, the app tests and build, and the sandbox patch dry run (`HOME=<scratch> bun run patch.ts --no-commit-button`). Commit.

## After the tasks

- A fresh whole-branch review (opus), then fix what it finds.
- Merge into main, push, patch the Mac (`bun run patch.ts --no-commit-button`), and update memory.
