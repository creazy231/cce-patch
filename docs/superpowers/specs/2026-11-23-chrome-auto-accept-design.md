# Claude in Chrome auto-accept (design)

Date: 2026-11-23 · Status: built on 2026-11-23.

The user asked (relayed by another session, then confirmed directly): "find a way that I dont need to confirm to use the browser all the time … maybe it's possible to implement something that will auto accept if claude code extension asks for permission to use the browser."

Of the options offered, the user picked **B**: an opt-in switch in the Connection tab, off by default. While it is on, the bridge answers Claude in Chrome's permission prompts in VS Code, both kinds, and takes the "always allow this site" option, so each site asks at most once per session. Every other prompt stays as it is.

The whole-branch review found that the CLI marks some Claude in Chrome prompts for a person (`defaultToNo`). These include every action the auto-mode safety check blocked. Answering them would switch off Claude Code's last check against prompt injection, and the user had not been told that. So the switch answers only the **routine** prompts: the ones the user's own `PermissionRequest` hook (`afk-auto-allow.sh`, matcher `mcp__claude-in-chrome__.*`) is meant to approve, and site cards. Prompts marked for a person still ask. See "Decisions after the review".

## Why the existing ways don't help

The user's logs (2026-11-23, window 9) show both outcomes:
- In some prompts the hook's allow counts and the tool runs 50 ms later. VS Code raises its prompt anyway and drops it again.
- In auto mode, the hook's allow is ignored for some Chrome tools: the auto-mode safety check skips them ("tool is on the safe allowlist"), and a hook can't approve them. Those prompts waited minutes for the user. One waited 8 minutes until the user picked "don't ask again" for `tabs_context_mcp` for the session.

Two kinds of prompt come up when Claude uses Chrome from VS Code:

1. **Tool prompts** for the `mcp__claude-in-chrome__*` tools. The user's `PermissionRequest` hook answers "allow" for them, but in auto mode the CLI ignores a hook's approval for Claude in Chrome tools ("while auto mode is on … a hook cannot approve <tool>"). The prompt then goes on as an ordinary ask, and nothing marks it for a person.
   - When the auto-mode safety check blocks a Chrome action (`chrome_floor_block`), the CLI asks a person instead of denying.
   - It does the same when the check has no verdict.
   - Those prompts carry `personOnly`, `hooksMayAllow:false`, `defaultToNo:true` and `suppressAlwaysAllowRule:true`. The host passes `defaultToNo` on to the webview, which then pre-selects No.
2. **The site card** ("Claude in Chrome requires permission", reason "Claude in Chrome action on <site>"). It comes when Chrome's extension answers an action with `needs_approval`. The CLI then asks through `canUseTool` with a forced ask, so no hook runs. Its suggestion is `{type:"addRules", rules:[{toolName:"ClaudeInChromeDomain", ruleContent:<site>}], behavior:"allow", destination:"session"}`, unless the CLI sets `suppressAlwaysAllowRule`.

Both reach the webview the same way. The host sends `{type:"request", channelId, requestId, request:{type:"tool_permission_request", toolName:"mcp__claude-in-chrome__<tool>", inputs, suggestions, defaultToNo, suppressAlwaysAllowRule, toolUseId, agentId, plugin, reason?}}`. The webview answers `{type:"response", requestId, response:{type:"tool_permission_response", result}}`.

The host registers its waiter before it sends (`sendRequest`). It also drops any `updatedPermissions` the prompt didn't suggest.

The extension has its own auto-allow for Claude in Chrome tools (`chromeToolsAutoAllowed`). It only works while the experiment gate `tengu_staged_ladybug` is `false`, so it can't be relied on.

## Behaviour

**The switch.**
- It is stored as `chromeAutoAccept: true` in `~/.cce-remote/state.json`. Any other value, or no file, means off.
- It covers every VS Code window: each window's coordinator watches the file, so the others follow within 2 s.
- It works whether remote access is on or off.
- The phone can't change it: no frame or hub call carries it.
- Turning it on creates the state file if there is none.

**What the window agent does with a prompt.** It acts only on a host→webview `request` whose inner request meets all of these:
- `type` is `tool_permission_request`;
- the tool is one of Claude in Chrome's: `mcp__claude-in-chrome__<tool>`, where `<tool>` is not empty and has no `__` (a server named `claude-in-chrome__x` doesn't pass);
- nothing marks it for a person: no `defaultToNo: true`, no `personOnly: true`, no `reason` (a safety check's words, such as a file upload's), no `hookReason` (a hook that asked);
- the switch is on, read afresh from the state file as the prompt passes;
- `classifyPending` reads it as a tool prompt.

