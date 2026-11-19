# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iPhone notifications from CCE Remote when a Claude Code session waits for the user or finishes a turn. The Mac sends them as Web Push; tapping one opens the session.

**Architecture:**
- **Mac side.** Window agents emit `attention` events. The coordinator forwards them to the hub at all times, peers included. The hub's notifier decides which paired devices get a push and sends it straight to the push service, with RFC 8291 encryption and VAPID keys the phone made.
- **App side.** The app subscribes, hands its subscription to each Mac over the authenticated WebSocket, shows notifications in its service worker and opens the session from the link.

**Tech Stack:**
- Bridge: plain CommonJS on Node built-ins (crypto, https, child_process), tested with `bun test` and the real-Node smoke scripts.
- App: Preact + TypeScript, WebCrypto, the Push API and a classic service worker; tests run with `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-19-push-notifications-design.md` (read it; it is the authority). Background: `docs/superpowers/specs/2026-11-19-phone-remote-design.md` and `CLAUDE.md`.

## Global Constraints

- **Public repo.** No names, e-mail addresses, host names, tailnet names, deployment URLs or machine paths in code, tests, docs or commit messages.
- **`remote-bridge/` code.**
  - Plain CommonJS with `'use strict'`, only Node built-ins (and `vscode` where it already is), no dependencies, no build step.
  - It must load under Bun (tests) and under Node/Electron (the extension host).
  - New `lib/*.js` files are copied into the extension automatically (`installRemoteBridge`).
- **`remote-app/`.** No new dependencies. Nothing loaded from third-party origins at runtime. `public/sw.js` stays a classic script (no `import`).
- **Protocol stays version 1, backwards compatible.**
  - An old app never sends the new frames.
  - An old bridge answers an acked unknown frame with `ack ok:false error:'unknown_type'`; the new app treats that as "this Mac can't notify".
  - The new bridge ignores a `visibility` frame without a boolean.
- **No real pushes or network in tests.**
  - Never send a real push or touch the real network: transports are injected or local.
  - Never run `tailscale serve/up/down` against the real tailnet.
  - Never touch the running editors (`~/.vscode-insiders`, `~/.cursor`).
- **Secrets stay out of logs.** Logs carry an endpoint's host at most. Never the endpoint URL, keys, JWK or JWT.
- **Commits.** Name the paths explicitly (`git add <paths> && git commit -m "…" -- <paths>`), with the repo's style ("🔧 Add …", "🐛 Fix …", "📝 …"). End each message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Test commands.**
  - `bun test remote-bridge/test` (all green before every commit);
  - `node remote-bridge/test/hub-smoke.js` and `node remote-bridge/test/bridge-smoke.js` (real Node);
  - `(cd remote-app && bun test test && npm run build)`.

## Review Focus

1. **iOS tap rule.** `Notification.requestPermission()` must be the first thing awaited in the tap that turns notifications on. Any await before it (key generation, `serviceWorker.ready`) makes iOS refuse. Pinned by a call-order test in Task 4.
2. **Stale "looking".** iOS can suspend the app without the hidden `visibility` frame getting out. The device must count as not looking once its socket has been silent for 40 s. Pinned by a hub test with a short `lookFreshMs` in Task 3.
3. **Hostile or broken `push_set`.** A frame with an http endpoint, a port, credentials in the URL, an unknown host, oversized strings, wrong key lengths or a JWK that doesn't match its public key must store nothing and ack an error. Pinned in Task 3.
4. **Oversized text.** Very long titles, questions or commands with emoji and other multibyte text must give a payload of at most 3000 bytes that is still valid JSON and never splits a surrogate pair. Pinned in Task 3.
5. **Shutdown.** Closing the hub while a grace timer waits or a push is in flight must not throw, must not send afterwards and must not keep the process alive. Pinned in Task 3.

---

### Task 1: Web Push sender and the Mac's idle time

**Files:**
- Create: `remote-bridge/lib/webpush.js`, `remote-bridge/lib/idle.js`
- Test: `remote-bridge/test/webpush.test.ts`, `remote-bridge/test/idle.test.ts`

**Interfaces (produces):**

`webpush.js` exports `{ encrypt, vapidAuthorization, sendPush, isAllowedEndpoint, validSubscriptionKeys, validVapid, b64url }`:

- **`encrypt(payload, keys, options?)`** → Buffer.
  - `payload: string | Buffer`; `keys: {p256dh: string, auth: string}` (base64url); `options?: {salt?: Buffer, serverPrivateKey?: Buffer}`.
  - The result is the aes128gcm body: `salt(16) ‖ rs(uint32 BE 4096) ‖ idlen(1)=65 ‖ server public key(65) ‖ ciphertext+tag`.
  - The record is `payload ‖ 0x02`, with no extra padding.
  - Throws `TypeError` for keys of the wrong length.
- **`vapidAuthorization({endpoint, publicKey, privateJwk, subject, now?, expSeconds?})`** → `"vapid t=<jwt>, k=<publicKey>"`.
  - The JWT header is `{"typ":"JWT","alg":"ES256"}`, with claims `{aud: new URL(endpoint).origin, exp: floor(now/1000) + expSeconds, sub: subject}`.
  - Defaults: `now = Date.now()`, `expSeconds = 43200`.
  - The signature is `crypto.sign('sha256', …, {key: createPrivateKey({key: privateJwk, format: 'jwk'}), dsaEncoding: 'ieee-p1363'})`.
