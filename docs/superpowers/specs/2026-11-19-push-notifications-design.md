# Push notifications for CCE Remote — design

Date: 2026-11-19 · Status: decided autonomously. The user asked for this ("push notifications on iPhone, something we really need") and earlier asked for no questions in this project. The calls we made are listed at the end so they can be reviewed.

## Intent

With the phone in the pocket and CCE Remote closed, the user wants to know when Claude needs them: a question, a permission prompt, a plan to approve. They also want to know when a session finishes. Tapping the notification opens that session in the app.

## Goals

- **When Claude waits.** A notification on the iPhone when a session starts waiting for input: a question, a permission prompt, a plan or a dialog. The text names the project and the session and shows the question or the tool.
- **When a turn ends.** A notification when a turn ends ("Finished: …"). It can be turned off.
- **Opening.** Tapping a notification opens the app on that session.
- **Badge.** The app's home-screen badge counts the sessions that wait, summed over the paired Macs.
- **Reach.** It works with several paired Macs and with the app closed or suspended. The phone needn't be on the tailnet to receive one; only opening the session needs the tailnet.
- **No new parts.** No new server and no third-party SDK. Coolify stays out of the data path.

## Non-goals

- Android/desktop-specific polish. It's standard Web Push, so Chrome and Firefox should work, but the iPhone is the target.
- Answering from the notification itself (actions on iOS web notifications are limited). Tapping opens the session.
- Notifications while remote access is off, while no VS Code window is open, or while the Mac sleeps.

## Anti-goals

- **Readable content.** Session content must be readable by no one but the phone. Payloads are end-to-end encrypted (RFC 8291); Apple's push service sees only ciphertext and metadata.
- **Arbitrary URLs.** The Mac must not make requests to arbitrary URLs on a phone's say-so. Endpoints must be https on an allowlist of known push services.
- **Spam.** A burst of prompts or prompts answered at once on the Mac must not produce a pile of notifications.
- **Silent pushes.** iOS requires every push to show a notification, and breaking that gets the subscription revoked. So there is no silent push, not even to update the badge.

## Platform facts (iOS 16.4+ Web Push)

- **Where it works.** Only for web apps added to the Home Screen and opened from there (`display-mode: standalone`).
  - `Notification.requestPermission()` must run inside a tap, before any other `await` in that handler.
  - `PushManager.subscribe({userVisibleOnly: true, applicationServerKey})` then gives `{endpoint, keys: {p256dh, auth}}`, with endpoints on `web.push.apple.com`.
- **Sending.** The sender POSTs to the endpoint with:
  - `Authorization: vapid t=<JWT ES256>, k=<public key>`;
  - `Content-Encoding: aes128gcm`, `TTL`, an optional `Urgency` and `Topic`;
  - a body of at most 4096 bytes.
- **The JWT.** `aud` is the endpoint's origin, `exp` at most 24 h ahead, and `sub` a `mailto:` or `https:` URL. Apple requires `sub`.
- **Answers.**
  - 201: sent.
  - 404 or 410: the subscription is gone, so delete it.
  - 429: back off.
  - 400 or 403: bad JWT or headers.
- **The service worker.**
  - Its `push` handler must call `showNotification`.
  - A `tag` replaces an earlier notification with the same tag.
  - `notificationclick` opens or focuses the app.
  - `navigator.setAppBadge(n)` works for installed apps, from the page and from the worker.
- **Key binding.** A subscription is bound to one `applicationServerKey`.

## Approaches

1. **The Mac sends Web Push directly, with VAPID keys owned by the phone (chosen).**
   - The app generates a VAPID P-256 key pair once with WebCrypto and subscribes with its public key.
   - It gives every paired Mac `{subscription, VAPID keys, app origin, prefs}` over the authenticated WebSocket.
   - Each Mac's hub signs and encrypts with Node crypto and POSTs to Apple.
   - One subscription serves every Mac, and no server is involved.
2. *The Mac owns the VAPID keys.* Simpler hand-off, but only one Mac could ever notify, because a subscription is bound to one key. Rejected.
3. *A push relay on the Coolify server.* It adds a public service that would receive events, which contradicts the trust model. Rejected.

## Design

### Bridge (`remote-bridge/`, Node built-ins only)

#### `lib/webpush.js`

