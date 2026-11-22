# CCE Remote

A home-screen web app for your iPhone that follows and controls the Claude Code sessions running in VS Code on your Mac. It shows every open VS Code window with the patched Claude Code as a project, with its sessions and their live state: needs you, running, new, idle. Open a session to read along while Claude works, answer its permission prompts, questions and plan approvals, send messages and photos, start new sessions, or stop a turn.

The phone talks to your Mac directly, over Tailscale. The server that hosts this app only serves its files: your sessions never pass through it.

## How it works

```
iPhone (CCE Remote, from your server)
   │  wss://<mac>.<tailnet>.ts.net:47821/ws   (inside your tailnet)
   ▼
tailscale serve (HTTPS)  →  the bridge in the patched Claude Code extension on the Mac
```

The Mac side is part of the patch in this repository (`patch.ts` installs it). It stays off until you turn it on in the **Connection** tab of the Claude Code sessions panel.

## Trust model

**The host of this app is inside your trust boundary.** The phone runs whatever code the host serves, keeps the device token in the app's storage, and sits on your tailnet. Whoever can change the files this server serves (the server, its admin panel, a poisoned build dependency) can act as your paired phone and drive Claude Code on your Mac, which can run commands. To keep that surface small:

- The four runtime libraries (`preact`, `marked`, `dompurify`, `jsqr`) and the build tools are pinned to exact versions with a lockfile, and the image builds with `npm ci`.
- Nothing is loaded from third-party origins at runtime: no CDN, no web fonts, no analytics.
- A strict Content Security Policy (below) only allows the app's own files and connections to `*.ts.net`, or only to your own tailnet with `CCE_REMOTE_TAILNET`.
- The Docker base images are pinned to exact versions, like the dependencies.
- Messages are rendered as sanitised Markdown; links only open outside the app.

A stronger setup for later: let the bridge on the Mac serve the built app itself on its `tailscale serve` address, so no other server is involved.

## Pairing

1. On the Mac: apply the patch (`bun run patch.ts`), reload VS Code, open the Claude Code sessions panel, choose **Connection** and click **Connect with Tailscale**. The tab shows a QR code, a link and a one-time code (valid for 10 minutes).
2. On the iPhone, with Tailscale on: open this app's address in Safari, then **Share → Add to Home Screen**.
3. Open **CCE Remote** from the Home Screen and pair: **Scan the QR code**, **Paste the link** (after "Copy link" on the Mac), or **Enter address and code**.

Pair inside the Home Screen app. On iOS, a Home Screen app has its own storage, separate from Safari: a pairing made in Safari doesn't carry over. If you scan the QR code with the Camera app, the link opens in Safari, and the app asks you to add it to the Home Screen first.

After pairing the phone reconnects by itself. You can pair several Macs and switch between them on the Home screen. Remove a pairing in **Settings**, or remove the phone in the Mac's Connection tab.

If the app can't reach the Mac, check that Tailscale is on on the phone and that the Connection tab says it's connected.

## Notifications

CCE Remote can notify your iPhone when Claude needs you — a question, a permission prompt, a plan or a dialog — and when a session finishes. Tapping a notification opens that session in the app.

### What you need

- iOS 16.4 or later, and CCE Remote **added to your Home Screen** (Share → Add to Home Screen) and opened from there. A Safari tab can't show these notifications.
- Remote access turned on in the Mac's **Connection** tab, a VS Code window open, and the Mac awake. The Mac sends the notifications itself.
- The phone doesn't need Tailscale on to receive a notification; it needs it to open the session.

### Turn them on

1. In CCE Remote, open **Settings**.
2. Under **Notifications**, tap **Turn on notifications** and allow notifications when iOS asks.
3. Choose what you get:
   - **When Claude needs you** — a question, a permission prompt, a plan or a dialog.
   - **When a session finishes** — a turn that ended, including one that stopped with an error.
   - **Only when I'm away from the Mac** — no notification while you're using the Mac (no keyboard or mouse input for 2 minutes).
   - **Show details** — the project, session and question in the notification. With it off, notifications only say that a session needs you or has finished.
4. Tap **Send a test notification**. It should arrive in a moment. If it doesn't, check that remote access is on in the Mac's Connection tab.

The status line shows whether the connected Mac is set up for this phone. Other paired Macs are set up the next time the app connects to them. **Turn off notifications** removes the subscription from this phone and from the Mac.

### Privacy

Notifications are end-to-end encrypted: the Mac encrypts each one for this phone, and Apple's push service only sees ciphertext. The app's server is not involved at all. The phone makes the notification keys and gives its paired Macs the subscription and keys over the authenticated Tailscale connection.

A notification can wait on Apple's push service until the phone is reachable; waiting notifications expire after an hour, finished-session notifications after 10 minutes, and test notifications after a minute. Nothing is sent while remote access is off, while no VS Code window is open, or while the Mac sleeps.

## The home screen

