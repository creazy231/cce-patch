# Phone Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Connection tab in the patched Claude Code sessions panel that puts the Mac on the user's tailnet (via `tailscale serve`), and a home-screen web app (CCE Remote) that lists every open VS Code project and its non-archived sessions, mirrors them live and lets the user answer prompts and send messages.

**Architecture:** A dependency-free CommonJS bridge (`remote-bridge/`) is copied into the Claude Code extension by `patch.ts` and attached to the extension's webview provider by a one-line hook. It taps the host↔webview protocol of every Claude webview, keeps per-session state, and serves the phone over a WebSocket on 127.0.0.1:47821 (one window is the hub, the others join as local peers), exposed on the tailnet by `tailscale serve`. The phone app (`remote-app/`, Vite + Preact + TS) is a static PWA, served by nginx from Coolify, that talks straight to the Mac over Tailscale.

**Tech Stack:** Node (VS Code extension host, CommonJS, no deps) · Bun (`bun test`, patch.ts) · Vite 8 + Preact 11 + TypeScript 7 (exact pins), marked, dompurify, jsqr · nginx:alpine Docker · Tailscale CLI 1.9x–1.10x.

**Spec:** `docs/superpowers/specs/2026-11-19-phone-remote-design.md` (read it first; this plan pins names and tests, the spec carries the why and the protocol tables).

## Global Constraints

- Never patch, reload, restart or close the user's running editors (`~/.vscode-insiders`, `~/.cursor`). Patch only sandbox copies (`HOME=<scratch>/home`). Never run `tailscale serve`/`up`/`down` against the real tailnet from tests: tests use a fake CLI via `CCE_REMOTE_TAILSCALE`.
- Work on branch `phone-remote` in `<repo>` (already checked out). One commit per task (more if useful), message in the repo's style: `🔧 <Imperative summary>` (`🐛` for fixes), then a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, merge, rebase or switch branches.
- Two tracks run in parallel in this checkout (bridge/patcher: `remote-bridge/`, `patch.ts`, root docs; web app: `remote-app/`). Stage and commit only your task's own paths: `git add <paths> && git commit -m "…" -- <paths>` (the `-- <paths>` keeps another track's staged files out of your commit); never `git add -A`, `git add .` or `git commit -a`; if `index.lock` exists, wait a few seconds and retry.
- Public repo: no real hostnames, tailnet names, IPs, emails, tokens or API keys in any file. Fixtures use `example-mac`, `tailnet-0000.ts.net`, `owner@example.com`.
- `remote-bridge/**` is plain CommonJS for the extension host: `"use strict"`, `require` only Node built-ins and `vscode` (only in `bridge.js`, injectable), no build step. `.gitignore` must re-include `remote-bridge/**/*.js` (the repo ignores `*.js`).
- Every hook into the minified bundles fails closed: missing anchor → skip + `FAIL` verify line, extension unchanged. Identifier captures use `[\w$]+`, escaped with `escRe`/`escRepl` (patch.ts).
- Fixed values: port `47821`; state dir `$CCE_REMOTE_HOME` or `~/.cce-remote` (0700), file `state.json` (0600); extension subfolder `cce-remote/`; protocol version `1`; pairing alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 8 chars shown `XXXX-XXXX`, TTL 600 000 ms, 5 tries; hub port env override `CCE_REMOTE_PORT`; peer upgrade `Upgrade: cce-peer` + header `X-CCE-Secret` (replaced in the final fix wave by an HMAC challenge–response with `X-CCE-Nonce`/`X-CCE-Proof`, so the secret never goes on the wire: see the spec); injected request ids start with `cce-remote-`; webview request types start with `cce_remote_`.
- Deny texts copied verbatim from the extension (2.1.327):
  - `DENY = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."`
  - `DENY_WITH_REASON = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: "`
  - `KEEP_PLANNING = "User chose to stay in plan mode and continue planning"`
- App name "CCE Remote"; status colours waiting `#F97316`, running `#3B82F6`, unread `#22C55E`, idle `#6B7280`.
- Trust model (spec section "Trust model"): the web app pins exact dependency versions (no `^`/`~`) with a lockfile, loads nothing from third-party origins at runtime, and its README states that its host is inside the trust boundary. The Connection tab shows, next to the HTTPS step: "Turning on HTTPS publishes this Mac's Tailscale name (`<dnsName>`) in public certificate logs. Rename the machine in Tailscale first if the name is personal."
- Pristine bundles for tests/rigs: 2.1.327 at `<scratch>/ext327/{extension.js,webview.js,webview.css}` (copies of the Insiders `.bak` files) and 2.1.220 from `~/.cursor/extensions/anthropic.claude-code-2.1.220-darwin-arm64/{extension.js.bak,webview/index.js.bak,webview/index.css.bak}` (read only; copy before use). `<scratch>` = the session's scratchpad directory.

## Review Focus

1. **The phone answers a prompt that VS Code already answered (or the CLI withdrew).** Expect `ack ok:false error:"not_pending"`, no second response injected. Test in Task 6.
2. **A window reloads while the phone watches one of its sessions.** The project disappears and comes back with the same id; the phone gets a fresh snapshot without user action. Test in Task 8.
3. **Hub window closes.** A peer becomes hub within ~2 s, phones reconnect and re-authenticate with the same token (devices come from `state.json`). Test in Task 8.
4. **Huge transcripts / huge tool output** (a 5 MB file read, 2 000 messages). Snapshot stays under ~2 MB, last 400 messages, `truncatedBefore` set. Test in Task 4.
5. **Extension update changes the bundle shape.** Each new hook prints `FAIL` and leaves the file valid (`node --check`). Test in Task 9 against a bundle with the anchors removed.

---

### Task 1: WebSocket server and peer link (transport)

**Files:**
- Create: `remote-bridge/lib/ws.js`, `remote-bridge/lib/peer-link.js`
- Test: `remote-bridge/test/ws.test.ts`, `remote-bridge/test/peer-link.test.ts`
- Modify: `.gitignore` (add `!remote-bridge/**/*.js`)