- **`encrypt(payload, {p256dh, auth}, {salt?, serverPrivateKey?})`** follows RFC 8291 aes128gcm:
  - ECDH P-256, HKDF-SHA-256 and AES-128-GCM;
  - one record, `rs` 4096, padding delimiter `0x02`.

  The salt and server key are injectable only so that the RFC 8291 §5 example can be a byte-exact test.
- **`vapidAuthorization({endpoint, publicKey, privateJwk, subject, now, expSeconds})`** returns `vapid t=…, k=…`. The JWT is ES256 with a raw r‖s signature, `aud` is the endpoint origin, and `exp` defaults to now + 12 h.
- **`sendPush(...)`**:
  - Takes `{endpoint, keys, vapid, subject, payload, ttl, urgency, topic}` and options `{request?, timeoutMs = 10000, allowEndpoint?}`.
  - Returns `{ok, status, gone}`.
  - Never throws: a network error or timeout gives status 0.
- **`isAllowedEndpoint(url)`** accepts https only, on port 443, on hosts that end in `.push.apple.com` or `.push.services.mozilla.com` or `.notify.windows.com`, or that are exactly `fcm.googleapis.com`.

#### `lib/idle.js`

`userIdleSeconds()` reads macOS `HIDIdleTime` from `/usr/sbin/ioreg -c IOHIDSystem -d 4` with a 2 s timeout, cached for 5 s. Other platforms or a failed read give `Infinity`, which counts as away.

#### Window agent → `attention` events

These are emitted like the other events, only while remote access is on.

- **`{kind: 'waiting', session, requestId, title, prompt: {kind, toolName, text}}`** fires once per requestId when a prompt appears.
  - `kind` is one of `'question'|'tool'|'plan'|'dialog'`.
  - `text` is:
    - for a question, its first question;
    - for a tool, the key argument: the command for Bash, the file's base name for file tools, the URL for WebFetch, the query for WebSearch, otherwise the first text field;
    - '' for a plan or a dialog.
  - It is cut to 140 characters.
  - **Never announced.** A prompt that appeared while remote access was off, or while no hub listened, is announced as `waiting` when a hub starts listening (`replayAttention`); one already announced to a hub is only counted.
- **`{kind: 'open', session, requestIds}`** fires whenever the list of a session's open prompts changes. `requestIds` is the list as it is now, often empty once answered here or on the phone.
- **`{kind: 'done', session, title, isError, durationMs, text}`** fires when a `result` ends a turn. `text` is the start of the result text (140 characters).

#### Coordinator and hub plumbing

- **Coordinator.** `attention` is forwarded always: to the local hub's window handle, or over the peer link (`notify('attention', ev)`). It is not gated by "a phone is connected", unlike session events.
- **Hub.** A window handle gets `attention(ev)`, and a peer's `attention` event reaches the same path. The hub resolves the window's public project id and name and hands both to the notifier.

#### `lib/notifier.js` (owned by the hub)

- **Storage.** Push settings are stored per device in `state.json` as `devices[i].push = {endpoint, keys: {p256dh, auth}, vapid: {publicKey, privateJwk}, subject, prefs: {waiting, done, onlyAway, details}, createdAt}`.
  - Written only through `updateState`, and only when something changed.
  - Removed with the device.
  - Never shown outside the hub: the Connection tab sees `push: true` only.
- **Bookkeeping.**
  - It keeps the open prompts per session (from `waiting` and `open`) to count the sessions that wait (the badge).
  - It drops a window's entries when the window goes.
- **Who gets a push.** A device gets one only if all of these hold:
  - it has `push`;
  - the matching pref is on;
  - it isn't looking.

    Looking means an authenticated socket of that device whose last `visibility` frame said visible and which sent any frame within the last 40 s. The app pings every 25 s; a backgrounded app stops pinging.
  - With `onlyAway`, the Mac has also seen no keyboard or mouse input for at least 120 s.