- **`sendPush(push, options?)`** → `Promise<{ok: boolean, status: number, gone: boolean}>`.
  - `push = {endpoint, keys, vapid: {publicKey, privateJwk}, subject, payload, ttl, urgency?, topic?}`; `options = {request?: typeof https.request, timeoutMs = 10000, allowEndpoint = isAllowedEndpoint}`.
  - It POSTs with headers `Authorization`, `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `Content-Length`, `TTL`, and `Urgency`/`Topic` when given.
  - `ok` is true for 2xx; `gone` is true for 404 and 410.
  - A refused endpoint, a body over 4096 bytes, a network error or a timeout give `{ok:false, status:0, gone:false}`. It never rejects.
- **`isAllowedEndpoint(url: unknown)`** → boolean.
  - A string ≤ 1024 chars, `https:`, no username or password, port '' or '443'.
  - The hostname ends in `.push.apple.com`, `.push.services.mozilla.com` or `.notify.windows.com`, or equals `fcm.googleapis.com`.
- **`validSubscriptionKeys(keys: unknown)`** → boolean: `p256dh` decodes to 65 bytes starting with 0x04, and `auth` decodes to 16 bytes. Both are base64url strings ≤ 200 chars.
- **`validVapid(vapid: unknown)`** → boolean.
  - `publicKey` decodes to 65 bytes starting with 0x04.
  - `privateJwk` is `{kty:'EC', crv:'P-256', x, y, d}` with 32-byte base64url fields, and `0x04‖x‖y` equals `publicKey`.
  - `createPrivateKey` accepts it.
- **`b64url(buf)`** → string.

`idle.js` exports `{ createIdleReader, parseIdleSeconds, userIdleSeconds }`:

- **`parseIdleSeconds(text: string)`** → `number | null`: the first `"HIDIdleTime" = <digits>` (nanoseconds) as seconds.
- **`createIdleReader({platform = process.platform, run, now = Date.now, cacheMs = 5000, timeoutMs = 2000} = {})`** → `() => Promise<number>`.
  - Non-darwin gives `Infinity`.
  - On darwin it runs `/usr/sbin/ioreg -c IOHIDSystem -d 4` through `run(file, args, {timeoutMs})` (default: `child_process.execFile` with that timeout).
  - Any failure or unparsable output gives `Infinity`.
  - A result is reused for `cacheMs`.
- **`userIdleSeconds`** = `createIdleReader()`.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `remote-bridge/test/webpush.test.ts`:
  - **`"encrypts the RFC 8291 §5 example byte for byte"`.** `encrypt(Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'), {p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg'}, {salt: b('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')})` must equal, as base64url, `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`. These values were checked against Node and Bun crypto.
  - **`"round-trips with a subscriber's keys"`.** Generate a P-256 subscriber key and a 16-byte auth secret. Encrypt `'{"hello":"wörld 🎉"}'`. Decrypt in the test as a browser would: ECDH with the key id from the header, the same HKDF steps and AES-128-GCM. Strip the trailing 0x02. The plaintext must match.
  - **`"signs a VAPID JWT the public key verifies"`.** Use a generated key pair (JWK private, raw public) and endpoint `https://web.push.apple.com/QAbc`. Check:
    - the `vapid t=…, k=…` format;
    - `k` = the public key;
    - the header is `{"typ":"JWT","alg":"ES256"}`;
    - the claims are `aud = 'https://web.push.apple.com'`, `exp = floor(now/1000) + 43200` and `sub` as given;
    - the signature verifies with `dsaEncoding: 'ieee-p1363'`.
  - **`"allows only known push services over https"`.**
    - True: `https://web.push.apple.com/x`, `https://api.push.apple.com/x`, `https://fcm.googleapis.com/fcm/send/x`, `https://updates.push.services.mozilla.com/wpush/v2/x`, `https://wns2-par02p.notify.windows.com/w/?token=x`.
    - False: `http://web.push.apple.com/x`, `https://web.push.apple.com:8443/x`, `https://user:pw@web.push.apple.com/x`, `https://push.apple.com.evil.com/x`, `https://evilpush.apple.com/x` (no dot before `push`), `https://localhost/x`, `https://127.0.0.1/x`, a 1025-char https URL, `42`, `undefined`.
  - **`"checks subscription keys and VAPID keys"`.** Valid generated keys pass. Wrong lengths, a non-0x04 first byte, a JWK whose `x` differs from `publicKey`, a non-EC JWK and non-strings fail.
  - **`"sendPush posts the encrypted body with the push headers"`.** A stub `request` records the method, headers and body, then answers 201. Check:
    - `{ok:true, status:201, gone:false}`;
    - the headers `TTL: '3600'`, `Urgency: 'high'`, `Topic`, `Content-Encoding: 'aes128gcm'` and `Authorization` starting with `vapid t=`;
    - the body decrypts to the payload with the subscriber keys.
  - **`"sendPush reports gone, refused and failed pushes without throwing"`.**
    - 410 → `{ok:false, status:410, gone:true}`; 404 → gone; 429 → not gone.
    - A request that emits `error` → status 0.
    - A request that never answers, with `timeoutMs: 50` → status 0 within 1 s, and the request is destroyed.
    - An endpoint the allowlist refuses → status 0 and no request made.
    - A 5000-byte payload → status 0 and no request made.

  In `remote-bridge/test/idle.test.ts`:
  - **`"parses HIDIdleTime"`.** A sample `ioreg` text containing `"HIDIdleTime" = 125000000000` gives 125. Text without it gives null.
  - **`"reads ioreg on macOS and caches the result"`.** A fake `run` counts its calls and the fake `now` advances: two reads within 5 s run once, and a read after 5 s runs again. The arguments are `/usr/sbin/ioreg` and `['-c','IOHIDSystem','-d','4']`.
  - **`"counts as away when it can't tell"`.** `platform: 'linux'` → Infinity without running anything. A `run` that rejects → Infinity. Output without the field → Infinity.