Such a prompt is **swallowed**: VS Code never shows it, the phone never sees it, and no attention or push event fires. The agent answers it on the next microtask through the comms' original `fromClient`, as VS Code's own button would:
- **"Always"** goes back only when VS Code would offer it (`canAlwaysAllow`) and every suggestion only allows sites for this session. That means each suggestion is `addRules` with behaviour `allow` and destination `session`, and every rule is a site (`ClaudeInChromeDomain` with a `ruleContent`). The suggestions go back unchanged as `updatedPermissions`. This is the site card's "always allow this site", so a site asks once per session. A session rule for a whole tool would outlast the switch, so a tool prompt always gets a plain allow.
- **Otherwise it is a plain allow** (`updatedPermissions: []`). That writes no settings file and changes no mode.
- `inputs` go back unchanged as `updatedInput`.
- The log gets one line per answer: `window agent: Claude in Chrome auto-accept allowed <tool>[ and <site> for the session]`.

**If the host has withdrawn the prompt** before the answer goes out (its `outstandingRequests` no longer has it), nothing is sent. This happens when a hook answered it, or when the turn was stopped.

**If the answer can't go out** (the comms has no `fromClient`, or it throws or rejects) while the host still waits, the prompt goes on to VS Code through the original `send`, and to the phone, as it would without the switch.

**Not touched, with the switch on or off:**
- every other tool;
- `AskUserQuestion` and `ExitPlanMode`;
- `user_dialog_request`;
- any Claude in Chrome prompt marked for a person (see above).

**Turning it off** stops the answers at once in every window: each reads the switch as a prompt passes. A missing, unreadable or broken state file counts as off. A site already allowed in a session stays allowed in that session, just as if the user had picked "always allow this site".

**The log.** Each window's Claude Code output says when the switch was turned on or off there. It also says when the window starts with the switch on ("Claude in Chrome auto-accept is on"), and when the state file turned it on or off from elsewhere ("… (the state file changed)").

**The Connection tab** gets a "Claude in Chrome" section at the bottom. It shows whenever the status is loaded, with remote access on or off, but not for a bridge whose status lacks the field. It has:
- a status line: "Auto-accept is on" (green dot) or "Auto-accept is off" (grey dot);
- a button: "Turn on auto-accept" or "Turn off auto-accept";
- a hint that names the risk.

**The request** is `cce_remote_set_chrome_auto_accept {on: boolean}`. It calls `coordinator.setChromeAutoAccept(on)` and answers with a fresh status, which carries `chromeAutoAccept: boolean`. A value that isn't a boolean is refused without changing anything.

**`--revert`** turns the switch off in `state.json` (`turnChromeAutoAcceptOff`). Windows that still run the bridge until they reload stop answering at once, and a later patch starts with the switch off.

## Risk

With the switch on, a web page that Claude reads in Chrome could steer it into acting on that page or on other sites, and no prompt would appear (prompt injection). This is the trade the user accepted. The tab's hint and the README say it plainly. Prompts that Claude Code's safety checks mark for a person still ask.

The switch is off by default. Within the bridge's protocols, only a VS Code window's Connection tab can turn it on. Any program running as the user can write the state file, as it could write `~/.claude/settings.json`; each window logs such a change.

## Decisions after the review

- **Prompts marked for a person stay with the person.** The reviewer showed that answering `defaultToNo` prompts would approve exactly the Chrome actions that the auto-mode safety check blocked. The user's logs and the CLI show that the prompts the user answers by hand are ordinary asks. So the switch still covers what was asked for, without overriding Claude Code's safety checks.
- **Sites only for "always".** A tool's session rule would outlast the switch.
- **The tool name rule** keeps out a server named `claude-in-chrome__…`.
- **Read the switch afresh, failing closed.** Deleting the file, a revert, or a change in another window counts at once.
- **`--revert` turns it off.**
- **Not changed:** `updateState` has no lock, as for every other key in the file. It is not worth a lock here: the races are milliseconds wide, and the tab shows a fresh status every 2 s.

## Testing

Test-first, on fakes:
- **Window agent** (fake extension): on, off, other tools, the always rule, and an answer that can't go out.
- **Coordinator**: temp `CCE_REMOTE_HOME`; covers the getter, the setter, status, and the watcher's log.
- **`store.chromeAutoAcceptOn`**: what counts as on, and that it never writes.
- **`turnChromeAutoAcceptOff`** (`--revert`).
- **`connection-ui`**: the new request.
- **The Connection tab**: the fake DOM.
- **`bridge.js`**: the wiring.

A real Claude in Chrome prompt can't be raised from the tests: the Chrome extension isn't connected in the isolated editor. The user checks it in their own windows after the reload, and the extension's log line shows each answer.
