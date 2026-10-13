# Claude Commit Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Source Control button in VS Code Insiders that generates the commit message exactly like the built-in ✨ button, answered by Claude Haiku through the user's Claude Code login.

**Architecture:** A dependency-free companion VS Code extension in `claude-commit/` (plain CommonJS). It has three pure modules: `context` (Copilot's change/diff/commit gathering), `prompt` (Copilot's prompt and parsing) and `claude` (one `claude -p` call). A thin `extension.js` wires them to the git extension API and the `scm/inputBox` + `scm/title` menus. `install.ts` packs a VSIX, installs it with the editor CLI and enables the proposed input-box menu in `argv.json`.

**Tech Stack:** VS Code extension API (CommonJS, no build), git extension API v1, Claude Code CLI 2.1.29x, Bun (tests via `bun test`, installer).

**Spec:** `docs/superpowers/specs/2026-10-13-claude-commit-message-design.md`

## Global Constraints

- Never close, restart or reload the user's running VS Code Insiders. E2E runs only in an isolated instance (`--user-data-dir`/`--extensions-dir` in the scratchpad).
- Extension id `cce-patch.claude-commit-message`; commands `claudeCommit.generateCommitMessage` ("Generate Commit Message with Claude", `$(claude)`) and `claudeCommit.cancel` (`$(debug-stop)`).
- Default model `haiku`. CLI call: `claude -p --model <model> --safe-mode --tools "" --disable-slash-commands --no-session-persistence --output-format json --system-prompt <system>`, prompt on stdin, cwd = OS temp dir, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Prompt text, diff rules (100 000-char cap, 1 MB untracked cap) and parsing copied from built-in Copilot 0.70. Custom instructions from `github.copilot.chat.commitMessageGeneration.instructions`.
- No runtime dependencies, no build step. The repo ignores `*.js`, so add an exception for `claude-commit/`.
- Commits: none in this session. The user didn't ask for commits, so leave everything in the working tree.

## Review Focus

1. A huge change set (a lockfile, generated code): the prompt must stay within budget and the call must still return quickly. Covered by `fitChanges` tests (Task 2).
2. Untracked binary or huge files: describe them, don't inline them (Task 1 tests).
3. Claude Code logged out or rate limited: show the CLI's message with a login hint, never a silent no-op (Task 3 `parseResult` tests).
4. The user clicks cancel, or clicks again while generating: the CLI process is killed and nothing is written (Task 3 cancel test; Task 6 E2E).
5. `argv.json` holds comments or other ids: the edit keeps them and uninstall restores the file (Task 5 tests).

---

### Task 1: Context gathering (`lib/context.js`)

**Files:**
- Create: `claude-commit/lib/context.js`
- Test: `claude-commit/test/context.test.ts`

**Interfaces:**
- Produces: `truncateDiff(diff, max=100000)`, `selectChanges(state)`, `untrackedPatch(relPath, {size, content?})`, `collectDiffs(repo, changes, token?) → {path, diff}[]`, `recentCommitMessages(repo) → {repository: string[], user: string[]}`, `readOriginalCode(file) → string|undefined`, `readInstructions(entries, roots) → string[]`, `gatherContext({repo, instructionEntries?, workspaceRoots?, token?}) → PromptInput|undefined`, `CancelledError`, `Status`, `MAX_DIFF_CHARS`, `MAX_FILE_BYTES`.

