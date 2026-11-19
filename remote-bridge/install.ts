/**
 * The phone remote's part of the patch, used by patch.ts: copies the bridge (this folder) into a
 * Claude Code extension and hooks it in.
 *
 *   extension.js       patchExtensionRemote: the webview provider hands itself to
 *                      cce-remote/bridge.js while it's constructed (its `allComms` field)
 *   webview/index.js   patchWebviewConnection: a Connection tab next to Local and Web in the
 *                      sessions list, drawn by webview-runtime.js (put in front of the bundle)
 *   webview/index.css  patchConnectionCss: the tab row's states and the Connection view
 *   cce-remote/        installRemoteBridge: bridge.js, the .js files under lib/, licence files
 *   ~/.cce-remote/     turnRemoteAccessOff (--revert): remote access off, `tailscale serve` off
 *
 * Every hook fails closed: a missing anchor leaves the file as it was (patch.ts prints a FAIL
 * verify line), and at runtime every call into the bridge or the runtime is guarded.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** The bridge's folder inside the extension. */
export const REMOTE_DIR = "cce-remote";
const HERE = dirname(fileURLToPath(import.meta.url));

/** The Connection tab's browser code (webview-runtime.js). */
export const CONNECTION_RUNTIME = readFileSync(join(HERE, "webview-runtime.js"), "utf8");

type Log = (line: string) => void;
type Result = { patched: string; count: number };
/** [position, length to replace, text to put there] */
type Edit = [at: number, length: number, insert: string];

// Captured minified identifiers may contain `$`, which a RegExp would read as an anchor.
function escRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  for (const [at, length, insert] of [...edits].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, at) + insert + out.slice(at + length);
  }
  return out;
}

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
// Words after which a `/` starts a regular expression literal; after any other word it divides.
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Scans `code` from `from` to the first closing bracket that closes no bracket opened after `from`
 * (so one of those around `from`) and returns its index; -1 when brackets don't match, a literal
 * or comment doesn't end, or nothing closes within `limit` chars. String, template and regular
 * expression literals and comments are skipped. A `/` starts a regular expression where a value
 * is expected, as tokenizers without a parser decide it: after an operator, `(`, `[`, `{`, `}`,
 * `,`, `;` or a keyword like `return`; after a name, a number, a literal, `)` or `]` it divides.
 * (A regular expression right after `)`, as in `if(a)/b/.test(c)`, is the case this reads wrong:
 * a bracket or quote in it then throws the count off, which ends in a mismatch, so the hook is
 * skipped. The whole 2.1.220, 2.1.327 and 2.1.328 bundles scan from start to end without one.)
 */
function scanToClose(code: string, from: number, limit: number): number {
  const end = Math.min(code.length, from + limit);
  const stack: string[] = []; // the closers expected; "${" is a template literal's expression
  // The last character that counts (not whitespace or a comment), and whether it ended a literal.
  let last = from - 1;
  while (last >= 0 && code[last] <= " ") last--;
  let afterLiteral = false;
  const regexHere = (): boolean => {
    if (afterLiteral) return false;
    if (last < 0) return true;
    const c = code[last];
    if (c === ")" || c === "]") return false;
    if (/[\w$]/.test(c)) {
      let start = last;
      while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
      return code[start - 1] !== "." && BEFORE_REGEX.has(code.slice(start, last + 1));
    }
    return !((c === "+" || c === "-") && code[last - 1] === c); // `a++/2` divides
  };
  // Template text from `i`: the index of the closing backtick, or of the `{` of a `${`.
  const template = (i: number): [at: number, expression: boolean] => {
    for (; i < end; i++) {
      if (code[i] === "\\") i++;
      else if (code[i] === "`") return [i, false];
      else if (code[i] === "$" && code[i + 1] === "{") return [i + 1, true];
    }
    return [end, false];
  };
  for (let i = from; i < end; i++) {
    const c = code[i];
    if (c <= " ") continue;
    if (c === '"' || c === "'") {
      for (i++; i < end && code[i] !== c; i++) if (code[i] === "\\") i++;
      if (i >= end) return -1;
      afterLiteral = true;
    } else if (c === "`") {
      const [at, expression] = template(i + 1);
      if (at >= end) return -1;
      i = at;
      if (expression) stack.push("${");
      afterLiteral = !expression;
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      if (close < 0 || close + 2 > end) return -1;
      i = close + 1;
      continue;
    } else if (c === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n" && code[i] !== "\r") i++;
      continue;
    } else if (c === "/" && regexHere()) {
      let inClass = false;
      for (i++; i < end && (inClass || code[i] !== "/"); i++) {
        if (code[i] === "\\") i++;
        else if (code[i] === "\n" || code[i] === "\r") return -1;
        else if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
      }
      if (i >= end) return -1;
      afterLiteral = true;
    } else if (c === "(" || c === "[" || c === "{") {
      stack.push(CLOSER[c]);
      afterLiteral = false;
    } else if (c === ")" || c === "]" || c === "}") {
      if (stack.length === 0) return i;
      const want = stack.pop();
      if (want === "${") {
        if (c !== "}") return -1;
        const [at, expression] = template(i + 1);
        if (at >= end) return -1;
        i = at;
        if (expression) stack.push("${");
        afterLiteral = !expression;
      } else if (want !== c) {
        return -1;
      } else {
        afterLiteral = false;
      }
    } else {
      afterLiteral = false;
    }
    last = i;
  }
  return -1;
}