- [ ] **Step 2: Run them and see them fail.** Run `bun test remote-bridge/test/webpush.test.ts remote-bridge/test/idle.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `remote-bridge/lib/webpush.js` and `remote-bridge/lib/idle.js`** to the interfaces above.
  - **Key derivation (RFC 8291 §3.4):**
    - `ikm = hkdf(sha256, ecdhSecret, auth, "WebPush: info\0" ‖ ua_public ‖ as_public, 32)`;
    - `cek = hkdf(sha256, ikm, salt, "Content-Encoding: aes128gcm\0", 16)`;
    - `nonce = hkdf(sha256, ikm, salt, "Content-Encoding: nonce\0", 12)`.
  - Use `crypto.createECDH('prime256v1')` (with `setPrivateKey` when a key is injected), `crypto.hkdfSync` and `aes-128-gcm`.
  - **Timeout:** `req.setTimeout`, or a timer that destroys the request. Settle exactly once and drain the response.

- [ ] **Step 4: Run the tests and see them pass.** Run `bun test remote-bridge/test/webpush.test.ts remote-bridge/test/idle.test.ts`, then `bun test remote-bridge/test`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add remote-bridge/lib/webpush.js remote-bridge/lib/idle.js remote-bridge/test/webpush.test.ts remote-bridge/test/idle.test.ts
git commit -m "🔧 Add Web Push encryption, VAPID signing and the Mac's idle time" -- remote-bridge/lib/webpush.js remote-bridge/lib/idle.js remote-bridge/test/webpush.test.ts remote-bridge/test/idle.test.ts
```

---

### Task 2: Attention events from the windows to the hub

**Files:**
- Modify: `remote-bridge/lib/window-agent.js`. The touch points are:
  - `_onIoMessage` (~693), `_onRequest` (~722), `_emitPending` (~932);
  - a new `_titleOf`, using `project()`'s title logic (~1147);
  - `_emitSession` (~1705).
- Modify: `remote-bridge/lib/coordinator.js`: `_bind` (~1159) registers the agent's `attention` event; the hub sink (~1005) and the peer sink (~1036).
- Modify: `remote-bridge/lib/hub.js`: the `addWindow` handle (~524), the `attachPeer` events (~550) and `_removeWindow` (~632).
- Test: `remote-bridge/test/window-agent.test.ts`, `remote-bridge/test/coordinator.test.ts`, `remote-bridge/test/hub.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- **Produces, agent event `'attention'`:** emitted through `_emitSafe`, only while `this._enabled`, with one argument `ev`:
  - **`{kind:'waiting', session, requestId, title, prompt: {kind, toolName, text}}`.**
    - Sent from `_onRequest` after the entry is stored, once per requestId per agent. Keep a bounded set of the last 1000 ids, so a request delivered twice doesn't notify twice.
    - Skipped when the request has no session.
    - `text` is as the spec says: question → `input.questions[0].question`; Bash → `command`; Edit/Write/Read/MultiEdit/NotebookEdit → the base name of `file_path ?? notebook_path`; WebFetch → `url`; WebSearch → `query`; others → the first string value of `input`; plan/dialog → ''.
    - Whitespace is collapsed and the text cut to 140 characters with `…`.
  - **`{kind:'open', session, requestIds: string[]}`.** Emitted from `_emitPending(sessionId)`, so every add, answer, sweep or closed channel reports the session's live prompt ids.
  - **`{kind:'done', session, title, isError, durationMs, text}`.** Emitted from `_onIoMessage` when `sdk.type === 'result'`.
    - `isError` = `sdk.is_error === true || (typeof sdk.subtype === 'string' && sdk.subtype !== 'success')`.
    - `durationMs` = a finite `sdk.duration_ms` or 0.
    - `text` = `sdk.result` collapsed and cut to 140 characters, or ''.
  - **`title`** = `_titleOf(session)`: the live title, else the listed `customTitle ?? summary`, else `'New session'`. Cut to 200 characters.
- **Produces, coordinator.** The sink given to `_bind` gains `attention(ev)`:
  - hub role: `window.attention(ev)`;
  - peer role: `link.notify('attention', ev)`, always, NOT gated by `active`.

  `_bind` adds and removes the `attention` listener like `project`/`session`, with a throwing sink caught by `_quiet`.
- **Produces, hub.**
  - The `addWindow()` handle gains `attention(ev)`.
  - `attachPeer` routes the peer event `'attention'` to it.
  - The hub validates `ev`: a record, `kind` ∈ `waiting|open|done`, `session` passes `isId`, and for waiting `requestId` passes `isId`.
  - It drops `ev` for a removed window or one without a project yet.
  - Otherwise it emits `hub.emit('attention', {key: win.key, project: win.publicId, projectName: text(win.project.name), ev})`.
  - `_removeWindow` emits `hub.emit('window-removed', win.key)`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - **`window-agent.test.ts`, `describe("attention")`:**
    - **`"a prompt emits waiting once, with its text"`.** Cover a Bash permission request (`command: 'npm  test'` → text `npm test`), an AskUserQuestion (first question's text), an Edit (`/x/y/file.ts` → `file.ts`), ExitPlanMode (kind plan, text '') and a dialog. Each gives one `waiting` with the session, requestId, title and prompt. The same request delivered again gives no second event.
    - **`"answering or losing the channel reports the open prompts"`.** A new prompt gives `open` with `[id]`. Answering it from the phone path gives `open` with `[]`. A closed channel gives `open` with `[]`.
    - **`"a result emits done"`.** Check a success with `result: 'All tests pass.\n\nDetails…'` and `duration_ms: 1234` → `{isError:false, durationMs:1234, text:'All tests pass. Details…'}`. Then `subtype:'error_during_execution'` → isError true.
    - **`"nothing while remote access is off"`.** After `setEnabled(false)`, prompts and results emit no `attention`.
  - **`coordinator.test.ts`, `"attention reaches the hub from its own window and from a peer, with no phone connected"`.** With a hub window and a peer window and no phone, each agent's `emit('attention', {kind:'done', session:'s1', …})` makes the hub emit `'attention'`, with `project` = that window's public id and `projectName` its name.
  - **`hub.test.ts`, `describe("attention")`.**
    - A window handle's `attention` with a valid ev emits `'attention'`.
    - Invalid kinds and ids, a window without a project and a removed window emit nothing.
    - `remove()` emits `'window-removed'` with the key.
    - A peer link's `'attention'` event reaches the same path. Use the existing peer test helpers.

- [ ] **Step 2: Run them and see them fail.** Run `bun test remote-bridge/test/window-agent.test.ts remote-bridge/test/coordinator.test.ts remote-bridge/test/hub.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement it** in `window-agent.js`, `coordinator.js` and `hub.js` per the Interfaces above. Keep the existing events and their gating unchanged.