- [ ] **Step 1: Write the failing test** — `claude-commit/test/context.test.ts` (full content in the implementation; it covers selectChanges, untrackedPatch format/newline/empty/too-large/binary, truncateDiff, collectDiffs status routing + cancel, recentCommitMessages local/global/no user, readOriginalCode, readInstructions, gatherContext empty/full/detached HEAD).
- [ ] **Step 2: Run** `bun test claude-commit/test/context.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `claude-commit/lib/context.js`:
  - `selectChanges`: `state.indexChanges.length > 0 ? indexChanges : [...workingTreeChanges, ...(untrackedChanges ?? [])]`.
  - `collectDiffs`: status `<= 4` (INDEX_*) → `repo.diffIndexWithHEAD(fsPath)`; `7` (UNTRACKED) → `untrackedPatch` from disk (stat first; > 1 MB not read); else `repo.diffWithHEAD(fsPath)`; every diff through `truncateDiff`; throws `CancelledError` when the token is cancelled.
  - `untrackedPatch`: `diff --git a/P b/P` / `new file mode 100644` / `--- /dev/null` / `+++ b/P`, then `@@ -0,0 +1,N @@` and `+` lines, `\ No newline at end of file` when needed; too large → `\ File too large to diff (K KB)`; NUL byte in the first 8000 bytes → `Binary files /dev/null and b/P differ`.
  - `recentCommitMessages`: subjects of `log({maxEntries:5})`; author = local `user.name`, else global (each `.catch(() => undefined)`); author log only when one is found; everything in try/catch.
  - `readOriginalCode`: undefined when missing, > 1 MB, binary or unreadable.
  - `readInstructions`: `{text}` trimmed, `{file}` absolute or relative to each root (first readable non-empty wins).
  - `gatherContext`: `repo.status()` (errors ignored) → no changes → `undefined`; else `{repositoryName: basename(root), branchName: HEAD?.name ?? '', recentCommits, changes: [{path, diff, originalCode}], instructions, multiRoot: roots > 1}`. Original code is skipped for new files (UNTRACKED, INDEX_ADDED) because their diff already is the whole file.
- [ ] **Step 4: Run** `bun test claude-commit/test/context.test.ts` → PASS.

### Task 2: Prompt (`lib/prompt.js`)

**Files:**
- Create: `claude-commit/lib/prompt.js`
- Test: `claude-commit/test/prompt.test.ts`

**Interfaces:**
- Consumes: `truncateDiff` from `./context`.
- Produces: `SYSTEM_PROMPT`, `PROMPT_BUDGET = 300000`, `buildUserPrompt(PromptInput) → string`, `codeBlock(lang, code, filePath?)`, `withLineNumbers(text)`, `languageOf(path)`, `fitChanges(changes, budget?) → PromptChange[]`, `parseCommitMessage(text) → string`.

- [ ] **Step 1: Write the failing test** — `claude-commit/test/prompt.test.ts`: system prompt verbatim lines; section order `repository-context, user-commits, recent-commits, changes(original-code, code-changes), reminder, custom-instructions`; empty sections omitted; original code block `` ```typescript\n// filepath: /repo/src/a.ts\n1: b\n``` ``; multi-root note; line-number padding; fence growth; comment syntax per language; fitChanges keep/drop-largest-original/share/immutability; parse text block/other fence/raw.
- [ ] **Step 2: Run** `bun test claude-commit/test/prompt.test.ts` → FAIL.
- [ ] **Step 3: Implement** `claude-commit/lib/prompt.js` with Copilot's texts verbatim (system message steps 1–7, reminder lines, custom-instructions intro and multi-root sentence), `tag(name, body)` → `<name>\nbody\n</name>\n`, fence = max(3, longest line-leading backtick run + 1), legacy line numbers `padStart(width) + ": "`, `fitChanges` = drop largest original code first, then water-fill the diffs.
- [ ] **Step 4: Run** `bun test claude-commit/test/prompt.test.ts` → PASS.

### Task 3: Claude CLI runner (`lib/claude.js`)

**Files:**
- Create: `claude-commit/lib/claude.js`
- Test: `claude-commit/test/claude.test.ts`

**Interfaces:**
- Produces: `ClaudeError`, `resolveClaudeBinary({configuredPath?, claudeCodeExtensionPath?, envPath?}) → string|undefined`, `buildArgs({model, systemPrompt}) → string[]`, `buildEnv(base, extra?) → env`, `parseResult(stdout, stderr, code) → string` (throws ClaudeError), `runClaude({binary, args, env, input, cwd, token?, timeoutMs=120000}) → Promise<string|undefined>` (undefined = cancelled).

- [ ] **Step 1: Write the failing test** — `claude-commit/test/claude.test.ts`: exact args; env strips `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION`, applies `{name,value}` extras, forces the traffic flag; binary order configured → `<ext>/resources/native-binary/claude` → PATH, non-executables skipped; parseResult object/array/is_error (login hint)/stderr; runClaude with fake `/bin/sh` CLIs: args+stdin passed, failure, cancel (< 2 s, `exec sleep`), timeout, missing binary.
- [ ] **Step 2: Run** `bun test claude-commit/test/claude.test.ts` → FAIL.
- [ ] **Step 3: Implement** `claude-commit/lib/claude.js` (spawn with piped stdio, `stdin.end(input)`, a state machine `running|cancelled|timeout|done`, kill on cancel/timeout, `~` expansion for the configured path).
- [ ] **Step 4: Run** `bun test claude-commit/test/claude.test.ts` → PASS.

### Task 4: The extension (`package.json`, `extension.js`)

**Files:**
- Create: `claude-commit/package.json`, `claude-commit/extension.js`, `claude-commit/README.md`
- Modify: `.gitignore` (add `!claude-commit/**/*.js`)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: commands `claudeCommit.generateCommitMessage(target?, groups?, token?)`, `claudeCommit.cancel()`; context keys `claudeCommit.inputBoxButton`, `claudeCommit.generating`; log channel "Claude Commit Message".

