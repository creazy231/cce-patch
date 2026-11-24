# Phone remote for Claude Code (Connection tab + CCE Remote web app) — design

Date: 2026-11-19 · Status: decided autonomously (the user asked for no questions and
is away; every call below is marked as ours so it can be reviewed afterwards)

## Intent

The user runs several VS Code windows (projects), each with Claude Code sessions.
They want to leave the desk and keep working from their iPhone. On the phone they
want to see what each session is doing right now, answer Claude's questions and
permission prompts, and send new messages. The phone and the Mac are already in the
same Tailscale network. The phone side is a web app that the user hosts on their
Coolify server and adds to the home screen. Nothing about the sessions should go
through that server or any third party. The phone talks to the Mac over Tailscale.

Asked for, in their words:

1. A third tab, **Connection**, next to **Local** and **Web** in the sessions
   panel (the sidebar this patch adds). From it, the user connects with Tailscale.
2. A PWA website, hosted on Coolify, installable with "Add to Home Screen". It
   connects over Tailscale and shows (1) the open projects and (2) every session
   that is not archived. It mirrors the extension's output so the user can see where
   a session is. It lets the user answer whatever Claude asks (select options or
   type, as in VS Code), and has a text area for new messages. In short, it
   controls every open VS Code project and all of its Claude Code sessions.
3. An icon (and any other images) made with the Gemini image skill.
4. The website lives in a folder of this repo. No deployment for now.
5. The repo is public: nothing private may end up in it.

## Goals

- See every open VS Code window (with the patched Claude Code), across editors
  (Insiders, Cursor, VS Code) on the Mac, as a project. Each project lists its
  non-archived local sessions with a live status: waiting for input, running,
  finished (unread), or idle.
- Open a session and see its transcript: user messages, Claude's answers
  (Markdown), tool calls with their key arguments, results (shortened), and the todo
  list. Claude's text streams in live while it runs.
- Answer every prompt VS Code shows for a tool. That covers permission prompts
  (Yes / Yes, and don't ask again / No + reason), questions (`AskUserQuestion`:
  single and multi select, "Other" with text, several questions), and plan approval
  (`ExitPlanMode`: auto-accept / manual / keep planning + feedback). When the phone
  answers, VS Code's prompt goes away, and the other way round.
- Send a message to any listed session (existing, idle or running) and start a new
  session in any project. Stop a running turn. Attach photos (images) to a message.
- Pair the phone once: a QR code or link plus a one-time code shown in the
  Connection tab. After that the phone reconnects by itself.
- Works on an iPhone home-screen web app: safe areas, keyboard, offline app shell,
  reconnect after the app was in the background.

## Non-goals

- Cloud ("Web" tab) sessions. They are on claude.ai and the official Claude app
  already covers them.
- Push notifications while the web app is closed, through Apple's push service:
  built in the follow-up design (`2026-11-19-push-notifications-design.md`).
- Changing settings, models, permission modes (other than what a plan approval does
  in VS Code too), MCP servers, or files from the phone. No file browser and no diff
  viewer.
- Deploying to Coolify (the user will do that later). We only ship a Dockerfile and
  instructions.
- Waking a sleeping Mac.

## Anti-goals (would make this a failure even if it works)

- **Anyone other than the user can drive Claude Code on the Mac.** A session can run
  shell commands, so this is remote code execution by design. Only paired devices
  of the Mac's own Tailscale user, over the tailnet, may connect. Never Tailscale
  Funnel, never a listener on a public interface, never a relay through a server.
- Session content leaving the tailnet (through the Coolify server, logs or
  analytics).
- The patched extension misbehaves while remote access is **off**. Off is the
  default, and in that state nothing listens.
- A broken anchor after an extension update silently breaks Claude Code. Every
  hook must fail closed (feature missing, extension fine) and show up as a `FAIL`
  verify line.
- Private data in the public repo: hostnames, tailnet names, IPs, emails, tokens,
  API keys, real session content in screenshots or fixtures.
- Touching the user's running editors while building this. No reload, no restart,
  no patching of the live install, no `tailscale serve` changes on their real
  tailnet from tests.

## What exists today (read from extension 2.1.327, cross-checked against 2.1.220)

The extension host (`extension.js`) owns the Claude CLI processes. The chat UI
(`webview/index.js`) is a React app inside a VS Code webview.

- **Provider** — one per window, the class with field `allComms=new Set` (unique in
  both versions). It holds `allComms` (a `Set` of comms objects, one per Claude
  webview: the sidebar, each editor tab, the Session Manager view), `webviews`,
  `sessionStates` (`Map<sessionId, {info:{sessionId,state,title},author}>`, state ∈
  `idle|running|waiting_input`, reported by the panels), `unreadSessionKeys`,
  `liveElsewhereSessions`, `settings`, `output` (the "Claude Code" log channel).
- **Comms** — the class `Mt extends Zl` (names are minified, the members are not).
  One per webview. `channels: Map<channelId, channel>` (a channel = one running CLI,
  `{sessionId, cwd, query, atRest, turnComplete, …}`), `pendingChannels`,
  `outstandingRequests`, `webview`, `cwd`. Methods: `send(msg)` (host → webview,
  posts `{type:"from-extension", message: msg}`), `fromClient(msg)` (webview → host,
  queued and handled in order), `processRequest(e, signal)` (handles webview
  requests, called with `this`), `getSession(id, purpose)` (transcript from disk,
  `{messages, …}`), `buildSessionList()` / `listSessions()` (the session list with
  `archived`, `summary`, `customTitle`, `lastModified`, `gitBranch`, `worktree`).
  `listSessions()` emits telemetry, so we call `buildSessionList()` when it exists.
