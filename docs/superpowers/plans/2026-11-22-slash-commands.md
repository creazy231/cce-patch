# Slash Commands in CCE Remote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `/` in CCE Remote's message field lists the window's Claude Code slash commands, and tapping one sends `/name` to the session as Send would.

**Architecture:** The phone asks the window for its list with a new acked request, `{t:"commands", id, project}`, routed by the hub like `open` (local window or peer). The window agent reads the list the extension already holds (each comms' config, the stored copy, a running session's `supportedCommands()`) and maps it to VS Code's names. The hub checks and bounds it into the ack. The app caches it per window, filters it as you type, and runs a pick through the composer's normal send. Phone messages gain `origin:{kind:"human"}`.

**Tech Stack:** Plain CommonJS bridge (Node built-ins only, `bun test`), Preact 11 + TypeScript web app (`bun test` with jsdom, `tsc` + Vite build).

**Spec:** `docs/superpowers/specs/2026-11-22-slash-commands-design.md`

## Global Constraints

- **Bridge code style:** `remote-bridge/lib/*` is plain CommonJS: `'use strict'`, `// @ts-check`, only Node built-ins, no dependencies. Everything the agent reads from the host goes through `guard(...)`, and host reads are bounded by `_hostRead`.
- **Never start anything to list commands:** no `get_claude_state`, no `loadConfig()`, no `processRequest`. Only read `settledConfig`, `storedStartupConfig.read(surfaceCwd())`, `channel.query.supportedCommands()` and the `config` promise.
- **Protocol stays version 1,** backwards compatible. An old hub answers `unknown_type`, an old peer window `unknown_method`.
- **Hub bounds on `commands`:**
  - at most 300 entries;
  - `name`: 1–100 characters, no whitespace, no characters matching hub.js's `INVISIBLE_CHAR_RE`, unique;
  - `description`: one line (whitespace runs become one space), control, bidi and invisible characters removed, cut to 300 characters;
  - `argumentHint` and `plugin`: the same treatment, cut to 100 characters;
  - `aliases`: at most 10, each with the name rule;
  - empty strings and lists are left out.
- **Timeouts:** the hub's `commands` call times out after 15 s (`DEFAULT_CALL_TIMEOUTS_MS.commands = 15_000`); the app's request after 20 s.
- **Cache:** the app keeps each window's list about 60 s (`COMMANDS_FRESH_MS = 60_000`). A refetch keeps showing the old list.
- **Copy, verbatim:**
  - "Loading commands…"
  - "No slash commands in this window yet"
  - "No matching command"
  - "This Mac can't list commands yet. Typing one still works."
  - "Couldn't load commands. Tap to try again."
- **UI tokens:** use the app's existing ones in `styles/tokens.css`. No new third-party code.

## Review Focus

1. **Tapping a row on iOS.** Pressing a row must not blur the field; otherwise the list closes before the tap lands and nothing runs. Rows prevent the default of `mousedown` and `pointerdown`. (Task 6 test: "rows keep the field's focus".)
2. **Enter on a hardware keyboard with no match.** With `/xyz` typed and nothing matching, Enter sends the text as typed. It is not swallowed. (Task 6 test: "Enter without a match sends what was typed".)
3. **A window without Claude Code open, or a list not loaded yet.** `commands()` resolves `[]` and the app shows "No slash commands in this window yet", never a spinner that never ends. (Task 2 test: "no comms: []"; Task 6 test: "empty list note".)
4. **Duplicate command names.** A user command and a plugin command share a name: the phone shows the plugin-prefixed name, as VS Code does, and tapping it sends that name. (Task 1 test: "shared names take the alias ending in :name".)
5. **A command picked with photos attached.** The photos go with it, exactly as with Send, and the field and photos clear only when the send was taken. (Task 6 test: "run sends through the normal send". `run` and Send share one `sendText`.)

---

### Task 1: Bridge — map Claude Code's command list to the phone's (`lib/commands.js`)

**Files:**
- Create: `remote-bridge/lib/commands.js`
- Test: `remote-bridge/test/commands.test.ts`

**Interfaces:**
- Produces: `toSlashCommands(raw: unknown): SlashCommand[]`, where `SlashCommand = { name: string, description?: string, argumentHint?: string, aliases?: string[], plugin?: string }` (JSDoc typedef, exported).

