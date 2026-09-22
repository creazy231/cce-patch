#!/usr/bin/env bun
/**
 * Claude Code Extension Patch
 * Makes the sessions list permanently visible alongside the chat (80/20 split)
 * adds colored status dots to each session, and defaults reasoning effort to max.
 *
 * Status dots:
 *   🟢 green  = job done, not yet viewed
 *   🔵 blue   = running
 *   🟠 orange = waiting for input (needs interaction)
 *   ⚫ gray   = job done and viewed
 *
 * Usage: bun run /Volumes/WD_BLACK/PROJECTS/cce-patch/patch.ts [--revert]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const EDITOR_CONFIGS = [
  { label: "VS Code Insiders", extDir: join(homedir(), ".vscode-insiders", "extensions") },
  { label: "VS Code",          extDir: join(homedir(), ".vscode", "extensions") },
  { label: "Cursor",           extDir: join(homedir(), ".cursor", "extensions") },
  { label: "VSCodium",         extDir: join(homedir(), ".vscodium", "extensions") },
];

function extractVersion(dirName: string): number[] {
  const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0, 0, 0];
}

function findAllExtensionDirs(): { label: string; dir: string }[] {
  const results: { label: string; dir: string }[] = [];
  for (const { label, extDir } of EDITOR_CONFIGS) {
    if (!existsSync(extDir)) continue;
    const entries = readdirSync(extDir)
      .filter((e) => e.startsWith("anthropic.claude-code-"))
      .map((e) => join(extDir, e));
    if (entries.length > 0) {
      entries.sort((a, b) => {
        const va = extractVersion(a);
        const vb = extractVersion(b);
        return va[0] - vb[0] || va[1] - vb[1] || va[2] - vb[2];
      });
      results.push({ label, dir: entries[entries.length - 1] });
    }
  }
  if (results.length === 0) {
    throw new Error(
      "Claude Code extension not found. Searched:\n" +
      EDITOR_CONFIGS.map((c) => `  ${c.extDir}`).join("\n")
    );
  }
  return results;
}

// Minified identifiers may contain `$` and `_` (esbuild emits names like `$ot`).
// `\w` does NOT match `$`, so every identifier capture must use [\w$].
const ID = "[\\w$]+";

// Escape a captured minified identifier for safe use inside a RegExp
// (a bare `$` would otherwise act as an end-of-input anchor).
function escRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Escape a captured identifier for use in a String.replace() replacement
// (`$` is special there too: `$&`, `$1`, `$$`, …).
function escRepl(v: string): string {
  return v.replace(/\$/g, "$$$$");
}

// ── Webview JS patches: sessions sidebar always open ──
function patchWebviewJs(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Step 1: Find the CSS module var: VAR={overlay:"overlay_XXXXX",dropdown:"dropdown_XXXXX"}
  const cssModuleRe = /([\w$]+)=\{overlay:"(overlay_\w+)",dropdown:"(dropdown_\w+)"\}/;
  const cssModuleMatch = patched.match(cssModuleRe);

  if (!cssModuleMatch) {
    console.log("  Could not find sessions dropdown CSS module");
    return { patched, count };
  }

  const cssVar = cssModuleMatch[1];
  const overlayClass = cssModuleMatch[2];
  const dropdownClass = cssModuleMatch[3];
  console.log(`  CSS module: ${cssVar} (overlay: ${overlayClass}, dropdown: ${dropdownClass})`);

  // Step 2: Find the function that references this CSS module
  const cssUseIdx = patched.indexOf(`${cssVar}.overlay`);
  if (cssUseIdx === -1) {
    console.log(`  Could not find ${cssVar}.overlay usage`);
    return { patched, count };
  }

  // NOTE: the component name is minified and may start with `$` (e.g. `$ot` in
  // 2.1.229+, `sot` in 2.1.227). Must be [\w$]+ — `\w+` silently fails on `$ot`,
  // which skips steps 3-7 and leaves the sidebar styled but never rendered.
  const searchBack = patched.substring(Math.max(0, cssUseIdx - 3000), cssUseIdx);
  const allFuncMatches = [...searchBack.matchAll(/function\s+([\w$]+)\(\{isOpen:([\w$]+),/g)];
  if (allFuncMatches.length === 0) {
    console.log("  Could not find sessions dropdown function");
    return { patched, count };
  }
  const funcMatch = allFuncMatches[allFuncMatches.length - 1];
  const funcName = funcMatch[1];
  const isOpenVar = funcMatch[2];
  console.log(`  Sessions function: ${funcName}, isOpen var: "${isOpenVar}"`);

  // Step 3: Remove the "if not open, return null" guard
  const guardAnchor = `function ${funcName}({isOpen:${isOpenVar},`;
  const guardIdx = patched.indexOf(guardAnchor);
  if (guardIdx !== -1) {
    const funcChunk = patched.substring(guardIdx, guardIdx + 600);
    const guardPattern = `[${isOpenVar}]),!${isOpenVar})return null;`;
    const guardLocalIdx = funcChunk.indexOf(guardPattern);
    if (guardLocalIdx !== -1) {
      const absIdx = guardIdx + guardLocalIdx;
      patched =
        patched.substring(0, absIdx) +
        `[${isOpenVar}]),!0)/*patched:sessions-always-open*/void 0;` +
        patched.substring(absIdx + guardPattern.length);
      count++;
      console.log(`  Removed isOpen guard (anchored to ${funcName})`);
    } else {
      console.log(`  Warning: Found ${funcName} but no guard within it`);
    }
  } else {
    console.log(`  Warning: Could not find ${funcName} function`);
  }

  // Step 4: Remove the overlay div (click-outside backdrop).
  //
  // Supports BOTH element-creation forms:
  //   - classic:  X.default.createElement("div",{className:VAR.overlay,onMouseDown:...})
  //   - JSX runtime (2.1.186+):  b("div",{className:VAR.overlay,onMouseDown:...})
  //
  // We anchor on the contiguous, highly-specific `("div",{className:VAR.overlay`
  // and bracket-match the element from its opening paren. This can NEVER jump to an
  // unrelated element (the old code's `lastIndexOf("createElement")` matched a far-away
  // <input> in the JSX-runtime bundle and corrupted the render tree). If the element
  // can't be found, we skip — the CSS rule already hides `.overlay` with display:none.
  const overlayOpen = `("div",{className:${cssVar}.overlay`;
  const overlayOpenIdx = patched.indexOf(overlayOpen);
  if (overlayOpenIdx !== -1) {
    // Walk back over the element-creation helper identifier
    // ("b", or "Cg.default.createElement", etc.) to find the element start.
    let elemStart = overlayOpenIdx;
    while (elemStart > 0 && /[\w$.]/.test(patched[elemStart - 1])) elemStart--;
    // Bracket-match parens from the opening "(" to find the element end.
    let depth = 0;
    let end = overlayOpenIdx;
    for (let i = overlayOpenIdx; i < patched.length && i < overlayOpenIdx + 1500; i++) {
      if (patched[i] === "(") depth++;
      else if (patched[i] === ")") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (depth === 0 && end > overlayOpenIdx) {
      if (patched[end] === ",") end++; // consume the comma separating it from the dropdown sibling
      const removed = patched.substring(elemStart, end);
      patched = patched.substring(0, elemStart) + patched.substring(end);
      count++;
      console.log(`  Removed overlay backdrop element: ${removed.substring(0, 80)}...`);
    } else {
      console.log("  Warning: could not bracket-match overlay element; skipped (CSS still hides it)");
    }
  } else {
    console.log("  Could not find overlay element to remove (CSS still hides it)");
  }

  // Step 5: Remove the fixed positioning style on dropdown
  const styleRe = new RegExp(`className:${escRe(cssVar)}\\.dropdown,style:${ID},`);
  if (styleRe.test(patched)) {
    patched = patched.replace(styleRe, `className:${escRepl(cssVar)}.dropdown,`);
    count++;
    console.log(`  Removed inline positioning style`);
  }

  // Escape any regex-special chars in the (minified) function name.
  const fnEsc = escRe(funcName);

  // Step 6: Force isOpen:!0 in the render call that mounts this component.
  // Anchors on `<funcName>,{isOpen:VAR,onClose:` so it matches both forms:
  //   classic:      createElement(nQe,{isOpen:VAR,onClose:...)
  //   JSX runtime:  b(nQe,{isOpen:VAR,onClose:...)
  const renderRe = new RegExp(`(${fnEsc},\\{isOpen:)[\\w$]+(,onClose:)`);
  if (renderRe.test(patched)) {
    patched = patched.replace(renderRe, "$1!0$2");
    count++;
    console.log(`  Forced isOpen:!0 in render call`);
  } else if (new RegExp(`${fnEsc},\\{isOpen:!0,onClose:`).test(patched)) {
    console.log(`  Already forced isOpen:!0 in render call`);
  } else {
    console.log(`  WARNING: could not force isOpen:!0 — sidebar will NOT appear`);
  }

  // Step 7: Make onClose a no-op to prevent closing (form-agnostic).
  const noopCloseRe = new RegExp(`(${fnEsc},\\{isOpen:!0,onClose:)\\(\\)=>[^,]+,`);
  if (noopCloseRe.test(patched)) {
    patched = patched.replace(noopCloseRe, "$1()=>{},");
    count++;
    console.log(`  Made onClose a no-op`);
  }

  return { patched, count };
}

// ── Webview JS patches: session status dots ──
function patchSessionStatusDots(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Step 1: Find the session item CSS module variable
  // Pattern: VAR={...sessionItem:"sessionItem_XXXXX"...}
  const cssRe = /([\w$]+)=\{[^}]*sessionItem:"(sessionItem_\w+)"/;
  const cssMatch = patched.match(cssRe);
  if (!cssMatch) {
    console.log("  Could not find session item CSS module");
    return { patched, count };
  }
  const cssVar = cssMatch[1];
  console.log(`  Session CSS module: ${cssVar}`);

  // Step 2: Find the session item render function.
  // Unique: the only component function destructuring both `session` and `isActive`.
  // Match the bare `function({session:...` so it works whether the function is
  // wrapped in `forwardRef(...)` (classic) or a minified alias like `Jt(...)`
  // (2.1.186+). Other props may sit between the two (2.1.280 inserted `id:Z`), so
  // allow anything up to `isActive` that stays inside the parameter list (no `)`).
  const itemUseIdx = patched.indexOf(`${cssVar}.sessionItem`);
  if (itemUseIdx === -1) {
    console.log(`  Could not find ${cssVar}.sessionItem usage`);
    return { patched, count };
  }

  const searchStart = Math.max(0, itemUseIdx - 6000);
  const searchBack = patched.substring(searchStart, itemUseIdx);
  const funcRe = /function\(\{session:([\w$]+),[^)]*?\bisActive:([\w$]+)[,}]/g;
  const funcMatches = [...searchBack.matchAll(funcRe)];
  if (funcMatches.length === 0) {
    console.log("  Could not find session item render function");
    return { patched, count };
  }
  const fm = funcMatches[funcMatches.length - 1];
  const sessionVar = fm[1];
  const isActiveVar = fm[2];
  // Use the match position itself: the minified names (`J`, `X`) are reused by
  // other `function({session:J,...` components elsewhere in the bundle.
  const funcSigIdx = searchStart + fm.index!;
  console.log(`  Session item vars: session=${sessionVar}, isActive=${isActiveVar}`);

  // Step 3: Inject status computation at the beginning of the function body,
  // right after the signals hook call (`W5();`) so the signal reads below are
  // tracked and the row re-renders whenever a session's state changes.
  // Bracket-match the parameter list rather than searching a fixed window: the
  // signature keeps growing (~400 chars in 2.1.280).
  const paramsOpen = funcSigIdx + "function".length;
  let depth = 0;
  let bodyStart = -1;
  for (let i = paramsOpen; i < patched.length && i < paramsOpen + 5000; i++) {
    if (patched[i] === "(") depth++;
    else if (patched[i] === ")" && --depth === 0) {
      if (patched[i + 1] === "{") bodyStart = i + 2;
      break;
    }
  }
  const hookMatch = bodyStart === -1 ? null : patched.substring(bodyStart, bodyStart + 40).match(/^[\w$]+\(\);/);
  if (!hookMatch) {
    console.log("  Could not find function body opening");
    return { patched, count };
  }
  const insertIdx = bodyStart + hookMatch[0].length;

  // Status per session row. Mirrors how the extension itself reports a session's
  // state to the host (pending permissionRequests → "waiting_input", busy or
  // background tasks → "running"), and merges the host's cross-panel feed on
  // `session.context.comms` so sessions open in other tabs, other windows or a
  // terminal are coloured too:
  //   sessionStates          state each chat panel reports for its session
  //   liveElsewhereSessions  sessions held by other processes, with activity
  //   unreadSessionKeys      persisted "finished while not viewed" marks
  // Remote (web) sessions use remoteStatus. `pendingInput` is only ever set from
  // host state (Session Manager view), never in a chat panel — so it can't be the
  // sole waiting signal, and waiting must win over busy (a prompt keeps busy on).
  //
  //   waiting → orange   running → blue
  //   done    → green: host unread mark, or this panel saw it working and it
  //             finished while another session was being viewed
  //   seen    → gray: everything else, including the session being viewed
  //
  // Only work observed in *this* webview is tracked locally: other tabs, and the
  // Session Manager (whose busy flags are host-fed), defer to the host's mark.
  // Every read is guarded — a throw here would take down the whole sessions list.
  const statusFn = [
    `function(s,active){try{`,
    `var arr=(v)=>Array.isArray(v)?v:[],c=s.context?.comms,id=s.sessionId?.value,`,
    `remote=s.isRemote?.value===!0,key=id&&(remote?"remote:"+id:id),`,
    `from=s.teleportedFromSessionId?.value,keys=arr(c?.unreadSessionKeys?.value),`,
    `host=id?arr(c?.sessionStates?.value).find((x)=>x?.sessionId===id)?.state:void 0,`,
    `away=id&&!remote?arr(c?.liveElsewhereSessions?.value).find((x)=>x?.sessionId===id)?.activity:void 0,`,
    `rs=remote?s.remoteStatus?.value:void 0,`,
    `perms=(s.permissionRequests?.value?.length??0)>0,busy=s.busy?.value===!0,`,
    `bg=(s.backgroundTaskIds?.value?.size??0)>0,`,
    `waiting=perms||s.pendingInput?.value===!0||host==="waiting_input"||away==="waiting"||rs==="requires_action",`,
    `running=busy||bg||host==="running"||away==="running"||rs==="running",`,
    `unread=!!key&&keys.includes(key)||!!from&&keys.includes("remote:"+from),`,
    `W=window.__cceWorked??=new Set,U=window.__cceUnseen??=new Set,t=id||s;`,
    `if(waiting||running){if((busy||bg||perms)&&!window.IS_SESSION_LIST_ONLY)W.add(t);`,
    `U.delete(t);return waiting?"waiting":"running"}`,
    `if(active){W.delete(t);U.delete(t);return"seen"}`,
    `if(W.delete(t))U.add(t);`,
    `return unread||U.has(t)?"done":"seen"`,
    `}catch{return"seen"}}`,
  ].join("");
  const statusCode =
    `/*cce-status:begin*/window.__cceStatus=window.__cceStatus||${statusFn};/*cce-status:end*/` +
    `var __cceSt=window.__cceStatus(${sessionVar},${isActiveVar});`;

  patched = patched.substring(0, insertIdx) + statusCode + patched.substring(insertIdx);
  count++;
  console.log(`  Injected status tracking code`);

  // Step 4: Inject the dot element as the first child of the session item button.
  // Two render forms are supported:
  //   JSX runtime (2.1.186+):  E("button",{...,onMouseMove:a,children:[ <children> ]})
  //                            → insert the dot as first element inside `children:[`
  //   classic:                 X.default.createElement("button",{...,onMouseMove:a}, <children>)
  //                            → insert the dot right after the props object `},`
  const btnClassAnchor = `className:\`\${${cssVar}.sessionItem}`;
  const btnClassIdx = patched.indexOf(btnClassAnchor, funcSigIdx);
  if (btnClassIdx === -1) {
    console.log("  Could not find button className anchor");
    return { patched, count };
  }

  const afterBtnClass = patched.substring(btnClassIdx, btnClassIdx + 600);
  const childrenRel = afterBtnClass.indexOf(",children:[");
  const onMouseMatch = afterBtnClass.match(/onMouse(?:Enter|Move):[\w$]+\},/);

  if (childrenRel !== -1 && (!onMouseMatch || childrenRel < (onMouseMatch.index ?? Infinity))) {
    // JSX runtime form — insert as first element of the children array.
    const childrenStart = btnClassIdx + childrenRel + ",children:[".length;
    // Capture the single-element jsx helper (e.g. "b") from the next element.
    const helperMatch = patched
      .substring(childrenStart, childrenStart + 120)
      .match(/([\w$]+)\("(?:span|div)"/);
    if (!helperMatch) {
      console.log("  Could not determine jsx helper for status dot");
      return { patched, count };
    }
    const jsxHelper = helperMatch[1];
    const dotElement =
      `${jsxHelper}("span",{className:"cce-status-dot","data-status":__cceSt}),`;
    patched = patched.substring(0, childrenStart) + dotElement + patched.substring(childrenStart);
    count++;
    console.log(`  Injected status dot element (jsx form, helper: ${jsxHelper})`);
  } else if (onMouseMatch && onMouseMatch.index !== undefined) {
    // Classic createElement form — insert right after the props object.
    // Anchor on btnClassIdx (recomputed after the status-code injection) — the
    // button's `X.default.createElement("button",{ref:f,` sits just before it.
    const reactMatch = patched
      .substring(Math.max(0, btnClassIdx - 200), btnClassIdx)
      .match(/([\w$]+)\.default\.createElement\("button"/);
    if (!reactMatch) {
      console.log("  Could not find React module variable");
      return { patched, count };
    }
    const reactVar = reactMatch[1];
    const childrenStart = btnClassIdx + onMouseMatch.index + onMouseMatch[0].length;
    const dotElement =
      `${reactVar}.default.createElement("span",` +
      `{className:"cce-status-dot","data-status":__cceSt}),`;
    patched = patched.substring(0, childrenStart) + dotElement + patched.substring(childrenStart);
    count++;
    console.log(`  Injected status dot element (createElement form, React: ${reactVar})`);
  } else {
    console.log("  Could not find children insertion point for status dot");
  }

  return { patched, count };
}

// ── Webview CSS patches: sessions sidebar layout ──
function patchWebviewCss(css: string, jsCode: string): { patched: string; count: number } {
  let patched = css;
  let count = 0;

  const cssModuleRe = /([\w$]+)=\{overlay:"(overlay_\w+)",dropdown:"(dropdown_\w+)"\}/;
  const cssModuleMatch = jsCode.match(cssModuleRe);

  if (!cssModuleMatch) {
    console.log("  Could not find dropdown CSS classes from JS");
    return { patched, count };
  }

  const overlayClass = cssModuleMatch[2];
  const dropdownClass = cssModuleMatch[3];

  // Restyle dropdown from floating popover to persistent sidebar
  const dropdownRe = new RegExp(`\\.${dropdownClass}\\{[^}]+\\}`);
  const dropdownMatch = patched.match(dropdownRe);
  if (dropdownMatch) {
    patched = patched.replace(
      dropdownMatch[0],
      `.${dropdownClass}{` +
        "position:relative !important;" +
        "background:var(--app-menu-background);" +
        "border-left:1px solid var(--app-menu-border);" +
        "border-radius:0;" +
        "display:flex;" +
        "z-index:1;" +
        "outline:none;" +
        "flex-direction:column;" +
        "width:20%;" +
        "min-width:200px;" +
        "max-width:350px;" +
        "max-height:none !important;" +
        "height:100% !important;" +
        "box-shadow:none;" +
        "flex-shrink:0;" +
        "overflow-y:auto;" +
        "inset:auto !important;" +
      "}"
    );
    count++;
    console.log(`  Restyled .${dropdownClass} as sidebar`);
  }

  // Hide overlay
  const overlayRe = new RegExp(`\\.${overlayClass}\\{[^}]+\\}`);
  const overlayMatch = patched.match(overlayRe);
  if (overlayMatch) {
    patched = patched.replace(
      overlayMatch[0],
      `.${overlayClass}{display:none !important}`
    );
    count++;
    console.log(`  Hidden .${overlayClass}`);
  }

  // Find the main app layout classes from JS
  const appCssRe = /([\w$]+)=\{root:"(root_\w+)",editorMode:"(editorMode_\w+)",body:"(body_\w+)",content:"(content_\w+)",sessionBody:"(sessionBody_\w+)"/;
  const appCssMatch = jsCode.match(appCssRe);

  if (appCssMatch) {
    const bodyClass = appCssMatch[4];
    const contentClass = appCssMatch[5];

    // Make body a horizontal flex container
    const bodyRe = new RegExp(`\\.${bodyClass}\\{[^}]+\\}`);
    const bodyMatch = patched.match(bodyRe);
    if (bodyMatch) {
      patched = patched.replace(
        bodyMatch[0],
        `.${bodyClass}{display:flex;overflow:hidden;flex:1;flex-direction:row !important}`
      );
      count++;
      console.log(`  Made .${bodyClass} horizontal flex`);
    } else {
      patched += `\n.${bodyClass}{display:flex;overflow:hidden;flex:1;flex-direction:row !important}`;
      count++;
      console.log(`  Added .${bodyClass} horizontal flex rule`);
    }

    // Make content fill remaining space
    const contentRe = new RegExp(`\\.${contentClass}\\{[^}]+\\}`);
    const contentMatch = patched.match(contentRe);
    if (contentMatch) {
      const newContent = contentMatch[0].replace("}", ";flex:1 1 0% !important;min-width:0 !important;}");
      patched = patched.replace(contentMatch[0], newContent);
      count++;
      console.log(`  Made .${contentClass} fill remaining space`);
    }
  } else {
    console.log("  Could not find main app CSS classes");
  }

  return { patched, count };
}

// ── Webview CSS patches: session status dots ──
function patchStatusDotsCss(css: string): { patched: string; count: number } {
  let patched = css;
  let count = 0;

  const dotStyles = [
    "",
    "/* cce-patch: session status dots */",
    ".cce-status-dot{" +
      "width:6px;" +
      "height:6px;" +
      "border-radius:50%;" +
      "flex-shrink:0;" +
      "align-self:center;" +
      "transition:background-color .3s ease" +
    "}",
    '.cce-status-dot[data-status="done"]{background:#22C55E}',
    '.cce-status-dot[data-status="running"]{background:#3B82F6;animation:cce-pulse 2s ease-in-out infinite}',
    '.cce-status-dot[data-status="waiting"]{background:#F97316;animation:cce-pulse 1.5s ease-in-out infinite}',
    '.cce-status-dot[data-status="seen"]{background:#6B7280}',
    // 2.1.280+ renders its own dot in Session Manager rows; ours is always the
    // first child, so hide the upstream one after it — one dot, one legend.
    ".cce-status-dot~[data-status-dot]{display:none}",
    "@keyframes cce-pulse{0%,100%{opacity:1}50%{opacity:.4}}",
  ].join("\n");

  patched += dotStyles;
  count++;
  console.log("  Added status dot CSS");

  return { patched, count };
}

// ── Webview JS patches: default includeSelection to OFF ──
function patchIncludeSelectionDefault(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Strategy: find the STATE OWNER — the component that defines the toggle callback
  // "includeSelection:VAR,onToggleIncludeSelection:()=>SETTER(..."
  // This distinguishes the owner (with arrow function setter) from components that
  // merely receive includeSelection as a prop parameter.
  const ownerRe = /includeSelection:([\w$]+),onToggleIncludeSelection:\(\)=>([\w$]+)\(/;
  const ownerMatch = patched.match(ownerRe);

  if (!ownerMatch) {
    // 2.1.280+ removed the toggle entirely.
    return patchSelectionOptIn(patched);
  }

  const stateVar = ownerMatch[1];
  const setterVar = ownerMatch[2];
  console.log(`  Found includeSelection state owner: [${stateVar},${setterVar}]`);

  // Find the state initializer matching BOTH the state var and setter.
  // Supports the classic `[VAR,SETTER]=REACT.useState(!0)` form AND the newer
  // bundles' bare minified hook alias `[VAR,SETTER]=oe(!0)` (2.1.186+).
  const esc = (v: string) => v.replace(/[$]/g, "\\$");
  const stateRe = new RegExp(
    `\\[${esc(stateVar)},${esc(setterVar)}\\]=[\\w$.]+\\(!0\\)`
  );
  const stateMatch = patched.match(stateRe);

  if (stateMatch) {
    const original = stateMatch[0];
    const flipped = original.replace(/\(!0\)$/, "(!1)");
    patched = patched.replace(original, flipped);
    count++;
    console.log(`  Changed ${original} → ${flipped}`);
  } else {
    // Check if already patched
    const alreadyRe = new RegExp(
      `\\[${esc(stateVar)},${esc(setterVar)}\\]=[\\w$.]+\\(!1\\)`
    );
    if (alreadyRe.test(patched)) {
      console.log("  Already patched: includeSelection default is !1");
    } else {
      console.log(`  Could not find state initializer for [${stateVar},${setterVar}]`);
    }
  }

  return { patched, count };
}

// ── Webview JS patches: current file/selection is opt-in per session (2.1.280+) ──
// 2.1.280 dropped the include-selection toggle. The session's `selection` signal
// now follows the editor and send() attaches it to every prompt — the open file as
// <ide_opened_file>, highlighted lines as <ide_selection> — until the chip's ×
// dismisses it, and any new selection or file switch brings it straight back.
// Rebuild the old per-session opt-in on top of that model:
//   • session.cceSelOn signal, off for every new session
//   • send() only attaches the selection while it's on
//   • the chip's × turns it off again, instead of hiding the chip
//   • while off, the footer shows the chip dimmed (the old inactive look);
//     clicking it attaches
function patchSelectionOptIn(code: string): { patched: string; count: number } {
  // Locate every anchor before changing anything: gating send() without the chip
  // change would leave no way to attach a selection at all.
  const fieldRe = /selection=([\w$]+)\(void 0\);dismissedSelection;/;
  const sendRe = /if\(([\w$]+)&&!([\w$]+)\(this\.lastSentSelection,this\.selection\.value\)\)/;
  const dismissRe = /dismissSelection\(\)\{([^}]*)\}/;
  // function CHIP({currentSelection:S,onRemove:R}){let L=LABEL(S);return JSXS("span",{className:CSS.selectionChip,…
  const chipRe = /function ([\w$]+)\(\{currentSelection:([\w$]+),onRemove:[\w$]+\}\)\{let [\w$]+=([\w$]+)\(\2\);return ([\w$]+)\("span",\{className:([\w$]+)\.selectionChip/;
  const field = code.match(fieldRe);
  const send = code.match(sendRe);
  const dismiss = code.match(dismissRe);
  const chip = code.match(chipRe);
  // The chip is rendered once, by the input footer: `SEL&&JSX(CHIP,{currentSelection:SEL,onRemove:FN})`.
  const render = chip && code.match(
    new RegExp(`([\\w$]+)&&([\\w$]+)\\(${escRe(chip[1])},\\{currentSelection:\\1,onRemove:([\\w$]+)\\}\\)`)
  );
  // The footer's own `session` prop, from the nearest enclosing component signature.
  const footerSession = render && render.index !== undefined
    ? [...code.substring(Math.max(0, render.index - 8000), render.index).matchAll(/function [\w$]+\(\{session:([\w$]+),/g)].pop()?.[1]
    : undefined;

  const missing = [
    !field && "session selection field",
    !send && "send() selection gate",
    !dismiss && "dismissSelection()",
    !chip && "selection chip",
    chip && !render && "selection chip render",
    render && !footerSession && "footer session prop",
  ].filter(Boolean);
  if (missing.length > 0 || !field || !send || !dismiss || !chip || !render || !footerSession) {
    console.log(`  Could not find includeSelection toggle or selection chip (missing: ${missing.join(", ")})`);
    return { patched: code, count: 0 };
  }

  const [, chipFn, , labelFn, jsxs, chipCss] = chip;
  const [renderSrc, selVar, jsx, onRemove] = render;
  const s = footerSession;
  // The chip's file icon, so the off state looks like the chip (optional).
  const icon = code.substring(chip.index!, chip.index! + 800)
    .match(/children:\[[\w$]+\(([\w$]+),\{\}\),[\w$]+\("span",\{children:/)?.[1];

  let patched = code;
  patched = patched.replace(fieldRe, (_m, sig) => `selection=${sig}(void 0);cceSelOn=${sig}(!1);dismissedSelection;`);
  patched = patched.replace(sendRe, (_m, include, same) =>
    `if(${include}&&this.cceSelOn?.value===!0&&!${same}(this.lastSentSelection,this.selection.value))`);
  patched = patched.replace(dismissRe, (_m, body) =>
    `dismissSelection(){if(this.cceSelOn)this.cceSelOn.value=!1;else{${body}}}`);

  const label = `${labelFn}(${selVar})`;
  const offChip =
    `${jsxs}("button",{type:"button",className:${chipCss}.footerButton+" cce-sel-off",` +
    `title:"Not showing Claude your current file selection ("+${label}+"). Click to attach.",` +
    `onClick:()=>{if(${s}.cceSelOn)${s}.cceSelOn.value=!0},` +
    `children:[${icon ? `${jsx}(${icon},{}),` : ""}${jsx}("span",{children:${label}})]})`;
  const onChip = `${jsx}(${chipFn},{currentSelection:${selVar},onRemove:${onRemove}})`;
  // Only a flag that is exactly on shows the attached chip — matches the send() gate.
  patched = patched.replace(renderSrc, () => `${selVar}&&(${s}.cceSelOn?.value===!0?${onChip}:${offChip})`);

  console.log(`  2.1.280+ selection chip (${chipFn}): current file/selection now opt-in per session, off by default`);
  return { patched, count: 4 };
}

// ── Webview CSS patches: dimmed selection chip while not attached ──
function patchSelectionCss(css: string): { patched: string; count: number } {
  // Same look as the pre-2.1.280 inactive include-selection button.
  const rules = "\n/* cce-patch: selection chip, not attached */\n.cce-sel-off{opacity:.5}\n.cce-sel-off:hover{opacity:1}";
  console.log("  Added dimmed selection chip CSS");
  return { patched: css + rules, count: 1 };
}

// ── Webview JS patches: default reasoning effort to max ──
function patchDefaultEffortMax(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Find: effortLevel=OBSERVABLE(void 0)  →  effortLevel=OBSERVABLE("max")
  // The observable constructor (E0, etc.) is minified, so capture it dynamically.
  // Context: ...fastModeState=E0("off");effortLevel=E0(void 0);todos=E0([])...
  const initRe = /effortLevel=([\w$]+)\(void 0\)/;
  const initMatch = patched.match(initRe);

  if (initMatch) {
    const obsConstructor = initMatch[1];
    const original = initMatch[0];
    const replacement = `effortLevel=${obsConstructor}("max")`;
    patched = patched.replace(original, replacement);
    count++;
    console.log(`  Changed ${original} → ${replacement}`);
  } else {
    // Check if already patched
    if (/effortLevel=[\w$]+\("max"\)/.test(patched)) {
      console.log('  Already patched: effortLevel default is "max"');
    } else {
      console.log("  Could not find effortLevel observable initializer");
    }
  }

  return { patched, count };
}

// ── Extension JS patches: default --effort to max ──
function patchExtensionEffortMax(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Find: if(this.options.effort)ARGS.push("--effort",this.options.effort)
  // Replace with: ARGS.push("--effort",this.options.effort||"max")
  // This ensures the CLI always receives --effort max unless explicitly overridden.
  const effortRe = /if\(this\.options\.effort\)([\w$]+)\.push\("--effort",this\.options\.effort\)/;
  const effortMatch = patched.match(effortRe);

  if (effortMatch) {
    const argsVar = effortMatch[1];
    const original = effortMatch[0];
    const replacement = `${argsVar}.push("--effort",this.options.effort||"max")`;
    patched = patched.replace(original, replacement);
    count++;
    console.log(`  Changed conditional --effort to default "max" (args var: ${argsVar})`);
  } else {
    // Check if already patched
    if (/\.push\("--effort",this\.options\.effort\|\|"max"\)/.test(patched)) {
      console.log('  Already patched: --effort defaults to "max"');
    } else {
      console.log("  Could not find --effort push pattern in extension.js");
    }
  }

  return { patched, count };
}

// ── Extension JS patches (feature flags) ──
function patchExtensionJs(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  const targets = [
    "claude-vscode.sessionsListEnabled",
    "claude-vscode.primaryEditorEnabled",
  ];

  for (const target of targets) {
    const escaped = target.replace(/\./g, "\\.");
    // Check if already hardcoded to !0
    const alreadyEnabled = new RegExp(`"${escaped}",!0`);
    if (alreadyEnabled.test(patched)) {
      console.log(`  Already enabled: ${target}`);
      continue;
    }
    // Match dynamic flag: "flag",!!VAR.VAR
    const re = new RegExp(
      `"${escaped}",!![a-zA-Z_$][a-zA-Z0-9_$]*\\.[a-zA-Z_$][a-zA-Z0-9_$]*`,
      "g"
    );
    const matches = patched.match(re);
    if (matches) {
      patched = patched.replace(re, `"${target}",!0`);
      count += matches.length;
      console.log(`  Enabled ${matches.length}x: ${target}`);
    }
  }

  return { patched, count };
}

function patchOne(extDir: string, label: string, revert: boolean): boolean {
  const extJs = join(extDir, "extension.js");
  const extJsBak = join(extDir, "extension.js.bak");
  const webviewJs = join(extDir, "webview", "index.js");
  const webviewJsBak = join(extDir, "webview", "index.js.bak");
  const webviewCss = join(extDir, "webview", "index.css");
  const webviewCssBak = join(extDir, "webview", "index.css.bak");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`  ${extDir}`);
  console.log("=".repeat(60));

  if (revert) {
    let reverted = 0;
    for (const [src, dst] of [[extJsBak, extJs], [webviewJsBak, webviewJs], [webviewCssBak, webviewCss]]) {
      if (existsSync(src)) {
        copyFileSync(src, dst);
        reverted++;
        console.log(`  Reverted ${dst}`);
      }
    }
    if (reverted === 0) {
      console.error("  No backup files found — skipping.");
      return false;
    }
    return true;
  }

  // Create backups from originals (only if backup doesn't exist yet)
  for (const [file, bak] of [[extJs, extJsBak], [webviewJs, webviewJsBak], [webviewCss, webviewCssBak]]) {
    if (!existsSync(bak)) {
      copyFileSync(file, bak);
      console.log(`  Backup: ${bak}`);
    }
  }

  // Always read from backups (the true originals)
  let totalPatches = 0;

  // 1. Patch extension.js (feature flags + default effort max)
  console.log("\n[extension.js — feature flags]");
  const extCode = readFileSync(extJsBak, "utf-8");
  let extPatched = extCode;
  let extCount = 0;

  const extFlagResult = patchExtensionJs(extPatched);
  extPatched = extFlagResult.patched;
  extCount += extFlagResult.count;

  console.log("\n[extension.js — default effort max]");
  const extEffortResult = patchExtensionEffortMax(extPatched);
  extPatched = extEffortResult.patched;
  extCount += extEffortResult.count;

  if (extCount > 0) {
    writeFileSync(extJs, extPatched, "utf-8");
    totalPatches += extCount;
  } else {
    console.log("  No extension.js patches needed.");
  }

  // 2. Patch webview/index.js (sidebar + status dots)
  const wvJsOriginal = readFileSync(webviewJsBak, "utf-8");
  let wvJsCode = wvJsOriginal;
  let wvJsCount = 0;

  console.log("\n[webview/index.js — sidebar]");
  const sidebarResult = patchWebviewJs(wvJsCode);
  wvJsCode = sidebarResult.patched;
  wvJsCount += sidebarResult.count;

  console.log("\n[webview/index.js — includeSelection default]");
  const selResult = patchIncludeSelectionDefault(wvJsCode);
  wvJsCode = selResult.patched;
  wvJsCount += selResult.count;

  console.log("\n[webview/index.js — default effort max]");
  const effortResult = patchDefaultEffortMax(wvJsCode);
  wvJsCode = effortResult.patched;
  wvJsCount += effortResult.count;

  console.log("\n[webview/index.js — status dots]");
  const dotsResult = patchSessionStatusDots(wvJsCode);
  wvJsCode = dotsResult.patched;
  wvJsCount += dotsResult.count;

  // Verify the sidebar actually got wired up. The CSS patches apply independently,
  // so without this check a failed JS anchor looks like a partial success: the panel
  // is styled as a sidebar but never rendered. Fail loudly instead.
  console.log("\n[webview/index.js — verify]");
  const checks: [string, boolean][] = [
    ["sessions-always-open guard removed", wvJsCode.includes("/*patched:sessions-always-open*/")],
    ["isOpen forced true", /[\w$]+,\{isOpen:!0,onClose:/.test(wvJsCode)],
    ["status dot injected", wvJsCode.includes("cce-status-dot")],
    ["current file/selection not attached by default", selResult.count > 0],
  ];
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) failed++;
  }
  if (failed > 0) {
    console.log(
      `\n  !! ${failed} check(s) failed — the extension bundle likely changed shape.\n` +
      `     Each FAIL above needs its patch function's anchors updated for this version\n` +
      `     (sidebar: patchWebviewJs, dots: patchSessionStatusDots,\n` +
      `      selection: patchIncludeSelectionDefault / patchSelectionOptIn).`
    );
  }

  if (wvJsCount > 0) {
    writeFileSync(webviewJs, wvJsCode, "utf-8");
    totalPatches += wvJsCount;
  } else {
    console.log("  No JS patches applied.");
  }

  // 3. Patch webview/index.css (sidebar layout + status dots)
  const wvCssOriginal = readFileSync(webviewCssBak, "utf-8");
  let wvCssCode = wvCssOriginal;
  let wvCssCount = 0;

  console.log("\n[webview/index.css — sidebar]");
  const sidebarCssResult = patchWebviewCss(wvCssCode, wvJsOriginal);
  wvCssCode = sidebarCssResult.patched;
  wvCssCount += sidebarCssResult.count;

  console.log("\n[webview/index.css — status dots]");
  const dotsCssResult = patchStatusDotsCss(wvCssCode);
  wvCssCode = dotsCssResult.patched;
  wvCssCount += dotsCssResult.count;

  console.log("\n[webview/index.css — selection chip]");
  const selCssResult = patchSelectionCss(wvCssCode);
  wvCssCode = selCssResult.patched;
  wvCssCount += selCssResult.count;

  if (wvCssCount > 0) {
    writeFileSync(webviewCss, wvCssCode, "utf-8");
    totalPatches += wvCssCount;
  } else {
    console.log("  No CSS patches applied.");
  }

  if (totalPatches === 0) {
    console.log("\n  No patches were applied. The extension may have a different structure.");
    return false;
  }

  console.log(`\n  ${totalPatches} patch(es) applied.`);
  return true;
}

function patch(revert: boolean) {
  const editors = findAllExtensionDirs();
  console.log(`Found ${editors.length} editor(s) with Claude Code:\n`);
  for (const { label, dir } of editors) {
    console.log(`  - ${label}: ${dir}`);
  }

  let successCount = 0;
  for (const { label, dir } of editors) {
    const ok = patchOne(dir, label, revert);
    if (ok) successCount++;
  }

  if (successCount === 0) {
    console.error("\nNo editors were successfully patched.");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Done: ${successCount}/${editors.length} editor(s) ${revert ? "reverted" : "patched"}.`);
  console.log("=".repeat(60));
  console.log("\nRestart each editor (Cmd+Shift+P → 'Reload Window') to apply.");
  if (!revert) console.log("To revert: bun run patch.ts --revert");
}

const revert = process.argv.includes("--revert");
patch(revert);
