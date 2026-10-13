# Claude commit message button — design

Date: 2026-10-13 · Status: decided autonomously (the user asked for no interaction; review afterwards)

## Goal

A button in the VS Code Insiders Source Control view that does exactly what the
built-in ✨ "Generate Commit Message" button does, but asks Claude (through the
user's Claude Code login) instead of Copilot. Use the fastest model that is good
enough: Claude Haiku (`haiku` alias, currently `claude-haiku-5-5`).

Constraints from the user: don't close, restart, or reload VS Code while working on
this; no interaction needed.

## What the built-in button does (VS Code Insiders 1.142, built-in Copilot 0.70)

Read from `extensions/copilot/dist/extension.js` in the installed app:

- Menu: `scm/inputBox` → `github.copilot.git.generateCommitMessage`,
  `when: scmProvider == git && chatSetupCompleted`.
- The input-box toolbar runs the command with
  `(rootUri, [{resourceGroupId, resources}], cancellationToken)`. While it runs, the
  toolbar swaps the button for a stop button that cancels the token. With more than one
  `scm/inputBox` action, the last-used one is shown and the rest sit in a dropdown
  (`scm.input.lastActionId`).
- Command: resolve the repository (`rootUri`, else the only repo, else the active
  editor's repo), generate, then set `repository.inputBox.value`.
- Generation, inside `withProgress({ location: SourceControl })`:
  1. `await repo.status()`. No changes → info message *"Cannot generate a commit
     message because there are no changes."*
  2. Changes = staged changes if any, else working tree + untracked.
  3. Per file: index statuses 0–4 → `diffIndexWithHEAD(path)`, untracked → a
     synthetic "new file" patch (skipped above 1 MB), otherwise
     `diffWithHEAD(path)`. Each diff is truncated at 100 000 chars with
     `... [diff truncated]`.
  4. Last 5 repository commit subjects plus the last 5 by `user.name`.
  5. Prompt: a fixed system message, then the repo name and branch, recent user
     commits, recent repo commits, and for each file its current content with
     line numbers ("ORIGINAL CODE") and its diff ("CODE CHANGES"). Then a
     reminder to answer with one ```text block, and the custom instructions from
     `github.copilot.chat.commitMessageGeneration.instructions` (text or file
     entries). Sections are XML-style tags with priorities, so lower-priority
     parts (original code first) are dropped when the budget is exceeded.
  6. Model `copilot-utility-small`, temperature `base × (1 + attemptCount)`
     (attemptCount grows when you regenerate for the same HEAD and diff).
  7. The response is parsed with `/^```text\s*([\s\S]+?)\s*```$/m`, falling back to the raw text.

The user has custom instructions configured (the emoji-prefixed style used in this
repo), so honouring that setting is required, not optional.

## Platform constraints found

- `scm/inputBox` is still a **proposed** menu (`contribSourceControlInputBoxMenu`).
  Only extensions allow-listed in `product.json` (just `GitHub.copilot-chat`) may
  use it. Anyone else needs the `--enable-proposed-api <id>` flag, or
  `"enable-proposed-api": [...]` in `~/.vscode-insiders/argv.json`. argv.json is
  read once by the main process, so **it takes effect only after a full restart**.
- `scm/title` (the icons next to ✓ ↻ in the "Changes" header) is stable and works
  as soon as the extension is installed. No restart is needed: VS Code picks up
  extensions installed through the CLI while it runs.
- The user is on a claude.ai Team subscription (OAuth). The only supported way to
  use that login is the Claude Code CLI (`claude -p`). `--bare` refuses OAuth.
  `--safe-mode` disables CLAUDE.md, hooks, plugins and MCP servers but keeps the
  login, which is exactly what a one-shot call needs.
- Measured (2026-10-13, `claude -p --model haiku --safe-mode --tools ""
  --no-session-persistence --output-format json --system-prompt …`): ~2.8 s wall
  time. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: ~1.4 s, because the CLI
  no longer waits on telemetry and update traffic. `--effort` makes no difference
  for Haiku (no thinking).
- VS Code ≥ 1.134 ships a `$(claude)` codicon. Cursor 3.13 does not.

## Approaches considered

1. **Companion extension (chosen).** A small extension with its own command,
   contributed to `scm/inputBox` (identical UX once the flag is active) and to
   `scm/title` (works immediately). It calls the Claude Code CLI. It is
   independent of Claude Code and Copilot updates and is installed once.
2. **Patch the built-in Copilot extension.** It lives inside the signed app
   bundle, gets overwritten by the daily Insiders update, and would mean editing
   a 20 MB minified bundle. Rejected.
3. **Inject the button into the Claude Code extension through `patch.ts`.** This
   needs re-patching after every Claude Code update. Editing its `package.json`
   triggers "Extensions have been modified on disk" prompts. It has the same
   proposed-API limit as option 1. Rejected.
4. **Register Claude as a language-model provider and point
   `chat.utilitySmallModel` at it.** Copilot's own button would then use Claude,
   with no restart. But that setting reroutes *every* Copilot utility task
   (titles, summaries, intent detection…) through a CLI spawn. It also adds a
   model to the chat picker that would need full chat and tool support. Rejected
   for its blast radius. It stays a possible follow-up.

## Design

### Components (folder `claude-commit/`, plain CommonJS, no build step, no dependencies)

| Unit | Responsibility | Depends on |
|---|---|---|
| `package.json` | Manifest: commands, menus, settings, `enabledApiProposals` | — |
| `extension.js` | VS Code glue: activation, context keys, command handler, repository resolution, progress, cancellation, writes the input box | `vscode`, `lib/*` |
| `lib/changes.js` | Copilot's change selection and diff collection on a git-extension `Repository` (file reads injected) | — |
| `lib/prompt.js` | Copilot's prompt (system and user parts, tags, line numbers, code fences, budget) and response parsing | — |
| `lib/claude.js` | Find the CLI, build args and env, spawn, parse the JSON result, cancel and time out | `child_process`, `fs` |
| `install.ts` | Pack a VSIX (tiny built-in zip writer), install with each editor's CLI, add the id to `argv.json` (`--uninstall` reverts) | Bun / Node |
| `test/*.test.ts` | `bun test` unit tests for `lib/*` and the installer helpers | — |

### Behaviour

- Command `claudeCommit.generateCommitMessage`, "Generate Commit Message with
  Claude", icon `$(claude)`.
  - `scm/inputBox` when `scmProvider == git`. Gets `(rootUri, groups, token)`.
    VS Code draws the stop button and handles cancel.
  - `scm/title` (group `navigation`) when
    `scmProvider == git && !claudeCommit.inputBoxButton && !claudeCommit.generating`.
    This is the fallback until the restart. While generating, a
    `claudeCommit.cancel` button (`$(debug-stop)`) takes its place.
  - Command palette when `gitOpenRepositoryCount != 0`.
- On activation, the context key `claudeCommit.inputBoxButton` is set to whether
  VS Code actually granted `contribSourceControlInputBoxMenu`. VS Code empties the
  extension's runtime `enabledApiProposals` when the proposal isn't allowed. So the
  title-bar button disappears by itself once the input-box button is live.
- Repository resolution follows Copilot (`rootUri` → the only repo → the
  active editor's repo). Additions: accept a `SourceControl` argument (that's what
  `scm/title` passes), and fall back to the selected repo or a quick pick when there
  are several repos.
- Starting a new generation cancels a running one, as the input-box runner
  does.
- Generation follows Copilot steps 1–4 and 7 exactly. Step 5 matches Copilot's
  text and tag structure. Its budget is a char budget (default 300 000 chars,
  ~75k tokens, keeps Haiku fast): drop the largest "original code" blocks first;
  if the diffs alone are still too big, give each diff an equal share of the
  budget. Binary untracked files and binary original code are described, not
  inlined.
- Step 6 runs this CLI call:
  `claude -p --model <claudeCommit.model|haiku> --safe-mode --tools "" --disable-slash-commands --no-session-persistence --output-format json --system-prompt <system>`.
  The prompt goes over stdin, cwd is the OS temp dir, and the env has
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDECODE` /
  `CLAUDE_CODE_ENTRYPOINT` removed, and the Claude Code extension's
  `claudeCode.environmentVariables` applied. Temperature can't be set through the
  CLI. Claude's default (1.0) already varies the message on each regeneration, so
  attempt tracking is left out.
- Binary lookup order: `claudeCommit.claudePath`, then the Claude Code
  extension's bundled `resources/native-binary/claude`, then `claude` on `PATH`.
- Errors: no CLI → message explaining how to install or configure it.
  `is_error` / non-zero exit → the CLI's own message (with a "log in with
  `claude`" hint for auth failures). Cancel → silent. Timeout 120 s.

### Installation

`bun run claude-commit/install.ts [insiders|code|cursor|codium …] [--uninstall]`
(no names = every detected editor, the same rule as `patch.ts`). Per editor:

1. Pack the VSIX. If the editor's workbench has no `claude` codicon, swap the
   icon to `$(sparkle)` (Cursor).
2. `<editor-cli> --install-extension <vsix> --force`.
3. Add `cce-patch.claude-commit-message` to `"enable-proposed-api"` in that
   editor's `argv.json`, preserving comments. Validate the result before writing.

For this session: install into VS Code Insiders only. The title-bar button works
right away. The input-box button appears after the next full restart. It shares a
dropdown with Copilot's ✨ and becomes the visible one once picked.

### Testing

1. `bun test` unit tests (prompt structure versus Copilot's, line numbers, fences,
   budget, parsing, untracked patches, change selection, CLI args/env/lookup,
   spawn with a fake CLI: success, error, non-zero exit, cancel, timeout, argv.json
   edit, zip writer).
2. Live check: a real prompt built from this repo's history → real Claude CLI.
   The message must follow the user's emoji convention and arrive in a few seconds.
3. End to end in an **isolated** VS Code Insiders instance (separate
   `--user-data-dir` / `--extensions-dir`, extension-development mode, which
   enables the proposal): open a temp repo with staged changes, then over the
   Chrome DevTools Protocol check that the button renders in the input box,
   click it, and confirm the input box gets filled. Screenshots before and after.
   The user's running instance is never touched.
4. Install into the user's Insiders, confirm the extension is registered and
   `argv.json` is valid.