- **Protocol** (host → webview, the argument of `send`):
  - `{type:"io_message", channelId, message, done}`. `message` is an SDK message
    (`system` (`init` starts a turn), `assistant`, `user` (tool results, and the
    CLI's **replay** of every user prompt, `isReplay: true`), `result` (ends a
    turn), `stream_event` (partial output, the CLI runs with
    `--include-partial-messages`)).
  - `{type:"request", channelId, requestId, request}` with `request.type` of
    `tool_permission_request` (`toolName, inputs, suggestions, toolUseId,
    defaultToNo, suppressAlwaysAllowRule, reason, hookReason, agentId`) or
    `user_dialog_request` (`dialogKind, payload, toolUseID`).
  - `{type:"cancel_request", targetRequestId}`: the webview aborts that request's
    UI (it's how the CLI withdraws a prompt).
  - `{type:"close_channel", channelId, error?}`.
- **Protocol** (webview → host, the argument of `fromClient`):
  `{type:"io_message", channelId, message, done}` (a prompt),
  `{type:"response", requestId, response}` (answers),
  `{type:"interrupt_claude", channelId}`, `{type:"launch_claude", channelId,
  resume, …}`, `{type:"request", channelId, requestId, request}`.
- **Answers VS Code sends** (`response.result`):
  - Tool, Yes: `{behavior:"allow", updatedInput: inputs, updatedPermissions: []}`.
  - Tool, "Yes, and don't ask again" (only when `suggestions` is non-empty and not
    `suppressAlwaysAllowRule`): `updatedPermissions` = the suggestions. A `setMode`
    suggestion with destination `session` is also applied with
    `set_permission_mode` first.
  - Tool, No: `{behavior:"deny", message: iC, interrupt: true}`, or with a reason
    `{behavior:"deny", message: J5 + reason, interrupt: false}` (the two texts are
    quoted in the bridge source).
  - `AskUserQuestion`, "Submit answers": allow with
    `updatedInput: {questions, answers}`. `answers` maps each question's text to the
    chosen labels joined by `", "`; "Other" is replaced by the typed text.
  - `ExitPlanMode`: "Yes, and auto-accept" = `set_permission_mode` `acceptEdits` (or
    `auto` when available), then allow with `[]`. "Yes, and manually approve edits"
    = `set_permission_mode` `default`, then allow with
    `[{type:"setMode",mode:"default",destination:"session"}]`. "No, keep planning" =
    deny with `"User chose to stay in plan mode and continue planning"`
    (`interrupt: true`), or `J5 + feedback` (`interrupt: false`).
- **A prompt the webview did not send still shows in VS Code.** The CLI replays it
  (`isReplay`), the webview inserts unknown replays as user rows, and `system/init`
  / `result` drive its busy state. So injecting a prompt on the host side keeps the
  VS Code panel in sync.
- `claude-vscode.editor.open(sessionId?, initialPrompt?)` opens a session (or a new
  one) in an editor tab. A new panel starts its CLI right away
  (`preloadConnection`), so a channel exists before the first prompt.
  `initialPrompt` only pre-fills the input. (2.1.328: the sixth argument is
  `{programmatic}`; without it the open counts as the user's choice and
  `claudeCode.preferredLocation` is saved as "panel" in the user's settings;
  `claude-vscode.sidebar.open` always saves "sidebar". VS Code's own session list
  passes `programmatic`, and so does the bridge.)
- The extension activates on `onStartupFinished` in every window. `extension.js` is
  CommonJS (starts with `var __EXT_BUNDLE_URL = require('node:url')…`), so
  `require` works anywhere in it.
- Webview: the sessions list component has
  `[TAB,SET]=useState("local")` (2.1.327: `let pe=y==="claudeai",[J,F]=B("local"),G=pe?J:"local",`;
  2.1.220: `let C=p==="claudeai",[y,x]=ne("local"),`), the tab row
  `k("div",{className:CSS.segmented,children:[<Local>,<Web>]})` (only rendered for
  claude.ai logins), and the list
  `m("div",{id:LIST_ID,className:\`${CSS.content} …\`,children:…})`. The app boots
  with `X.createRoot(document.querySelector("#root")).render(…{sessions:S,context:C…})`
  (twice: chat and Session Manager). `S.comms.connection.value.sendRequest(req)`
  sends a request to the host. CSP allows `img-src data:`, scripts by nonce (an
  appended script is part of the bundle, so it runs).
- Tailscale on a Mac: usually the GUI app, whose CLI wrapper is
  `/usr/local/bin/tailscale` → `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
  (1.9x–1.10x). The bridge has to start from any tailnet state, e.g. a tailnet with
  MagicDNS on and **HTTPS certificates still off** (`CertDomains` empty), where the
  phone is just another peer.

## Constraints

- **Mixed content.** The web app is served over HTTPS from Coolify. iOS Safari
  blocks `ws://`/`http://` requests from an HTTPS page. The Mac must therefore be
  reachable as `https://`/`wss://` with a trusted certificate: `tailscale serve`
  (HTTPS on the MagicDNS name, Let's Encrypt via Tailscale). That needs HTTPS
  certificates enabled once in the tailnet. The Connection tab detects this and
  links to the enable page.
- iOS home-screen apps have storage separate from Safari. Pairing must happen
  inside the installed app.
- `patch.ts` runs on Bun or Node with no dependencies, and the patched extension
  can only load what we copy into its folder. The bridge is plain CommonJS with no
  dependencies (like `claude-commit/`).
- Extension updates reshuffle minified names. Anchor on stable strings (protocol
  type names, class field names, CSS module keys), capture minified names with
  `[\w$]+`, verify each hook, and skip it when it's missing.
- The repo is public, and the remote app will be public on the internet (the page,
  not the data).

## Approaches considered

**Where the Mac side runs**
1. *Inside the Claude Code extension host, loaded by `patch.ts` (chosen).* Only
   there do we have the live channels, the permission prompts and the session list.
   The bridge is a separate CommonJS file copied into the extension folder. A
   one-line hook in `extension.js` hands it the provider.
2. *A companion extension (like `claude-commit/`).* Claude Code exposes no API, so
   another extension could only tail transcript files: no prompts, no injection.
   Rejected.
3. *A separate daemon (launchd).* Same problem: it can't see the extension's
   in-process sessions. Rejected.

**How the phone reaches the Mac**
1. *Directly over the tailnet: `tailscale serve` HTTPS → bridge on 127.0.0.1, with a
   WebSocket (chosen).* Private, end to end inside Tailscale. Needs HTTPS certs in
   the tailnet.
2. *Plain `ws://100.x.y.z`.* Blocked by mixed-content rules in an HTTPS PWA.
   Rejected.
3. *Relay through the Coolify server.* Puts session content and a control surface
   on a public server. Contradicts "connect via Tailscale". Rejected.
4. *Tailscale Funnel.* Public. Rejected.

**How to mirror and act**
1. *Host side: tap `send`/`fromClient` of every comms, inject messages through
   `fromClient` (chosen).* Uses the host↔webview protocol, the most stable contract
   in the bundle. It sees every SDK message and prompt. Injected prompts show in VS
   Code through the replay. Answers resolve the host's own pending request, and a
   `cancel_request` clears VS Code's prompt.
2. *Webview side: drive the React app's session objects.* Higher fidelity in VS Code
   (titles, held prompts), but it depends on many internal UI names and only works
   while that webview lives. Rejected.
3. *Read transcript files.* Read only. Rejected (used indirectly: history comes
   from the extension's own `getSession`).

**Several windows (each window has its own extension host)**
1. *Hub election on a fixed localhost port (chosen).* The first window binds
   `127.0.0.1:47821` and becomes the hub. The others connect to it as peers over a
   local link and register their project. When the hub window closes, a peer takes
   over. `tailscale serve` always points at that one port.
2. *One port per window, with `tailscale serve` path routing.* That rewrites the
   user's Tailscale config whenever a window opens. Rejected.

**Pairing / authentication**
- *Chosen: all of these.* (a) `tailscale serve` only: the bridge only answers phone
  requests that carry Tailscale's `Tailscale-User-Login` header, and it must equal
  the Mac's own Tailscale login. (b) A one-time pairing code (QR / link / typed)
  that is exchanged for a random device token, stored hashed. (c) The origin
  recorded at pairing must match on later connections.
- *Tailscale identity alone* would let any device of that user (or a tailnet
  service running as them) control Claude without consent. Rejected as the only
  check.

**Web app stack**
- *Vite + Preact + TypeScript, static build served by nginx in Docker (chosen).*
  Small and fast on a phone, typed, and Coolify builds it from a Dockerfile.
  Dependencies: `preact`, `marked` + `dompurify` (Markdown, sanitised), `jsqr` (QR
  scanning).
- *No-build vanilla JS (the repo's habit).* The UI is large (transcript rendering,
  three prompt kinds, pairing, scanning), so types and components pay off.
  Rejected for the app, kept for the bridge.

## Design

### Overview

```
iPhone (home-screen PWA, origin https://<app domain>)
   │  wss://<mac>.<tailnet>.ts.net:47821/ws   (Tailscale, HTTPS by tailscale serve)
   ▼
tailscale serve  ──►  127.0.0.1:47821  ── hub (one of the windows' bridges)
                                          │ local peer links (NDJSON over HTTP Upgrade)
                        ┌─────────────────┼──────────────────┐
                    window agent      window agent       window agent
                 (VS Code window A) (window B, Insiders) (window C, Cursor)
                    taps comms ⇄ Claude Code extension host ⇄ CLI processes
```

### Repo layout

```
remote-bridge/            CommonJS, no deps; patch.ts copies it to <ext>/cce-remote/
  bridge.js               attach(provider): starts the window agent + coordinator
  lib/window-agent.js     taps comms, tracks channels/sessions/prompts, executes actions
  lib/coordinator.js      on/off, hub election, re-election, config watching
  lib/hub.js              HTTP server, phone WebSockets (auth, routing), peer registry
  lib/peer-link.js        NDJSON RPC over an HTTP "Upgrade: cce-peer" socket
  lib/ws.js               minimal RFC 6455 server (text frames, ping/pong, close)
  lib/store.js            ~/.cce-remote/state.json (0600), atomic writes
  lib/pairing.js          codes, tokens, hashing, attempt limits
  lib/tailscale.js        CLI discovery, status, serve on/off, consent-URL parsing
  lib/transcript.js       SDK message → trimmed phone message
  lib/qr.js               QR code → SVG path (vendored MIT encoder, notice kept)
  lib/connection-ui.js    answers for the Connection tab (cce_remote_* requests)
  test/*.test.ts          bun test (fake provider/comms, real sockets)
remote-app/               the PWA (Vite + Preact + TS), Dockerfile, nginx.conf
patch.ts                  + hooks for extension.js, the webview, CSS; copies the bridge
docs/…                    this design + the plan
```

### Bridge — attach hook (`extension.js`)

`patchExtensionRemote` replaces the provider's `allComms=new Set` with
`allComms=(function(p){try{require("./cce-remote/bridge.js").attach(p)}catch(e){try{console.error("[cce-remote]",e)}catch(_){}}})(this)||new Set`.
The field initializer runs at the start of construction, so `attach` gets the
provider instance and defers all work (`setImmediate`) until the constructor is
done. If the folder is missing or throws, the extension continues unchanged. Verify
line: `remote bridge hook`. `installRemoteBridge` copies `remote-bridge/bridge.js`
and `remote-bridge/lib/**/*.js` (plus `LICENSE`/notice files) to
`<extDir>/cce-remote/`. `--revert` deletes that folder and, when `state.json` says
remote access is on, sets `enabled:false` there and turns `tailscale serve` off for
the bridge's port (20 s at most; if that fails it prints the command to run). With
remote access off it leaves serve alone, even one left on by a turn-off that failed.
`~/.cce-remote/` itself stays: pairings, secret and app address. `--no-remote` skips
the hook, the copy and the webview tab.

`attach(provider)` (idempotent per provider):
- wraps `provider.allComms.add` so every new comms is instrumented at once, and
  instruments the existing ones;
- creates the window agent and the coordinator (which starts only when enabled).

### Bridge — window agent

Per comms (instance-level wrappers, the class stays untouched):
- `send(msg)`: observe, then call the original — except for responses to requests
  the bridge injected itself (`requestId` starting with `cce-remote-`), which are
  swallowed so the webview doesn't log "No handler".
- `fromClient(msg)`: observe, then call the original — except a webview's late
  `response` for a request the phone already answered (kept 60 s), which is dropped,
  and a `cce_remote_*` request (the Connection tab), which is answered here
  (`connection-ui.js`, the response through the original `send`): the host reads
  webview messages in order and awaits each `launch_claude`, so a launch that waits
  (Claude Code's folder-trust dialog) would hold the tab up.
- `processRequest(e, signal)`: `e.request.type` starting with `cce_remote_` →
  `connection-ui.js` (should one get this far); anything else → the original.

State it keeps (memory only):
- **Channels**: `comms.channels`/`pendingChannels` are read live. The session of a
  channel is `channel.sessionId`, or the `session_id` of its messages.
- **Live buffer per session**: the last 500 non-stream messages seen since attach,
  by `uuid`. Only while remote access is on (the coordinator calls `setEnabled` when
  it sees `enabled` change): while it is off the agent maps, keeps and emits no
  session messages and lets go of what it kept. It still follows prompts, turns and
  the channels' sessions, so a prompt that waits when remote access is turned on can
  be answered, and it still answers the Connection tab.
- **Pending prompts per session**: from `request` messages
  (`tool_permission_request`, `user_dialog_request`). Removed on the webview's
  `response`, on a host `cancel_request`, on `close_channel`, or when the phone
  answers.
- **Turn state per session**: `system/init` → running, `result` → idle, plus
  `channel.atRest`.

Project (one per window):
```
{ id, name, folders, editor, claudeOpen, sessions: [
  { id, title, lastModified, state: "waiting"|"running"|"unread"|"idle",
    live, gitBranch?, worktree?, pendingCount } ] }
```
- `id` = first 12 hex of sha1(`vscode.env.appName` + folders). It stays stable
  across reloads; the hub appends `-2`, `-3` on clashes.
- `name` = `vscode.workspace.name` ?? basename of the first folder ?? "No folder".
  `editor` = `vscode.env.appName`.
- Sessions = `buildSessionList()` of any comms in the window (`listSessions()` if
  missing), `archived` dropped, sorted by `lastActivity ?? lastModified`, up to
  200. Sessions that have a channel but are not listed yet (brand new) are added
  as "New session". Title = live title in `sessionStates` ?? `customTitle` ??
  `summary` ?? "Untitled".
- State = waiting (pending prompt, `waiting_input` in `sessionStates`, or
  `liveElsewhereSessions` activity `waiting`) > running (turn open, `running`) >
  unread (`unreadSessionKeys` has it) > idle.
- No comms in the window → `claudeOpen: false`, no sessions. The phone offers
  "Open Claude Code" (`openClaude()`).
- The list is refreshed only while at least one phone is connected: on connect,
  every 15 s, and 1 s after channel / title / turn changes (debounced). A project
  event is emitted only when the JSON changed.

Actions:
- `snapshot(sessionId)` → `{messages, pending, state, live, truncatedBefore}`:
  `comms.getSession(id)` (no purpose argument, so no telemetry) merged with the live
  buffer, mapped by `transcript.js`, the last 400 that fit 2 MiB kept. The transcript
  on disk has no `result` messages, so a live message the history lacks goes right
  after the live message before it (by its timestamp when nothing before it is
  placed, else at the end). Errors for a brand-new session give an empty history.
- `send(sessionId|null, text, images)`: builds the webview's message shape
  `{type:"user", uuid, session_id:"", parent_tool_use_id:null, message:{role:"user",
  content:[…images as {type:"image",source:{type:"base64",media_type,data}}, {type:"text",text}]}}`
  and `fromClient({type:"io_message", channelId, message, done:false})`. The channel
  is the one on that session (also pending ones). Without one:
  `executeCommand("claude-vscode.editor.open", sessionId, …, {programmatic:"honor-preferred-location"})`,
  so it opens where the user keeps Claude Code (the sidebar or a tab; see
  `2026-11-24-phone-sessions-in-sidebar-design.md`), wait up to 20 s for a channel on
  that session, then inject. A session an editor tab shows without a channel (its CLI
  exited; showing it again does not start one) has that tab closed first
  (`provider.sessionPanels`) and is reopened with `pin-to-panel`, so a fresh tab
  resumes it; one the sidebar shows gets one open, then `not_running_in_vscode` after
  5 s. For a new session (`null`): `editor.open` with no session and
  `honor-preferred-location`, wait up to 20 s for a channel that didn't exist before
  and that the webview hasn't closed (in the sidebar: the newest such channel, once it
  has stayed the newest for 500 ms, so a booting sidebar's start-up chat is never
  taken), then inject. Text ≤ 100 000 chars; ≤ 4 images, ≤ 5 MB
  base64 each, `image/jpeg|png|gif|webp`.
- `answer(sessionId, requestId, result)`: the request must be pending on that
  session. The result is validated and normalised by kind (the shapes listed under
  "What exists today"; the phone sends a structured choice, the bridge builds the
  exact payload, see the phone protocol). Optional mode change first
  (`fromClient({type:"request", channelId, requestId:"cce-remote-…",
  request:{type:"set_permission_mode", mode, userInitiated:false}})`; `false` as VS Code sends for prompt-driven mode changes — `true` would persist the mode into the user's settings). Then
  `fromClient({type:"response", requestId, response:{type: tool ?
  "tool_permission_response" : "user_dialog_response", result}})`, then
  `send({type:"cancel_request", targetRequestId: requestId})` so VS Code drops its
  prompt.
- `interrupt(sessionId)`: `fromClient({type:"interrupt_claude", channelId})`.
- `open(sessionId)`: `executeCommand("claude-vscode.editor.open", sessionId, …,
  {programmatic:"honor-preferred-location"})`, as the session list opens a session.
- `openClaude()`: the same with no session: a new session where the user keeps
  Claude Code (never `claude-vscode.sidebar.open`, which rewrites that setting).

### Bridge — transcript mapping (`transcript.js`)

SDK message → phone message:
`{uuid, type, ts, role?, content?, subtype?, isReplay?, isMeta?, parent?, result?}`.
Drop `stream_event`, `system` except `compact_boundary`, `rate_limit_event`,
`prompt_suggestion`, `user` messages that are `isMeta`, and anything without a
`uuid` (except `result`). Trim: text blocks to 20 000 chars, `tool_result` content
to 3 000 (flattened to text), `thinking` to 2 000, every string in `tool_use.input`
to 4 000 (`Write`/`Edit` bodies), images → `{type:"image", omitted:true}`.
`result` → `{subtype, isError, durationMs, costUsd, numTurns}`. Subagent messages
(`parent_tool_use_id` set) are kept with `parent` so the app can fold them.

Live stream (not buffered): for watched sessions, `stream_event` with
`event.type` of `message_start`, `content_block_start`, `content_block_delta`
(`text_delta` only), `content_block_stop`, `message_stop`, and no
`parent_tool_use_id`, is forwarded as `{type, index, text?}`.

### Bridge — coordinator, hub and peers

- `state.json` (`$CCE_REMOTE_HOME` or `~/.cce-remote/`, dir 0700, file 0600):
  `{version:1, enabled:false, port:47821, secret, appUrl:"", devices:[{id, name,
  tokenHash, origin, createdAt, lastSeenAt}]}`. `secret` (32 random bytes, hex) is
  the key with which the windows prove themselves to each other; it never leaves
  the file. Writes are atomic (tmp + rename). Every window polls the file every 2 s
  (`fs.watchFile`) for `enabled`/`port`.
- Enabled → try `listen(port, "127.0.0.1")`. Success = hub. `EADDRINUSE` = connect
  as a peer. Peer link lost = wait 300–1500 ms (random), then try again: hub first,
  else peer. Disabled = close everything.
- A window closes: the bridge stops inside the provider's `shutdownAll()`, which
  the extension's `deactivate()` awaits, with a 2 s budget. Only a hub with no peer
  joined at that moment (the last remaining window, closed on its own) turns
  `tailscale serve` off (one try) and leaves `enabled` on, so the next start serves
  again. Quitting VS Code with two or more windows open stops them together: the hub
  still has its peers when it stops and they are stopping too, so serve stays on,
  as after a crash, until a window is the hub again (the next start), a Disconnect
  or `--revert`. A window that becomes the hub looks at serve afresh.
- Hub HTTP: `GET /health` → `{ok:true, app:"cce-remote", v:1}`; `GET /` → a short
  HTML page ("open the CCE Remote app"); `GET /ws` with WebSocket upgrade → phone;
  `/_peer` with `Upgrade: cce-peer` and `X-CCE-Nonce` → peer link (rejected if any
  `Tailscale-*` or `X-Forwarded-*` header is present, or the Host isn't loopback).
  Everything else → 404. Only the `/ws` upgrade accepts traffic coming from
  Tailscale.
- Peer link authentication: 127.0.0.1 is open to every program on the Mac (other
  macOS accounts, sandboxed apps, a container that publishes the port), so either
  side of `/_peer` may be an impostor. A mutual challenge–response with
  HMAC-SHA256 keyed with `secret` (its hex text) proves both sides know it, and the
  secret never goes on the wire:
  - the peer's upgrade carries `X-CCE-Nonce: <32 random bytes, hex>`;
  - the hub answers 101 with its own `X-CCE-Nonce` and
    `X-CCE-Proof: hex(HMAC(secret, "hub\n" + peerNonce + "\n" + hubNonce))`;
  - the peer checks that proof (constant time) before it sends anything. Missing or
    wrong → the port is held by another program: the window pauses remote access,
    turns `tailscale serve` off for the port, answers nothing, and on each retry
    checks serve again (and turns it off again if something turned it on);
  - the peer's first line is
    `{t:"auth", proof: hex(HMAC(secret, "peer\n" + peerNonce + "\n" + hubNonce))}`.
    The hub reads nothing else and sends nothing until it matches (within 5 s and
    1 KB, else the link closes), and registers the window only then. Links still
    waiting for their proof count against the peer limit.
- Peer link: NDJSON both ways over the upgraded socket. Messages:
  `{t:"call",id,m,a}` / `{t:"ret",id,ok,v|e}` / `{t:"evt",e,d}`. The peer sends
  `evt project` and `evt session` (session events). The hub calls `snapshot`,
  `send`, `answer`, `interrupt`, `open`, `openClaude`, `active` (phones connected
  yes/no). The peer calls the hub for the Connection tab: `status`,
  `newPairingCode`, `removeDevice`, `setAppUrl`.
- The hub writes `state.json` only when a device is paired or removed or the app
  address changes, never periodically: a write rewrites the whole file and could
  undo what another window wrote meanwhile (a Disconnect). When a phone was last
  heard from stays in the hub's memory; `devices()` and the status report the later
  of that and the file's `lastSeenAt` (the pairing time), and a peer's Connection
  tab gets it through the hub's status. Enabling and disabling are written by
  whichever window the user clicks in.

### Bridge — phone protocol (WebSocket JSON, protocol version 1)

Auth, for every `/ws` upgrade:
1. `Tailscale-User-Login` must be present, and must equal the Mac's own login
   (`tailscale status --json` → `User[Self.UserID].LoginName`) when that is known.
   `Tailscale-Funnel-Request` present → reject. (No bypass switch in production
   code. Tests put a header-adding proxy in front, as `tailscale serve` does.)
2. The first frame within 10 s is `pair` or `hello`, otherwise close 4400.
   Frames > 8 MB close the socket (1009).

Client → hub:
```
{t:"pair", code, device}                      → {t:"paired", deviceId, token, mac:{name}}
{t:"hello", v:1, deviceId, token}             → {t:"welcome", v:1, mac:{name}, push:boolean, now} then {t:"projects", …} then {t:"usage", …}
{t:"sub", project, session}                   → {t:"snapshot", …} then live events
{t:"unsub", project, session}
{t:"send", id, project, session|null, text, images?:[{mediaType,data}]} → {t:"ack", id, ok, error?, session?}
{t:"answer", id, project, session, requestId, choice}                     → ack
{t:"interrupt", id, project, session}                                      → ack
{t:"open", id, project, session} / {t:"openClaude", id, project}            → ack
{t:"visibility", visible}                                                   (no reply)
{t:"push_set", id, subscription:{endpoint, keys:{p256dh, auth}}, vapid:{publicKey, privateJwk}, subject, prefs:{waiting, done, onlyAway, details}} → ack
{t:"push_clear", id}                                                        → ack
{t:"push_test", id}                                                         → ack (push_off | push_gone | push_failed + status)
{t:"usage_refresh"}                                                         → {t:"usage", …} (no ack)
{t:"commands", id, project}                                                 → {t:"ack", id, ok, error?, commands?:[{name, description?, argumentHint?, aliases?, plugin?}]}
{t:"ping"}                                                                 → {t:"pong"}
```
`choice` (the bridge turns it into the exact VS Code payload):
- tool: `{kind:"allow"}` | `{kind:"allowAlways"}` | `{kind:"deny", reason?}`
- question: `{kind:"answers", answers:{[question]: string}}` | `{kind:"deny", reason?}`
- plan: `{kind:"approveAuto"}` | `{kind:"approveManual"}` | `{kind:"keepPlanning", feedback?}`
- dialog: `{kind:"cancel"}`

Hub → client:
```
{t:"projects", projects:[Project]}                 on welcome and on any change (300 ms debounce)
{t:"snapshot", project, session, messages, pending, state, live, truncatedBefore}
{t:"msg", project, session, message}
{t:"stream", project, session, event}
{t:"pending", project, session, pending:[Pending]}  the full list whenever it changes
{t:"usage", state:"ok"|"none"|"unsupported", fiveHour?:{percent, resetsAt?}, week?:{percent, resetsAt?}, at?, account?}
                                                    after projects on welcome, after usage_refresh, and on any change
{t:"ack", id, ok, error?, session?, status?, commands?}
{t:"error", code, message}                          e.g. bad_token, bad_code, revoked
```
Push frames (protocol version 1, backwards compatible): `welcome.push` says whether this
Mac holds a subscription for the device. `push_set` validates the endpoint against the
same allowlist used for sending, the subscription keys and the VAPID JWK, and the
subject (`https:` or `mailto:`); prefs are booleans and missing ones default to on.
Errors are `bad_request`, `bad_endpoint`, `bad_keys` and `save_failed`. `push_test`
ignores looking, away and the flood cap; its ack carries `push_off`, `push_gone` or
`push_failed` with the push service's status. A status-0 `push_failed` may also carry `reason`
(`refused`, `too_large`, `invalid`, `network`, `timeout` or `aborted`), why no answer came.
`visibility` has no ack: a socket counts
as visible from its hello until it says otherwise, and it stops counting as looking
after 40 s without a frame. An old bridge answers the new acked frames with
`unknown_type` and ignores `visibility`.

Usage frames (added 2026-11-20, protocol version 1, backwards compatible; design:
`2026-11-20-home-active-new-usage-design.md`). `welcome.now` is the Mac's clock (epoch ms) when
it sent the welcome; the app measures its read state and the usage's age in it. `usage` mirrors
Claude Code's own usage meter (2.1.325+): `percent` is the share used (to 0.1, may pass 100),
`resetsAt` and `at` are epoch ms (`at`: when the Mac got the numbers). `ok` carries the newest
numbers of any window; `none` means a window has the meter but no numbers (not yet, signed out,
a login without limits); `unsupported` means no window's Claude Code has the meter. A reset
time in the past is kept (the app shows that limit as 0 %). `usage_refresh` has no id and no
ack: the hub has the windows read the usage afresh through a running session's Claude process
(at most once a minute, the newest reading's window first, until one got new numbers) and
answers with a `usage` frame either way. An old bridge sends no `usage` and drops
`usage_refresh` (an unknown frame without an id).

`usage.account` (added 2026-11-21, backwards compatible) is the email of the Claude account
Claude Code on the Mac is signed in to, as `claude auth status` reported it to the extension
(each comms' `cliReportedAccountEmail()`, 2.1.330; the bridge reads no login files itself). In
`ok` it is the account of the reading the numbers come from and never another window's, which
could still be the account before a switch (a login in a terminal or another window); in `none`
it is the first account any window knows; `unsupported` has none. It is left out while Claude
Code doesn't know one (still asking, signed out, an API key or a third-party provider, an
older extension). The pairing is as good as Claude Code's own panel: an account change clears
the numbers and the account in one go, but a session still running from before a switch can
report one more set of numbers (its `rate_limit_event`, which Claude Code doesn't tie to the
account the way it does a `get_usage` read), shown with the new account until the next update.
The hub and the app keep it only as a non-empty string of at most 254 characters without
control, bidi or invisible characters, and the app shows it as the card's first line. An old
bridge sends none, and an old app ignores it.

Slash commands (added 2026-11-22, protocol version 1, backwards compatible; design:
`2026-11-22-slash-commands-design.md`).
- **The request.** `commands` asks the project's window for its slash commands. They are the Claude Code commands VS
  Code's `/` menu lists for it, named as VS Code names them (the plugin-prefixed alias when two share a name). The hub
  routes it like the other acked actions (the hub's own window, or a peer), and the window has 15 s.
- **Where the window reads them.** From what the extension already holds, in this order:
  - a comms' loaded config (`settledConfig.commands`), the window's folder first;
  - the stored copy the webview shows while that loads;
  - a running session's `query.supportedCommands()`;
  - a config still loading.

  It never asks the extension to load one, which can start a Claude process. `[]` is a normal answer (no Claude Code
  webview open, no list yet).
- **The hub's checks on the ack:**
  - at most 300 commands;
  - names of 1–100 characters, each once, without control, bidi or invisible characters, and without whitespace
    except one trailing ` (MCP)` (an MCP server's prompts);
  - descriptions on one line, cut to 300 characters; argument hints and plugins to 100;
  - at most 10 aliases, each with the name rule.
- **Older bridges.** An old hub answers `unknown_type`, and an old peer window `unknown_method`. The app then says the
  Mac can't list commands, and stops asking until the next welcome.
- **Phone messages** (`send`) now carry `origin: {kind: "human"}`, as the webview marks what the user types. Claude Code
  runs a plugin's local commands only from such a message.

Only `bad_token`, `bad_origin` and `revoked` mean the phone itself was refused: the app
stops and asks to pair again. Any other error (e.g. `unsupported_version` before the
welcome) is shown while the app keeps retrying; a code the app doesn't know shows the
frame's `message`. After a `timeout` or a connection that closed first, nobody knows
whether a request was carried out, so the app says "not confirmed", never "not sent".
`Pending = {requestId, kind:"tool"|"question"|"plan"|"dialog", toolName, input,
suggestions?, canAlwaysAllow, alwaysLabel?, reason?, createdAt, dialogKind?}`.
`kind` is set by the bridge: `AskUserQuestion` → question, `ExitPlanMode` → plan,
other tools → tool, `user_dialog_request` → dialog (shown as "answer in VS Code",
with Cancel).

Pairing: `newPairingCode()` makes an 8-character code from
`ABCDEFGHJKMNPQRSTUVWXYZ23456789` (shown as `XXXX-XXXX`), valid 10 min, single use,
invalid after 5 wrong tries. One code at a time; a new one replaces the old. On
`pair` the hub creates `{id: 16 hex, token: 32 random bytes base64url}` and stores
`sha256(token)` and the WebSocket `Origin`. On `hello` the token hash is compared
with `timingSafeEqual`, and the `Origin` must equal the stored one. The hello and
every later frame update the hub's in-memory last-seen time (see above), never
`state.json`.

Pairing link: `<appUrl or https://cce-remote.invalid>/#pair=<base64url(JSON
{v:1,u:"https://<dnsName>:<port>",c:"<code>",n:"<mac name>"})>`. The app parses the
`pair=` fragment from a scanned QR, a pasted link, or its own URL on load.

### Bridge — Tailscale (`tailscale.js`)

- CLI: `$CCE_REMOTE_TAILSCALE`, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, `/usr/bin/tailscale`,
  then `tailscale` on `PATH`. 5 s timeout on every call except serve on (20 s).
- `status()` (cached 5 s): `{installed, running (BackendState === "Running"),
  backendState, loginName, dnsName (Self.DNSName without the trailing dot),
  hostName, httpsEnabled (CertDomains non-empty)}`.
- `serveOn(port)`: `serve --bg --https=<port> http://127.0.0.1:<port>`. Output with a
  `https://login.tailscale.com/…` link → `{needsConsent: url}` (the process is killed
  after the link appears). `serveOff(port)`: `serve --https=<port> off`.
  `serveStatus()`: `serve status --json`, true when our port proxies to
  `http://127.0.0.1:<port>`.
- `openApp()`: `open -a Tailscale` (macOS only).

### Connection tab (webview)

Hooks in `webview/index.js` (`patchWebviewConnection`), each verified:
1. **Attach**: `X.createRoot(document.querySelector("#root")).render(` →
   `(window.__cceRemote&&window.__cceRemote.attach(S),X).createRoot(…` with `S` the
   `sessions:` prop captured right after. Both roots (chat and Session Manager).
2. **Tab state**: after `[TAB,SET]=USESTATE("local"),` insert
   `[__cceConn,__cceSetConn]=USESTATE(!1),`.
3. **Tab row**: the row renders for every login (remove its `claudeai &&` guard; for
   other logins the Web button is hidden with a class `cce-no-web`). The row gets
   `onClickCapture` (a click on a non-Connection tab closes Connection) and the class
   `cce-conn-on` while Connection is open (CSS removes the Local/Web highlight). A
   third button `Connection` (class `cce-conn-tab`, the tab classes,
   `aria-pressed`) is appended to the row's children.
4. **Content**: `m("div",{id:LIST,…})` → `__cceConn?m("div",{className:CSS.content+" cce-conn",ref:window.__cceRemote.mount}):m("div",{id:LIST,…})`.
   The root div gets `cce-conn-root` while open, and CSS hides its search row.

`window.__cceRemote` (appended to the bundle, plain DOM, every call guarded):
- `attach(sessions)` keeps the sessions manager. `request(type, data)` =
  `sessions.comms.connection.value.sendRequest({type, ...data})`.
- `mount(el)` renders the Connection view into `el` and polls `cce_remote_status`
  every 2 s while mounted (`mount(null)` stops).
- View (VS Code tokens only, same look as the panel):
  - Header: "Phone remote" + one sentence: "Control this Mac's Claude Code sessions
    from your phone over Tailscale."
  - Tailscale row: state dot + text (Connected as `login` · `dnsName` / Not
    installed → link to tailscale.com/download / Stopped or logged out → "Open
    Tailscale" / HTTPS certificates off → "Turn on HTTPS" link (consent URL from
    `serveOn` or `https://login.tailscale.com/admin/dns`)).
  - Primary button: **Connect with Tailscale** (off) / **Disconnect** (on). Connect
    = enable + `serveOn` + start. While busy: "Connecting…".
  - When on: address `https://<dnsName>:<port>`, role (this window is the hub /
    connected to the hub), number of connected windows.
  - Pair a phone: QR (SVG from the host), code `XXXX-XXXX`, expiry countdown, "New
    code", "Copy link". Steps: 1) open the CCE Remote app on your phone (Tailscale
    on) 2) Add Mac → scan, or paste the link.
  - Phone app address: a text field + Save (`appUrl`, used in the QR link).
  - Paired devices: name · paired date · last seen, with a remove button.
  - Claude in Chrome (added 2026-11-23, see
    `2026-11-23-chrome-auto-accept-design.md`): "Auto-accept is on/off", and
    **Turn on auto-accept** / **Turn off auto-accept**, with a hint that names
    the risk. Shown whenever the status carries `chromeAutoAccept`, with remote
    access on or off.
  - Errors in a red notice (port in use by something else, serve failed, …).
- Requests (`cce_remote_*`, answered by the bridge in that window; a peer forwards
  hub-owned ones): `status`, `connect`, `disconnect`, `new_code`, `remove_device
  {id}`, `set_app_url {url}`, `set_chrome_auto_accept {on}`, `open_tailscale`.
  `set_chrome_auto_accept` is written by the window itself, never through the hub,
  and no phone frame carries it. Links use the existing `open_url` request.

### Web app (`remote-app/`, "CCE Remote")

Stack: Vite 8, Preact 11, TypeScript 7 (exact versions pinned), `marked`, `dompurify`, `jsqr`. Tests:
`bun test` for `src/lib/**` (pure logic), plus E2E in headless Chrome. Built
`dist/` served by nginx (Dockerfile, multi-stage build; both base images pinned to
exact versions, `node:22.x.y-alpine3.z` and `nginx:1.x.y-alpine3.z`). One optional
runtime setting, `CCE_REMOTE_TAILNET` (see Hosting). The Mac's address comes from
pairing.

Screens (stack navigation, iPhone first, fine on desktop):
1. **Home**: the Mac name and connection state in the header (switcher if several
   Macs are paired). Projects as sections: name, editor, folder path (short), with
   their sessions as rows (status dot, title, relative time, branch, a
   "needs you" badge for pending prompts). A section menu: New session, Open Claude
   Code (when closed). Waiting sessions sort to the top within each project. Empty
   states for "no projects" and "Claude Code isn't open in this window".
2. **Session**: header (back, title, project, state pill, ⋯ menu: Open on Mac, Stop).
   The transcript: user bubbles (IDE context tags `<ide_selection>`,
   `<ide_opened_file>`, `<system-reminder>`, `<command-*>` become small chips or are
   hidden); Claude's Markdown (sanitised: a short list of tags, no classes but
   Markdown's own, links open externally); tool calls as
   compact rows (icon + name + key argument: Bash command, file path, pattern, URL,
   task description), tapping expands input and result; `TodoWrite` as a checklist,
   with the latest one pinned under the header as "3/7"; thinking folded; subagent
   messages folded under their task; results as a thin "Done in 1m 12s" line;
   streaming text with a caret. Auto-scroll while at the bottom, a "↓ new" pill
   otherwise.
   Prompt card above the composer when something is pending, one at a time with a
   count:
   - tool: "Allow `Bash`?" + the key argument (full command in monospace) + reason
     → Yes / Yes, and don't ask again (when offered, with its label) / No (with an
     optional reason field).
   - question: each question with its header chip, options as radio or checkbox
     cards (label + description), "Other" with a text field. Submit enabled when
     every question has an answer (the same rule as VS Code). Paged when several.
   - plan: the plan as Markdown (scrollable) → "Yes, and auto-accept edits" /
     "Yes, manually approve edits" / "No, keep planning" (+ feedback).
   - dialog: "Claude Code needs an answer in VS Code" + Cancel.
   Composer: auto-growing textarea (font-size 16 px, so iOS doesn't zoom), photo
   attach (downscaled to a 1568 px long side, JPEG 0.85), Send; Stop while running
   (sending stays possible and queues as in VS Code). Sending shows the message at
   once as "sending…" and replaces it with the replayed one.
3. **Pair** (first run and "Add Mac"): Scan QR (camera, `jsQR`), Paste link
   (clipboard on tap), or Enter address + code by hand. Shows the Tailscale hint when
   it can't connect ("Is Tailscale on on this phone?").
4. **Settings**: paired Macs (rename, remove), app version, a link to the README.

Client: one WebSocket per selected Mac; reconnect with backoff (0.5 s → 10 s) and
immediately on `visibilitychange`/`online`; `ping` every 25 s; re-`sub` the open
session after a reconnect (a fresh snapshot replaces the view). Stored in
`localStorage` key `cce-remote:macs` → `[{id, name, url, deviceId, token}]`.
`?demo` runs on built-in fixture data (no network), for screenshots and UI tests.
App badge (`navigator.setAppBadge`) = number of waiting sessions while open.

Look: dark by default (follows the system), a calm workbench-like palette with one
warm accent (status colours match the patch's dots: waiting `#F97316`, running
`#3B82F6`, unread `#22C55E`, idle `#6B7280`), system font, 44 px touch targets, safe
areas (`viewport-fit=cover`, `env(safe-area-inset-*)`), `100dvh`, keyboard-aware
composer (`visualViewport`). The implementer uses the `frontend-design` skill.

PWA: `manifest.webmanifest` (name "CCE Remote", short_name "CCE Remote",
`display: standalone`, theme/background colours, icons 192/512 + maskable 512 (the
artwork at 80 % on the icon's own background, inside the safe zone),
`start_url: "/"`), `apple-touch-icon` 180, `apple-mobile-web-app-capable`, a service
worker that precaches the shell and serves it network-first for HTML and
cache-first for hashed assets (never caches anything cross-origin). The icon is made
with the Gemini skill (1024 px master → sizes with `sips`): an original mark (no
Anthropic logo or trademark), a warm accent with a terminal chevron and a signal
arc.

Hosting: `Dockerfile` (build → nginx, port 80), `nginx.conf` (a template: SPA
fallback, `Cache-Control: no-cache` for `index.html`, `sw.js` and the manifest,
long-lived for `/assets/`, CSP
`default-src 'self'; connect-src 'self' wss://*.ts.net:* https://*.ts.net:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
with `CCE_REMOTE_TAILNET` in place of `ts.net` (default `ts.net`; the tailnet's DNS
name allows only its machines; anything but a DNS name stops the container),
plus `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(self)`). README section for Coolify (Dockerfile build
pack, base directory `remote-app`, port 80, a domain with HTTPS).

### patch.ts

- `installRemoteBridge(extDir)` / `removeRemoteBridge(extDir)`.
- `patchExtensionRemote` (`extension.js`), `patchWebviewConnection` + the appended
  runtime (`webview/index.js`), `patchConnectionCss` (`webview/index.css`).
- Verify lines: `remote bridge hook (extension.js)`, `remote bridge files`,
  `Connection tab`, `Connection runtime attached`.
- Flags: `--no-remote`. README + CLAUDE.md updated.

## Trust model (decided after the builder check)

- **The web app's host is inside the trust boundary.** The phone runs whatever
  code the Coolify host serves, holds the device token, and sits on the tailnet. So
  whoever can change those files (the server, the Coolify panel, a poisoned build
  dependency) can act as the paired phone and drive Claude Code on the Mac. Hosting
  on Coolify is the user's explicit choice, so we keep it and shrink the surface:
  exact-pinned dependencies plus a lockfile (`npm ci`), four well-known runtime
  libraries, no third-party origins at runtime (no CDN, fonts or analytics), a strict
  CSP, and the token kept only in the app origin's storage. The README states this
  plainly. It also names the stronger alternative for later: the bridge serves the
  built app itself on the `tailscale serve` origin.
- **Outbound Web Push.** With notifications on, the hub POSTs an end-to-end encrypted
  payload (RFC 8291) to the phone's push service (Apple's, Mozilla's, Google's or
  Microsoft's), never to an arbitrary URL: the endpoint must be https on one of the
  known push-service hosts. The push service sees the endpoint, the request headers
  (VAPID JWT, TTL, Urgency, Topic) and the ciphertext; the session text stays
  unreadable to it. The phone owns the VAPID key pair, and its private key sits in
  `state.json` (0600) like the device token hashes.
- **Other programs on the Mac can reach 127.0.0.1.** Any process may bind the port
  first (another macOS account, a sandboxed app, a container that publishes it: at
  login, while VS Code is closed, or in a handover). So the windows never send the
  peer secret: both sides of a peer link prove that they know it (see "Peer link
  authentication"), and a window that finds a program on the port that can't is sent
  nothing and keeps `tailscale serve` off. What is left: while serve is on and no
  window holds the port, whatever binds it receives the phones' connections, device
  tokens included. That is the case after a crash, and after quitting VS Code with
  two or more windows open: only the last remaining window, closed on its own,
  turns serve off. Disconnect turns it off, and so does `--revert` while remote
  access is on; on a Mac shared with other accounts the README says to Disconnect
  before quitting or reverting.
- **Turning on HTTPS publishes the Mac's Tailscale name.** Certificates for
  `<machine>.<tailnet>.ts.net` go into public Certificate Transparency logs. Tailscale
  warns about this when HTTPS is enabled, and only the tailnet owner can enable it.
  The Connection tab repeats the warning next to the "Turn on HTTPS" step and
  suggests renaming the machine in Tailscale first if its name is personal. We never
  enable HTTPS on the user's behalf. A private CA with its profile installed on the
  iPhone would avoid the logs, but it changes transport, auth and pairing. Not now.

## Testing and verification

1. `bun test remote-bridge/test`: ws framing (fragments, masking, ping, close,
   oversize), peer link RPC, store perms and atomic write, pairing (expiry, attempts,
   single use, hashing), tailscale parsing with a fake CLI script (running, stopped,
   no HTTPS, consent URL, serve status), transcript trimming, window agent against a
   **fake provider/comms** (mirror, pending add/remove both ways, answer payloads for
   every choice, send with and without a channel, new session, interrupt), hub +
   peer election with real sockets on a random port (hub dies → peer takes over),
   phone auth (missing header, wrong user, funnel, bad token, wrong origin, pairing).
2. `bun test remote-app/test`: transcript view model, chips, pairing-link parsing,
   client reconnect/resubscribe with a fake socket, image downscale math.
3. Patch dry run in a sandbox `HOME` on copies of 2.1.327 and 2.1.220: all verify
   lines, `node --check` on both bundles, revert restores byte-identical files.
4. Real end to end (the main proof): an **isolated** VS Code Insiders
   (`--user-data-dir`/`--extensions-dir` in the scratchpad, the patched 2.1.327
   copy, `CCE_REMOTE_HOME`, `CCE_REMOTE_PORT` and `CCE_REMOTE_TAILSCALE` (a fake
   CLI) set) driven over CDP:
   - the Connection tab renders, Connect works, a code and a QR show;
   - a phone client (through a local proxy that adds `Tailscale-User-Login`, as
     `tailscale serve` does) pairs, lists the project and its sessions, sends a
     message, sees it in VS Code, and gets the streamed answer;
   - a `Bash` permission prompt is answered from the phone and disappears in VS Code;
   - an `AskUserQuestion` is answered from the phone;
   - a new session is started from the phone.
   Then the real PWA build in headless Chrome at iPhone size against the same
   bridge, with screenshots.
5. Repo hygiene scan before handing over: no tailnet/host names, IPs, emails, tokens
   or keys in tracked or new files; `.gitignore` covers `node_modules`, `dist`, env
   files.

## Decisions we made (for review)

- Names: web app **CCE Remote**; folders `remote-app/` and `remote-bridge/`;
  extension subfolder `cce-remote/`; state in `~/.cce-remote/`.
- Port **47821** for the local hub and for the tailnet HTTPS endpoint.
- Remote access is **off** until the user clicks Connect. It then stays on across
  reloads (all windows join) until Disconnect.
- Only the Mac's own Tailscale user can pair or connect, and a token is required on
  top.
- Host-side injection (not webview-side) for every action. New sessions open where
  the user keeps Claude Code (an editor tab until 2026-11-24; see
  `2026-11-24-phone-sessions-in-sidebar-design.md`).
- Image attachments included. Push notifications, cloud sessions, settings and
  diff views left out.
- Work happens on a local feature branch `phone-remote` (made from `main`), one
  commit per task in the repo's emoji style, so each task can be reviewed on its
  own. Nothing is pushed or merged; the user reviews the branch and merges or
  squashes it.
- The user's running editors are not patched or reloaded. Applying the patch is
  left to the user (`bun run patch.ts`, then Reload Window), as is deploying the app.

## Left to the builder

Exact CSS and component structure of the app, the copy of the empty and error
states, how the QR scanner overlay looks, file splits inside `remote-app/src`, the
vendored QR encoder (any MIT/Apache one, notice kept), and the order of
`remote-bridge` internals, as long as the contracts above hold.
