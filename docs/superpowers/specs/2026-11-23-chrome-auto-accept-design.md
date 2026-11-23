# Claude in Chrome auto-accept (design)

Date: 2026-11-23 · Status: built on 2026-11-23.

The user asked (relayed by another session, then confirmed directly): "find a way that I dont need to confirm to use the browser all the time … maybe it's possible to implement something that will auto accept if claude code extension asks for permission to use the browser."

Of the options offered, the user picked **B**: an opt-in switch in the Connection tab, off by default. While it is on, the bridge answers Claude in Chrome's permission prompts in VS Code, both kinds, and takes the "always allow this site" option, so each site asks at most once per session. Every other prompt stays as it is.

## Why the existing ways don't help

Two kinds of prompt come up when Claude uses Chrome from VS Code:

1. **Tool prompts** for the `mcp__claude-in-chrome__*` tools. The user's `PermissionRequest` hook answers "allow" for them, but in auto mode the CLI ignores a hook's approval for Claude in Chrome tools ("while auto mode is on … a hook cannot approve <tool>").
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
- the tool's name starts with `mcp__claude-in-chrome__`;
- the switch is on, read as the prompt passes;
- `classifyPending` reads it as a tool prompt.

Such a prompt is **swallowed**: VS Code never shows it, the phone never sees it, and no attention or push event fires. The agent answers it on the next microtask through the comms' original `fromClient`, as VS Code's own button would:
- **"Always"** goes back only when VS Code would offer it (`canAlwaysAllow`) and every suggestion only allows Claude in Chrome for this session. That means each suggestion is `addRules` with behaviour `allow` and destination `session`, and every rule is either a site (`ClaudeInChromeDomain` with a `ruleContent`) or a `mcp__claude-in-chrome__` tool. The suggestions go back unchanged as `updatedPermissions`. This is the site card's "always allow this site", so a site asks once per session.
- **Otherwise it is a plain allow** (`updatedPermissions: []`). That writes no settings file and changes no mode.
- `inputs` go back unchanged as `updatedInput`.
- The log gets one line per answer: `window agent: Claude in Chrome auto-accept allowed <tool>[ and <site> for the session]`.

**If the answer can't go out** (the comms has no `fromClient`, or it throws), the prompt goes on to VS Code through the original `send`, and to the phone, as it would without the switch.

**Not touched, with the switch on or off:**
- every other tool;
- `AskUserQuestion` and `ExitPlanMode`;
- `user_dialog_request`.

**Turning it off** stops the answers at once in that window and within 2 s in the others. A site already allowed in a session stays allowed in that session, just as if the user had picked "always allow this site".

**The Connection tab** gets a "Claude in Chrome" section at the bottom. It shows whenever the status is loaded, with remote access on or off, but not for a bridge whose status lacks the field. It has:
- a status line: "Auto-accept is on" (green dot) or "Auto-accept is off" (grey dot);
- a button: "Turn on auto-accept" or "Turn off auto-accept";
- a hint that names the risk.

**The request** is `cce_remote_set_chrome_auto_accept {on: boolean}`. It calls `coordinator.setChromeAutoAccept(on)` and answers with a fresh status, which carries `chromeAutoAccept: boolean`. A value that isn't a boolean is refused without changing anything.

**`--revert`** leaves the flag in `state.json`: with the bridge gone, nothing answers. Patching again brings the switch back as it was.

## Risk

With the switch on, a web page that Claude reads in Chrome could steer it into acting on that page or on other sites, and no prompt would appear (prompt injection). This is the trade the user accepted. The tab's hint and the README say it plainly.

The switch is off by default, and it can only be turned on from a VS Code window.

## Testing

Test-first, on fakes:
- **Window agent** (fake extension): on, off, other tools, the always rule, and an answer that can't go out.
- **Coordinator**: temp `CCE_REMOTE_HOME`; covers the getter, the setter, status, and the watcher.
- **`connection-ui`**: the new request.
- **The Connection tab**: the fake DOM.
- **`bridge.js`**: the wiring.

A real Claude in Chrome prompt can't be raised from the tests: the Chrome extension isn't connected in the isolated editor. The user checks it in their own windows after the reload, and the extension's log line shows each answer.