/** The index of the bracket that closes the one at `open` (`(`, `[` or `{`); -1 as scanToClose. */
function findClose(code: string, open: number, limit = 20000): number {
  const close = scanToClose(code, open + 1, limit - 1);
  return close >= 0 && code[close] === CLOSER[code[open]] ? close : -1;
}

/** The index of the `}` that ends the block `from` is in (a function's body, say); -1 as scanToClose. */
function blockEnd(code: string, from: number, limit: number): number {
  const close = scanToClose(code, from, limit);
  return close >= 0 && code[close] === "}" ? close : -1;
}

// ── cce-remote/: the bridge's files ──

const LICENCE = /^(LICENSE|LICENCE|NOTICE)/i;

/** The bridge's files under `srcDir`, as relative paths: bridge.js, the .js files under lib/, licence files. */
function bridgeFiles(srcDir: string): string[] {
  const files = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name === "bridge.js" || LICENCE.test(e.name)))
    .map((e) => e.name);
  // Plain files only: a symlink could point anywhere.
  const walk = (rel: string) => {
    for (const e of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
      const path = join(rel, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && (e.name.endsWith(".js") || LICENCE.test(e.name))) files.push(path);
    }
  };
  if (existsSync(join(srcDir, "lib"))) walk("lib");
  return files.sort();
}

/**
 * Copies the bridge into `<extDir>/cce-remote/`, replacing what was there. Returns how many files
 * it copied: 0 (and no folder) when `srcDir` has no bridge.js.
 */
export function installRemoteBridge(extDir: string, srcDir: string = HERE): number {
  const dest = join(extDir, REMOTE_DIR);
  rmSync(dest, { recursive: true, force: true });
  if (!existsSync(join(srcDir, "bridge.js"))) return 0;
  const files = bridgeFiles(srcDir);
  for (const rel of files) {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(join(srcDir, rel), join(dest, rel));
  }
  return files.length;
}

/** Deletes `<extDir>/cce-remote/`; true when there was one. */
export function removeRemoteBridge(extDir: string): boolean {
  const dest = join(extDir, REMOTE_DIR);
  if (!existsSync(dest)) return false;
  rmSync(dest, { recursive: true, force: true });
  return true;
}

// ── extension.js: the provider hands itself to the bridge ──

const BRIDGE_ATTACH = `require("./${REMOTE_DIR}/bridge.js").attach(p)`;
// The provider (one per window) is the class with the field `allComms=new Set`. A field
// initializer runs while the instance is constructed, with `this` the instance: the bridge gets
// the provider and defers its own work until construction is done. Whatever the require or
// attach throws is logged and dropped, and the field is the same new Set as before.
const PROVIDER_HOOK = `allComms=(function(p){try{${BRIDGE_ATTACH}}catch(e){try{console.error("[cce-remote]",e)}catch(_){}}})(this)||new Set`;