- [ ] **Step 4: Run the whole bridge suite and the smoke scripts.** Run `bun test remote-bridge/test && node remote-bridge/test/hub-smoke.js && node remote-bridge/test/bridge-smoke.js`. Expected: all pass.

- [ ] **Step 5: Commit** the three lib files and three test files, with explicit paths: "🔧 Forward attention events from every window to the hub".

---

### Task 3: The notifier in the hub, the protocol frames, the Connection tab and the docs

**Files:**
- Create: `remote-bridge/lib/notifier.js`
- Modify:
  - `remote-bridge/lib/hub.js`: constructor, `_onPhoneMessage`, `_onHello` (welcome), `_publicDevices`, `_removeWindow`, `close`, and a looking check;
  - `remote-bridge/webview-runtime.js`: the device row (~475–480).
- Modify (docs):
  - `docs/superpowers/specs/2026-11-19-phone-remote-design.md`: the protocol section gets the new frames and `welcome.push`; the trust model notes the outbound push to the push service;
  - `CLAUDE.md`: the remote-bridge modules list gets `webpush.js`, `idle.js` and `notifier.js`, plus `devices[].push` in `state.json`;
  - `README.md`: the phone-remote section gets a "Notifications" paragraph (needs the home-screen app, remote access on, a VS Code window open and the Mac awake; E2E encrypted).
- Test: `remote-bridge/test/notifier.test.ts` (new); `remote-bridge/test/hub.test.ts` (`describe("push")`, plus one end-to-end test); `remote-bridge/test/webview-runtime.test.ts` (the device row)

**Interfaces:**
- Consumes:
  - Task 1: `sendPush`, `isAllowedEndpoint`, `validSubscriptionKeys`, `validVapid` from `webpush.js`, and `userIdleSeconds` from `idle.js`.
  - Task 2: the hub's `'attention'` `{key, project, projectName, ev}` and `'window-removed'` (key) events.