- [ ] **Step 1: Write the failing tests** in `remote-bridge/test/commands.test.ts`:
  - `"keeps name, description, argumentHint, aliases and plugin"`: `[{name:"review", description:"Review a PR", argumentHint:"[pr]", aliases:["rv"], builtin:true, plugin:"gh"}]` → `[{name:"review", description:"Review a PR", argumentHint:"[pr]", aliases:["rv"], plugin:"gh"}]`.
  - `"leaves out empty and non-string fields"`: `{name:"a", description:"", argumentHint:"", aliases:[], plugin:7}` → `[{name:"a"}]`. `{name:"b", aliases:["x", 3, ""]}` → `[{name:"b", aliases:["x"]}]`.
  - `"drops entries without a usable name"`: `[null, 1, {}, {name:""}, {name:5}, {name:"ok"}]` → `[{name:"ok"}]`.
  - `"shared names take the alias ending in :name"`: `[{name:"deploy"}, {name:"deploy", plugin:"ops", aliases:["ops:deploy"]}, {name:"lint"}]` → names `["deploy", "lint", "ops:deploy"]`. The `ops:deploy` entry keeps `plugin:"ops"` and `aliases:["ops:deploy"]`.
  - `"a later entry with the same name replaces the earlier one"` (VS Code's registry): `[{name:"x", description:"one"}, {name:"x", description:"two"}]` (no namespaced alias) → `[{name:"x", description:"two"}]`.
  - `"sorted by name"`: input names `["zeta", "Alpha", "beta"]` → `["Alpha", "beta", "zeta"]` (`localeCompare`).
  - `"not an array: []"`: `undefined`, `null`, `{}` and `"x"` each → `[]`.

- [ ] **Step 2: Run them to see them fail.** `bun test remote-bridge/test/commands.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `toSlashCommands(raw)` in `remote-bridge/lib/commands.js`.**
  - The invocation rule is VS Code's `bLe`: count names over the raw list. A name that occurs more than once uses the first alias that ends with `:${name}`, when there is one; otherwise the name itself.
  - Keep entries in a `Map` by invocation, so a later entry replaces the earlier one.
  - Sort with `a.name.localeCompare(b.name)`.
  - The module header comment says where the shapes come from (2.1.330 `config.commands`, `supportedCommands()`) and that the hub bounds the result.

- [ ] **Step 4: Run the tests to see them pass.** `bun test remote-bridge/test/commands.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add remote-bridge/lib/commands.js remote-bridge/test/commands.test.ts && git commit -m "🔧 Map Claude Code's command list to the names VS Code shows"`

### Task 2: Bridge — the window agent's `commands()` and human origin

**Files:**
- Modify: `remote-bridge/test/fake-extension.ts` (FakeComms gets the config fields; `FakeChannel.query` may carry `supportedCommands`; header comment updated)
- Modify: `remote-bridge/lib/window-agent.js` (`commands()`; `userMessage()` gets the origin; the header lists `commands()`)
- Test: `remote-bridge/test/window-agent.test.ts`, `remote-bridge/test/fake-extension.test.ts`

**Interfaces:**
- Consumes: `toSlashCommands` (Task 1).
- Produces: `WindowAgent#commands(): Promise<SlashCommand[]>`. Phone messages carry `origin: {kind: "human"}`.

- [ ] **Step 1: Extend the fake.** These are the 2.1.330 host members, documented in the fake's header:
  - `settledConfig: Record<string, any> | undefined`;
  - `config: Promise<Record<string, any>> | undefined`;
  - `configCwd: string | undefined`;
  - `storedStartupConfig: { read(cwd: string): Record<string, any> | undefined } | undefined`;
  - `surfaceCwd(): string` (returns `this.cwd`);
  - `loadConfig()` and a `get_claude_state` branch in `processRequest`, which record calls into `configLoads: number` (the agent must never cause them).

  The `query` type becomes `FakeUsageQuery & { supportedCommands?(): Promise<unknown[]> }`. Add one fake test pinning that `loadConfig()` and `get_claude_state` count into `configLoads`.

- [ ] **Step 2: Write the failing agent tests** in a new `describe("commands", …)` in `window-agent.test.ts`, built on `windowWith()`:
  - `"the settled config: VS Code's list"`: `sidebar.settledConfig = {commands:[{name:"compact", description:"Compact"}, {name:"init"}]}` → `await agent.commands()` equals `[{name:"compact", description:"Compact"}, {name:"init"}]`.
  - `"the comms for the window's folder comes first"`: workspace folder `/work/demo` (createFakeVscode's folders). `tab.configCwd="/work/demo"`, `tab.settledConfig` = list A; `sidebar.configCwd="/elsewhere"`, `sidebar.settledConfig` = list B → list A.
  - `"the stored copy while the live list loads"`: no `settledConfig`; `sidebar.storedStartupConfig = {read: (cwd) => cwd === "/work/demo" ? {commands:[{name:"stored"}]} : undefined}` → `[{name:"stored"}]`.
  - `"a running session's supportedCommands()"`: no config anywhere; `sidebar.channels.get("c1")!.query = {supportedCommands: async () => [{name:"live"}]}` → `[{name:"live"}]`.
  - `"the pending config promise"`: only `tab.config = Promise.resolve({commands:[{name:"later"}]})` → `[{name:"later"}]`.
  - `"a host read that hangs: [] after hostReadMs"`: `windowWith({hostReadMs: 50})`, `supportedCommands: () => new Promise(() => {})` → `[]` within 1 s.
  - `"no comms: []"`: `new WindowAgent({provider: {allComms: new Set()}, vscode: {}})` → `[]`.
  - `"never asks the host to load a config"`: after each of the above, `sidebar.configLoads === 0 && tab.configLoads === 0`.
  - `"a phone message carries origin human"`: `await agent.send("s1", "/compact")`, then `await sidebar.flush()`; the injected io_message's `message.origin` equals `{kind:"human"}`.

- [ ] **Step 3: Run them to see them fail.** `bun test remote-bridge/test/window-agent.test.ts -t "commands|origin human"`. Expected: FAIL (`agent.commands is not a function`, origin undefined).

- [ ] **Step 4: Implement `async commands()`** in `window-agent.js`, near `refreshUsage`. Sources in this order; the first that yields an array wins:
  1. A comms' `settledConfig.commands`. Comms whose `configCwd`, `path.resolve`d, equals the window's first folder (`this._folders()[0]`) come first.
  2. `storedStartupConfig.read(surfaceCwd())`'s `.commands`, called only when both are functions, inside `guard`.
  3. A running channel's `query.supportedCommands()` through `_hostRead('the command list', …)`. Channels whose `cwd` is the first folder come first. A rejection or timeout moves on to the next source.
  4. A comms' `config`, when it is a thenable, through `_hostRead`.
  5. `[]`.

  Return `toSlashCommands(list)`. In `userMessage()` add `origin: {kind:'human'}` to the returned object, with a comment: Claude Code refuses plugin-provided local commands without it, and VS Code sends it for typed text.

- [ ] **Step 5: Run the whole bridge suite.** `bun test remote-bridge/test`. Expected: PASS. A test that compares a whole injected user message may need `origin` added, which is correct: VS Code sends it too.

- [ ] **Step 6: Commit.** `git add remote-bridge/lib/window-agent.js remote-bridge/test/fake-extension.ts remote-bridge/test/window-agent.test.ts remote-bridge/test/fake-extension.test.ts && git commit -m "🔧 Read a window's slash commands and mark phone messages as typed by a person"`

### Task 3: Bridge — route `commands` through the hub and peers

**Files:**
- Modify: `remote-bridge/lib/hub.js` (`DEFAULT_CALL_TIMEOUTS_MS`, `actionCall`, the frame switch, `_onAction`, new `checkSlashCommands`)
- Modify: `remote-bridge/lib/coordinator.js` (`callAgent`)
- Test: `remote-bridge/test/hub.test.ts`, `remote-bridge/test/coordinator.test.ts`

**Interfaces:**
- Consumes: `WindowAgent#commands()` (Task 2).
- Produces: phone frame `{t:"commands", id, project}` → `{t:"ack", id, ok:true, commands:SlashCommand[]}`, or `{ok:false, error}`.

- [ ] **Step 1: Write the failing tests.**
  - In hub.test.ts's `describe("requests")`, `"commands: routed to the window, acked with the checked list"`: the phone sends `{t:"commands", id:"r1", project:ID}`. The window gets `{method:"commands", args:{}}` and answers `[{name:"compact", description:"Compact the\nconversation"}]`. The ack is `{t:"ack", id:"r1", ok:true, commands:[{name:"compact", description:"Compact the conversation"}]}`.
  - `"commands: the hub bounds what a window answers"`. The window answers 400 valid entries plus each of these, every one of which is dropped:
    - `{name:"has space"}`;
    - `{name:""}`;
    - `{name:"x".repeat(101)}`;
    - `{name:"bad‮name"}`;
    - a duplicate of the first name.

    Also: a description of 500 characters comes back as 300; `aliases` of 12 valid entries come back as 10; an alias `"a b"` is dropped; `argumentHint:"[x]​"` comes back `"[x]"`; `commands.length === 300`.
  - `"commands: a window answer that is not a list acks []"`: the window answers `undefined` → `commands: []`.
  - Extend the existing `DEFAULT_CALL_TIMEOUTS_MS` assertion with `commands: 15_000`.
  - In coordinator.test.ts, `"callAgent('commands') returns agent.commands()"`: a stub agent with `commands: async () => [{name:"x"}]` → `[{name:"x"}]`. Use the file's existing pattern for calling a window through the coordinator; if callAgent isn't reachable, assert through the hub's window call as the other methods' tests do.
  - An old peer: `"commands to a window whose agent lacks it: ack unknown_method"`. Call through a peer link (or coordinator) whose agent has no `commands` → `{ok:false, error:"unknown_method"}`.

- [ ] **Step 2: Run them to see them fail.** `bun test remote-bridge/test/hub.test.ts remote-bridge/test/coordinator.test.ts -t commands`. Expected: FAIL (`unknown_type` acks; the timeouts object differs).

- [ ] **Step 3: Implement.**
  - `actionCall` gets `case 'commands': return { method: 'commands', args: {} };`, after the existing project check.
  - The frame switch sends `'commands'` to `_onAction`.
  - `_onAction` sets `fields.commands = checkSlashCommands(result)` when `call.method === 'commands'`.
  - `checkSlashCommands(value)` is module-level in hub.js and applies the Global Constraints bounds with `INVISIBLE_CHAR_RE`. For text fields, remove the characters it matches, collapse `\s+` to one space, trim, then cut.
  - In coordinator.js `callAgent`: `case 'commands': if (typeof agent.commands !== 'function') throw codeError('unknown_method'); return await agent.commands();`.
  - Update hub.js's JSDoc on `actionCall` and the `_timeoutFor` note.

- [ ] **Step 4: Run the bridge suite.** `bun test remote-bridge/test`. Expected: PASS. (coordinator.test.ts's "election > a second window joins the hub as a peer…" is a known flaky test, failing about 1 in 5 runs at base too. Rerun it alone before treating it as a failure.)

- [ ] **Step 5: Commit.** `git add remote-bridge/lib/hub.js remote-bridge/lib/coordinator.js remote-bridge/test/hub.test.ts remote-bridge/test/coordinator.test.ts && git commit -m "🔧 Let phones ask a window for its slash commands"`

### Task 4: App — protocol, matching, client and demo

**Files:**
- Modify: `remote-app/src/lib/protocol.ts` (`SlashCommand`, the `commands` client message, `Ack.commands?`)
- Create: `remote-app/src/lib/commands.ts`
- Modify: `remote-app/src/lib/client.ts` (`commands(project)`; `COMMANDS_ACK_TIMEOUT_MS = 20_000`)
- Modify: `remote-app/src/state/source.ts` (`commands(project: string): Promise<Ack>`)
- Modify: `remote-app/src/lib/demo.ts` (`DEMO_COMMANDS`), `remote-app/src/state/demo-source.ts` (`commands`)
- Test: `remote-app/test/commands.test.ts` (new), `remote-app/test/client.test.ts`, `remote-app/test/demo.test.ts`

**Interfaces:**
- Produces:
  - `slashQuery(text: string): string | null`: the name being typed while `text` matches `^/\S*$`, without the slash; `null` otherwise.
  - `rankCommands(commands: SlashCommand[], query: string): SlashCommand[]`.
  - `parseCommands(value: unknown): SlashCommand[]`: well-formed entries only, `[]` for anything else.
  - `RemoteClient#commands(project: string): Promise<Ack>` and `DemoSource#commands(project: string): Promise<Ack>`.
  - `DEMO_COMMANDS: SlashCommand[]`.

- [ ] **Step 1: Write the failing tests.**
  - `test/commands.test.ts`, `slashQuery`:
    - `"/"` → `""`;
    - `"/com"` → `"com"`;
    - `"/compact now"` → `null`;
    - `"/a\nb"` → `null`;
    - `"hi /x"` → `null`;
    - `""` → `null`;
    - `" /x"` → `null`.
  - `rankCommands`, list `[{name:"compact"}, {name:"context", description:"Show context usage"}, {name:"init", description:"compact the repo notes"}, {name:"ops:deploy", aliases:["dep"]}, {name:"Config"}]`:
    - query `""` → all, alphabetical with `localeCompare`;
    - `"co"` → `["compact", "Config", "context", "init"]`: the three name-prefix matches alphabetical, then the description match;
    - `"dep"` → `["ops:deploy"]`;
    - `"COMP"` → `["compact", "init"]`;
    - `"zzz"` → `[]`.
  - `parseCommands`:
    - `[{name:"a", description:"d", aliases:["x", 2], plugin:"p", extra:1}, {name:""}, {}, "x"]` → `[{name:"a", description:"d", aliases:["x"], plugin:"p"}]`;
    - `undefined` → `[]`.
  - In client.test.ts's requests, `"commands sends its frame and resolves on the ack"`: `client.commands("p1")` sends `{t:"commands", id, project:"p1"}`, and the ack's `commands` arrives on the resolved Ack. Also `"commands times out after 20 s"`, with the file's fake timers.
  - demo.test.ts, `"the demo lists commands"`: `await demo.commands(<a demo project id>)` → `ok:true`; `commands` includes `compact` and at least one entry with an `argumentHint` and one with a `plugin`.

- [ ] **Step 2: Run them to see them fail.** `cd remote-app && bun test test/commands.test.ts test/client.test.ts test/demo.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `rankCommands` scores each command, case-insensitively:
    - 0: the name starts with the query;
    - 1: an alias starts with it, or the name or an alias contains it;
    - 2: the description contains it;
    - otherwise the command is excluded.

    Sort by score, then `a.name.localeCompare(b.name)`. For `""` everything scores 0.
  - `RemoteClient#commands` is `this.request((id) => ({t:"commands", id, project}), COMMANDS_ACK_TIMEOUT_MS)`.
  - `DEMO_COMMANDS` has 8 entries: `compact`, `context`, `init`, `review` (argumentHint `"[pr number]"`), `release-notes`, a user command `fix-issue` (argumentHint `"[issue]"`), a skill `brainstorming`, and a plugin command `ops:deploy` (plugin `"ops"`, argumentHint `"[env]"`).
  - `DemoSource#commands` resolves after about 150 ms with `{t:"ack", id, ok:true, commands: DEMO_COMMANDS}`, or rejects `not_connected` like `simpleAck`.

- [ ] **Step 4: Run them to see them pass, plus the type check.** `cd remote-app && bun test test && npx tsc --noEmit`. Expected: PASS. The type check covers the store's `FakeSource` in store.test.ts, which now needs `commands`: add `commands(...args) { return this.deferred("commands", args); }`.

- [ ] **Step 5: Commit.** `git add remote-app/src/lib/protocol.ts remote-app/src/lib/commands.ts remote-app/src/lib/client.ts remote-app/src/state/source.ts remote-app/src/lib/demo.ts remote-app/src/state/demo-source.ts remote-app/test && git commit -m "🔧 Teach CCE Remote the commands request and how to match commands"`

### Task 5: App — the store's per-window command cache

**Files:**
- Modify: `remote-app/src/state/store.ts` (`AppState.commands`, `loadCommands`, the welcome and Mac-switch handling)
- Test: `remote-app/test/store.test.ts`

**Interfaces:**
- Consumes: `Source#commands`, `parseCommands` (Task 4).
- Produces:
  - `export type CommandsStatus = "loading" | "ready" | "failed" | "unsupported"`;
  - `export interface CommandsEntry { status: CommandsStatus; list: SlashCommand[]; at: number }`;
  - `AppState.commands: Record<string, CommandsEntry>`, by project id;
  - `Store#loadCommands(project: string): void`;
  - `export const COMMANDS_FRESH_MS = 60_000`.

- [ ] **Step 1: Write the failing tests** in a new `describe("slash commands", …)` in store.test.ts. Use `FakeSource.deferred`, and the store's `now` option to move time.
  - `"the first load asks the Mac and keeps the list"`: `loadCommands("p1")`. The state is `{status:"loading", list:[], at:0}` and one `commands` call goes out with `["p1"]`. The call resolves with an ack whose `commands` is `[{name:"a"}]` → `{status:"ready", list:[{name:"a"}], at: now}`.
  - `"a fresh list is not asked again; an old one is, and stays on screen meanwhile"`. Load again within 60 s → no second call. Move to 61 s and load → a second call, while the state still holds the list with status `ready`.
  - `"one request at a time"`: two `loadCommands("p1")` while loading → one call.
  - `"a failure without a list: failed; with one: the list stays"`. A reject with `RemoteError("timeout")` on the first load → `failed`. After a ready list, a failed refresh keeps `ready` with the old list.
  - `"an old Mac: unsupported, and not asked again until the next welcome"`. A reject with `RemoteError("unknown_type")` → `unsupported`, and a later `loadCommands` makes no call. Emit `welcome` on the fake, then `loadCommands` → a call. Same for `unknown_method`.
  - `"a reconnect makes every list stale"`. After a ready list, a `welcome` → the next `loadCommands` within 60 s asks again.
  - `"switching Macs forgets the lists"`. `state.commands` is `{}` after selecting another Mac, using the file's existing Mac-switch helper.
  - `"not connected: nothing is asked"`. With the fake's state not `open`, `loadCommands` makes no call and leaves no entry.

- [ ] **Step 2: Run them to see them fail.** `cd remote-app && bun test test/store.test.ts -t "slash commands"`. Expected: FAIL.

- [ ] **Step 3: Implement `loadCommands(project)`.**
  - It returns at once when the connection isn't `open`, when the entry is `unsupported`, when a request for the project is in flight (a private `Set`), or when the entry is `ready` and `now() - at < COMMANDS_FRESH_MS`.
  - Otherwise it sets `loading` (keeping a ready list as `ready`) and calls `source.commands(project)`:
    - on success, `parseCommands(ack.commands)` makes the entry `ready`;
    - on `unknown_type` or `unknown_method` it becomes `unsupported`;
    - on any other error, `failed` when there was no list, otherwise unchanged.
  - The welcome handler sets every entry's `at` to 0 and deletes `unsupported` entries.
  - The Mac switch resets `commands` to `{}`.

- [ ] **Step 4: Run the app suite.** `cd remote-app && bun test test && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add remote-app/src/state/store.ts remote-app/test/store.test.ts && git commit -m "🔧 Keep each window's slash commands on the phone"`

### Task 6: App — the list in the message field

**Files:**
- Create: `remote-app/src/components/SlashCommands.tsx`
- Modify: `remote-app/src/components/Composer.tsx` (the `project` prop; open, close, run, insert, keys)
- Modify: `remote-app/src/components/Session.tsx` (passes `project`; prefetches on open and on connect)
- Modify: `remote-app/src/components/icons.tsx` (an insert arrow, `ArrowUpLeft`), `remote-app/src/styles/session.css`
- Modify: `remote-app/src/lib/commands.ts` (`composerKey`)
- Test: `remote-app/test/slash-commands.test.ts` (new), `remote-app/test/commands.test.ts`

**Interfaces:**
- Consumes: `slashQuery`, `rankCommands` (Task 4); `AppState.commands`, `Store#loadCommands` (Task 5).
- Produces:
  - `SlashCommands(props: { id: string; entry: CommandsEntry | undefined; items: SlashCommand[]; highlighted: number; disabled: boolean; onRun(c: SlashCommand): void; onInsert(c: SlashCommand): void; onRetry(): void })`;
  - `Composer` gets the prop `project: string`.

- [ ] **Step 1: Write the failing tests** in `test/slash-commands.test.ts`. Render `SlashCommands` into jsdom as usage-card.test.ts does.
  - `"rows show /name, the argument hint, the description and the plugin"`: an item `{name:"ops:deploy", argumentHint:"[env]", description:"Ship it", plugin:"ops"}` → the row's text contains `/ops:deploy`, `[env]`, `Ship it`, `ops`.
  - `"tapping a row runs it"`: a click on the row calls `onRun` with the item.
  - `"rows keep the field's focus"`: a dispatched `mousedown` and a `pointerdown` on a row both have `defaultPrevented === true`.
  - `"only rows with an argument hint have the insert button, and it inserts"`: the button with `aria-label` "Add arguments to /review" exists for `review`, not for `compact`. Clicking it calls `onInsert` and not `onRun`.
  - `"disabled: rows don't run"`: `disabled: true` → clicking calls nothing, and the rows carry `aria-disabled="true"`.
  - `"the highlighted row is marked"`: `highlighted: 1` → the second row has `aria-selected="true"`.
  - Notes, verbatim:
    - loading with no list → "Loading commands…";
    - ready with an empty `entry.list` → "No slash commands in this window yet";
    - ready with a non-empty list and `items: []` → "No matching command";
    - unsupported → "This Mac can't list commands yet. Typing one still works.";
    - failed with no list → "Couldn't load commands. Tap to try again.", and clicking it calls `onRetry`.

  For Composer behaviour, extract its key handling into a pure exported helper and test that: `composerKey(e: {key, shiftKey, isComposing}, open: boolean, count: number, highlighted: number, fine: boolean): { action: "none" | "move" | "run" | "close" | "send"; highlighted: number }` in `lib/commands.ts`.
  - `"↓ and ↑ move and wrap"`.
  - `"Enter runs the highlighted command on a hardware keyboard"`: open, count 3, fine → `run`.
  - `"Enter without a match sends what was typed"`: open, count 0, fine → `send`.
  - `"Enter on a phone keeps today's newline"`: fine false → `none`.
  - `"Escape closes"`.
  - `"Shift+Enter and composition do nothing special"`.

  Then Composer-level tests. Render `Composer` inside `AppContext.Provider`, with a fake store (`draft`, `setDraft`, `toast`, `loadCommands`) and a state whose `commands.p1` is ready with `[{name:"compact"}, {name:"review", argumentHint:"[pr]"}]`. Focus the textarea, set its value to `/`, and dispatch `input`.
  - `"typing / opens the list and asks for the window's commands"`: the listbox shows both rows, and `loadCommands` was called with `"p1"`.
  - `"run sends through the normal send"`: clicking the `compact` row calls `onSend("/compact", [])`. The field is cleared when `onSend` returns true and kept when it returns false.
  - `"insert puts /review and a space in the field and closes the list"`: the textarea's value is `"/review "`, and the listbox is gone.
  - `"blur closes the list"`.

  Photos go with a run because `run` and the Send button share `sendText`. The final review checks that there is one send routine.

- [ ] **Step 2: Run them to see them fail.** `cd remote-app && bun test test/slash-commands.test.ts test/commands.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `SlashCommands.tsx`.** A `ul role="listbox"` with `id`. Rows are `li role="option"` holding a button area, which prevents the default of `mousedown` and `pointerdown`. An `ArrowUpLeft` icon button sits inside rows that have an `argumentHint`. A note row replaces the rows for the loading, empty, no-match, unsupported and failed states, with the exact copy. The spinner is `Spinner` from ui.tsx.

- [ ] **Step 4: Wire `Composer.tsx`.**
  - **Focus.** `focused` state, from the textarea's `onFocus` and `onBlur`.
  - **When it's open.** `const query = slashQuery(text)`. A `dismissed` flag is set by Escape and cleared when the text changes. `open = focused && query !== null && !dismissed && (entry !== undefined || connected)`.
  - **Loading.** On opening, call `store.loadCommands(project)`.
  - **Items and highlight.** `items = rankCommands(entry?.list ?? [], query)`. The highlight index resets to 0 when the query changes, and only shows when `finePointer()`.
  - **Keys.** `onKeyDown` runs `composerKey` and acts on its answer. `send` falls through to today's Enter-to-send.
  - **Run.** `run(c)` calls the same send routine as the Send button, with the text `"/" + c.name`. Refactor `send()` into `sendText(value: string)` and use it for both.
  - **Insert.** `insert(c)` calls `change("/" + c.name + " ")`, keeps the focus and puts the caret at the end.
  - **Disabled.** `disabled = !canGo || !ready` (photos still preparing), the same as Send.
  - **Accessibility.** `aria-controls` and `aria-activedescendant` on the textarea while open.

- [ ] **Step 5: Wire `Session.tsx` and the CSS.**
  - Session passes `project={view.project}` to `Composer`. A `useEffect` keyed on `[view?.project, connected]` calls `store.loadCommands(view.project)` when connected.
  - CSS: `.composer` gets `position: relative`. `.slash-commands` is absolutely positioned above the composer at full width (`bottom: 100%`), about five rows tall, scrolling, on the dock's surface with its border and radius tokens.
  - Rows: two lines. The first holds `/name` with the hint muted; the description is muted and one line with an ellipsis; the plugin is a small muted tag. A highlighted row uses the list-selection token.

- [ ] **Step 6: Run the app suite and build.** `cd remote-app && bun test test && npm run build`. Expected: PASS, and the build succeeds.

- [ ] **Step 7: Look at it.** Open `npm run dev` with `?demo` in headless Chrome (playwright-core, scratch rig) at phone size (390×844). Type `/`, then `/re`. Screenshot the open list, check the rows and the insert button, tap `compact`, and confirm the message goes out as `/compact`.

- [ ] **Step 8: Commit.** `git add remote-app/src remote-app/test && git commit -m "🔧 List the window's slash commands when / is typed on the phone"`

### Task 7: Docs, patch and the real extension

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-phone-remote-design.md` (protocol section: the `commands` line, plus a dated paragraph)
- Modify: `README.md` (the Phone Remote paragraph), `remote-app/README.md` (a "Slash commands" section, shown in the app), `CLAUDE.md` (the remote-bridge paragraph: `commands`, and `origin` on phone messages)
- Modify: `docs/superpowers/specs/2026-11-22-slash-commands-design.md` (Status: implemented, with any deviations)

- [ ] **Step 1: Write the docs.**
  - The protocol line: `{t:"commands", id, project} → {t:"ack", id, ok, error?, commands?:[{name, description?, argumentHint?, aliases?, plugin?}]}`.
  - The paragraph says where the list comes from, the bounds, and the old-hub and old-peer answers.

- [ ] **Step 2: Dry-run the patch in the sandbox.** As in CLAUDE.md, run `HOME=<scratch> bun run patch.ts --no-commit-button` against copies of the installed extension. Expected: every verify line `ok`, and `cce-remote/lib/commands.js` among the copied files.

- [ ] **Step 3: Check against the real extension.** Use an isolated Insiders (memory recipe: VSIX into a scratch extensions dir, patched with `HOME=<scratch>`, a clean env, a short `--user-data-dir`, `CCE_REMOTE_HOME` set to a scratch dir, `--inspect-extensions=<port>`). The workspace is a scratch folder with `.claude/commands/hello.md` (`model: haiku`, "Reply with exactly: pong").
  1. Open one Claude panel there.
  2. Through the extension host's inspector, reach the window agent: find how bridge.js keeps it (read bridge.js), via `require.cache` or a module global.
  3. Check that `await agent.commands()` contains `context` and `hello`, plus the user's skills.
  4. Run `agent.send(<the panel's session>, "/context")` and then `"/hello"`. In the webview DOM (CDP), check that the context output and "pong" show in the VS Code session.
  5. Stop the instance by its PID (never by app name).

  Remote access stays off, and nothing touches Tailscale. If the isolated run can't be brought up, record why, and rely on the bundle facts in the design.

- [ ] **Step 4: Commit.** `git add -A docs README.md CLAUDE.md remote-app/README.md && git commit -m "📝 Document slash commands on the phone"`

## After the tasks

- A whole-branch review by a fresh reviewer on the most capable model, then fixes.
- Merge into `main` (fast-forward), push, and deploy CCE Remote through Coolify (`mcp__coolify__deploy`, app `ssk6yp8jmymwesbcyjbbkc3v`).
- `bun run patch.ts --no-commit-button` for the real install, then check that the installed files match the dry run.
- The user reloads every VS Code window.