**Interfaces:**
- Produces (`ws.js`): `acceptWebSocket(req, socket, head, {maxPayload = 8 * 1024 * 1024}) → WsConnection | null` (writes 101 with `Sec-WebSocket-Accept`; returns null after writing 400 when the request isn't a valid v13 upgrade). `class WsConnection extends EventEmitter` — events `message(text: string)`, `close(code: number, reason: string)`; `send(text)`, `close(code = 1000, reason = "")`, `ping()`, `readyState: "open"|"closing"|"closed"`, `headers` (request headers), `origin`.
- Produces (`peer-link.js`): `class PeerLink extends EventEmitter` — `call(method, args, {timeoutMs = 20000}) → Promise<any>`, `notify(event, data)`, `setHandler(async (method, args) => value)`, events `event(name, data)`, `close()`; `close()`. `acceptPeer(req, socket, head, secret) → PeerLink | null` (writes `HTTP/1.1 101 Switching Protocols\r\nUpgrade: cce-peer\r\nConnection: Upgrade\r\n\r\n`; 403 + destroy when the secret mismatches (timingSafeEqual on equal-length buffers) or any request header starts with `tailscale-`). `connectPeer({port, secret, host = "127.0.0.1", timeoutMs = 3000}) → Promise<PeerLink>` (rejects with the socket error code, e.g. `ECONNREFUSED`, or `"refused"` on non-101).

- [ ] **Step 1: Write the failing tests.** `ws.test.ts` (a `node:http` server on port 0 whose `upgrade` handler calls `acceptWebSocket`; Bun's built-in `WebSocket` as the client): echo round trip of a 70 000-char text (64-bit length path); a 125/126-byte boundary message; fragmented client message reassembled (raw TCP client sends FIN=0 + continuation); server answers ping with pong (raw client); binary frame → close 1003; unmasked client frame → close 1002; payload over `maxPayload` → close 1009; `close()` → client sees code 1000; non-upgrade request → 400. `peer-link.test.ts`: `connectPeer` + `acceptPeer` round trip `call("add",{a:1,b:2})` → 3; handler throwing → rejected promise with the message; `notify` → `event` on the other side; wrong secret → `connectPeer` rejects `"refused"`; a `Tailscale-User-Login` header on the upgrade → refused; call on a closed link rejects `"closed"`; timeout rejects `"timeout"`; a 5 MB JSON value survives (newline framing, no split corruption).
- [ ] **Step 2: Run** `bun test remote-bridge/test/ws.test.ts remote-bridge/test/peer-link.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** `ws.js` (RFC 6455 server: handshake with SHA-1 of key + `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, incremental frame parser over a Buffer list, unmask, continuation frames, control frames ≤125 bytes, server frames unmasked) and `peer-link.js` (NDJSON: `{t:"call",id,m,a}` / `{t:"ret",id,ok,v|e}` / `{t:"evt",e,d}`, ids increasing integers, pending map rejected on close).
- [ ] **Step 4: Run** the same command → PASS. `git check-ignore remote-bridge/lib/ws.js` → exit 1.

### Task 2: State store and pairing

**Files:**
- Create: `remote-bridge/lib/store.js`, `remote-bridge/lib/pairing.js`
- Test: `remote-bridge/test/store.test.ts`, `remote-bridge/test/pairing.test.ts`

**Interfaces:**
- Produces (`store.js`): `remoteHome(env = process.env) → string`; `loadState(env?) → State` (creates dir 0700 + file 0600 with defaults `{version:1, enabled:false, port:47821, secret:<64 hex>, appUrl:"", devices:[]}`, repairs wider perms, keeps unknown keys, a corrupt file is renamed `state.json.corrupt-<ts>` and replaced); `saveState(state, env?)` (tmp file + rename, 0600); `updateState(fn: (s) => void|State, env?) → State` (re-reads immediately before writing); `watchState(cb: (state) => void, env?, intervalMs = 2000) → () => void` (`fs.watchFile`, cb only when JSON changed); `effectivePort(state, env?) → number` (`CCE_REMOTE_PORT` wins).
- Produces (`pairing.js`): `CODE_ALPHABET`, `CODE_TTL_MS = 600000`, `MAX_ATTEMPTS = 5`; `class Pairing { newCode(now = Date.now()) → {code, expiresAt}; current(now) → {code, expiresAt} | null; consume(input, now) → boolean }`; `formatCode(code) → "XXXX-XXXX"`; `normalizeCode(input) → string` (upper case, drops everything outside the alphabet); `createDevice({name, origin, now}) → {device: {id, name, tokenHash, origin, createdAt, lastSeenAt}, token}` (id 16 hex, token 32 random bytes base64url, name trimmed to 60 chars, default "Phone"); `hashToken(token) → hex`; `verifyToken(device, token) → boolean`; `pairingLink({appUrl, url, code, macName}) → string` (`(appUrl || "https://cce-remote.invalid").replace(/\/+$/,"") + "/#pair=" + base64url(JSON.stringify({v:1,u:url,c:code,n:macName}))`).

- [ ] **Step 1: Write the failing tests.** store: defaults + perms (`statSync(...).mode & 0o777` = 0o600 file, 0o700 dir); secret is 64 hex and stable across loads; `updateState` keeps a concurrent write of another key; corrupt JSON → renamed + defaults; `effectivePort` env override; `watchState` fires once for a real change and not for a rewrite with identical JSON (pass `intervalMs` 100 in the test). pairing: code uses only the alphabet, length 8; `formatCode`; consume with `"abcd efgh"` style input works; second consume fails (single use); expired (now = expiresAt + 1) fails; 5 wrong tries invalidate the code even for the right one afterwards; `newCode` replaces the previous code; `verifyToken` true/false, different-length token false (no throw); `pairingLink` decodes back to the payload and uses the placeholder origin without `appUrl`.
- [ ] **Step 2: Run** `bun test remote-bridge/test/store.test.ts remote-bridge/test/pairing.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules (crypto.randomBytes / randomInt, `crypto.timingSafeEqual` on sha256 digests).
- [ ] **Step 4: Run** → PASS.

### Task 3: Tailscale CLI wrapper and QR encoder

**Files:**
- Create: `remote-bridge/lib/tailscale.js`, `remote-bridge/lib/qr.js` (+ `remote-bridge/lib/vendor/qrcodegen.js` with its MIT notice header, or an equivalent MIT/Apache encoder)
- Test: `remote-bridge/test/tailscale.test.ts`, `remote-bridge/test/qr.test.ts`, fixture `remote-bridge/test/fixtures/fake-tailscale.sh`

**Interfaces:**
- Produces (`tailscale.js`): `findCli(env = process.env, exists = fs.existsSync) → string | null` (order in the spec); `parseStatus(json) → {installed:true, running, backendState, loginName, dnsName, hostName, httpsEnabled}`; `parseServeStatus(json, port) → boolean` (true when `TCP[port].HTTPS` and `Web["<host>:<port>"].Handlers["/"].Proxy` is `http://127.0.0.1:<port>`); `findConsentUrl(text) → string | null` (first `https://login.tailscale.com/…` URL); `class Tailscale { constructor({cli?, env?, run?}); status() → Promise<Status>` (cached 5 s; not installed → `{installed:false, running:false, httpsEnabled:false}`; CLI error → `{installed:true, running:false, error}`); `serveOn(port) → Promise<{ok:true} | {ok:false, needsConsent?, error?}>`; `serveOff(port) → Promise<{ok, error?}>`; `serveStatus(port) → Promise<{configured:boolean}>`; `openApp() → Promise<void>` }.
- Produces (`qr.js`): `qrSvgPath(text, ecc = "M") → {size: number, path: string}` (`path` = `M x y h1 v1 h-1 z` per dark module, no quiet zone).

- [ ] **Step 1: Write the failing tests.** tailscale: `parseStatus` of a fixture with `BackendState:"Running"`, `Self.DNSName:"example-mac.tailnet-0000.ts.net."`, `User["123"].LoginName:"owner@example.com"`, `CertDomains:["example-mac.tailnet-0000.ts.net"]` → `{running:true, dnsName:"example-mac.tailnet-0000.ts.net", loginName:"owner@example.com", httpsEnabled:true}`; `CertDomains` null → `httpsEnabled:false`; `BackendState:"Stopped"`/`"NeedsLogin"` → running false; `findCli` with an injected `exists`; `findConsentUrl("To enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n")`; `parseServeStatus` true/false fixtures; with `fake-tailscale.sh` (bash script switching on `$1 $2`, behaviour selected by env `FAKE_TS_MODE`: `ok`, `consent` (prints the consent text, then `sleep 30`), `fail` (exit 1 with stderr)): `serveOn` ok; `consent` → `{ok:false, needsConsent}` in < 3 s and the child is killed; `fail` → `{ok:false, error}` with stderr text; `status()` caches (the script appends to a counter file; two calls within 5 s → one run). qr: `qrSvgPath("https://example.com/#pair=abc")` → `size` 25–57, `path` non-empty and only `M`, `h`, `v`, `z`, digits, spaces, `-`; deterministic; a 300-char text fits (version ≤ 20).
- [ ] **Step 2: Run** `bun test remote-bridge/test/tailscale.test.ts remote-bridge/test/qr.test.ts` → FAIL.
- [ ] **Step 3: Implement** (`child_process.execFile`/`spawn` with timeouts: 5 s; `serveOn` 20 s and resolves as soon as a consent URL appears in stdout/stderr, then kills the child; `serve --bg --https=<port> http://127.0.0.1:<port>`, `serve --https=<port> off`, `serve status --json`, `status --json`; `openApp` = `open -a Tailscale` on darwin). Vendor the encoder (download the MIT-licensed Nayuki `qrcodegen` JS/TS release, or another MIT/Apache encoder; keep the license header) and wrap it.
- [ ] **Step 4: Run** → PASS.

### Task 4: Transcript mapping and answers

**Files:**
- Create: `remote-bridge/lib/transcript.js`, `remote-bridge/lib/answers.js`
- Test: `remote-bridge/test/transcript.test.ts`, `remote-bridge/test/answers.test.ts`

**Interfaces:**
- Produces (`transcript.js`): `LIMITS = {text: 20000, toolResult: 3000, thinking: 2000, inputString: 4000, messages: 400}`; `toPhoneMessage(sdk) → PhoneMessage | null` where `PhoneMessage = {uuid, type:"user"|"assistant"|"result"|"system", ts?, content?, subtype?, isReplay?, parent?, result?: {subtype, isError, durationMs, costUsd, numTurns}}` and content blocks are `{type:"text",text}` | `{type:"thinking",text}` | `{type:"tool_use",id,name,input}` | `{type:"tool_result",toolUseId,text,isError}` | `{type:"image",omitted:true}` | `{type:"document",title}`; `toStreamEvent(sdk) → {type, index?, text?} | null`; `mergeHistory(history, live, limit = LIMITS.messages) → {messages, truncatedBefore}`.
- Produces (`answers.js`): `DENY`, `DENY_WITH_REASON`, `KEEP_PLANNING` (Global Constraints); `classifyPending(requestMsg, now) → Pending` (spec shape; `canAlwaysAllow = kind === "tool" && suggestions.length > 0 && !suppressAlwaysAllowRule`; `alwaysLabel` = "Yes, allow all edits this session" for a lone `setMode acceptEdits` suggestion, "Yes, and don't ask again" otherwise); `buildAnswer(pending, choice, {autoMode = false} = {}) → {response, mode?: string}` where `response = {type:"tool_permission_response"|"user_dialog_response", result}`; throws `Error("invalid_choice")`.

- [ ] **Step 1: Write the failing tests.** transcript: `stream_event`, `system/init`, `system/status`, `rate_limit_event`, `prompt_suggestion`, an `isMeta` user message → null; `compact_boundary` kept; a user string content → one text block; a 10 000-char tool_result string and an array of `{type:"text"}` parts → flattened + cut to 3 000 with `"…[truncated]"`; image → `{type:"image",omitted:true}`; thinking cut to 2 000; `Write` input `content` of 9 000 chars cut to 4 000, other keys intact; `parent_tool_use_id` → `parent`; result mapping; `toStreamEvent` of `content_block_delta/text_delta` → `{type:"content_block_delta", index, text}`, `input_json_delta` → null, any event with `parent_tool_use_id` → null; `mergeHistory` appends live messages with unknown uuids in order, keeps the last 400 of 2 000 and sets `truncatedBefore: 1600`; a 2 000-message history with a 5 MB tool result serialises below 2 MB. answers (assert the exact objects): tool allow → `{type:"tool_permission_response", result:{behavior:"allow", updatedInput: input, updatedPermissions: []}}`; allowAlways → `updatedPermissions: suggestions` and `mode:"acceptEdits"` when a `setMode` suggestion with destination `session` is present; allowAlways without suggestions → throws; deny → `{behavior:"deny", message: DENY, interrupt:true}`; deny with reason "use pnpm" → `{behavior:"deny", message: DENY_WITH_REASON + "use pnpm", interrupt:false}`; question answers → `updatedInput:{questions: input.questions, answers}`, missing an answer for a question → throws; plan approveAuto → `mode:"acceptEdits"` (`"auto"` with `{autoMode:true}`), `updatedPermissions:[]`; approveManual → `mode:"default"`, `updatedPermissions:[{type:"setMode",mode:"default",destination:"session"}]`; keepPlanning → `{behavior:"deny", message: KEEP_PLANNING, interrupt:true}`, with feedback "split it" → `DENY_WITH_REASON + "split it"`, `interrupt:false`; dialog cancel → `{type:"user_dialog_response", result:{behavior:"cancelled"}}`; a tool choice on a question pending → throws.
- [ ] **Step 2: Run** `bun test remote-bridge/test/transcript.test.ts remote-bridge/test/answers.test.ts` → FAIL.
- [ ] **Step 3: Implement** both (pure functions, no I/O).
- [ ] **Step 4: Run** → PASS.

### Task 5: Fake extension for tests

**Files:**
- Create: `remote-bridge/test/fake-extension.ts`
- Test: `remote-bridge/test/fake-extension.test.ts`

**Interfaces:**
- Produces: `createFakeVscode({folders = ["/work/demo"], appName = "Visual Studio Code - Insiders", name = "demo"}) → {workspace, env, commands: {executeCommand, calls}}`; `createFakeComms({cwd = "/work/demo", sessions = []}) → FakeComms` with the real member names (`channels: Map`, `pendingChannels: Map`, `webview: {postMessage, posted}`, `cwd`, `send(msg)` (records into `sent`), `fromClient(msg)` (records into `received`, and simulates the host: `io_message` user → `send` replay `{...message, isReplay:true, session_id}`, then `system/init`, an assistant text, a `result`; `response` → resolves the matching entry of `outstandingRequests`; `interrupt_claude` → `send` a `result` with `subtype:"error_during_execution"`), `processRequest(e, signal)`, `getSession(id)`, `buildSessionList()`, helpers `openChannel(channelId, sessionId)`, `emit(channelId, sdkMessage)`, `requestPermission(channelId, request) → Promise<response>` (uses the real `{type:"request", channelId, requestId, request}` shape and an `outstandingRequests` map), `closeChannel(channelId)`}; `createFakeProvider() → {allComms: Set, sessionStates: Map, unreadSessionKeys: Set, liveElsewhereSessions: [], output: {info, warn, error, debug, lines}}`.

- [ ] **Step 1: Write the failing test** — the fake behaves as specified: a user `io_message` produces the replay/init/assistant/result sequence on `sent`; `requestPermission` resolves when `fromClient({type:"response"…})` arrives.
- [ ] **Step 2: Run** `bun test remote-bridge/test/fake-extension.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

### Task 6: Window agent

**Files:**
- Create: `remote-bridge/lib/window-agent.js`
- Test: `remote-bridge/test/window-agent.test.ts`

**Interfaces:**
- Consumes: Task 4 (`toPhoneMessage`, `toStreamEvent`, `mergeHistory`, `classifyPending`, `buildAnswer`), Task 5 fakes.
- Produces: `class WindowAgent extends EventEmitter` — `constructor({provider, vscode, log = () => {}, now = Date.now, channelWaitMs = 20000})`; `instrument(comms)` (idempotent, marks `comms.__cceRemote = true`); `start()` (instruments `provider.allComms` and wraps its `add`, subscribes to `vscode.workspace.onDidChangeWorkspaceFolders` when present); `projectId() → string`; `project() → Project`; `refreshProject() → Promise<Project>` (emits `"project"` only when the JSON changed); `setActive(on: boolean)` (on → refresh now and every 15 s; off → stop); `snapshot(sessionId) → Promise<{messages, pending, state, live, truncatedBefore}>`; `send(sessionId | null, text, images = []) → Promise<{session: string|null, uuid: string}>`; `answer(sessionId, requestId, choice) → Promise<void>` (throws `Error("not_pending")`); `interrupt(sessionId) → Promise<void>` (throws `"not_running"` without a channel); `open(sessionId)`, `openClaude()`; events `"project"(Project)`, `"session"(sessionId, ev)` with `ev` = `{t:"msg", message}` | `{t:"stream", event}` | `{t:"pending", pending: Pending[]}`; property `onCceRequest: ((comms, request) => Promise<object>) | null`.

- [ ] **Step 1: Write the failing tests** (fake provider with two comms: a sidebar holding session `s1` on channel `c1`, a tab holding `s2` on `c2`):
  - an assistant `io_message` on `c1` → `"session"("s1", {t:"msg"})` with the mapped message; a `stream_event` text delta → `{t:"stream"}`; `system/init` → session state running in `project()`; `result` → idle.
  - `send(msg)` with `{type:"response", requestId:"cce-remote-x"}` is swallowed (the webview never sees it); other messages pass through unchanged and in order.
  - a `tool_permission_request` on `c1` → `{t:"pending"}` with one `Pending` of kind `tool`, state waiting; the webview's `response` (`fromClient`) removes it; a host `cancel_request` removes it; `close_channel` clears it.
  - `answer("s1", id, {kind:"allow"})` → `fromClient` received `{type:"response", requestId:id, response:{type:"tool_permission_response", result:{behavior:"allow",…}}}` then `send` posted `{type:"cancel_request", targetRequestId:id}`; the pending list empties; a later webview `response` for the same id is dropped (not passed to the original `fromClient`).
  - plan `approveManual` → first a `set_permission_mode` request with `mode:"default"` and an id starting `cce-remote-`, then the response; its host response is swallowed.
  - answering a request that is not pending → rejects `not_pending` and injects nothing.
  - `send("s1","hi")` → `fromClient` got `{type:"io_message", channelId:"c1", done:false, message:{type:"user", uuid, session_id:"", parent_tool_use_id:null, message:{role:"user", content:[{type:"text",text:"hi"}]}}}`; images go before the text as `{type:"image", source:{type:"base64", media_type, data}}`; 5 images or a 6 MB image → rejects `"bad_images"`; empty text without images → `"empty"`.
  - `send("s3","hi")` (listed, no channel): calls `executeCommand("claude-vscode.editor.open","s3")`; the test opens a channel for `s3` 100 ms later; the message goes to it. Never opened → rejects `"timeout"` after `channelWaitMs` (use 300 in the test).
  - `send(null,"new")`: `executeCommand("claude-vscode.editor.open")`; a new comms with a new channel (no session id yet) appears → message injected there; result `session` is the id once `system/init` names it, or null.
  - `interrupt("s1")` → `{type:"interrupt_claude", channelId:"c1"}`.
  - `project()`: id = first 12 hex of sha1(appName + "\n" + folders.join("\n")); sessions from `buildSessionList()` without archived ones, sorted by `lastActivity ?? lastModified` descending, title precedence (live `sessionStates` title > `customTitle` > `summary` > "Untitled"), state precedence waiting > running > unread > idle, `pendingCount`; a channel whose session isn't listed appears as "New session"; no comms → `claudeOpen:false`, `sessions:[]`.
  - `processRequest` with `cce_remote_status` → `onCceRequest` called with `(comms, request)`; other types → the original.
  - `snapshot("s1")` merges `getSession` history with live messages by uuid and includes pending + state; `getSession` throwing → empty history.
- [ ] **Step 2: Run** `bun test remote-bridge/test/window-agent.test.ts` → FAIL.
- [ ] **Step 3: Implement** `window-agent.js` (instance-level wrappers that call the originals with the comms as `this`; request id map `answeredByPhone` with 60 s expiry; channel lookup across all comms in `channels` then `pendingChannels`, session of a channel = `channel.sessionId` or the last `session_id` seen on it; live buffer 500 per session; waits poll every 250 ms; every vscode call guarded).
- [ ] **Step 4: Run** → PASS.

### Task 7: Hub (phone protocol, auth, routing)

**Files:**
- Create: `remote-bridge/lib/hub.js`
- Test: `remote-bridge/test/hub.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4, 6 (`WindowAgent` events/methods shape).
- Produces: `class Hub extends EventEmitter` — `constructor({state: () => State, updateState, tailscale: {status()}, macName: () => string, log, now = Date.now, helloTimeoutMs = 10000, projectsDebounceMs = 300})`; `listen(port) → Promise<void>` (rejects with `err.code === "EADDRINUSE"` when taken); `close() → Promise<void>`; `addWindow({key, call: (method, args) => Promise<any>}) → {setProject(project), sessionEvent(sessionId, ev), remove()}` (the hub assigns the public project id: the window's own id, `-2`, `-3` … on clashes; `call` methods `snapshot|send|answer|interrupt|open|openClaude|active`); `attachPeer(link: PeerLink)` (registers a window for it and answers its hub-side calls); `newPairingCode() → {code, expiresAt, link, qr}`; `devices() → Device[]` (without `tokenHash`); `removeDevice(id) → Promise<void>` (also closes that device's sockets); `setAppUrl(url) → Promise<void>` (only `https://` or empty, else throws `"bad_url"`); `info() → {windows: number, devices, pairing}`; `phoneCount() → number`.
- HTTP/upgrade routing and every phone message exactly as in the spec ("Bridge — phone protocol").

- [ ] **Step 1: Write the failing tests** (hub on port 0 via `listen(0)` + `server.address()`, a stub tailscale with `loginName:"owner@example.com"`, phones = Bun `WebSocket` with `headers`):
  - `/health` → `{ok:true, app:"cce-remote", v:1}`; `/` → HTML containing "CCE Remote"; `/nope` → 404.
  - upgrade without `Tailscale-User-Login` → 403; with `other@example.com` → 403; with `Tailscale-Funnel-Request: ?1` → 403; with the owner → open. Owner unknown (status fails) + header present → open.
  - no first frame within 10 s (inject `helloTimeoutMs: 200`) → close 4400.
  - pairing: `newPairingCode()`, phone sends `{t:"pair", code:"abcd-efgh"-style input, device:"iPhone"}` → `paired` with token; `state.json` device has `tokenHash` = sha256(token), `origin` = the `Origin` header; wrong code → `{t:"error", code:"bad_code"}` and the socket stays open for a retry.
  - hello with the token and the same Origin → `welcome` then `projects`; wrong token → `error bad_token` + close 4401; other Origin → close 4401; `lastSeenAt` written.
  - a registered fake window: `setProject(p)` → phones get `projects` (debounced, one message for three quick updates); `sub` → `call("snapshot",{session})` → `snapshot` frame; events for that session reach only subscribers; events arriving during the snapshot call are delivered after the snapshot.
  - `send`/`answer`/`interrupt`/`open`/`openClaude` → routed to the right window's `call` and acked (`{t:"ack", id, ok:true, session?, uuid?}`), a thrown error → `{ok:false, error: message}`; unknown project → `ok:false, error:"unknown_project"`.
  - window `remove()` then re-add with the same key/id → subscribed phones receive a fresh `snapshot` automatically.
  - `active`: the first authenticated phone → every window gets `call("active",{on:true})`, the last one leaving → `{on:false}`; a window added while phones are connected gets `{on:true}`.
  - `removeDevice` closes that phone (4401) and drops it from `state.json`.
- [ ] **Step 2: Run** `bun test remote-bridge/test/hub.test.ts` → FAIL.
- [ ] **Step 3: Implement** `hub.js` (`node:http` server bound to `127.0.0.1`; one `Pairing`; per phone `{ws, deviceId, subs: Set<"project\u0000session">, pendingSnapshots}`).
- [ ] **Step 4: Run** → PASS.

### Task 8: Coordinator, Connection-tab requests, bridge entry

**Files:**
- Create: `remote-bridge/lib/coordinator.js`, `remote-bridge/lib/connection-ui.js`, `remote-bridge/bridge.js`
- Test: `remote-bridge/test/coordinator.test.ts`, `remote-bridge/test/bridge.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces (`coordinator.js`): `class Coordinator extends EventEmitter` — `constructor({agent, tailscale, env = process.env, log, macName, retryMs = [300, 1500]})`; `start()` (reads state, watches it, elects when enabled); `stop()`; `role: "off"|"starting"|"hub"|"peer"|"error"`; `connect() → Promise<ConnectionStatus>` (sets `enabled:true`, `tailscale.serveOn(port)`, elects; keeps `consentUrl` when consent is needed); `disconnect() → Promise<ConnectionStatus>` (`enabled:false`, `serveOff`, tears down); `status() → Promise<ConnectionStatus>`; `newPairingCode()`, `removeDevice(id)`, `setAppUrl(url)` (local hub or a peer `call` to the hub).
- `ConnectionStatus` = `{enabled, role, error?, port, url?, macName, tailscale:{installed, running, loginName?, dnsName?, httpsEnabled, consentUrl?}, serve:{configured}, windows, devices:[{id,name,createdAt,lastSeenAt}], pairing?:{code, expiresAt, link, qr:{size,path}}, appUrl}`. `url` = `https://<dnsName>:<port>` when `dnsName` is known. `pairing` is created on demand by `status()` when enabled and no valid code exists.
- Produces (`connection-ui.js`): `handleConnectionRequest(coordinator, request, {openExternal, copy}) → Promise<object>` for `cce_remote_status|connect|disconnect|new_code|remove_device|set_app_url|open_tailscale|copy` → `{type: request.type + "_response", status?, error?}` (every one but `copy`/`open_tailscale` returns a fresh `status`).
- Produces (`bridge.js`): `attach(provider, {vscode = require("vscode"), env = process.env} = {})` (idempotent per provider; defers via `setImmediate`; log = `provider.output?.info/warn/error` with prefix `[cce-remote] `, never logs tokens/codes/secrets); `VERSION = "1.0.0"`.

- [ ] **Step 1: Write the failing tests.** coordinator (temp `CCE_REMOTE_HOME`, random free port in `CCE_REMOTE_PORT`, fake tailscale object): disabled → role off, nothing listening; `connect()` → hub, `serveOn` called with the port, state enabled; a second coordinator (second agent) → peer, the hub's `info().windows` = 2; closing the hub coordinator (`stop()` only on it, simulating a closed window) → the peer becomes hub within 2 s and a phone can `hello` again with the same token; `disconnect()` from the peer → every coordinator ends `off` (state watch) and `serveOff` was called; port held by a plain TCP server that isn't a hub → role `error` with `error` mentioning the port; `status()` while consent is needed → `tailscale.consentUrl`. bridge: `attach(fakeProvider, {vscode: fake, env})` twice → one agent; comms added later get instrumented; a `cce_remote_status` request through the comms' `processRequest` returns `{type:"cce_remote_status_response", status:{role:"off",…}}`; `attach` on an object without `allComms` doesn't throw.
- [ ] **Step 2: Run** `bun test remote-bridge/test/coordinator.test.ts remote-bridge/test/bridge.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files. The local window is registered with the hub through an adapter around the agent (`call` → agent methods, agent events → `setProject`/`sessionEvent`); a peer registers through a `PeerLink` (`evt project`, `evt session`; the hub's calls are answered by the agent). Re-election: on link close or hub `close`, wait a random `retryMs` delay, try `listen`, else `connectPeer`.
- [ ] **Step 4: Run** `bun test remote-bridge/test` → all PASS.

### Task 9: patch.ts — bridge install, extension hook, Connection tab

**Files:**
- Create: `remote-bridge/install.ts`, `remote-bridge/webview-runtime.js`, `remote-bridge/test/install.test.ts`, `remote-bridge/test/fixtures/bundles.ts` (synthetic minified-shape snippets for 2.1.327 and 2.1.220, written by hand, not copied from the extension)
- Modify: `patch.ts` (import and call; `--no-remote`; verify lines; revert), `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `remote-bridge/bridge.js` + `lib/**` (files to copy), `ConnectionStatus` (Task 8).
- Produces (`install.ts`): `REMOTE_DIR = "cce-remote"`; `installRemoteBridge(extDir) → number` (files copied: `bridge.js`, `lib/**/*.js`, `LICENSE*`/`NOTICE*`; removes stale files first); `removeRemoteBridge(extDir) → boolean`; `patchExtensionRemote(code) → {patched, count}`; `patchWebviewConnection(code) → {patched, count, checks: {attach: boolean, tab: boolean}}`; `patchConnectionCss(css, jsCode) → {patched, count}`; `CONNECTION_RUNTIME` (contents of `webview-runtime.js`).
- Produces (`webview-runtime.js`): `window.__cceRemote = {attach(sessions), mount(el | null), request(type, data) → Promise<object>}`; DOM classes `cce-conn`, `cce-conn-*`.

Exact edits:
- `patchExtensionRemote`: replace the single `allComms=new Set` with `allComms=(function(p){try{require("./cce-remote/bridge.js").attach(p)}catch(e){try{console.error("[cce-remote]",e)}catch(_){}}})(this)||new Set` (count 1). Already patched → count 0 + "Already patched". Zero or several matches → count 0 + message.
- `patchWebviewConnection`:
  1. attach: every `([\w$]+)\.createRoot\(document\.querySelector\("#root"\)\)\.render\(` whose next 300 chars contain `sessions:([\w$]+)` → `(window.__cceRemote&&window.__cceRemote.attach(S),X).createRoot(…` (the `X.` is preceded by `{`, `,`, `;` or `)`).
  2. tab state: `\[([\w$]+),([\w$]+)\]=([\w$]+)\("local"\),` (the only one) → append `[__cceConn,__cceSetConn]=USE(!1),`.
  3. row: `([\w$]+)&&([\w$]+)\("div",\{className:([\w$]+)\.segmented,children:\[` → `JSX("div",{className:CSS.segmented+(__cceConn?" cce-conn-on":"")+(GUARD?"":" cce-no-web"),onClickCapture:(e)=>{if(!(e.target&&e.target.closest&&e.target.closest(".cce-conn-tab")))__cceSetConn(!1)},children:[`; then bracket-match that `children:[` array and insert before its closing `]`: `,JSX("button",{className:\`${CSS.tab} cce-conn-tab ${__cceConn?CSS.tabActive:""}\`,"aria-pressed":__cceConn,onClick:()=>__cceSetConn(!0),children:"Connection"})`.
  4. content: `([\w$]+)\("div",\{id:([\w$]+),className:\`\$\{([\w$]+)\.content\}` (first one after the row) → prefix with `__cceConn?JSX("div",{className:CSS.content+" cce-conn",ref:window.__cceRemote&&window.__cceRemote.mount}):`; and the root `className:([\w$]+)\.root,` of that component (the nearest before the row) → `className:CSS.root+(__cceConn?" cce-conn-root":""),`.
  All of 2–4 or none (`checks.tab`), 1 independent (`checks.attach`). Then append `CONNECTION_RUNTIME`.
- `patchConnectionCss`: append rules for `.cce-conn-on .{tab}.{tabActive}` (reset to the inactive look), `.cce-no-web>.{tab}:nth-child(2){display:none}`, `.cce-conn-root>.{searchRow}{display:none}` (class names from the sessions-list CSS module `{…segmented:"segmented_X",…}`), and the `cce-conn-*` view styles (VS Code tokens only, as in the spec).
- `patch.ts`: in `patchOne` after the existing steps (unless `--no-remote`): extension hook (writes extension.js when count > 0), `installRemoteBridge`, webview hooks after the draft patch and before the resize script, CSS after the selection chip CSS. Verify lines: `remote bridge hook (extension.js)`, `remote bridge files`, `Connection tab`, `Connection runtime attached`. Revert: `removeRemoteBridge` (log "Removed cce-remote"). Usage text, README feature section ("Phone remote") + usage, CLAUDE.md pipeline steps 11–13 and a `remote-bridge/` + `remote-app/` section.

Runtime behaviour (`webview-runtime.js`, plain ES2019, no globals besides `window.__cceRemote`, every handler in try/catch):
- `request(type, data)` → `sessions.comms.connection.value.sendRequest({type, ...data})`.
- `mount(el)`: renders the view described in the spec into `el`, polls `cce_remote_status` every 2 s (and immediately after each action), re-renders only when the status JSON changed, keeps the app-address input element across renders (value replaced only while not focused), countdown text updated every second, QR as `<svg viewBox="-4 -4 N+8 N+8">` with a white background rect and the path in black. Buttons: Connect with Tailscale → `cce_remote_connect`; Disconnect → `cce_remote_disconnect`; New code → `cce_remote_new_code`; Copy link → `cce_remote_copy {text}`; Save (app address) → `cce_remote_set_app_url {url}`; remove device → `cce_remote_remove_device {id}`; Open Tailscale → `cce_remote_open_tailscale`; links (install, HTTPS consent, admin DNS page) → the extension's own `open_url {url}`. `mount(null)` stops timers.

- [ ] **Step 1: Write the failing tests** (`install.test.ts`, fixtures in `bundles.ts` reproduce the shapes quoted in the spec for both versions): `patchExtensionRemote` count 1, the result contains `require("./cce-remote/bridge.js").attach(p)`, `new Function` parses it (wrap the class snippet), second run on patched code → 0; zero / two `allComms=new Set` → 0. `patchWebviewConnection` on both fixtures: `checks` both true, the snippet still parses (`new Function`), contains `"Connection"`, `__cceConn`, `cce-no-web`, `window.__cceRemote.attach(`; a fixture without the content div → `checks.tab` false and the code unchanged except the attach + runtime. `patchConnectionCss` uses the fixture's hashed class names. `installRemoteBridge` into a temp dir copies `bridge.js` + every `lib/*.js`, `removeRemoteBridge` deletes it.
- [ ] **Step 2: Run** `bun test remote-bridge/test/install.test.ts` → FAIL.
- [ ] **Step 3: Implement** `install.ts`, `webview-runtime.js`, the `patch.ts` wiring and the docs.
- [ ] **Step 4: Run** `bun test remote-bridge/test` → PASS.
- [ ] **Step 5: Sandbox dry run.** `HOME=<scratch>/home` with `.vscode-insiders/extensions/anthropic.claude-code-2.1.327-darwin-arm64/` and `.cursor/extensions/anthropic.claude-code-2.1.220-darwin-arm64/` built from the pristine copies (`extension.js`, `webview/index.js`, `webview/index.css`, `package.json`); run `HOME=<scratch>/home bun run patch.ts --no-commit-button`. Expected: every verify line `ok` for 2.1.327 (the four new ones included); 2.1.220 may FAIL only lines that already failed before this change (record which); `node --check` passes on both editors' `extension.js` and `webview/index.js`; `cce-remote/bridge.js` exists in both; `--revert` restores the three files byte-identical to the pristine copies and removes `cce-remote/`.

### Task 10: Web app — scaffold, protocol client, pairing, view model

**Files:**
- Create: `remote-app/package.json`, `remote-app/tsconfig.json`, `remote-app/vite.config.ts`, `remote-app/index.html`, `remote-app/src/main.tsx`, `remote-app/src/lib/protocol.ts`, `remote-app/src/lib/pairing.ts`, `remote-app/src/lib/macs.ts`, `remote-app/src/lib/client.ts`, `remote-app/src/lib/transcript.ts`, `remote-app/src/lib/images.ts`, `remote-app/src/lib/demo.ts`, `remote-app/.gitignore` (`node_modules/`, `dist/`)
- Test: `remote-app/test/pairing.test.ts`, `remote-app/test/client.test.ts`, `remote-app/test/transcript.test.ts`, `remote-app/test/images.test.ts`

**Interfaces:**
- Consumes: the phone protocol (spec), `PhoneMessage`/`Pending` shapes (Task 4).
- Produces: `protocol.ts` types `Project`, `SessionSummary`, `PhoneMessage`, `ContentBlock`, `Pending`, `Choice`, `ServerMsg`, `ClientMsg`, `Ack`; `pairing.ts` `parsePairingInput(text) → {url, code, name} | null` (accepts a full link, a bare `#pair=…` fragment, the raw base64url, or `"https://host:port CODE"`), `normalizeMacUrl(input) → string | null` (adds `https://`, rejects `http://` except `localhost`/`127.0.0.1`, default port 47821 when missing); `macs.ts` `type Mac = {id, name, url, deviceId, token}`, `loadMacs()`, `saveMacs()`, `upsertMac()`, `removeMac()`, `selectedMacId()`/`selectMac()` (localStorage keys `cce-remote:macs`, `cce-remote:selected`); `client.ts` `pairWithMac(url, code, device, {WebSocketImpl?}) → Promise<{deviceId, token, macName}>`, `class RemoteClient` (`constructor(mac, {WebSocketImpl?, timers? = {setTimeout, clearTimeout, setInterval, clearInterval}})`, `connect()`, `close()`, `state: "connecting"|"open"|"offline"|"unauthorized"`, `projects`, `on("state"|"projects"|"snapshot"|"msg"|"stream"|"pending"|"error", fn) → off`, `subscribe(project, session)`, `unsubscribe()`, `send(project, session|null, text, images?) → Promise<Ack>`, `answer(project, session, requestId, choice) → Promise<Ack>`, `interrupt`, `open`, `openClaude`; reconnect 500 ms doubling to 10 s, immediate on `visibilitychange` visible / `online`; `ping` every 25 s; resubscribes after `welcome`; acks time out after 30 s); `transcript.ts` `buildTranscript(messages, stream?) → TranscriptItem[]` (`user` | `assistant-text` | `thinking` | `tool` (with its result attached by `toolUseId`) | `todos` | `result` | `compact` | `streaming`), `toolSummary(name, input) → string`, `splitIdeContext(text) → {text, chips: {kind, label}[]}`, `latestTodos(messages) → {done, total, items} | null`; `images.ts` `fitWithin(w, h, max = 1568) → {w, h}`, `downscaleImage(file) → Promise<{mediaType:"image/jpeg", data}>`; `demo.ts` `demoProjects`, `demoSnapshot(sessionId)`.

- [ ] **Step 1: Scaffold** `npm create`-free: write `package.json` (scripts `dev`, `build` = `tsc --noEmit && vite build`, `preview`, `test` = `bun test test`), deps `preact`, `marked`, `dompurify`, `jsqr`; devDeps `vite`, `@preact/preset-vite`, `typescript`, `@types/dompurify` (if needed). `npm install` (creates `package-lock.json`).
- [ ] **Step 2: Write the failing tests.** pairing: round trip of a link built in the test exactly like Task 2's format (`"https://app.example.com/#pair=" + base64url(JSON.stringify({v:1,u,c,n}))`; don't import `remote-bridge`, the tracks are independent); `"example-mac.tailnet-0000.ts.net"` → `https://example-mac.tailnet-0000.ts.net:47821`; `http://evil` → null. client (fake WebSocket class): `hello` sent first with deviceId/token; `welcome` + `projects` → state open + projects event; close → reconnect after 500, 1000, 2000 ms (fake timers via the injected `timers`); `error bad_token` → state unauthorized and no reconnect; resubscribe after reconnect; `send` resolves on the matching `ack`, rejects on `ok:false`. transcript: tool_use + tool_result pair into one `tool` item; `<ide_selection>The user selected the lines 3 to 9 from /a/b.ts:…</ide_selection>` becomes a chip `b.ts:3-9`; `<ide_opened_file>…/x.ts…` → chip `x.ts`; `<system-reminder>` removed; `toolSummary("Bash",{command:"npm test"})` = `"npm test"`, `Read` → file name, `Grep` → pattern, `WebFetch` → host; latest `TodoWrite` → `{done:2,total:5}`; streaming text appended as the last item; replayed user message with a known uuid replaces the optimistic one. images: `fitWithin(4032, 3024)` → `{w:1568, h:1176}`; small images unchanged.
- [ ] **Step 3: Run** `cd remote-app && bun test test` → FAIL. **Step 4: Implement** the `lib/` modules. **Step 5: Run** → PASS.