- **Produces, `notifier.js` exports `{ Notifier, NOTIFIER_LIMITS, buildPayload }`:**
  - **The constructor.** `new Notifier({state, updateState, isLooking, macName, log, now = Date.now, idleSeconds = userIdleSeconds, send = sendPush, sendOptions = {}, timers = {setTimeout, clearTimeout}, limits = {}})`.
    - `isLooking(deviceId) → boolean` comes from the hub.
    - `sendOptions` is handed to `send`, so the end-to-end test injects `request` and `allowEndpoint`.
    - Timers are `unref`'d.
  - **`NOTIFIER_LIMITS`** = `{graceMs: 4000, awayAfterS: 120, capPerMinute: 12, failLogEveryMs: 3_600_000, maxPayloadBytes: 3000, dedupeKeep: 1000, ttl: {waiting: 3600, done: 600, test: 60}, urgency: {waiting: 'high', done: 'normal', test: 'high'}}`.
  - **`attention({key, project, projectName, ev})`.**
    - `waiting`: records the requestId as open, then schedules a push after `graceMs`. The push is dropped if an `open` event without that id arrives first.
    - `open`: replaces the session's open set.
    - `done`: pushes now.
  - **`windowRemoved(key)`** drops that window's open sets and timers.
  - **`waitingCount()`** = the number of sessions with a non-empty open set.
  - **`hasPush(deviceId)`** → boolean (from `state()`).
  - **`setPush(deviceId, frame)`** → `{ok:true}` or `{ok:false, error:'bad_request'|'bad_endpoint'|'bad_keys'|'save_failed'}`.
    - It validates per the spec, with prefs defaulting to true.
    - It stores `{endpoint, keys, vapid, subject, prefs, createdAt}` through `updateState`, only when endpoint, keys, vapid, subject or prefs differ. The original `createdAt` is kept.
  - **`clearPush(deviceId)`** → `{ok:true}` or `{ok:false, error:'save_failed'}`.
  - **`test(deviceId)`** → `Promise<{ok:true} | {ok:false, error:'push_off'|'push_gone'|'push_failed', status?}>`.
  - **`close()`**: no timers, no sends afterwards.
- **`buildPayload({kind, details, mac, project, projectName, ev, badge, macName})`** → string (JSON).
  - Fields `{v:1, kind, title, body, tag, url, mac, badge}`, with these exact texts:
    - **With details:**
      - title = projectName (≤ 60 chars) or `'Claude Code'`;
      - body = `<ev.title (≤ 80 chars) or 'Untitled'>\n<line>`, where line is one of:
        - question: `Claude asks: <text>`, or `Claude has a question`;
        - tool: `Allow <toolName>: <text>?`, or `Allow <toolName>?`;
        - plan: `Plan ready for your approval`;
        - dialog: `Claude needs your input`;
        - done: `Finished: <text>`, or `Finished`;
        - done with isError: `Stopped with an error`.
      - Lines are cut to 160 chars.
    - **Without details:** title `Claude Code`; body `A session needs your input` (waiting) or `A session finished` (done).
    - **test:** title `CCE Remote`, body `Notifications from <macName> work.`, tag `cce-test`, url `/`.
    - **Otherwise:** tag = `<mac>:<project>:<session>`; url = `/?mac=<enc>&project=<enc>&session=<enc>` (`encodeURIComponent`).
  - All cuts are by code point, with `…`. When the JSON is over `maxPayloadBytes`, the body is cut further until it fits.
- **Who gets a push.** For each device with `push`:
  - skip it if the pref for the kind is off;
  - skip it if `isLooking(id)`;
  - skip it if `prefs.onlyAway` and `await idleSeconds() < awayAfterS`;
  - skip it if over the cap (12 in the last 60 s; log once per minute);
  - otherwise send with `Topic` = the first 32 chars of base64url(sha256(`${kind}\n${project}\n${session}`)), `ttl`/`urgency` per kind and `subject` = the stored subject.
  - `gone` → remove `push` from that device in `updateState`, only if its endpoint is still the one that failed.
  - Other failures → log the host and status, at most once per device per `failLogEveryMs`.
- **Hub changes.**
  - The hub creates `this._notifier` in its constructor with `isLooking: (id) => this._isLooking(id)`. It forwards its own `'attention'`/`'window-removed'` events to it and calls `close()` in `close()`.
  - `_isLooking(id)`: some authed, open phone of that device has `phone.visible !== false` and `performance.now() - phone.lastFrameAt <= this._limits.lookFreshMs`. Add `lookFreshMs: 40_000` to `DEFAULT_LIMITS`.
  - A phone is visible from its hello.
  - New frames in `_onPhoneMessage`:
    - `visibility`: sets `phone.visible` when the value is a boolean; no reply.
    - `push_set`, `push_clear`, `push_test`: need an ack id (else a `bad_request` error frame) and answer `{t:'ack', id, ok, error?, status?}` from the notifier.
  - `welcome` gains `push: this._notifier.hasPush(device.id)`.
  - `_publicDevices` adds `push: isRecord(device.push)`. It never exposes the subscription or the keys.
  - Hub options gain `notifier?: Partial<NotifierOptions>`, passed through to the Notifier (idle, send, sendOptions, limits), so tests inject them.