export function patchExtensionRemote(code: string, log: Log = console.log): Result {
  if (code.includes(BRIDGE_ATTACH)) {
    log("  Already patched: the provider hands itself to cce-remote/bridge.js");
    return { patched: code, count: 0 };
  }
  const fields = [...code.matchAll(/(?<![\w$.])allComms=new Set(?![\w$])/g)];
  if (fields.length !== 1) {
    log(
      fields.length === 0
        ? "  Could not find the webview provider's allComms=new Set field"
        : `  Found ${fields.length} allComms=new Set fields, expected one — skipped (which is the provider is unclear)`,
    );
    return { patched: code, count: 0 };
  }
  const at = fields[0].index!;
  log("  Provider hook: allComms=new Set → cce-remote/bridge.js attach(provider)");
  return { patched: applyEdits(code, [[at, fields[0][0].length, PROVIDER_HOOK]]), count: 1 };
}

// ── webview/index.js: the Connection tab ──

const OPEN = "__cceConn";
const SET_OPEN = "__cceSetConn";
// How far the tab state's block (the list component's body) may reach: 2.1.327's is ~18 000 chars.
const SCOPE_LIMIT = 100000;
// Every read of the Connection state, and every call of its setter, is guarded, a second safety net
// behind the scope check in tabEdits: where the state isn't declared, a bare read throws a
// ReferenceError while rendering, and React drops the whole view. This reads as closed instead.
const IS_OPEN = `(typeof ${OPEN}!=="undefined"&&${OPEN})`;
const setOpen = (value: string) => `(typeof ${SET_OPEN}==="function"&&${SET_OPEN}(${value}))`;