- **Grace for prompts.** A `waiting` push goes out after 4 s. If an `open` event shows the prompt answered in the meantime, nothing is sent. Away and looking are checked when it goes out.
- **Payload.** JSON, at most 3000 bytes before encryption: `{v: 1, kind, title, body, tag, url, mac, badge}`.
  - `mac` is the device id. The app knows each Mac by the device id it got there.
  - `tag` is `<mac>:<project>:<session>`, so a session has one notification at a time.
  - `url` is `/?mac=<id>&project=<id>&session=<id>`.
  - **Long ids.** A tag over 128 characters becomes `cce:` + the first 32 characters of base64url(sha256(`${mac}\n${project}\n${session}`)), still one stable tag per session; a url over 1024 characters becomes `/`, so the app opens on its home screen.
  - `badge` is the number of sessions that wait on this Mac.
  - **With `details`:**
    - title: the project name.
    - body: the session title on the first line, then one of:
      - "Claude asks: …"
      - "Allow <Tool>: <arg>?"
      - "Plan ready for your approval"
      - "Claude needs your input" (a dialog)
      - "Finished: <excerpt>", or "Finished"
      - "Stopped with an error"
  - **Without `details`:** title "Claude Code", body "A session needs your input" or "A session finished".
- **Headers.**
  - `Topic` is 32 base64url characters of sha256(kind, project, session), so a newer push replaces one still queued at Apple.
  - `Urgency`: high for waiting and test, normal for done.
  - `TTL`: 3600 s for waiting, 600 s for done, 60 s for a test.
- **Limits.**
  - Dedupe: one push per requestId.
  - Flood cap: 12 pushes per device per minute; over that, pushes are dropped and logged once.
  - Gone (404/410): the subscription is removed (only if it is still the same endpoint).
  - Other failures are logged at most once per device per hour and never retried.
  - Logs carry the endpoint's host only, never the URL, keys or JWT.

#### Phone protocol additions (v1, backwards compatible)

- **`{t: 'push_set', id, subscription: {endpoint, keys: {p256dh, auth}}, vapid: {publicKey, privateJwk}, subject, prefs}`** → ack.
  - Validated: endpoint against the allowlist; keys by decoded length (65 bytes starting `0x04`; auth 16 bytes); the JWK as a P-256 key that matches `publicKey`; `subject` as `https:` or `mailto:`; prefs as booleans (missing ones default to on).
  - Errors: `bad_request`, `bad_endpoint`, `bad_keys`, `save_failed`.
- **`{t: 'push_clear', id}`** → ack.
- **`{t: 'push_test', id}`** → ack once the push service accepted it, otherwise one of:
  - `{ok: false, error: 'push_off'}`;
  - `'push_gone'`;
  - `'push_failed', status`.

  It ignores looking, away and the cap.
- **`{t: 'visibility', visible}`** has no ack. A socket counts as visible from its hello until it says otherwise.
- **`welcome`** gains `push: boolean`: this Mac holds a subscription for the device.
- An old bridge answers the new acked frames with `unknown_type` and ignores `visibility`. An old app never sends them.

#### Connection tab

A paired device with `push` shows "notifications on".

### App (`remote-app/`)

#### `src/lib/push.ts` (browser APIs injectable for tests)

- **`pushSupport()`** returns `'ok' | 'not-installed' | 'unsupported' | 'denied'`. `'not-installed'` means an iPhone or iPad browser tab that isn't the home-screen app.
- **`ensureVapidKeys()`** generates an ECDSA P-256 pair once and stores `{publicKey (raw, base64url), privateJwk}` in `localStorage` `cce-remote:vapid`.
  - It runs when Settings opens, so the tap that turns notifications on can call `requestPermission()` first.
- **`subscribePush()`**: permission, then `pushManager.subscribe`, then the setup to send.
- **`currentSetup()`**: `getSubscription()` → the setup or null.
- **`unsubscribePush()`.**
- **Storage.** Prefs live in `cce-remote:push-prefs`, defaults `{waiting: true, done: true, onlyAway: true, details: true}`. "On" lives in `cce-remote:push`.
- **`parseOpenLink(search)`** reads the deep link.
- **`setBadgeCount(mac, n)`** keeps per-Mac counts and sets the badge to their sum. The counts live in Cache Storage (`cce-badge`, `/badge.json`), shared with the service worker.

#### Client and store

- **Client frames.**
  - The client sends `visibility` on `visibilitychange` and right after `welcome`.
  - It gains `pushSet`, `pushClear` and `pushTest` (acked) and a `welcome` event.
  - `DemoSource` answers them with `demo`.