- [ ] **Step 1:** Write `package.json`: `enabledApiProposals: ["contribSourceControlInputBoxMenu"]`, `activationEvents: ["onStartupFinished"]`, `extensionDependencies: ["vscode.git"]`. Menus: `scm/inputBox` (`scmProvider == git`); `scm/title` navigation (generate when `scmProvider == git && !claudeCommit.inputBoxButton && !claudeCommit.generating`, cancel when `… && claudeCommit.generating`); `commandPalette` (generate when `gitOpenRepositoryCount != 0`, cancel when `claudeCommit.generating`). Settings `claudeCommit.model` (default `haiku`) and `claudeCommit.claudePath` (machine scope).
- [ ] **Step 2:** Write `extension.js`. On activation: the log channel, then the context key from `context.extension.packageJSON.enabledApiProposals` (VS Code empties it when the proposal isn't granted). `generate` does: cancel the previous run, create its own CTS linked to the passed token, set the `generating` context key, resolve the repository (Uri → SourceControl.rootUri → the only repo → the active editor → the selected repo → a quick pick), run `withProgress(SourceControl)` → `gatherContext` → "no changes" info message → resolve the binary (the setting, then the `anthropic.claude-code` extension path, then PATH) → `runClaude` → `parseCommitMessage` → `repo.inputBox.value`. Errors show a message unless the run was cancelled.
- [ ] **Step 3: Verify** `node --check claude-commit/extension.js && node -e "JSON.parse(require('fs').readFileSync('claude-commit/package.json','utf8'))"` → no output, exit 0. `git check-ignore claude-commit/extension.js` → exit 1 (not ignored).

### Task 5: Installer + docs (`install.ts`)

**Files:**
- Create: `claude-commit/install.ts`
- Test: `claude-commit/test/install.test.ts`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Produces: `EXTENSION_ID`, `crc32`, `zip(entries)`, `buildVsix(manifest, files)`, `withIcon(manifest, icon)`, `hasClaudeCodicon(workbenchJs)`, `parseJsonc(text)`, `addProposedApi(text, id)`, `removeProposedApi(text, id)`; CLI `bun run claude-commit/install.ts [insiders|code|cursor|codium …] [--uninstall]`.

- [ ] **Step 1: Write the failing test** — `claude-commit/test/install.test.ts`: crc32("hello") = 0x3610a686; `unzip -t`/`-p` reads the zip back; VSIX entry layout and XML escaping; argv.json add (comments kept, idempotent), remove restores the file byte for byte, existing list joined and kept, commented-out key ignored, `{}` handled, non-list refused; withIcon immutability; hasClaudeCodicon.
- [ ] **Step 2: Run** `bun test claude-commit/test/install.test.ts` → FAIL.
- [ ] **Step 3: Implement** `install.ts`: a stored-entry zip writer, `[Content_Types].xml` + `extension.vsixmanifest`, per-editor CLI lookup (app bundle `Contents/Resources/app/bin/<cli>`, else PATH), the icon fallback when the workbench lacks `claude:…("claude",N)`, `--install-extension <vsix> --force`, argv.json edit (comment-aware, validated by parsing). Uninstall tolerates "not installed".
- [ ] **Step 4: Run** `bun test claude-commit/test` → all PASS.
- [ ] **Step 5:** Document the button in `README.md` (what it does, install/uninstall, the restart note, the dropdown behaviour next to Copilot's ✨, settings) and in `CLAUDE.md` (what it is, architecture of `claude-commit/`).

### Task 6: Verification

- [ ] **Live CLI check** (scratchpad `live.ts`): build the prompt for this repo's HEAD commit (its diff as "staged" changes, the previous 5 subjects, the user's real instructions) and run it through `lib/claude.js` with the Insiders Claude Code binary. Expected: an emoji-prefixed subject comparable to `🔧 Keep each session's draft across session switches`, in a few seconds.
- [ ] **Isolated E2E** (scratchpad `e2e/`): temp repo with a staged change, then launch `open -g -n -a "Visual Studio Code - Insiders" --args --user-data-dir=<e2e>/ud --extensions-dir=<e2e>/ext --extensionDevelopmentPath=<repo>/claude-commit --extensionDevelopmentPath=<e2e>/helper --remote-debugging-port=9339 …`. The helper extension opens the SCM view. Over CDP: find `[aria-label*="Generate Commit Message with Claude"]` inside `.scm-editor`, screenshot, click it, confirm the input box (`.scm-editor .view-lines`) gets a message, screenshot again, read the extension log. Then kill only the PID whose command line has `--user-data-dir=<e2e>/ud`.
- [ ] **Install for real:** `bun run claude-commit/install.ts insiders`. Then check `code --list-extensions --show-versions | grep cce-patch`, that the extension log in the running window's `exthost/cce-patch.claude-commit-message/` says "Input-box button: no (title-bar button instead)", and that `~/.vscode-insiders/argv.json` parses and lists the id.
- [ ] **Final review:** one fresh reviewer over all new and changed files (superpowers:requesting-code-review); fix the confirmed findings.
