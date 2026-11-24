# Phone Sessions in the Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new session started from the phone, and a stopped session the phone wakes that VS Code doesn't show, open where the user keeps Claude Code (the sidebar for `claudeCode.preferredLocation: "sidebar"`), not always in an editor tab.

**Architecture:**
- The window agent passes `{programmatic:'honor-preferred-location'}` to `claude-vscode.editor.open` where it passes `pin-to-panel` today. Claude Code then sends the session into the sidebar's webview, which starts the session's Claude process at once.
- The agent keeps taking the new channel and injecting the prompt as before.
- New: a sidebar that hasn't started (no `provider.sidebarComms`, or its page isn't ready yet) is revealed and waited for first. Its start-up chat's channel is then already known, so it can't be taken for the new session.

**Tech Stack:** Plain CommonJS bridge (Node built-ins and `vscode` only), `bun test` on the fake extension.

**Spec:** `docs/superpowers/specs/2026-11-24-phone-sessions-in-sidebar-design.md`

> **Superseded in part (2026-11-24).** Task 1's reveal-and-wait mechanism (focus command, `clientReady`, `sidebarStartupMs`) failed the end-to-end check and was replaced, together with fixes from the whole-branch review. The spec's "Decisions after the end-to-end check" describes what was built instead.

**Branch:** `phone-sessions-sidebar`, from `main` (f147809). Fast-forward `main` when done, if the user agrees.

## Global Constraints