const APP_ROOT = /([\w$]+)\.createRoot\(document\.querySelector\("#root"\)\)\.render\(/g;
// An app root the attach hook went into (see attachEdits).
const HOOKED_ROOT = /\(window\.__cceRemote&&window\.__cceRemote\.attach\([\w$]+\),[\w$]+\)\.createRoot\(document\.querySelector\("#root"\)\)\.render\(/g;

/**
 * Every app root, `X.createRoot(document.querySelector("#root")).render(…{sessions:S…`, hands its
 * sessions manager to the runtime first: `(window.__cceRemote&&window.__cceRemote.attach(S),X)`.
 * Only where a statement or an expression list can go on with `(` (after `{`, `,`, `;` or the `)`
 * of an `if`), so the parenthesised expression can't become a call of what's before it. `found`
 * counts the roots, hooked or not: one that can't be hooked has a Connection tab without the bridge.
 */
function attachEdits(code: string, log: Log): { edits: Edit[]; found: number } {
  const edits: Edit[] = [];
  let found = 0;
  for (const m of code.matchAll(APP_ROOT)) {
    found++;
    const at = m.index!;
    // The prop of this root's own render call (300 chars on could reach into the next root's).
    const args = at + m[0].length;
    const callEnd = findClose(code, args - 1);
    const sessions = callEnd < 0 ? undefined : code.substring(args, Math.min(callEnd, args + 300)).match(/(?<![\w$])sessions:([\w$]+)[,}]/)?.[1];
    if (!sessions) {
      log(callEnd < 0 ? "  An app root's render call doesn't close: not hooked" : "  An app root renders without a sessions prop: not hooked");
    } else if (at === 0 || !"{,;)".includes(code[at - 1])) {
      log(`  An app root follows ${JSON.stringify(code[at - 1] ?? "")}, not { , ; or ): not hooked`);
    } else {
      edits.push([at, m[1].length, `(window.__cceRemote&&window.__cceRemote.attach(${sessions}),${m[1]})`]);
    }
  }
  return { edits, found };
}

/**
 * The tab, all or nothing (in the sessions list component; CSS = its CSS module, TAB/SET its tab
 * state, GUARD its claude.ai-login flag):
 *   [TAB,SET]=USE("local"),       → + [__cceConn,__cceSetConn]=USE(!1),
 *   className:CSS.root,           → + " cce-conn-root" while open (CSS hides the search row)
 *   GUARD&&JSXS("div",{className:CSS.segmented,children:[<Local>,<Web>]})
 *     → the row for every login (" cce-no-web" hides Web for the others), " cce-conn-on" while
 *       open, a click on another tab closes Connection, and a third tab: Connection
 *   JSX("div",{id:LIST,className:`${CSS.content} …`,…})
 *     → __cceConn ? the runtime's element (keyed, so React mounts a fresh one) : the list
 * The root, the row and the content must sit in the block that declares the tab state, after it
 * (the list component's body): only there can they read a state declared next to it.
 */
function tabEdits(code: string, log: Log): { edits: Edit[]; summary: string } {
  const none = (...missing: string[]) => {
    log(`  Could not add the Connection tab (missing: ${missing.join(", ")})`);
    return { edits: [], summary: "" };
  };

  const rows = [...code.matchAll(/([\w$]+)&&([\w$]+)\("div",\{className:([\w$]+)\.segmented,children:\[/g)];
  if (rows.length !== 1) return none(rows.length ? `a single tab row (found ${rows.length})` : "tab row");
  const row = rows[0];
  const [rowHead, guard, jsxs, css] = row;
  const rowAt = row.index!;
  const arrayOpen = rowAt + rowHead.length - 1;
  const arrayClose = findClose(code, arrayOpen);
  if (arrayClose < 0) return none("end of the tab row");
  const tabs = code.slice(arrayOpen, arrayClose + 1);

  // The tab state: the nearest `[TAB,SET]=USE("local"),` before the row whose setter the row's
  // tabs call (other components keep a "local" state too, e.g. the MCP server form).
  const stateFrom = Math.max(0, rowAt - 40000);
  const state = [...code.substring(stateFrom, rowAt).matchAll(/\[([\w$]+),([\w$]+)\]=([\w$]+)\("local"\),/g)]
    .filter((s) => new RegExp(`(?<![\\w$.])${escRe(s[2])}\\("local"\\)`).test(tabs))
    .pop();

  // The list's root element: the nearest `className:CSS.root,` before the row.
  const rootFrom = Math.max(0, rowAt - 3000);
  const root = [...code.substring(rootFrom, rowAt).matchAll(new RegExp(`className:${escRe(css)}\\.root,`, "g"))].pop();

  // The list content: the first `JSX("div",{(id:LIST,)?className:`${CSS.content}…` after the row,
  // where a conditional expression can stand in for it.
  const contentRe = new RegExp(`([\\w$]+)\\("div",\\{(?:id:[\\w$]+,)?className:\`\\$\\{${escRe(css)}\\.content\\}`, "g");
  contentRe.lastIndex = arrayClose;
  const content = contentRe.exec(code);
  const contentNear = !!content && content.index - arrayClose < 30000;
  // Only where a conditional expression means the same as the element alone (list item,
  // argument, property value, ternary branch), so `__cceConn?A:` can't regroup what's before it.
  const contentSwappable = !!content && "[,(:?".includes(code[content.index - 1]);

  const missing = [
    !state && "tab state",
    !root && "sessions list root",
    !contentNear ? "list content after the tab row" : !contentSwappable && "list content in a place it can be swapped",
  ].filter((m): m is string => !!m);
  if (missing.length > 0 || !state || !root || !content) return none(...missing);

  // The Connection state is declared next to the tab state, so it exists in that block only (the
  // list component's body, up to its closing brace), and only after the declaration. Say the
  // list's content moved into a child component: a read of the state there would throw.
  const stateEnd = stateFrom + state.index! + state[0].length;
  const scopeEnd = blockEnd(code, stateEnd, SCOPE_LIMIT);
  if (scopeEnd < 0) return none("end of the tab state's function");
  const inScope = (at: number) => at >= stateEnd && at < scopeEnd;
  const outside = [
    !inScope(rootFrom + root.index!) && "sessions list root",
    !(inScope(rowAt) && inScope(arrayClose)) && "tab row",
    !inScope(content.index) && "list content",
  ].filter((m): m is string => !!m);
  if (outside.length > 0) return none(`${outside.join(", ")} in the tab state's function`);

  const useState = state[3];
  const jsx = content[1];
  const edits: Edit[] = [
    [stateEnd, 0, `[${OPEN},${SET_OPEN}]=${useState}(!1),`],
    [rootFrom + root.index!, root[0].length, `className:${css}.root+(${IS_OPEN}?" cce-conn-root":""),`],
    [
      rowAt,
      rowHead.length,
      `${jsxs}("div",{className:${css}.segmented+(${IS_OPEN}?" cce-conn-on":"")+(${guard}?"":" cce-no-web"),` +
        `onClickCapture:(e)=>{var t=e&&e.target;if(t&&t.closest&&t.closest("button")&&!t.closest(".cce-conn-tab"))${setOpen("!1")}},children:[`,
    ],
    [
      arrayClose,
      0,
      `,${jsxs}("button",{className:\`\${${css}.tab} cce-conn-tab \${${IS_OPEN}?${css}.tabActive:""}\`,"aria-pressed":${IS_OPEN},` +
        `onClick:()=>${setOpen("!0")},children:["Connection"]})`,
    ],
    [
      content.index,
      0,
      `${IS_OPEN}?${jsx}("div",{className:${css}.content+" cce-conn",ref:window.__cceRemote&&window.__cceRemote.mount},"cce-conn"):`,
    ],
  ];
  return { edits, summary: `tab state [${state[1]},${state[2]}], row ${css}.segmented, list ${jsx}("div",{${content[0].includes("id:") ? "id:…," : ""}className:${css}.content…` };
}

/**
 * The Connection tab and the attach hooks. `checks` are patch.ts's verify lines: `attach` holds
 * when every app root hands its sessions to the runtime (each root is a webview: the Session
 * Manager's, the chat's), `tab` when the tab went in.
 */
export function patchWebviewConnection(
  code: string,
  log: Log = console.log,
): Result & { checks: { attach: boolean; tab: boolean } } {
  if (code.includes(CONNECTION_RUNTIME) || code.includes(SET_OPEN)) {
    log("  Already patched: Connection tab");
    const hooked = [...code.matchAll(HOOKED_ROOT)].length;
    const unhooked = [...code.matchAll(APP_ROOT)].length;
    return { patched: code, count: 0, checks: { attach: hooked > 0 && unhooked === 0, tab: code.includes(SET_OPEN) } };
  }
  const { edits: attach, found: roots } = attachEdits(code, log);
  if (roots === 0) log('  Could not find an app root (createRoot(document.querySelector("#root")).render)');
  else if (attach.length === roots) log(`  Connection runtime attached to ${roots} app root(s)`);
  else log(`  Connection runtime attached to ${attach.length} of ${roots} app roots: in the others the Connection tab can't reach the bridge`);
  const tab = tabEdits(code, log);
  if (tab.edits.length > 0) log(`  Connection tab added (${tab.summary})`);

  const edits = [...attach, ...tab.edits];
  if (edits.length === 0) return { patched: code, count: 0, checks: { attach: false, tab: false } };
  // In front of the bundle, not after it: the app boots synchronously at the end of the bundle,
  // and the attach hooks above run right then.
  const runtime = CONNECTION_RUNTIME.endsWith("\n") ? CONNECTION_RUNTIME : CONNECTION_RUNTIME + "\n";
  log("  Connection runtime put in front of the bundle");
  return {
    patched: runtime + applyEdits(code, edits),
    count: edits.length + 1,
    checks: { attach: roots > 0 && attach.length === roots, tab: tab.edits.length > 0 },
  };
}

// ── webview/index.css: the tab row's states and the Connection view ──

/** Rules on the sessions list's classes; `{name}` is that class of the list's CSS module. */
const TAB_RULES: [string, string][] = [
  // Connection open: Local and Web drop their highlight (back to the inactive tab's look).
  [".cce-conn-on>.{tab}.{tabActive}:not(.cce-conn-tab)", "background:none;box-shadow:none"],
  [".cce-conn-on>.{tab}.{tabActive}:not(.cce-conn-tab):not(:hover)", "color:var(--vscode-descriptionForeground)"],
  // Logins without web sessions (upstream shows them no tab row): no Web tab.
  [".cce-no-web>.{tab}:nth-child(2)", "display:none"],
  // No session search while Connection is open.
  [".cce-conn-root>.{searchRow}", "display:none"],
];

/** The Connection view: VS Code theme tokens only, in the look of the panel (patchSessionsPanelCss). */
const VIEW_RULES: [string, string][] = [
  // The tab's content element (the list's `content` class plus cce-conn): text can be selected.
  [".cce-conn", "user-select:text;-webkit-user-select:text;cursor:auto"],
  [".cce-conn-view", "display:flex;flex-direction:column;gap:16px;padding:12px 8px 20px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.45;color:var(--vscode-foreground);overflow-wrap:anywhere"],
  [".cce-conn-part", "display:contents"],
  [".cce-conn-view [hidden]", "display:none !important"],
  [".cce-conn-head", "display:flex;flex-direction:column;gap:4px"],
  [".cce-conn-title", "margin:0;font-size:inherit;font-weight:600"],
  [".cce-conn-intro", "margin:0;color:var(--vscode-descriptionForeground)"],
  [".cce-conn-section", "display:flex;flex-direction:column;gap:8px;margin:0;min-width:0"],
  // Section titles like the workbench's view sections.
  [".cce-conn-heading", "margin:0;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground))"],
  [".cce-conn-muted", "color:var(--vscode-descriptionForeground)"],
  [".cce-conn-strong", "font-weight:600"],
  [".cce-conn-hint,.cce-conn-note,.cce-conn-label", "font-size:12px;color:var(--vscode-descriptionForeground)"],
  [".cce-conn-mono", "font-family:var(--vscode-editor-font-family,monospace);font-size:12px"],
  [".cce-conn-address", "display:flex;flex-direction:column;gap:2px"],
  // A state dot and its text.
  [".cce-conn-line", "display:flex;align-items:flex-start;gap:8px;min-width:0"],
  [".cce-conn-line-body", "display:flex;flex-direction:column;gap:2px;min-width:0"],
  [".cce-conn-dot", "flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--vscode-disabledForeground)"],
  ['.cce-conn-dot[data-state="ok"]', "background:var(--vscode-testing-iconPassed,var(--vscode-charts-green))"],
  ['.cce-conn-dot[data-state="warn"]', "background:var(--vscode-editorWarning-foreground,var(--vscode-charts-orange))"],
  ['.cce-conn-dot[data-state="busy"]', "background:var(--vscode-progressBar-background,var(--vscode-charts-blue))"],
  ['.cce-conn-dot[data-state="error"]', "background:var(--vscode-errorForeground)"],
  // Buttons: VS Code's primary and secondary buttons, as tall as the panel's search field.
  [".cce-conn-actions", "display:flex;flex-wrap:wrap;gap:6px"],
  [".cce-conn-btn", "box-sizing:border-box;min-height:26px;margin:0;padding:3px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;font:inherit;line-height:18px;cursor:pointer"],
  [".cce-conn-primary", "background:var(--vscode-button-background);color:var(--vscode-button-foreground)"],
  [".cce-conn-primary:hover:not(:disabled)", "background:var(--vscode-button-hoverBackground)"],
  [".cce-conn-secondary", "background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)"],
  [".cce-conn-secondary:hover:not(:disabled)", "background:var(--vscode-button-secondaryHoverBackground)"],
  [".cce-conn-btn:disabled", "opacity:.6;cursor:default"],
  [".cce-conn-link", "display:inline;margin:0;padding:0;border:none;background:none;font:inherit;color:var(--vscode-textLink-foreground);text-align:start;cursor:pointer"],
  [".cce-conn-link:hover", "color:var(--vscode-textLink-activeForeground);text-decoration:underline"],
  [".cce-conn-view button:focus-visible", "outline:1px solid var(--vscode-focusBorder);outline-offset:2px"],
  // The app address: a VS Code input, like the panel's search field.
  [".cce-conn-field", "display:flex;gap:6px;min-width:0"],
  [".cce-conn-input", "flex:1;min-width:0;height:26px;box-sizing:border-box;margin:0;padding:3px 8px;border:1px solid var(--vscode-input-border,transparent);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit"],
  [".cce-conn-input:focus", "outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;border-color:transparent"],
  [".cce-conn-input::placeholder", "color:var(--vscode-input-placeholderForeground);opacity:1"],
  // Errors, and the note next to "Turn on HTTPS".
  [".cce-conn-notice", "padding:6px 8px;border:1px solid var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground));border-radius:4px;background:var(--vscode-inputValidation-errorBackground,transparent)"],
  [".cce-conn-warning", "display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground));border-radius:4px;background:var(--vscode-inputValidation-warningBackground,transparent)"],
  // Pairing: the QR code (black on white, its own quiet zone), the code and its countdown.
  [".cce-conn-qr", "align-self:flex-start;width:100%;max-width:176px;border-radius:4px;overflow:hidden"],
  [".cce-conn-qr svg", "display:block;width:100%;height:auto"],
  [".cce-conn-codeline", "display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px"],
  [".cce-conn-code", "font-family:var(--vscode-editor-font-family,monospace);font-size:18px;font-weight:600;letter-spacing:.06em"],
  // Paired devices: rows with a hairline between them, like a list.
  [".cce-conn-device", "display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border,transparent))"],
  [".cce-conn-device-main", "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"],
  [".cce-conn-device-meta", "font-size:12px"],
  [".cce-conn-device .cce-conn-btn", "min-height:22px;padding:1px 8px"],
];

export function patchConnectionCss(css: string, jsCode: string, log: Log = console.log): Result {
  // The sessions list's CSS module: {…,segmented:"segmented_X",tab:"tab_X",…}
  const listModule = jsCode.match(/[\w$]+=\{[^}]*segmented:"segmented_\w+"[^}]*\}/)?.[0];
  const listClass = (k: string) => listModule?.match(new RegExp(`\\b${k}:"(${k}_\\w+)"`))?.[1];
  let out = "\n/* cce-patch: Connection tab (phone remote) */";
  if (!listModule) {
    log("  Could not find the sessions list CSS classes: the tab row's Connection states are unstyled");
  } else {
    const skipped: string[] = [];
    for (const [template, declarations] of TAB_RULES) {
      const missing = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !listClass(k));
      if (missing.length > 0) {
        skipped.push(...missing);
        continue;
      }
      out += `\n${template.replace(/\{(\w+)\}/g, (_m, k) => listClass(k)!)}{${declarations}}`;
    }
    if (skipped.length > 0) log(`  Skipped tab row rules for missing classes: ${[...new Set(skipped)].join(", ")}`);
  }
  for (const [selector, declarations] of VIEW_RULES) out += `\n${selector}{${declarations}}`;
  log("  Added Connection tab CSS");
  return { patched: css + out, count: 1 };
}

// ── --revert: remote access off ──

/** What turnRemoteAccessOff needs of lib/tailscale.js's Tailscale (a test hands in a stub). */
type ServeOff = { serveOff(port: number): Promise<{ ok: boolean; error?: string }> };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Part of `--revert`. When the bridge's state file (`$CCE_REMOTE_HOME/state.json`, else
 * `~/.cce-remote/state.json`) says remote access is on, it turns it off there (`enabled:false`;
 * the pairings, the secret and the app address stay, as the folder does) and then stops
 * `tailscale serve` for the bridge's port, waiting `timeoutMs` at most. Off first: a window that
 * still runs the bridge sees the file change and stops its hub instead of serving again. Without
 * a state file, with remote access off, or with a file that isn't a JSON object, nothing is
 * touched and Tailscale isn't asked. Never throws. `serveOff` is null when serve wasn't asked.
 */
