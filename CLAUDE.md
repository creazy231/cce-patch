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

## Running

```bash
# Apply patch (Bun recommended)
bun run patch.ts

# Revert
bun run patch.ts --revert

# Alternative with Node.js
npx tsx patch.ts
npx tsx patch.ts --revert
```

After patching, restart each editor with `Reload Window`.

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

### How patching works

All patches operate on **minified, bundled JS/CSS** via regex and string matching against known code patterns (CSS module variable names, function signatures, `createElement` calls). The script:
- Creates `.bak` backups on first run
- Always reads from `.bak` files (the true originals) so re-running is idempotent
- Each patch function returns `{ patched: string; count: number }` — count tracks how many substitutions were made

### Key pattern-matching strategy

The script finds dynamically-generated CSS class names (e.g., `overlay_abc12`, `dropdown_xyz34`) by matching CSS module object literals in the bundled JS, then uses those class names to locate and modify both JS behavior and CSS rules. This is fragile by nature — extension updates may change the bundle structure.
