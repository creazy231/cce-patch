# CCE Remote: slash commands in the message field (design)

Date: 2026-11-22 · Status: draft for the user's review.

The user asked: "please implement something into the web app that makes the slash commands we have inside the claude code extensions also available in the web app. so when I start typing a slash it shows a list of the available slash commands i can then click on to send and execute them."

Asked what they want to run with it: "i want it to run the command in the session in the vs code extension." VS Code's `/` menu has two kinds of entries. The user picked **1: Claude Code's own commands only**, which run in the session itself. The second kind is the entries VS Code handles itself, which act on the Mac's screen. The calls made on the user's behalf are listed at the end.

## Intent

From the phone, run the slash commands a session has in VS Code without knowing their names by heart:
1. Type `/`.
2. Pick one.
3. It runs in that session in VS Code: the same Claude Code process, exactly as if it had been typed there.

The result shows in VS Code and on the phone.

## Goals

- **The list.** Typing `/` as the first character of the message field opens a list of the window's slash commands. Each row shows:
  - `/name`;
  - the argument hint, when there is one;
  - a one-line description;
  - the plugin's name, for a plugin's command.
- **Filtering.** Typing more of the name narrows the list.
- **Tap to run.** Tapping a row sends `/name` to the session at once. It is exactly what typing `/name` and pressing Send does: the same "sending…" message, the same errors, and the same new-session flow on the "New session" screen.
- **Same list as VS Code.** These are the Claude Code commands VS Code's own `/` menu shows for that window:
  - built-ins such as `/compact`, `/context`, `/review` and `/init`;
  - the user's and the project's own commands;
  - skills;
  - plugin and MCP commands.

  Names are written as VS Code writes them, including its plugin-prefixed name when two commands share a name.
- **Demo mode** (`?demo`) shows a sample list, and tapping a command there works like sending a message.
- **The built-ins VS Code shows its own UI for** (`/context`, `/usage`, `/model`, `/mcp`, `/config`, `/settings`) are listed and sent like the others. On the phone they run in Claude Code, which answers in text on both screens, where VS Code would open a dialog on the Mac. They are Claude Code's own commands (choice 1), and a dialog on the Mac couldn't be seen from the phone.
- **After `/clear`, `/reset` or `/new`** is sent from the phone, the phone follows Claude Code into the new session, as the VS Code tab does.

## Non-goals