export async function turnRemoteAccessOff(
  log: Log = console.log,
  { env = process.env, tailscale, timeoutMs = 20000 }: { env?: Record<string, string | undefined>; tailscale?: ServeOff; timeoutMs?: number } = {},
): Promise<{ wasOn: boolean; serveOff: boolean | null }> {
  const untouched = { wasOn: false, serveOff: null };
  const requireHere = createRequire(import.meta.url);
  let store: any;
  try {
    store = requireHere("./lib/store.js");
  } catch (error) {
    log(`  Could not load remote-bridge/lib/store.js (${errorText(error)}): remote access left as it is`);
    return untouched;
  }
  let file = "the state file";
  let state: Record<string, unknown> | null;
  try {
    file = store.statePath(env);
    if (!existsSync(file)) {
      log(`  No remote access state (${file}): nothing to turn off`);
      return untouched;
    }
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    state = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch (error) {
    log(`  Could not read ${file} (${errorText(error)}): remote access left as it is`);
    return untouched;
  }
  if (state?.enabled !== true) {
    log(`  Remote access is off (${file}): nothing to turn off`);
    return untouched;
  }

  const port: number = store.effectivePort(state, env);
  try {
    store.updateState((current: Record<string, unknown>) => {
      current.enabled = false;
    }, env);
    log(`  Remote access was on: turned it off (${file})`);
  } catch (error) {
    log(`  Could not turn remote access off in ${file}: ${errorText(error)}`);
  }

  let result: { ok: boolean; error?: string };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ts: ServeOff = tailscale ?? new (requireHere("./lib/tailscale.js").Tailscale)({ env });
    const late = new Promise<{ ok: boolean; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `Tailscale didn't answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    });
    result = await Promise.race([ts.serveOff(port), late]);
  } catch (error) {
    result = { ok: false, error: errorText(error) };
  } finally {
    clearTimeout(timer);
  }
  if (result.ok) {
    log(`  Turned off tailscale serve for port ${port}`);
    return { wasOn: true, serveOff: true };
  }
  log(`  Could not turn off tailscale serve for port ${port}: ${result.error ?? "unknown error"}`);
  log(`  Turn it off yourself: tailscale serve --https=${port} off`);
  return { wasOn: true, serveOff: false };
}