### Task 11: Web app — screens, PWA shell, icons, hosting

**Files:**
- Create: `remote-app/src/app.tsx`, `remote-app/src/components/*.tsx`, `remote-app/src/styles/*.css`, `remote-app/public/manifest.webmanifest`, `remote-app/public/sw.js`, `remote-app/public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180), `favicon-32.png` (from `<scratch>/icon/out/`), `remote-app/Dockerfile`, `remote-app/.dockerignore`, `remote-app/nginx.conf`, `remote-app/README.md`

**Interfaces:**
- Consumes: Task 10 modules.
- Produces: the screens Home, Session (transcript + prompt card + composer), Pair (scan / paste / manual), Settings, as in the spec; `?demo` renders from `demo.ts`.

- [ ] **Step 1:** Use the `frontend-design` skill for the visual direction, then build the screens. Required behaviours: prompt card per pending kind with the exact button labels — tool: "Yes" / `alwaysLabel` / "No" (+ optional reason); question: options per question, "Other" + text, "Submit answers" enabled only when every question has an answer; plan: "Yes, and auto-accept edits" / "Yes, manually approve edits" / "No, keep planning" (+ feedback); dialog: "Answer this in VS Code" + "Cancel". Markdown through `marked` → `DOMPurify.sanitize` (links get `target="_blank" rel="noopener noreferrer"`), never raw HTML from messages. Composer textarea font-size 16 px; Send; Stop while running; photo button (`accept="image/*"`, ≤ 4). `navigator.setAppBadge(waitingCount)` when supported.
- [ ] **Step 2:** PWA shell: `index.html` (viewport `width=device-width, initial-scale=1, viewport-fit=cover`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` `black-translucent`, `theme-color`, manifest + apple-touch-icon links); `manifest.webmanifest` per spec; `sw.js` (versioned cache, precache `/`, `/index.html`, `/manifest.webmanifest`, icons; network-first for navigations, cache-first for `/assets/`; ignore non-GET and cross-origin; delete old caches on activate); register in `main.tsx` in production only.
- [ ] **Step 3:** Hosting: `Dockerfile` (`node:22-alpine` → `npm ci && npm run build`; `nginx:alpine` with `nginx.conf` and `dist/`, `EXPOSE 80`, `HEALTHCHECK` on `/`), `nginx.conf` with the headers and CSP from the spec, `README.md` (what it is, pairing, Coolify steps, local dev with `?demo`).
- [ ] **Step 4: Verify.** `cd remote-app && npm run build` → exit 0, `dist/index.html`, `dist/sw.js`, `dist/manifest.webmanifest`. `bun test test` → PASS. Headless Chrome (playwright-core, system Chrome) at 390×844 (iPhone 15) on `vite preview` with `?demo`: Home, a session with each prompt kind, the composer with the keyboard closed; screenshots saved to `<scratch>/shots/`; no console errors. If Docker is available: `docker build -t cce-remote-test remote-app` → success (skip with a note otherwise).