- **VS Code-only entries** (the user's choice 1). These are `/status`, `/copy`, `/export`, `/fork`, `/btw`, `/tasks`, `/skills`, `/remote-control`, `/chrome`, `/design-login`, sign-in and sign-out. VS Code's chat view registers and handles them itself, and they act on the Mac's screen.
- **Per-session lists.** VS Code shows one list per window, and so does the phone.
- **A new way to show results.** The app already turns a command's echo (`<command-name>`, `<command-args>`) into a chip and shows local command output (`<local-command-stdout>` and `-stderr`) as text.
- **An argument form.** Arguments are typed after the name, as in VS Code.
- **Command history, favourites, or sorting by use.**
- **A new protocol version.**
- **Keeping VS Code's pickers in step.** A model, effort or setting changed by a command from the phone applies to the running session, but VS Code's pickers don't show it, and a new session starts from VS Code's settings. The README says so.

## Anti-goals

- **Nothing runs by accident.** Tapping Send, the photo button or the transcript never picks a command. A command only runs from a deliberate tap on its row, or from Enter on a hardware keyboard while its row is highlighted.
- **Only listed commands.** Tapping sends only names the Mac listed, never a VS Code-only entry. Free text typed and sent by the user goes out as typed, as today.
- **No side effects on the Mac.** Listing commands never starts a Claude Code process, never runs the extension's config loader, and never fires the user's hooks. The bridge only reads what the extension already holds.
- **No blocking.** Typing `/` never waits on the Mac: a list the app holds shows at once. The list never covers the text being typed.
- **No breakage across versions.**
  - An old Mac: the app shows a short note in place of the list, and typing commands still works.
  - An old app: it never asks for a list.

## Facts (Claude Code 2.1.330, read from the bundles)

- **What VS Code's `/` menu lists.**
  - The menu lists `session.drawnClaudeConfig.commands`: the window's config (`connection.claudeConfig`), or the stored copy (`storedClaudeConfig`) that VS Code shows while the live config loads.
  - Each entry is `{name, description, argumentHint, aliases?, builtin?, plugin?}`. The Slash Commands section shows only once the typed text starts with `/`.
  - Each command is registered as `slash-command-<invocation>`, labelled `/<invocation>`, and the section is sorted by label. The invocation is the name. When two commands share a name, the invocation is instead the alias that ends in `:<name>`, the plugin-prefixed form (`bLe`).
  - The entries VS Code handles itself are registered separately by the chat view. They are not in `commands`.
- **What a pick does.**
  - A click or Enter calls `submit("/<invocation>")`, the chat view's normal submit. Tab only completes.
  - Exceptions: VS Code keeps the set `mcp, config, settings, model, usage, context` (`kLn`), Claude Code built-ins that it shows its own UI for. `/usage` (aliases `/cost`, `/stats`) and `/context` open VS Code dialogs whenever the listed command is the built-in one. `/model`, `/mcp`, `/config` and `/settings` sent without arguments open VS Code's pickers. Only with arguments, or when a user command has that name, do they reach Claude Code. (Corrected after the builder check.)
- **MCP commands** are listed as `server:prompt (MCP)`, with a space. Claude Code reads `/server:prompt (MCP) args` as the command `server:prompt (MCP)` followed by arguments (`Ww`).
- **`/clear`** (aliases `/reset`, `/new`) is in the list. It starts a new session with empty context in the same Claude Code process, and VS Code doesn't intercept it. The tab, and the bridge's map from channel to session (from the next `system/init`), move to the new session id. The old session keeps no channel. A live session without a transcript is listed in the window's project as "New session".
- **Settings changed by a command.** After a command it sent itself, VS Code reads the model and effort again. It doesn't do that for a phone message, which skips the webview: Claude Code changes, but VS Code's pickers keep the old value. A new session starts from VS Code's value.
- **The list is per window, held by each webview's comms on the host:**
  - `config`: a promise of the window's config;
  - `settledConfig`: the resolved config;
  - `configCwd`: the folder it is for;
  - `storedStartupConfig.read(surfaceCwd())`: the stored copy.

  `get_claude_state` answers with that config. When a running session in the window's folder reports `system/commands_changed`, the host patches `commands` into it (`patchCachedConfig`) and pushes `update_state` to the webviews. A session in another folder, a worktree for example, doesn't change it.
- **A running session's own list.** Its SDK query has `supportedCommands()`, which returns `latestCommands ?? initialization.commands` in the same shape.
- **How a command reaches Claude.** VS Code sends a slash command as a plain user message with the text `/name args`:

  `{type:"user", uuid, session_id:"", parent_tool_use_id:null, origin:{kind:"human"}, message:{role:"user", content:[{type:"text", text}]}}`

  Claude Code treats such a message as a command, except when it is marked `text_not_typed` or the command sits inside a pasted block. Plugin-provided local commands (`type:"local"`, `loadedFrom:"plugin"`) also need `origin.kind === "human"`. Everywhere else a missing origin counts as a person. The bridge's injected messages carry no origin today.
- **How the phone sends today.** A phone message goes through the comms' own `fromClient` as an `io_message`, exactly as the webview sends one. VS Code then shows the CLI's replay and output.

## Approaches

1. **Ask when needed (picked).**
   - The app asks the Mac for a window's list with an acked request and keeps it per window.
   - It asks as soon as a session or the "New session" screen opens, so the list is ready by the time `/` is typed, and again when its copy gets old.
   - Cost: one new request, routed like Send. It is always fresh and costs nothing while unused.
2. **Send it with the window list.** Every `projects` frame carries each window's list. The list is instant, but those frames go out on every change and every refresh. Command lists can be long (skill descriptions especially), so every phone would carry them all the time. Change detection would need to be added.
3. **Send it with the session snapshot.** The list comes with `snapshot`, plus a frame when it changes. It is instant inside a session, but the "New session" screen has no snapshot, and the change tracking is new work.

The user left the how to Claude; 1 was picked.

## Design

### Protocol (version 1, backwards compatible)

Phone → hub, with the hub's answer:

```
{t:"commands", id, project}   → {t:"ack", id, ok:true, commands:[SlashCommand]}
                                 | {t:"ack", id, ok:false, error}
SlashCommand = {name, description?, argumentHint?, aliases?:[string], plugin?}
```

- **`name`** is what goes after the `/`: VS Code's invocation, plugin-prefixed when two commands share a name.
- **Empty list.** `commands: []` is a normal answer: the window has no Claude Code webview open, or the extension has no list yet.
- **Errors:**
  - `unknown_project`;
  - `bad_request`;
  - a window error, such as `timeout`;
  - `unknown_type`, from an old hub (it already answers unknown acked frames this way);
  - `unknown_method`, from an old peer window.
- **Docs.** The phone-remote spec's protocol section gets the frame and a dated paragraph, as for usage.

### Mac: the window agent's `commands()`

It returns the window's list, read from what the extension already holds. It never calls `get_claude_state`, `loadConfig()` or anything else that could start a process. The comms are read in this order (all reads guarded):

1. A comms whose `settledConfig.commands` is an array: the list VS Code's menu shows. Comms whose `configCwd` is the window's first workspace folder come first.
2. The stored copy, `storedStartupConfig.read(surfaceCwd())`, when it has `commands`. VS Code shows this while the live list loads.
3. A running session's `channel.query.supportedCommands()`, bounded by the agent's host-read timeout. Running sessions in the window's folder come first.
4. A comms' pending `config` promise, awaited within the same timeout.
5. Otherwise `[]`.

The agent then maps the entries:
- it drops entries without a usable name;
- it applies VS Code's invocation rule (the `bLe` rule above);
- it keeps `description`, `argumentHint`, `aliases` and `plugin` as strings;
- it sorts by name.

### Mac: phone messages carry `origin: {kind: "human"}`

`userMessage()` adds `origin: {kind:"human"}`, which is what VS Code sends for what the user types. Without it, Claude Code refuses plugin-provided local commands. It applies to every message from the phone, because a person typed it there. Everywhere else Claude Code already treats a missing origin as a person, so nothing else changes.

### Hub, coordinator, peers

- **Hub routing.** The hub routes `commands` like the other acked actions: `actionCall` gives `{method:'commands', args:{}}`, and `_onFrame` sends it to `_onAction`.
- **Hub checks.** The ack carries the hub's checked copy of the result:
  - at most 300 commands;
  - `name`: 1–100 characters, no control, bidi or invisible characters, no duplicates; no whitespace, except one trailing ` (MCP)` (MCP commands);
  - `description`: cut to 300 characters, on one line;
  - `argumentHint` and `plugin`: at most 100 characters;
  - `aliases`: at most 10, each with the same rules as a name;
  - anything else is dropped.
- **Coordinator.** `callAgent` gets `case 'commands': return await agent.commands()`.
- **Peers.** The peer link is generic. A peer window that is still on the old bridge answers `unknown_method`.

### App

- **Protocol types.** `protocol.ts` gets the `commands` client message, `Ack.commands?`, and the `SlashCommand` type.
- **Client.** `commands(project)` on `RemoteClient`, a request with a short timeout (about 15 s). The `Source` interface gets it too, and `DemoSource` answers with a sample list: `/compact`, `/context`, `/init` and `/review`, plus one command, one skill and one plugin command with argument hints.
- **Store: one cache entry per window** (`project` id), holding the list, when it came, and a status: loading, ready, failed, or unsupported.
  - **Fetching.** It fetches when a session or the "New session" screen opens, and when `/` is typed and the copy is missing or older than about 60 s. A refetch keeps showing the old list.
  - **Unsupported.** `unknown_type` or `unknown_method` marks the window unsupported until the next welcome, so the app doesn't ask on every keystroke.
  - **Reconnects.** A reconnect (welcome) marks every entry stale.
- **Store: following `/clear`.**
  - **When.** A send whose whole text is `/clear`, `/reset` or `/new` makes the store remember the window's session ids at that moment.
  - **What happens.** When the window's list next shows a session that wasn't there, within 30 s, the store opens it in place of the old one (replace navigation) and toasts "Continuing in the new session".
  - **Why it's safe.** If no new session appears (a user command with one of those names, say), nothing happens. Leaving the screen ends the watch.
- **Composer: the list.**
  - **When it shows.** The list shows while the field is focused and its whole text is a slash followed by a name being typed: `^/\S*$`. Typing a space, clearing the field or leaving it closes the list. After a space, Send sends the text as typed (`/name args`).
  - **Position.** It sits directly above the field, inside the dock. It shows about five rows and scrolls beyond that.
  - **Filtering and order.** Matching ignores case. Rows whose name starts with the typed text come first, then name or alias matches anywhere, then description matches; each group is alphabetical. A bare `/` shows everything, alphabetically.
  - **Tapping a row** sends `/name` through the composer's normal send. If Send would be disabled (not connected, or a new session still starting), the rows are disabled too.
  - **Rows with an argument hint** also get a small insert button. It puts `/name ` (with a space) in the field and keeps the keyboard up, so arguments can be typed before Send.
  - **Keeping focus.** Rows keep the field's focus when pressed, so the list doesn't close before the tap lands.
  - **Hardware keyboards** (iPad with a keyboard, a desktop browser):
    - the first row is highlighted;
    - ↑ and ↓ move the highlight;
    - Enter runs the highlighted command;
    - Esc closes the list.
  - **States in place of rows:**
    - while the first fetch runs: "Loading commands…" with a spinner;
    - an empty list: "No slash commands in this window yet";
    - an unsupported Mac: "This Mac can't list commands yet. Typing one still works."
    - a failed fetch: "Couldn't load commands", with a retry on tap.
  - **Accessibility.** A list with options; the field points to it (`aria-controls`, `aria-activedescendant` for the highlight).
- **The app's README** (shown in the app) gets a short section about the list. So does the repo README's phone-remote paragraph.

### Rollout

The Mac side needs `bun run patch.ts`, then a reload of every VS Code window. Windows on the old and new bridge still work together, because the request is optional. The app is redeployed through Coolify from `main`.

## Testing and verification

- **Bridge, `commands()` against the fake extension:**
  - each source in its order;
  - the folder preference;
  - VS Code's invocation rule for shared names;
  - a host read that hangs (timeout), and no comms at all;
  - that nothing like `get_claude_state` or `loadConfig` is called.
- **Bridge, hub:** the action routing, the checks and bounds on the ack, `unknown_project`, and an old peer's `unknown_method`.
- **Bridge, coordinator:** `callAgent('commands')`.
- **Bridge, messages:** `userMessage()` carries `origin:{kind:"human"}`.
- **App:** the filter and order (a pure function), the store's cache and its states, the client request, the demo list, and the composer's open, close, tap, insert and keyboard behaviour (rendered, as `usage-card.test.ts` does).
- **Real extension, once before calling it done.** In an isolated Insiders with a scratch `CCE_REMOTE_HOME`, read `commands()` from the real 2.1.330 extension. Then run a built-in command and a user command through `send` and see them run in the VS Code session.

## Decisions made on the user's behalf

- **Approach 1:** ask when needed, prefetched when a session opens, cached about 60 s per window.
- **One list per window**, as in VS Code, read from what the extension already holds, never by starting anything.
- **Tapping runs at once**, as asked. Rows with an argument hint also get an insert button for typing arguments.
- **Hardware keyboards:** the first match is highlighted and Enter runs it, as in VS Code. A space closes the list.
- **Origin:** phone messages carry `origin:{kind:"human"}`, as VS Code's typed messages do. This makes plugin-provided local commands work.
- **Notes in place of the list:** a short note for an old Mac, an empty window, and a failed fetch.
- **Bounds:** 300 commands, 300-character descriptions.
- **After the builder check** (the user was away and asked for every decision to be made on their behalf):
  - **The built-ins VS Code shows its own UI for** (`/context`, `/usage`, `/model`, `/mcp`, `/config`, `/settings`) are listed and sent as text. Claude Code answers on both screens. Hiding them would drop useful commands, and a dialog on the Mac can't be seen from the phone.
  - **`/clear`, `/reset` and `/new`:** the phone follows the new session through the window's list, with no protocol change. The cost: another session started in that window within 30 s could be opened instead.
  - **VS Code's pickers aren't kept in step** after a setting changed from the phone. The README says so.
  - **MCP command names** may end in ` (MCP)`.

## Left to the builder

- **The look**, using the app's tokens and the dock's existing styles. The list should read as part of the composer.
- **Filter scoring** within the stated order.
- **Exact timings:** the cache age and the request timeout.
- **Test structure.**