- **Connection tab:** a device with `push === true` shows `notifications on` in its meta line, after "last seen …", separated like the existing parts.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - **`notifier.test.ts`.** Use fakes for state and updateState (count the writes), `isLooking`, `idleSeconds`, `send` (records calls and answers a scripted status) and timers (manual). Tests:
    - **`"setPush validates and stores, and writes only changes"`.** A valid frame → ok, stored, 1 write; the same frame → ok, 0 writes; changed prefs → 1 write with `createdAt` kept; missing prefs → all true.
    - **`"setPush refuses bad frames and stores nothing"`.** Cases: a refused endpoint → `bad_endpoint`; bad p256dh/auth lengths → `bad_keys`; a mismatched JWK → `bad_keys`; subject `javascript:x` or `http://x` → `bad_request`; a 10 000-char subject → `bad_request`; non-boolean prefs → `bad_request`; a non-record frame → `bad_request`. Zero writes in every case.
    - **`"waiting pushes after the grace unless answered"`.** A waiting at t=0, then advancing the timers by 4000 → one send. A waiting answered by `open` with `[]` within the grace → no send.
    - **`"who gets a push"`.** Table-driven over looking (true/false) × onlyAway (true/false) × idle (30/300) × pref on/off, for waiting and done. A send happens only when not looking, the pref is on, and not (onlyAway and idle < 120).
    - **`"one push per prompt, and a cap per device"`.** The same requestId twice → one send. 13 done events in a minute → 12 sends and one log line. After 60 s, sends work again.
    - **`"payloads"`.** `buildPayload` for each prompt kind and done/error with details on, and with details off. Check the exact titles and bodies above, plus tag, url (encoded), mac and badge. For a 2000-char emoji title, a 5000-char Bash command and a 3000-char question: the bytes are ≤ 3000, `JSON.parse` works, and there is no lone surrogate (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` doesn't match).
    - **`"the badge counts waiting sessions"`.** Two sessions waiting → the payload badge is 2. `open []` for one → 1. `windowRemoved` → 0.
    - **`"a gone subscription is removed, other failures are logged once an hour"`.** A 410 removes `push` from the device, but keeps it when the stored endpoint changed meanwhile. A 500 twice within an hour → one log line, and the log text contains the host but not the endpoint path.
    - **`"test pushes ignore looking and away"`.** `test` with looking true and idle 0 → sent with tag `cce-test`. No push → `push_off`. A 410 → `push_gone` and removed. A 500 → `push_failed` with status 500.
    - **`"close stops timers and sends"`.** Close with a waiting in its grace → no send after advancing the timers. A send in flight resolving after close doesn't throw or log.
  - **`hub.test.ts`, `describe("push")`.** Use the existing `startHub`/`connectPhone` helpers, with `hub: {notifier: {send: fake, idleSeconds: async () => 9999, limits: {graceMs: 0}}}`.
    - **`"push_set, push_clear and push_test are acked"`.** Also: a frame without an id gets the `bad_request` error frame.
    - **`"welcome tells whether this Mac holds a subscription"`.** It reports false before and true after a reconnect.
    - **`"a looking phone gets no push, a hidden one does"`.** Visible and connected → no send. After `{t:'visibility', visible:false}` → a send.
    - **`"a phone that went silent counts as not looking"`.** With `limits: {lookFreshMs: 50}`, after 80 ms with no frames → a send.
    - **`"devices show push without the keys"`.** `devices()` has `push: true`, and `JSON.stringify(devices())` contains neither the endpoint nor `d`.
    - **`"a push reaches the push service end to end"`.** A real local `http.createServer` stands in for the push service. The test passes `notifier: {sendOptions: {request: http.request, allowEndpoint: () => true}, idleSeconds: async () => 9999, limits: {graceMs: 0}}` and sets push with an `http://127.0.0.1:<port>/push/abc` endpoint (allowed by the injected check). The hub window handle emits waiting. The server receives a POST, and the test decrypts the body with subscriber keys it generated. The payload's kind, title, tag, url and badge are as expected.
  - **`webview-runtime.test.ts`, `"a device with push shows notifications on"`.**

- [ ] **Step 2: Run them and see them fail.** Run `bun test remote-bridge/test/notifier.test.ts remote-bridge/test/hub.test.ts remote-bridge/test/webview-runtime.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement `notifier.js` and the hub and Connection tab changes** per the Interfaces above. Each send's promise is caught: the notifier never produces an unhandled rejection.

- [ ] **Step 4: Update the docs** as listed in Files. Describe behaviour, not code. No private data.

- [ ] **Step 5: Run everything.** Run `bun test remote-bridge/test && node remote-bridge/test/hub-smoke.js && node remote-bridge/test/bridge-smoke.js`. Expected: all pass.

- [ ] **Step 6: Commit** the lib, runtime, test and doc files, with explicit paths: "🔧 Send push notifications from the hub".

---

### Task 4: The app: turning notifications on, the service worker and opening from a notification

**Files:**
- Create: `remote-app/src/lib/push.ts`, `remote-app/test/push.test.ts`, `remote-app/test/sw.test.ts`
- Modify:
  - `remote-app/src/lib/protocol.ts`: the `ClientMsg` variants `push_set`, `push_clear`, `push_test` and `visibility`; `WelcomeFrame.push?: boolean`; `Ack.status?: number`;
  - `remote-app/src/lib/client.ts`: the `welcome` event and the visibility frames;
  - `remote-app/src/state/source.ts` and `remote-app/src/state/demo-source.ts`: the push methods;
  - `remote-app/src/state/store.ts`: push state and actions, the badge and the deep link;
  - `remote-app/src/components/Settings.tsx`: the Notifications group;
  - `remote-app/src/main.tsx`: the worker's `cce-open` message;
  - `remote-app/public/sw.js`: push, click and badge;
  - `remote-app/src/styles/*.css`, only if the switch rows need a style.
- Modify (docs): `remote-app/README.md` gets a "Notifications" section, written for the iPhone user (steps, privacy, "only when away", the test button, the requirements).
- Test: `remote-app/test/client.test.ts`, `remote-app/test/store.test.ts`, the new `push.test.ts` and `sw.test.ts`

**Interfaces:**
- Consumes (the Mac side, Task 3):
  - `push_set {id, subscription:{endpoint, keys:{p256dh, auth}}, vapid:{publicKey, privateJwk}, subject, prefs:{waiting, done, onlyAway, details}}`, `push_clear {id}`, `push_test {id}`: acked, with errors `bad_request|bad_endpoint|bad_keys|save_failed|push_off|push_gone|push_failed` (+`status`). An old Mac answers `unknown_type`.
  - `visibility {visible}`.
  - `welcome.push`.
  - Push payload `{v:1, kind:'waiting'|'done'|'test', title, body, tag, url, mac, badge}`, where `mac` = the device id that Mac gave this phone (`Mac.deviceId`).
- **Produces, `push.ts`:**
  - **Types and constants.** `type PushSupport = 'ok'|'not-installed'|'unsupported'|'denied'`; `interface PushPrefs {waiting; done; onlyAway; details}` (booleans); `DEFAULT_PUSH_PREFS` (all true); `interface PushSetup {subscription: {endpoint, keys: {p256dh, auth}}, vapid: {publicKey, privateJwk}, subject, prefs}`.
  - **`interface PushEnv`.** `{navigator, Notification, crypto, storage, origin, userAgent, maxTouchPoints, standalone(): boolean, caches}`. The default reads the browser globals; tests pass fakes.
  - **`pushSupport(env?)`.**
  - **`ensureVapidKeys(env?)`** → `Promise<{publicKey, privateJwk}>`.
    - Key `cce-remote:vapid`.
    - ECDSA P-256, extractable.
    - `publicKey` = base64url of the raw export.
    - Storage that can't be written still returns the keys for this run.
  - **`subscribePush(prefs, env?)`** → `Promise<PushSetup>`.
    - It calls `env.Notification.requestPermission()` FIRST, before any other await.
    - It throws `Error('denied')` unless the result is `'granted'`.
    - Then it gets the VAPID keys, `serviceWorker.ready`, and `pushManager.subscribe({userVisibleOnly: true, applicationServerKey: <raw public key bytes>})`.
    - If a subscription with another key exists, it unsubscribes it first.
    - `subject` = `env.origin`.
  - **`currentSetup(prefs, env?)`** → `Promise<PushSetup | null>` (null without permission, a subscription or keys).
  - **`unsubscribePush(env?)`.**
  - **Prefs and the on flag.** `loadPushPrefs`/`savePushPrefs` (`cce-remote:push-prefs`); `isPushOn`/`setPushOn` (`cce-remote:push`).
  - **`parseOpenLink(search: string)`** → `{mac, project, session} | null`. All three are required and non-empty, each ≤ 256 chars.
  - **`setBadgeCount(mac: string, count: number, env?)`.** It reads and writes `/badge.json` in cache `cce-badge` (a JSON map mac → count; it drops macs given count 0), then calls `navigator.setAppBadge(sum)`, or `clearAppBadge()` when the sum is 0. It never throws.
- **Produces, client and sources.**
  - `ClientEvents.welcome: WelcomeFrame`.
  - `RemoteClient.pushSet(setup): Promise<Ack>`, `pushClear(): Promise<Ack>` and `pushTest(): Promise<Ack>` go through the existing acked-request path.
  - The client sends `{t:'visibility', visible}` right after each welcome and on every `visibilitychange` while open. `visible` = `document.visibilityState === 'visible'`. The existing wake-up behaviour stays.
  - `Source` gains the three push methods. `DemoSource` answers `{ok:false, error:'demo'}`.
- **Produces, store.**
  - **State.** `AppState.push: {support: PushSupport, on: boolean, busy: boolean, prefs: PushPrefs, mac: 'on'|'off'|'unknown'|'unsupported', error: string | null}`.
  - **Methods.**
    - `enablePush()`: called straight from the button's click handler; `subscribePush` comes first.
    - `disablePush()`.
    - `setPushPref(key: keyof PushPrefs, value: boolean)`: saves the pref and sends `push_set` to the connected Mac.
    - `testPush()`: toasts the outcome.
    - `openFromLink(link: {mac, project, session})`.
  - **On every `welcome`, while on:**
    - `currentSetup()` is null → set on false, toast `Notifications were turned off on this iPhone`, send `pushClear`;
    - otherwise `pushSet` → ack ok gives mac `on`; `unknown_type` gives `unsupported`; other errors give `off` with `error` set.
  - **Turning on** with a connected Mac sends `push_set`. **Turning off** unsubscribes and sends `push_clear`.
  - **Badge:** every projects update calls `setBadgeCount(mac.deviceId, waitingCount(projects))`.
  - **`openFromLink`**:
    - if `link.mac` matches a paired Mac's `deviceId` that isn't the current one, it switches to that Mac first;
    - then it opens the session (`openSession`);
    - an unknown mac only clears the link.
  - **`start()`** consumes `parseOpenLink(location.search)` and replaces the URL with the path alone (`history.replaceState`, keeping the state).
  - **`main.tsx`** listens to `navigator.serviceWorker`'s `message` and calls `openFromLink(parseOpenLink(new URL(data.url, location.origin).search))` for `{type:'cce-open', url}`.
- **Produces, `public/sw.js`:**
  - **`push`:**
    - payload: `event.data.json()`, guarded;
    - fallback notification: title `Claude Code`, body `Open CCE Remote`, tag `cce`;
    - otherwise: `showNotification(title, {body, tag, data:{url}, icon:'/icons/icon-192.png', badge:'/icons/icon-192.png', renotify: kind === 'waiting'})`, with strings cut to sane lengths;
    - the badge map update and `setAppBadge(sum)` run when `mac` is a string and `badge` a non-negative integer;
    - everything happens inside `event.waitUntil`.
  - **`notificationclick`:**
    - `notification.close()`;
    - the target is `data.url` resolved against `self.location.origin`; anything off-origin becomes `/`;
    - `clients.matchAll({type:'window', includeUncontrolled:true})`: the first client is focused and posted `{type:'cce-open', url}`, otherwise `clients.openWindow(url)`.
  - **Badge cache:** the name `cce-badge` doesn't start with `cce-remote-`, so `activate` keeps it.
- **Settings.** A "Notifications" group between "Paired Macs" and "About", with the spec's states and exact texts:
  - **Guidance:**
    - not installed: `Add CCE Remote to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications.`
    - unsupported: `This browser can't show notifications from CCE Remote. On iPhone they need iOS 16.4 or later.`
    - denied: `Notifications are blocked for CCE Remote. Allow them in the Settings app → Notifications → CCE Remote.`
    - demo: `Notifications aren't available in the demo.`
  - **Off:** the button `Turn on notifications` and the hint `Get a notification when Claude needs you or a session finishes.`
  - **On:**
    - switches: `When Claude needs you`; `When a session finishes`; `Only when I'm away from the Mac` (sub: `After 2 minutes without keyboard or mouse use on the Mac`); `Show details` (sub: `Project, session and question in the notification`);
    - the status `<Mac name>: on` / `not set up yet` / `this Mac's patch is too old for notifications` / `can't be reached right now`;
    - the note `Other paired Macs are set up the next time the app connects to them.`;
    - the buttons `Send a test notification` and `Turn off notifications`.
  - **Switches** are native checkboxes with `role="switch"` and labels. Turning notifications on calls `ensureVapidKeys()` when Settings mounts.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - **`push.test.ts`** uses fake `Notification`/`PushManager`/serviceWorker/storage/caches and Bun's real `crypto.subtle`:
    - **`"support"`.** iPhone UA, not standalone → `not-installed`; no PushManager on desktop → `unsupported`; permission denied → `denied`; standalone with the APIs → `ok`.
    - **`"VAPID keys are made once and kept"`.** Check: a 65-byte raw key starting with 0x04; a JWK with `d`; the second call returns the same keys; JWK x/y match the raw key.
    - **`"subscribing asks for permission before anything else"`.** A call log shows `requestPermission` before `generateKey`/`ready`/`subscribe`. Denied → rejects `denied` and doesn't subscribe. A subscription with another `applicationServerKey` is unsubscribed first. The setup has the endpoint, keys, vapid, `subject` = origin and prefs.
    - **`"parseOpenLink"`.** It reads `?mac=a&project=p%2F1&session=s` (decoded). Missing parts, empty values or 300-char values give null.
    - **`"badge sums Macs"`.** `setBadgeCount('a', 2)` then `('b', 1)` → `setAppBadge(3)`; `('a', 0)` → 1; all 0 → `clearAppBadge`. A throwing `caches` doesn't throw.
  - **`sw.test.ts`** loads `public/sw.js` with `node:vm` into a context with fake `self` (event listeners, `registration.showNotification`, `clients`, `location.origin = 'https://app.example'`, `navigator.setAppBadge`), `caches`, `URL`, `Request`, `Response`, `fetch` and `setTimeout`:
    - **`"a push shows its notification and sets the badge"`.** Check the title, body, tag, `data.url` and `renotify` for waiting, and the badge map update.
    - **`"an unreadable push still shows a notification"`.** A throwing `data.json()` or a null `data` gives the fallback.
    - **`"a click focuses the app and tells it what to open"`.**
    - **`"a click opens the app when it is closed"`.**
    - **`"a click never leaves the app's origin"`.** A url `https://evil.example/x` opens `/`.
  - **`client.test.ts`.**
    - **`"sends visibility after welcome and on visibility changes"`.**
    - **`"push requests are acked"`** (`pushSet`, `pushClear`, `pushTest` with an ack id).
    - **`"emits welcome"`.**
  - **`store.test.ts`.**
    - **`"while on, every welcome sends push_set"`.**
    - **`"a vanished subscription turns notifications off"`.** It sends `push_clear` and toasts.
    - **`"an old Mac shows unsupported"`** (ack `unknown_type`).
    - **`"a link opens the session on its Mac"`.** It switches Mac by deviceId and opens the session; an unknown mac is ignored.
    - **`"projects update the badge"`.**

- [ ] **Step 2: Run them and see them fail.** Run `cd remote-app && bun test test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `push.ts`, the protocol/client/source/store changes, the service worker, `main.tsx` and Settings per the Interfaces above. Reuse the existing UI parts (`ui.tsx`, the group/kv rows in Settings) and the toasts. Write the `remote-app/README.md` section.

- [ ] **Step 4: Run the tests and build.** Run `cd remote-app && bun test test && npm run build`. Expected: all pass, and the type-check and build succeed. Then check that `dist/sw.js` contains the push handler and no placeholder.

- [ ] **Step 5: Commit** the app files and README with explicit paths: "🔧 Add notifications to CCE Remote".