### Task 12: End-to-end verification and hygiene

**Files:**
- Create (scratch only, not in the repo): `<scratch>/e2e/*` rigs.
- Modify: whatever the findings require (with tests first for bugs).

- [ ] **Step 1: Isolated editor.** Install the cached 2.1.327 VSIX into `<scratch>/e2e/ext` (memory recipe "Isolated VS Code E2E"), patch it with `HOME=<scratch>/home2 bun run patch.ts --no-commit-button`, launch Insiders with a clean env plus `CCE_REMOTE_HOME=<scratch>/e2e/remote-home`, `CCE_REMOTE_PORT=47999`, `CCE_REMOTE_TAILSCALE=<repo>/remote-bridge/test/fixtures/fake-tailscale.sh` (mode `ok`, owner `owner@example.com`), `--user-data-dir` (short symlink), `--extensions-dir`, `--remote-debugging-port`, a scratch workspace folder.
- [ ] **Step 2: Connection tab over CDP.** Open the Claude panel, click Connection, click Connect with Tailscale; expect "Connected", an address, a code and a QR; screenshot.
- [ ] **Step 3: Phone over a fake `tailscale serve`.** A Bun proxy on 47998 that adds `Tailscale-User-Login: owner@example.com` and forwards HTTP + upgrades to 47999. A Bun phone client: pair with the code from the tab (read via CDP), hello, `projects` lists the workspace; `send(null, "Reply with exactly: pong")` → a new tab opens in the editor, the reply streams to the phone and shows in VS Code; `send` to that session "Run the shell command `echo cce-remote-ok` with the Bash tool" → a `tool` pending reaches the phone, VS Code shows the prompt, the phone answers allow → VS Code's prompt disappears, the result contains `cce-remote-ok`; `"Use the AskUserQuestion tool to ask me to pick red or green"` → question pending → answer green → the transcript shows the answer. Screenshots of VS Code after each step.
- [ ] **Step 4: Real app.** `vite preview` of the build (no CSP) in headless Chrome at 390×844 pointed at the proxy (`http://127.0.0.1:47998`, allowed by `normalizeMacUrl` for localhost); pair by entering the address + code; screenshots of Home and the session.
- [ ] **Step 5: Stop** only the isolated instance (PID with that `--user-data-dir`, no `--type=`) and the proxy.
- [ ] **Step 6: Hygiene.** A scan script reads the real tailnet name, Mac DNS name, login and IPs from `tailscale status --json` (never printing them) and greps every new/changed file; plus grep for the owner's email domain, `AIza`, `sk-ant`, `/Users/`, `100.`-style IPs, the Coolify server IP. Expected: no hits (except `/Users/` in docs where it's generic, which is then rewritten to `~`). `git status --porcelain` shows only intended files; `remote-app/node_modules` and `dist` are ignored.
- [ ] **Step 7: Final review.** One fresh reviewer over the whole change (superpowers:requesting-code-review), focusing on security of the bridge and patch safety; fix confirmed findings with tests; rerun `bun test remote-bridge/test`, `cd remote-app && bun test test && npm run build`, the sandbox dry run.