- **Usage.** At the top, Claude Code's own usage meter from the Mac: how much of the 5-hour limit and the weekly limit of the Claude account it is logged in to is used, and when each resets.
  - **Whose limits.** The card's first line is that account's email, as Claude Code itself reported it, so after switching accounts on the Mac you can see which one the numbers belong to. It is left out while Claude Code doesn't know it: just after a switch, when signed out, with an API key or another provider (such as Bedrock or Vertex), or with a Claude Code version that doesn't report it (2.1.330 does).
  - **Refreshing.** The app asks for fresh numbers when it opens and every 5 minutes while it is open. The Mac also passes on new numbers whenever Claude Code learns them, which happens on every reply.
  - **When no session is open.** The Mac reads fresh numbers through a Claude Code session that is open in one of its VS Code windows, at most once a minute. Without one, the card shows the last numbers and how old they are.
  - **What it needs.** Claude Code 2.1.325 or later (older versions, such as Cursor's, have no usage meter), and a Claude subscription login. An API key has no such limits.
- **Active.** Every session that is running or waiting for you, from all windows, in one list. Each row names its window, and the window lists below hold the rest.
- **New.** A green dot marks a session with activity this phone hasn't shown yet. Opening it here clears it. Each phone keeps its own, apart from VS Code: reading a session in VS Code doesn't clear it here, nor the other way round.

## Slash commands

Type `/` in the message field and a list of the window's slash commands opens above it. These are the Claude Code commands VS Code's own `/` menu shows for that window:
- built-ins such as `/compact`, `/context` and `/review`;
- your own and the project's commands;
- skills;
- plugin and MCP commands.

Typing more of a name narrows the list.

- **Running one.** Tap it to run it. It is sent to the session like a message, so it runs in that session in VS Code, exactly as if you had typed it there. You see the result on the phone and on the Mac.
- **Arguments.** A command that takes arguments has an arrow. It puts the command in the field with a space, so you can type the arguments before sending. Typing `/name arguments` and tapping Send works too.
- **Commands VS Code shows a dialog for.** For `/context`, `/usage`, `/model`, `/mcp`, `/config` and `/settings`, VS Code opens its own dialog or picker on the Mac. From the phone, Claude Code answers them in text instead.
- **Settings changed from the phone.** A model, effort level or setting changed this way applies to the running session, but VS Code's pickers keep showing the old value, and a new session starts from VS Code's settings.
- **`/clear`, `/reset` and `/new`** start a new session in the same VS Code tab, and the phone follows it there.
- **What it needs.** The list comes from the Mac, so it needs a Mac patched with this version. A Mac that wasn't says it can't list commands yet, and typing a command still works.

## Dictation

Tap the microphone in the message field and speak. Your words appear in the field as you talk; tap the microphone again to stop, edit if you like, then send. Nothing is sent until you tap Send. On the iPhone the words come from Apple's dictation, in the phone's language or the one chosen in Settings → Dictation. If iOS doesn't offer dictation to the home-screen app, the microphone opens the keyboard instead, and its own microphone key does the same job.

## Hosting on Coolify

The app is a static build served by nginx (see `Dockerfile` and `nginx.conf`; the Dockerfile says how to move its pinned base images to newer versions).

1. New resource → your repository → build pack **Dockerfile**.
2. Base directory: `remote-app`. Dockerfile location: `/Dockerfile`.
3. Port: `80` (the container's health check calls `/`).
4. Set a domain with HTTPS (Coolify's proxy gets the certificate). The phone needs HTTPS: Safari blocks a secure page's connections to non-secure addresses, and the Mac is reached over `wss://`.
5. Optional: set the environment variable `CCE_REMOTE_TAILNET` to your tailnet's DNS name (e.g. `tailnet-0000.ts.net`; Tailscale's admin console shows it under **DNS**). The app may then connect only to Macs in that tailnet; the default, `ts.net`, allows any tailnet. A value that isn't a DNS name stops the container at start, with a line saying so in its log.
6. Deploy, open the domain on the iPhone, add it to the Home Screen.

Optionally enter the app's address in the Mac's Connection tab (**Phone app address**), so the QR code opens the app directly.

nginx serves every response with:

- `Content-Security-Policy: default-src 'self'; connect-src 'self' wss://*.ts.net:* https://*.ts.net:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (with `CCE_REMOTE_TAILNET=tailnet-0000.ts.net`, connect-src is `'self' wss://*.tailnet-0000.ts.net:* https://*.tailnet-0000.ts.net:*`)
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self)` (for the QR scanner)
- `Cache-Control: no-cache` for `index.html`, `sw.js` and the manifest; a year, immutable, for `/assets/`.

A service worker keeps the app shell available offline and refreshes it on the next start after a deploy.

## Development

```bash
cd remote-app
npm ci
npm run dev            # http://localhost:5173/?demo
npm test               # bun test test
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ on http://localhost:4173
docker build -t cce-remote .          # the production image (nginx on port 80)
docker run --rm -p 8080:80 -e CCE_REMOTE_TAILNET=tailnet-0000.ts.net cce-remote   # http://localhost:8080
```

`?demo` runs the whole app on built-in, made-up data with no network: a pretend Mac with three windows and sessions in every state, including each kind of prompt. Useful deep links: `?demo&session=demo-session-invoices` (a permission prompt), `demo-session-datepicker` (questions), `demo-session-router` (a plan), `demo-session-exports` (a dialog), `demo-session-ratelimit` (running), `?demo&screen=pair`, `?demo&screen=settings`, and `&inset=59,34` to fake an iPhone's safe areas on a desktop browser.

For a local bridge, `http://localhost` and `http://127.0.0.1` addresses are accepted when entered by hand; everything else must be `https://`.

## Files

- `src/lib/`: the protocol client, pairing, storage of paired Macs, what this phone has read (`readstate.ts`), the usage frame and how the card shows it (`usage.ts`), matching slash commands to what is typed (`commands.ts`), the transcript view model, image downscaling, demo data (tested with `bun test`).
- `src/state/`: the app's store, the home screen's lists and dots (`home.ts`), the demo source, question answers, text helpers.
- `src/components/`: the screens (Home, Session, Pair, Settings) and their parts.
- `src/styles/`: design tokens and styles (dark by default, light when the system is light).
- `public/`: the manifest, the service worker and the icons.