- `remote-bridge/` stays plain CommonJS: `"use strict"`, Node built-ins and `vscode` only, no dependencies, no build step.
- Command and options, verbatim: `claude-vscode.editor.open` with the sixth argument `{ programmatic: 'honor-preferred-location' }` for a new session and for a stopped session that VS Code doesn't show. `{ programmatic: 'pin-to-panel' }` stays for a session that a tab still shows (reopened in a tab) and for a session that the sidebar shows.
- Focus commands, verbatim: `claudeVSCodeSidebarSecondary.focus` when `vscode.version` is 1.106 or later, else `claudeVSCodeSidebar.focus`. Parse the version as the host does: `String(version).split('.').map(Number)`, then secondary when `major > 1 || (major === 1 && minor >= 106)`.
- Never run `claude-vscode.sidebar.open`, and never write the user's settings.
- The preferred location is `vscode.workspace.getConfiguration('claudeCode').get('preferredLocation')`, read at every send. `"sidebar"` means the sidebar; anything else, or a read that throws, means `"panel"`.
- The sidebar start applies only when `typeof provider.activateInSidebar === 'function'` and the preferred location is `"sidebar"`.
- A new session's whole wait for its channel, the sidebar start included, stays within `channelWaitMs` (default 20 000 ms). The naming wait after it is unchanged.
- `open_failed` and `timeout` still mean that nothing was sent.
- The short wait for a start-up chat is `AGENT_LIMITS.sidebarStartupMs = 3_000`; the constructor option `sidebarStartupMs` overrides it.
- Deadlines and ready times use `Date.now()`, because the waits run on real timers. `this.now` stays the clock for timestamps.
- Tests run with `~/.bun/bin/bun test remote-bridge/test` (bun isn't on this shell's PATH). Baseline: 1360 pass, 4 skip, 0 fail. Known flake: `coordinator.test.ts` "election > a second window joins the hub as a peer…" fails about 1 run in 5, at base too.
- Never run `tailscale serve`, `up` or `down` against a real tailnet.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The sidebar shows an empty chat with its own Claude process** (the user's screenshot, "Untitled"). The phone's message goes only to the new session. Test: Task 1, "an empty chat the sidebar shows…".
2. **The window has just opened and the sidebar's page is still loading** (its comms is registered, `clientReady` is pending). Its start-up chat never takes the message, even though that chat is still launching when the open runs. Test: Task 1, "a sidebar whose page is still loading…".
3. **The user switches `claudeCode.preferredLocation` while VS Code runs.** The next phone session follows the new value. Test: Task 1, "the preferred location is read at each send…".
4. **A woken session opens in the sidebar while it shows another running session.** That session is left alone, and the prompt goes only to the woken one. Test: Task 2, "send(s3) for a user who keeps Claude Code in the sidebar…".
5. **The sidebar never comes up** (the view is gone, or the focus command does nothing). The phone gets `timeout` within `channelWaitMs`, and no `editor.open` runs later to leave an empty session behind. Test: Task 1, "a sidebar that never comes up…".

---

### Task 1: New phone sessions open where the user keeps Claude Code

**Files:**
- Modify: `remote-bridge/test/fake-extension.ts`:
  - `FakeComms` (~191–260): `clientReady`;
  - `FakeProvider` and `createFakeProvider` (~949–1019): optional `sidebarComms` and `activateInSidebar`;
  - `FakeVscode` and `createFakeVscode` (~1035–1110): `version`, `settings`, `workspace.getConfiguration`.
- Modify: `remote-bridge/lib/window-agent.js`:
  - constants (~118–145);
  - constructor (~560–600);
  - `instrument` (~701);
  - `send` doc comment (~1826);
  - `_sendToNewSession` (~1915), with the new helpers next to it.
- Modify (comments only, no behaviour change, no redeploy): `remote-bridge/lib/hub.js:62-64`, `remote-app/src/lib/client.ts:118` and `:298`.
- Test: `remote-bridge/test/window-agent.test.ts`:
  - `Options` and `windowWith` (~112–162);
  - the existing `send(null)` test (~1537);
  - a new `describe("where a new session opens")` after `describe("send")`.

**Interfaces:**
- Produces, in the fakes:
  - `FakeComms.clientReady: Promise<void>`, resolved by default and replaceable;
  - `FakeProvider.sidebarComms?: FakeComms` and `FakeProvider.activateInSidebar?: (sessionId?: string, initialPrompt?: string) => void`, both absent by default;
  - `createFakeVscode({ settings?: Record<string, unknown>, version?: string })`, which returns a `FakeVscode` with:
    - `settings: Record<string, unknown>`, a live copy that tests may change, keyed like `"claudeCode.preferredLocation"`;
    - `version: string`, default `"1.107.0"`;
    - `workspace.getConfiguration(section).get(key)`, which reads `settings[\`${section}.${key}\`]` at call time.
- Produces, in the agent:
  - `AGENT_LIMITS.sidebarStartupMs` (3000) and the constructor option `sidebarStartupMs`;
  - private helpers `_preferredLocation(): 'sidebar' | 'panel'`, `_opensInSidebar(): boolean`, `_sidebarFocusCommand(): string`, `_watchReady(comms): void`, `_hasUnnamedChannel(comms): boolean`, `_sidebarStarted(): boolean` and `_startSidebar(deadline: number): Promise<void>`.
- Produces, in the tests: `SIDEBAR`, `focusCall(id?)`, `sidebarWindow(options)` and `bringUpSidebar(provider, setup?)`, used by Task 2.

- [ ] **Step 1: Branch, extend the fakes and the test helpers**

`git switch -c phone-sessions-sidebar`. Add the fake members above; existing tests keep passing unchanged. In `window-agent.test.ts`:
- add `sidebarStartupMs?: number` to `Options`, and have `windowWith` pass `sidebarStartupMs: options.sidebarStartupMs ?? 0` to the agent;
- add the helpers:

```ts
const SIDEBAR = { "claudeCode.preferredLocation": "sidebar" };
const focusCall = (id = "claudeVSCodeSidebarSecondary.focus") => ({ id, args: [] });

/** A host that can open sessions in the sidebar, for a user who keeps Claude Code there. `started: false`: no sidebar webview yet. */
function sidebarWindow(options: Options & { started?: boolean } = {}) {
  return windowWith({
    ...options,
    vscode: options.vscode ?? createFakeVscode({ settings: { ...SIDEBAR } }),
    before: (parts) => {
      parts.provider.activateInSidebar = () => {};
      if (options.started !== false) parts.provider.sidebarComms = parts.sidebar;
      options.before?.(parts);
    },
  });
}

/** What the host does when the sidebar's webview resolves. `setup` runs before allComms.add, where the agent starts watching clientReady. */
function bringUpSidebar(provider: FakeProvider, setup?: (comms: FakeComms) => void): FakeComms {
  const comms = createFakeComms({ sessions: LISTED });
  setup?.(comms);
  provider.allComms.add(comms);
  provider.sidebarComms = comms;
  return comms;
}
```

- [ ] **Step 2: Write the failing tests**

In the existing test "send(null) opens a new session and injects into the new channel…", the expected call becomes `editorOpen(undefined, HONOR_LOCATION)`. New block:

```ts
describe("where a new session opens", () => {
  const tabOnOpen = (provider: FakeProvider) => () =>
    void setTimeout(() => {
      const opened = createFakeComms({ sessions: LISTED });
      opened.openChannel("c-new");
      provider.allComms.add(opened);
    }, 30);

  test("the sidebar takes the new session where the user keeps Claude Code, and the prompt goes there", async () => {
    const { agent, vscode, sidebar, tab } = sidebarWindow();
    vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c-new"), 50);
    const sent = await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toMatch(/^s-\d+$/);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId);
    expect(tab.received).toEqual([]);
  });

  test("a sidebar that hasn't started is revealed first, and its start-up chat's channel is never taken", async () => {
    const { agent, vscode, provider } = sidebarWindow({ started: false, sidebarStartupMs: 2000 });
    let up: FakeComms | undefined;
    vscode.commands.onCommand = (id) => {
      if (id === "claudeVSCodeSidebarSecondary.focus")
        setTimeout(() => {
          up = bringUpSidebar(provider);
          setTimeout(() => up!.openChannel("c-startup"), 30);
        }, 30);
      else setTimeout(() => up!.openChannel("c-new"), 30);
    };
    const sent = await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([focusCall(), editorOpen(undefined, HONOR_LOCATION)]);
    expect(up!.received.map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(up!.channels.get("c-new")!.sessionId);
  });

  test("a sidebar that reopens an older session starts no start-up chat: the open follows after the short wait", async () => {
    const { agent, vscode, provider } = sidebarWindow({ started: false, sidebarStartupMs: 300 });
    let up: FakeComms | undefined;
    let upAt = 0;
    let openedAt = 0;
    vscode.commands.onCommand = (id) => {
      if (id === "claudeVSCodeSidebarSecondary.focus") {
        up = bringUpSidebar(provider, (comms) => comms.openChannel("c-old", "s3"));
        upAt = Date.now();
        return;
      }
      openedAt = Date.now();
      setTimeout(() => up!.openChannel("c-new"), 30);
    };
    await agent.send(null, "new");
    expect(openedAt - upAt).toBeGreaterThanOrEqual(290);
    expect(up!.received.map((m) => m.channelId)).toEqual(["c-new"]);
  });

  test("the short wait starts once the sidebar's page is ready (clientReady), not when its comms appears", async () => {
    const { agent, vscode, provider } = sidebarWindow({ started: false, sidebarStartupMs: 200 });
    let up: FakeComms | undefined;
    let readyAt = 0;
    let openedAt = 0;
    vscode.commands.onCommand = (id) => {
      if (id === "claudeVSCodeSidebarSecondary.focus") {
        up = bringUpSidebar(provider, (comms) => {
          comms.clientReady = new Promise((resolve) => setTimeout(() => ((readyAt = Date.now()), resolve()), 300));
        });
        return;
      }
      openedAt = Date.now();
      setTimeout(() => up!.openChannel("c-new"), 30);
    };
    await agent.send(null, "new");
    expect(readyAt).toBeGreaterThan(0);
    expect(openedAt - readyAt).toBeGreaterThanOrEqual(190);
  });

  test("before VS Code 1.106 the sidebar is revealed with claudeVSCodeSidebar.focus", async () => {
    const vscode = createFakeVscode({ settings: { ...SIDEBAR }, version: "1.105.2" });
    const { agent } = sidebarWindow({ started: false, channelWaitMs: 300, vscode });
    await expect(agent.send(null, "new")).rejects.toThrow("timeout");
    expect(vscode.commands.calls[0]).toEqual(focusCall("claudeVSCodeSidebar.focus"));
  });

  test("a focus command that fails rejects open_failed, and nothing is opened or sent", async () => {
    const { agent, vscode, sidebar, tab, logs } = sidebarWindow({ started: false });
    vscode.commands.onCommand = () => {
      throw new Error("command 'claudeVSCodeSidebarSecondary.focus' not found");
    };
    await expect(agent.send(null, "new")).rejects.toThrow("open_failed");
    expect(vscode.commands.calls).toEqual([focusCall()]);
    expect([...sidebar.received, ...tab.received]).toEqual([]);
    expect(logs.some((line) => line.includes("not found"))).toBe(true);
  });

  test("no sidebar start where the host can't open sessions there, or where the user keeps tabs", async () => {
    const olderHost = windowWith({ vscode: createFakeVscode({ settings: { ...SIDEBAR } }) });
    const keepsTabs = windowWith({ before: ({ provider }) => void (provider.activateInSidebar = () => {}) });
    for (const { agent, vscode, provider } of [olderHost, keepsTabs]) {
      vscode.commands.onCommand = tabOnOpen(provider);
      await agent.send(null, "new");
      expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
    }
  });

  // Review Focus 1, 2, 3 and 5
  test("an empty chat the sidebar shows with its own Claude process is left alone: the prompt goes to the new session", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ before: (parts) => void parts.sidebar.openChannel("c-blank") });
    vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c-new"), 50);
    await agent.send(null, "new");
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
  });

  test("a sidebar whose page is still loading is waited for: its start-up chat, launching when the open runs, is never taken", async () => {
    let ready!: () => void;
    const { agent, vscode, sidebar } = sidebarWindow({
      sidebarStartupMs: 2000,
      before: (parts) => void (parts.sidebar.clientReady = new Promise<void>((resolve) => (ready = resolve))),
    });
    setTimeout(() => {
      ready();
      setTimeout(() => sidebar.openChannel("c-startup", undefined, { pending: true }), 20);
    }, 100);
    vscode.commands.onCommand = () => {
      sidebar.promoteChannel("c-startup"); // the start-up chat's Claude process is up by now
      setTimeout(() => sidebar.openChannel("c-new"), 30);
    };
    await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]); // its comms was there: not revealed again
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
  });

  test("the preferred location is read at each send: a switch to tabs while VS Code runs counts at once", async () => {
    const { agent, vscode, provider } = sidebarWindow({ started: false });
    vscode.settings["claudeCode.preferredLocation"] = "panel";
    vscode.commands.onCommand = tabOnOpen(provider);
    await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
  });

  test("a sidebar that never comes up rejects timeout within channelWaitMs, and no session is asked for", async () => {
    const { agent, vscode } = sidebarWindow({ started: false, channelWaitMs: 400 });
    const startedAt = Date.now();
    await expect(agent.send(null, "new")).rejects.toThrow("timeout");
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(vscode.commands.calls).toEqual([focusCall()]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `~/.bun/bin/bun test remote-bridge/test/window-agent.test.ts -t "new session"`
Expected: FAIL. The calls show `pin-to-panel` and no focus command. The not-started tests time out or take `c-startup`.

- [ ] **Step 4: Implement in `remote-bridge/lib/window-agent.js`**

**Constants:**
- `SIDEBAR_FOCUS = 'claudeVSCodeSidebar.focus'` and `SECONDARY_SIDEBAR_FOCUS = 'claudeVSCodeSidebarSecondary.focus'`;
- `AGENT_LIMITS.sidebarStartupMs: 3_000`, commented "how long a sidebar whose page just got ready gets to start its start-up chat's Claude process";
- the comment on `PIN_TO_PANEL` becomes "An editor tab: where a session that a tab showed is reopened". The one on `HONOR_LOCATION` becomes "Where the user keeps Claude Code (`claudeCode.preferredLocation`): the sidebar or an editor tab. Phone sessions open this way."

**Constructor:**
- option `sidebarStartupMs = AGENT_LIMITS.sidebarStartupMs` → `this.sidebarStartupMs`, described in the JSDoc;
- `this._readyAt = new WeakMap()` (comms → `Date.now()` when its `clientReady` settled, 0 for a comms without one);
- `this._readyWatched = new WeakSet()`.

**Helpers:**
- `instrument(comms)` calls `this._watchReady(comms)` once the comms is wrapped.
- `_watchReady(comms)`:
  - idempotent through `_readyWatched`;
  - when `comms.clientReady` is a thenable, either outcome sets `_readyAt` to `Date.now()` and calls `this._notify()`;
  - otherwise it sets `_readyAt` to 0;
  - every host read is guarded.
- `_preferredLocation()` and `_opensInSidebar()`: as in Global Constraints.
- `_sidebarFocusCommand()`: by `vscode.version`, as in Global Constraints.
- `_hasUnnamedChannel(comms)`: some entry of `comms.channels` or `comms.pendingChannels` for which `_sessionOf` gives nothing.
- `_sidebarStarted()` is true when all of these hold:
  - `provider.sidebarComms` is an object; call `_watchReady` on it, as a fallback for a comms that `instrument` never saw;
  - it has a ready time;
  - either `Date.now() - readyAt >= this.sidebarStartupMs` or `_hasUnnamedChannel(sidebarComms)`.
- `_startSidebar(deadline)`:
  - return at once when `_sidebarStarted()`;
  - if there is no `sidebarComms`, log `window agent: revealed the Claude Code sidebar to open a new session there` and `await this._command(this._sidebarFocusCommand())` (it rejects `open_failed`);
  - then `await this._waitFor(() => (this._sidebarStarted() ? true : undefined), Math.max(0, deadline - Date.now()))` (it rejects `timeout`).

**`_sendToNewSession(message)`:**
- `const deadline = Date.now() + this.channelWaitMs`;
- `if (this._opensInSidebar()) await this._startSidebar(deadline)`;
- then take `before` as today and use `this._openAndWaitMs(Math.max(0, deadline - Date.now()), () => this._takeNewChannel(before), OPEN_EDITOR, ...editorArgs(undefined, HONOR_LOCATION))`;
- the injection and the naming wait are unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `~/.bun/bin/bun test remote-bridge/test/window-agent.test.ts`, then `~/.bun/bin/bun test remote-bridge/test`
Expected: PASS. The suite is at baseline plus the new tests, with only the known coordinator flake allowed (re-run it once).

- [ ] **Step 6: Correct the comments**

- `send`'s doc comment: "`sessionId` null starts a new session where the user keeps Claude Code (the sidebar or an editor tab; a sidebar that hasn't started is revealed and waited for first)".
- `hub.js:62-64`: "(up to 20 s for the new session's channel, a sidebar's start included, and up to 20 s for its name)".
- `client.ts:118`: "Starting a session waits on the Mac for the new session's Claude process (in VS Code's sidebar or a new tab) and then for its name: up to ~40 s."
- `client.ts:298`: "Opens the session on the Mac where Claude Code is kept: the sidebar or an editor tab."

- [ ] **Step 7: Commit**

```bash
git add remote-bridge/lib/window-agent.js remote-bridge/lib/hub.js remote-bridge/test/fake-extension.ts remote-bridge/test/window-agent.test.ts remote-app/src/lib/client.ts
git commit -m "🔧 Open the phone's new sessions where the user keeps Claude Code"
```

---

### Task 2: A stopped session the phone wakes opens there too

**Files:**
- Modify: `remote-bridge/lib/window-agent.js`, `_channelFor` and its doc comment (~1841–1871)
- Test: `remote-bridge/test/window-agent.test.ts`, `describe("send")` (~1430–1520)

**Interfaces:**
- Consumes: `sidebarWindow`, `editorOpen`, `HONOR_LOCATION` and `PIN_TO_PANEL` from Task 1's test file.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

- In "send(s3) (listed, no channel) opens it in an editor…" (rename it to "…opens it where the user keeps Claude Code…") and in "a session whose channel never opens rejects timeout…", the expected call becomes `editorOpen("s3", HONOR_LOCATION)`.
- These stay `editorOpen("s3", PIN_TO_PANEL)`:
  - the stale-tab test;
  - "a session the sidebar shows without a Claude process…";
  - "a tab that cannot be closed…".
- New test (Review Focus 4):

```ts
test("send(s3) for a user who keeps Claude Code in the sidebar: the sidebar resumes s3 without being revealed first, and s1 there is left alone", async () => {
  const { agent, vscode, sidebar } = sidebarWindow({ started: false });
  vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c3", "s3", { pending: true }), 50);
  const sent = await agent.send("s3", "hi");
  expect(vscode.commands.calls).toEqual([editorOpen("s3", HONOR_LOCATION)]);
  expect(sent).toEqual({ session: "s3", uuid: expect.stringMatching(UUID) });
  expect(sidebar.received.map((m) => m.channelId)).toEqual(["c3"]);
  expect(sidebar.channels.get("c1")?.sessionId).toBe("s1");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `~/.bun/bin/bun test remote-bridge/test/window-agent.test.ts -t "send"`
Expected: FAIL. The three tests that expect `honor-preferred-location` get `pin-to-panel`.

- [ ] **Step 3: Implement in `_channelFor(sessionId)`**

- A session with no tab that the sidebar doesn't hold opens with `editorArgs(sessionId, HONOR_LOCATION)`, with no sidebar start: its channel is found by session id.
- The stale-tab reopen keeps `editorArgs(sessionId, PIN_TO_PANEL)`, and so does the wake-wait branch.
- Doc comment: "A session VS Code doesn't show opens where the user keeps Claude Code (the sidebar resumes it, or a tab). One that a tab still shows without a process has that tab closed and is reopened in a tab. The sidebar is never closed: …" (the rest as today).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `~/.bun/bin/bun test remote-bridge/test`
Expected: PASS, with only the known coordinator flake allowed (re-run it once).

- [ ] **Step 5: Commit**

```bash
git add remote-bridge/lib/window-agent.js remote-bridge/test/window-agent.test.ts
git commit -m "🔧 Wake a stopped session where the user keeps Claude Code"
```

---

### Task 3: Docs, end-to-end check against the real extension, apply

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-phone-remote-design.md`: the `send(...)` action (~375–386) and "Decisions we made" (~844)
- Modify: `docs/superpowers/specs/2026-11-24-phone-sessions-in-sidebar-design.md` (status line)
- Modify: `CLAUDE.md` (the `remote-bridge/` paragraph), `README.md:48`

**Interfaces:**
- Consumes: the behaviour from Tasks 1–2.
- Produces: nothing new.

- [ ] **Step 1: Update the docs**

- **2026-11-19 spec, `send`:**
  - the pin-to-panel sentence becomes `editor.open(sessionId, …, {programmatic:"honor-preferred-location"})`, so the session opens where the user keeps Claude Code (the sidebar or a tab; see `2026-11-24-phone-sessions-in-sidebar-design.md`);
  - a tab that shows the session without a channel is closed and the session reopened with `pin-to-panel`;
  - for `null`: `editor.open` with no session and `honor-preferred-location`. A sidebar that hasn't started is revealed and waited for first, within the same 20 s.
- **2026-11-19 spec, "Decisions":** "New sessions open in an editor tab." becomes "New sessions open where the user keeps Claude Code (an editor tab until 2026-11-24; see `2026-11-24-phone-sessions-in-sidebar-design.md`)."
- **2026-11-24 design:** "Status: approved 2026-11-24, to be built." becomes "Status: built on 2026-11-24."
- **`CLAUDE.md`**, before "Phone messages carry `origin: {kind:"human"}`": "A phone's new session, and a stopped session it messages that VS Code doesn't show, open where the user keeps Claude Code (`claude-vscode.editor.open` with `{programmatic:"honor-preferred-location"}`: the sidebar for `claudeCode.preferredLocation: "sidebar"`, else a tab). A sidebar that hasn't started yet is revealed and waited for first, so its start-up chat never takes the phone's message (design: `docs/superpowers/specs/2026-11-24-phone-sessions-in-sidebar-design.md`)."
- **`README.md:48`:** "and start new sessions." becomes "and start new sessions, which open where you keep Claude Code in VS Code (the sidebar or an editor tab)."

- [ ] **Step 2: Run the whole suite**

Run: `~/.bun/bin/bun test remote-bridge/test`
Expected: PASS (baseline plus the new tests).

- [ ] **Step 3: Run the end-to-end check in an isolated Insiders**

Never touch the user's running editor.

**Prepare:**
- `SCR=<session scratchpad>/e2e` with `ud/`, `home/`, `ws/` and `remote/`.
- `ln -sfn $SCR /tmp/cce-e2e`: VS Code's IPC socket path must stay under 104 bytes.
- Install the cached VSIX `~/Library/Application Support/Code - Insiders/CachedExtensionVSIXs/anthropic.claude-code-2.1.330-darwin-arm64` with `env -i HOME USER PATH "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" --user-data-dir /tmp/cce-e2e/ud --extensions-dir /tmp/cce-e2e/home/.vscode-insiders/extensions --install-extension <vsix>`.
- Patch it: `HOME=$SCR/home ~/.bun/bin/bun run patch.ts --no-commit-button`. Every verify line must say OK.
- Write `ud/User/settings.json`: `{"claudeCode.preferredLocation":"sidebar","claudeCode.hideOnboarding":true,"window.dialogStyle":"custom"}`.

**Launch:**
- Start `.../Contents/MacOS/Code - Insiders` with:
  - the environment `env -i HOME USER PATH LANG CCE_REMOTE_HOME=$SCR/remote` (a clean environment, and a separate bridge state so it never joins the live hub);
  - the switches `--user-data-dir /tmp/cce-e2e/ud --extensions-dir /tmp/cce-e2e/home/.vscode-insiders/extensions --inspect-extensions=9339 --remote-debugging-port=9338 --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling --skip-welcome --new-window $SCR/ws`.
- Get the agent through the extension-host inspector (`http://127.0.0.1:9339/json`):
  - evaluate `process.getBuiltinModule('module').createRequire('<ext>/cce-remote/bridge.js')('./lib/window-agent.js').WindowAgent.prototype`;
  - run `Runtime.queryObjects` on it, and use the first instance.
- When Claude Code's "Trust folder" dialog shows in the workbench (`.monaco-dialog-box`, page target on 9338), click it.

**Scenario B, a sidebar that hasn't started:**
- `agent.provider.sidebarComms` must be undefined. If it isn't, close the secondary side bar and reload the window first.
- Send: `await agent.send(null, "Reply with just OK")`.
- Expect:
  - a session id comes back;
  - `agent.provider.sessionPanels.size === 0` (no editor tab);
  - `sidebarComms` now has a channel whose `sessionId` is that id;
  - within about 5 s, `agent.provider.sidebarChatShows?.()` returns that id, and no channel without a session is left on `sidebarComms`.
- Take a workbench screenshot (`Page.captureScreenshot`) into the scratchpad.

**Scenario A, the sidebar has started:** send again, and expect the same with the second id.

**Clean up:**
- kill the main process: the PID whose command line has `--user-data-dir /tmp/cce-e2e/ud` and no `--type=`;
- look into `~/.claude/projects/<encoded $SCR/ws>/`, then delete it;
- remove `/tmp/cce-e2e`.

The Claude Code CLI runs with the user's settings, so their hooks fire (sounds): keep it to these two sends.

- [ ] **Step 4: Apply to the real install**

Run: `~/.bun/bin/bun run patch.ts --no-commit-button`
Expected: every verify line OK. `shasum -a 256` of `remote-bridge/lib/window-agent.js` matches each patched editor's `cce-remote/lib/window-agent.js`. Tell the user to reload every VS Code window.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-19-phone-remote-design.md docs/superpowers/specs/2026-11-24-phone-sessions-in-sidebar-design.md CLAUDE.md README.md
git commit -m "📝 Document where phone sessions open"
```
