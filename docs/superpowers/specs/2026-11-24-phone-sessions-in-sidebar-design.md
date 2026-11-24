# Phone sessions open in the sidebar (design)

Date: 2026-11-24 · Status: approved 2026-11-24, to be built.

The user asked: "when opening a new session from the web app, it opens a new tab in the code editor view instead of inside the claude code extension … is it somehow possible to make it so that a new session will open inside the claude code extension instead of a new tab inside the code view?" They keep Claude Code in the right-hand sidebar (`claudeCode.preferredLocation` is `"sidebar"` in their Insiders settings), and the phone's session landed as a tab next to their code. They approved the design below as proposed.

## What happens today

- `WindowAgent.send(null, …)` runs `claude-vscode.editor.open(undefined, …, {programmatic:"pin-to-panel"})`, which always opens an editor tab. The agent then takes the first channel that is new and has no session yet, injects the prompt and waits for the session's name.
- `send(id, …)` for a listed session without a channel (`_channelFor`) opens it the same way, and the tab resumes it. A tab that still shows the session without a Claude process is closed first and the session reopened in a fresh tab. A session the sidebar shows without a process gets one open, then `not_running_in_vscode`.
- `open(id)` and `openClaude()` already pass `{programmatic:"honor-preferred-location"}`.
- "New sessions open in an editor tab" was one of the phone remote's design decisions (`2026-11-19-phone-remote-design.md`). Nothing in the extension requires it.

## What the extension does (read from 2.1.330)

- **Where `editor.open` opens.** With `programmatic` set, it opens in the sidebar when the option is `"honor-preferred-location"`, the preferred location is `"sidebar"` (anything else counts as `"panel"`) and no editor tab holds the session. Otherwise it opens an editor tab. With `programmatic` set, it never saves the preferred location.
- **The sidebar path.** `provider.activateInSidebar(sessionId, initialPrompt)` parks the request in `provider.pendingSidebarActivation`. It hands it to the sidebar's comms (`provider.sidebarComms`) at once, or when the sidebar's webview resolves; a request parked for more than 15 s is dropped. Then the command focuses the view: `claudeVSCodeSidebarSecondary.focus` on VS Code 1.106 or later, else `claudeVSCodeSidebar.focus`.
- **In the webview.** The comms waits for its `clientReady`, then posts `activate_session`. The webview first finishes its own start-up (restoring or creating its first session). Then it opens the session, or, when no session was given, creates a new one and makes it the active one.
- **A session that becomes active starts its Claude process at once** (`preloadConnection` → `launch_claude`). The host's channel for a new session has no session id; a resumed one carries its id from the launch. This is the channel the agent already waits for in a tab.
- **What a switch ends.** When the active session changes, the webview ends other sessions' processes only if they are unused empty chats (`endUnusedProcess`). A session with messages keeps running. Its unsent text is kept: Claude Code keeps it since 2.1.300, and the patch adds the @-mentions.
- **A sidebar that starts with nothing to restore** creates an empty start-up chat, which starts its own Claude process. A request parked until then is handled after that chat. So two channels without a session id appear one after the other, and the start-up chat's process ends once the new session becomes active.
- **Older extensions** without `activateInSidebar` (2.1.220, in Cursor) ignore the option, and `editor.open` opens a tab, as today.

## Approaches

1. **Claude Code's own open, honoring the preferred location** (picked). The bridge passes `honor-preferred-location` where it passes `pin-to-panel` today, so a new session opens where the user keeps Claude Code. The extension's own session list opens sessions this way, the bridge's `open` and `openClaude` already do, and the injection stays on the host side.
2. **Creating the session inside the sidebar's webview**, through the Connection-tab runtime loaded there. It needs a new host→webview message path, against the phone remote's rule that every action is injected on the host side, for the same result.
3. **Always the sidebar, whatever the setting.** It overrides the user's own choice and gains nothing.

## Behaviour

- **New session from the phone** (`send(null, …)`): `editor.open(undefined, …, {programmatic:"honor-preferred-location"})`. Where Claude Code is kept in the sidebar, the sidebar switches to the new session; where it is kept in tabs, a tab opens as today. The agent takes the new channel and injects the prompt as before.
- **A sidebar that hasn't started yet in that window.** This path applies when the host has `activateInSidebar`, the preferred location is `"sidebar"` and `provider.sidebarComms` is not set.
  - The agent first reveals the sidebar with the focus command the extension uses.
  - It waits until the sidebar has started: its comms is there and its `clientReady` has resolved.
  - Then it waits for the start-up chat's channel, or for a short time to pass. A sidebar that reopens an older session starts no start-up chat.
  - Only then does it run `editor.open`. The start-up chat's channel is already known by then, so it can't be taken for the new session.
  - The whole wait for the new session's channel, sidebar start included, stays within `channelWaitMs` (20 s), as today.
- **An older session the phone messages that has no Claude process and isn't shown anywhere**: `editor.open(id, …, {programmatic:"honor-preferred-location"})`. The sidebar switches to the session and resumes it; for a tab user, a tab opens as today. The agent finds its channel by session id, as before.
- **Unchanged:**
  - a session that an editor tab still shows without a process is closed and reopened in a tab (`pin-to-panel`);
  - a session the sidebar shows without a process gets one open, then `not_running_in_vscode`;
  - `open` and `openClaude`.
- **The trade-off.** The sidebar switches to the phone's session. If the session it showed has messages, it keeps running, stays in the sessions panel and keeps its unsent text. If it was an empty chat, Claude Code ends its idle process, as when the user starts a new session there.

## Non-goals

- Reusing an empty chat that the sidebar shows for the phone's message.
- Waking a session that the sidebar shows without a process (it stays `not_running_in_vscode`).
- Changes to the phone app or the hub. Only code comments that name the editor tab are corrected (`remote-app/src/lib/client.ts`, `remote-bridge/lib/hub.js`, `remote-bridge/lib/window-agent.js`), along with the phone remote's design doc.

## Testing

- **Test-first on the fake extension** (`remote-bridge/test/window-agent.test.ts`):
  - The fake vscode gains `workspace.getConfiguration(section).get(key)` and `version`.
  - The fake provider gains an optional `activateInSidebar` and `sidebarComms`, and a comms gains `clientReady`.
- **Cases:**
  - a new session with the sidebar preference and with the panel preference;
  - a sidebar that hasn't started: one with an empty start-up chat, and one that reopens an older session and starts no start-up chat;
  - an older session woken in the sidebar;
  - the unchanged tab and sidebar cases;
  - a host without `activateInSidebar`.
- **End to end:** an isolated Insiders with the patched 2.1.330 (the recipe in CLAUDE.md). Send a new session through the window agent and check that the sidebar shows it, both for a sidebar that has started and for one that hasn't.

## Left to the builder

- The short wait for the start-up chat's channel (about 3 s).
- How the agent reads the preferred location: through `vscode.workspace.getConfiguration("claudeCode")`, as the host reads it, or through the host's `provider.settings.getPreferredLocation()` where that exists.
