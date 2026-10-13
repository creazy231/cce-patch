# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A patcher script (`patch.ts`) that modifies the Claude Code VS Code extension to add:
- **Persistent sessions sidebar** — converts the floating sessions dropdown into a fixed side panel styled like a native VS Code view; drag the divider to resize it (width is remembered, double-click resets)
- **Live status dots** — colored indicators on each session (green=done, blue=running, orange=waiting, gray=seen)
- **Include Selection default off** — the open file / selected lines are not attached to prompts unless you opt in, per session (dimmed chip in the input footer, click to attach)
- **Reasoning effort default max** — sets effort to "max" on every new session
- **Drafts kept per session** — text, @-mentions and attachments you haven't sent survive switching sessions; an existing session's text also survives a window reload

It auto-detects and patches all installed editors (VS Code, VS Code Insiders, Cursor, VSCodium).

Separately, `claude-commit/` is a small companion VS Code extension (not a patch): a **Generate Commit Message with Claude** button for the Source Control view that does what the built-in ✨ Copilot button does, answered by Claude Haiku through the user's Claude Code login. `patch.ts` installs it into the editors it patches (`--revert` removes it, `--no-commit-button` skips it). `bun run claude-commit/install.ts` manages it on its own.

## Running

```bash
# Apply patch (Bun recommended); also installs the claude-commit button
bun run patch.ts

# Revert (also uninstalls the button)
bun run patch.ts --revert

# Patch without touching the button
bun run patch.ts --no-commit-button

# Alternative with Node.js
npx tsx patch.ts
npx tsx patch.ts --revert

# claude-commit tests
bun test claude-commit/test
```

After patching, restart each editor with `Reload Window`. The commit button's move into the commit message box needs a full restart (`argv.json`).

## Architecture

The entire patcher is a single file: `patch.ts`. No build step, no dependencies beyond the runtime.

### Patch pipeline (executed per editor)

1. **`patchExtensionJs`** — Hardcodes `sessionsListEnabled` and `primaryEditorEnabled` feature flags to `true` in `extension.js`
2. **`patchWebviewJs`** — Modifies `webview/index.js`: removes the isOpen guard, replaces the overlay backdrop with a `.cce-sash` resize handle (it sits between the chat column and the panel), forces isOpen=true, no-ops onClose. **`appendResizeScript`** then appends the drag logic (event delegation on `.cce-sash`, width in the `--cce-sessions-w` CSS variable + localStorage)
3. **`patchIncludeSelectionDefault`** — Flips `useState(!0)` to `useState(!1)` for the includeSelection state owner. 2.1.280+ removed that toggle, so it falls back to **`patchSelectionOptIn`**: a per-session `cceSelOn` signal (off), `send()` gated on it, the chip's × turns it off, and the footer renders the chip dimmed until clicked
4. **`patchDefaultEffortMax`** — Changes the `effortLevel` observable default from `void 0` (Auto) to `"max"` in `webview/index.js`
5. **`patchExtensionEffortMax`** — Makes `extension.js` pass `--effort max` to the CLI by default (unless explicitly overridden)
6. **`patchSessionStatusDots`** — Injects status computation code and a `<span class="cce-status-dot">` element into the session item renderer
7. **`patchDraftPersistence`** — The chat view is keyed by the session's `internalId`, so switching sessions remounts it and drops the input's text/@-mention state and the chat view's attachments state. Seeds those states from `session.cceDraft` and saves every change back via effects (a send empties both, which clears the draft); the text is written back into the contentEditable on mount, caret at the end on first focus. Existing sessions' text is mirrored to localStorage (`cce-draft:<sessionId>`, pruned after 30 days). The `window.__cceDraft` runtime is prepended to the bundle
8. **`patchWebviewCss`** — Restyles the dropdown as a fixed sidebar, hides the overlay, makes the body a horizontal flex container. **`patchSessionsPanelCss`** adds the VS Code look (theme tokens only, scoped to the panel so the Session Manager view keeps its upstream style) and the resize handle's style
9. **`patchStatusDotsCss`** — Appends dot color/animation CSS
10. **`patchSelectionCss`** — Appends the dimmed (not attached) selection chip style