- **On every `welcome`, while notifications are on.** The store sends `push_set` (endpoint, keys and prefs stay fresh; the hub writes only changes). If the subscription vanished or permission was withdrawn, it turns notifications off and sends `push_clear`.
- **Elsewhere.**
  - Projects updates set the badge count for the connected Mac.
  - The deep link, on load or from the worker's message, selects the Mac with that device id, opens the session and clears the query.

#### Service worker (`public/sw.js`)

- **`push`.** Parses the JSON, then `showNotification(title, {body, tag, data: {url}, icon, renotify})`, then updates the badge. It always shows something, falling back to "Claude Code" / "Open CCE Remote" if the payload can't be read.
- **`notificationclick`.** Only same-origin URLs are followed:
  - if a window is open, it is focused and receives `{type: 'cce-open', url}`;
  - otherwise the click opens `url`.

#### Settings → Notifications

- **States and guidance.**
  - not installed: "Add CCE Remote to your Home Screen and open it from there".
  - unsupported: iOS 16.4+ needed.
  - denied: allow in iOS Settings → Notifications → CCE Remote.
  - demo: not available in the demo.
- **Controls.**
  - A button that turns notifications on or off.
  - Four toggles: When Claude needs you; When a session finishes; Only when I'm away from the Mac; Show details.
  - The connected Mac's status.
  - "Send a test notification".
  - A note that other Macs are set up the next time the app connects to them.

### Docs

- **README.** A "Notifications" section in `remote-app/README.md` and the root `README.md`:
  - requirements and how to turn it on;
  - privacy (E2E encrypted; the Mac contacts Apple's push service);
  - "only when away";
  - that pushes need remote access on, a VS Code window open and the Mac awake.
- **Phone remote spec.** Its protocol section lists the new frames, and its trust model notes the outbound push.
- **CLAUDE.md** names the new modules.

## Testing

- **webpush:**
  - the RFC 8291 §5 vector, byte-exact;
  - a round trip, decrypting with the subscriber's keys as the browser would;
  - the JWT verifies with the public key, with the right `aud`, `exp` and `sub`;
  - the allowlist;
  - `sendPush` with a stub transport: 201, 404/410, 429, a timeout and a network error.
- **idle:** `ioreg` output parsing, the cache, non-macOS, and a failed run.
- **agent:**
  - `waiting` once per requestId with the text for each prompt kind;
  - `open` after an answer and after a closed channel;
  - `done` on a result;
  - nothing while remote access is off.
- **coordinator/hub plumbing:** attention from the hub's own window and from a peer reaches the hub with no phone connected.
- **notifier and hub:**
  - `push_set` validation and storage, without a write when nothing changed;
  - `push_clear` and `visibility`;
  - the matrix of looking × away × prefs;
  - grace and cancel;
  - dedupe and the cap;
  - 410 removal;
  - `push_test`;
  - payloads per kind, with details on and off;
  - the badge count;
  - `welcome.push`;
  - the devices view.
- **End to end, local:** a real hub, a phone socket and a fake window, with pushes going to a local HTTP server. The test decrypts the body with subscriber keys it generated.
- **app:**
  - `push.ts` with fake browser APIs;
  - client frames;
  - store reactions to `welcome`;
  - deep links;
  - `public/sw.js` loaded into `node:vm` with fakes (push mapping, fallback, click handling, badge sum).
- **iPhone:** the user turns notifications on and taps "Send a test notification".

## Decisions we made (for review)

- **Both kinds on by default.** Both "needs you" and "finished" notifications are on by default and can be switched off. There is no minimum turn length.
- **Only when away, by default.** "Only when I'm away from the Mac" is on by default: no input on the Mac for 120 s.
- **Grace period.** Prompts wait 4 s before notifying, so one answered right away on the Mac sends nothing.
- **Details shown.** Notifications are detailed by default; the payload is end-to-end encrypted.
- **Phone-owned VAPID keys.** The phone owns the VAPID keys and gives the private key to its paired Macs. It is stored 0600 in `state.json`, like the device token hashes. It only allows pushing to this phone.
- **`sub`.** It is the app's own origin, so no email address is needed.
- **Badge counts.** The badge sums per-Mac counts. A count can stay high until the next notification or until the app opens, since iOS allows no silent pushes.
