# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A patcher script (`patch.ts`) that modifies the Claude Code VS Code extension to add:
- **Persistent sessions sidebar** — converts the floating sessions dropdown into a fixed 80/20 split panel
- **Live status dots** — colored indicators on each session (green=done, blue=running, orange=waiting, gray=seen)
- **Include Selection default off** — flips the toggle default from on to off
- **Reasoning effort default max** — sets effort to "max" on every new session

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
2. **`patchWebviewJs`** — Modifies `webview/index.js`: removes the isOpen guard and overlay backdrop, forces isOpen=true, no-ops onClose
3. **`patchIncludeSelectionDefault`** — Flips `useState(!0)` to `useState(!1)` for the includeSelection state owner
4. **`patchDefaultEffortMax`** — Changes the `effortLevel` observable default from `void 0` (Auto) to `"max"` in `webview/index.js`
5. **`patchExtensionEffortMax`** — Makes `extension.js` pass `--effort max` to the CLI by default (unless explicitly overridden)
6. **`patchSessionStatusDots`** — Injects status computation code and a `<span class="cce-status-dot">` element into the session item renderer
7. **`patchWebviewCss`** — Restyles the dropdown as a fixed sidebar, hides the overlay, makes the body a horizontal flex container
8. **`patchStatusDotsCss`** — Appends dot color/animation CSS

### How patching works

All patches operate on **minified, bundled JS/CSS** via regex and string matching against known code patterns (CSS module variable names, function signatures, `createElement` calls). The script:
- Creates `.bak` backups on first run
- Always reads from `.bak` files (the true originals) so re-running is idempotent
- Each patch function returns `{ patched: string; count: number }` — count tracks how many substitutions were made

### Key pattern-matching strategy

The script finds dynamically-generated CSS class names (e.g., `overlay_abc12`, `dropdown_xyz34`) by matching CSS module object literals in the bundled JS, then uses those class names to locate and modify both JS behavior and CSS rules. This is fragile by nature — extension updates may change the bundle structure.