After all editors: **`installCommitButton`** (from `claude-commit/install.ts`) installs the commit message button into the same editors, matched by label. It runs even if a patch failed and skips editors whose installed copy is identical *and* still listed in `extensions.json` (an uninstall leaves the folder behind). With `--revert` it uninstalls instead; `--no-commit-button` skips it.

### How patching works

All patches operate on **minified, bundled JS/CSS** via regex and string matching against known code patterns (CSS module variable names, function signatures, `createElement` calls). The script:
- Creates `.bak` backups on first run
- Always reads from `.bak` files (the true originals) so re-running is idempotent
- Each patch function returns `{ patched: string; count: number }` — count tracks how many substitutions were made

### Key pattern-matching strategy

The script finds dynamically-generated CSS class names (e.g., `overlay_abc12`, `dropdown_xyz34`) by matching CSS module object literals in the bundled JS, then uses those class names to locate and modify both JS behavior and CSS rules. This is fragile by nature — extension updates may change the bundle structure.

## claude-commit/ (commit message button)

A plain-CommonJS VS Code extension (`cce-patch.claude-commit-message`, no build step, no dependencies; `.gitignore` re-includes its `*.js`). It mirrors the built-in Copilot commit-message generator (Copilot Chat 0.70 in VS Code Insiders 1.142) and swaps the model call for one `claude -p` call:

- **`lib/context.js`** — Copilot's input: staged changes, else working tree + untracked; per-file diffs (`diffIndexWithHEAD` / synthetic untracked patch / `diffWithHEAD`, cut at 100 000 chars); the last 5 commit subjects from the repo and from `user.name`; current file contents ("ORIGINAL CODE", skipped for new files, and read only while they fit the 300 000-char budget next to the diffs); `github.copilot.chat.commitMessageGeneration.instructions` from all settings scopes (folder → workspace → user, as Copilot merges them), files before texts, language-tagged entries skipped
- **`lib/prompt.js`** — Copilot's prompt texts verbatim (system message, section headings, reminder, instruction intro) in its section structure (XML-style tags, legacy line numbers). One difference: ORIGINAL CODE is a fenced block with a `filepath:` comment, where Copilot uses an attachment tag. Also a 300 000-char budget (largest original code dropped first, then diffs share the rest) and Copilot's ```text block parsing
- **`lib/claude.js`** — finds the CLI (`claudeCommit.claudePath` → the Claude Code extension's `resources/native-binary/claude` → `PATH`). Runs `claude -p --model haiku --safe-mode --tools "" --disable-slash-commands --no-session-persistence --output-format json --system-prompt …` with the prompt on stdin and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (it halves the latency). Handles cancel and timeout. `--bare` would skip the OAuth/keychain login, so it isn't used
- **`extension.js`** — the command `claudeCommit.generateCommitMessage`, contributed to `scm/inputBox` (the commit message box) and `scm/title` (fallback). Progress shows in the SCM view, and the result goes to `repository.inputBox.value`
- **`install.ts`** — packs a VSIX (built-in stored-zip writer), installs it with each editor's CLI, and adds the id to `"enable-proposed-api"` in `~/.<editor>/argv.json` (comment-preserving; `--uninstall` reverts). Uses `$(sparkle)` instead of `$(claude)` where the editor lacks that codicon (Cursor)

`scm/inputBox` is a proposed menu (`contribSourceControlInputBoxMenu`). Only `product.json`-allowlisted extensions (just Copilot) or ones named in `--enable-proposed-api` / `argv.json` can use it, and `argv.json` applies after a full restart. The extension reads its runtime `packageJSON.enabledApiProposals` (VS Code empties it when the proposal isn't granted) into the context key `claudeCommit.inputBoxButton`. The `scm/title` button hides itself once the box button is live.

Tests: `bun test claude-commit/test`. To verify end to end without touching a running editor, launch an isolated Insiders: `open -g -n -a "Visual Studio Code - Insiders" --args --user-data-dir=<tmp> --extensions-dir=<tmp> --extensionDevelopmentPath=claude-commit --remote-debugging-port=<port> <repo>`. Dev mode grants the proposal. Then drive the button over the Chrome DevTools Protocol.
