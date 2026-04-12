#!/usr/bin/env bun
/**
 * Claude Code Extension Patch
 * Makes the sessions list permanently visible alongside the chat (80/20 split)
 * and adds colored status dots to each session.
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

// ── Webview JS patches: sessions sidebar always open ──
function patchWebviewJs(code: string): { patched: string; count: number } {
  let patched = code;
  let count = 0;

  // Step 1: Find the CSS module var: VAR={overlay:"overlay_XXXXX",dropdown:"dropdown_XXXXX"}
  const cssModuleRe = /(\w+)=\{overlay:"(overlay_\w+)",dropdown:"(dropdown_\w+)"\}/;
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

  const searchBack = patched.substring(Math.max(0, cssUseIdx - 3000), cssUseIdx);
  const allFuncMatches = [...searchBack.matchAll(/function\s+(\w+)\(\{isOpen:([\w$]+),/g)];
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

  // Step 4: Remove the overlay div (click-outside backdrop)
  const overlayMarker = `className:${cssVar}.overlay,onMouseDown:`;
  const overlayMarkerIdx = patched.indexOf(overlayMarker);
  if (overlayMarkerIdx !== -1) {
    let createElemStart = patched.lastIndexOf("createElement", overlayMarkerIdx);
    const before = patched.substring(Math.max(0, createElemStart - 60), createElemStart);
    const prefixMatch = before.match(/([\w$]+\.default\.)$/);
    if (prefixMatch) {
      createElemStart -= prefixMatch[1].length;
    }
    let depth = 0;
    let end = createElemStart;
    for (let i = createElemStart; i < patched.length && i < createElemStart + 500; i++) {
      if (patched[i] === "(") depth++;
      if (patched[i] === ")") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (patched[end] === ",") end++;
    const removed = patched.substring(createElemStart, end);
    patched = patched.substring(0, createElemStart) + patched.substring(end);
    count++;
    console.log(`  Removed overlay backdrop element: ${removed.substring(0, 80)}...`);
  }

  // Step 5: Remove the fixed positioning style on dropdown
  const styleRe = new RegExp(`className:${cssVar}\\.dropdown,style:\\w+,`);
  if (styleRe.test(patched)) {
    patched = patched.replace(styleRe, `className:${cssVar}.dropdown,`);
    count++;
    console.log(`  Removed inline positioning style`);
  }

  // Step 6: Force isOpen:!0 in the createElement call that renders this component
  const renderRe = new RegExp(
    `createElement\\(${funcName},\\{isOpen:[\\w$]+,onClose:`
  );
  const renderMatch = patched.match(renderRe);
  if (renderMatch) {
    patched = patched.replace(renderMatch[0], `createElement(${funcName},{isOpen:!0,onClose:`);
    count++;
    console.log(`  Forced isOpen:!0 in render call`);
  }

  // Step 7: Make onClose a no-op to prevent closing
  const noopCloseRe = new RegExp(
    `createElement\\(${funcName},\\{isOpen:!0,onClose:` +
    `\\(\\)=>[^,]+,`
  );
  const noopCloseMatch = patched.match(noopCloseRe);
  if (noopCloseMatch) {
    patched = patched.replace(
      noopCloseMatch[0],
      `createElement(${funcName},{isOpen:!0,onClose:()=>{},`
    );
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
  const cssRe = /(\w+)=\{[^}]*sessionItem:"(sessionItem_\w+)"/;
  const cssMatch = patched.match(cssRe);
  if (!cssMatch) {
    console.log("  Could not find session item CSS module");
    return { patched, count };
  }
  const cssVar = cssMatch[1];
  console.log(`  Session CSS module: ${cssVar}`);

  // Step 2: Find the forwardRef session item render function
  // Unique: the only forwardRef function with {session:VAR,isActive:VAR,...}
  const itemUseIdx = patched.indexOf(`${cssVar}.sessionItem`);
  if (itemUseIdx === -1) {
    console.log(`  Could not find ${cssVar}.sessionItem usage`);
    return { patched, count };
  }

  const searchBack = patched.substring(Math.max(0, itemUseIdx - 6000), itemUseIdx);
  const funcRe = /forwardRef\(function\(\{session:([\w$]+),isActive:([\w$]+),/g;
  const funcMatches = [...searchBack.matchAll(funcRe)];
  if (funcMatches.length === 0) {
    console.log("  Could not find session item forwardRef function");
    return { patched, count };
  }
  const fm = funcMatches[funcMatches.length - 1];
  const sessionVar = fm[1];
  const isActiveVar = fm[2];
  console.log(`  Session item vars: session=${sessionVar}, isActive=${isActiveVar}`);

  // Step 3: Find the React module variable
  const nearButton = patched.substring(Math.max(0, itemUseIdx - 200), itemUseIdx);
  const reactMatch = nearButton.match(/([\w$]+)\.default\.createElement\("button"/);
  if (!reactMatch) {
    console.log("  Could not find React module variable");
    return { patched, count };
  }
  const reactVar = reactMatch[1];
  console.log(`  React module: ${reactVar}`);

  // Step 4: Inject status computation at the beginning of the function body
  // Find: forwardRef(function({session:S,isActive:A,...},REF){FIRSTCALL();
  // Inject after FIRSTCALL();
  const funcSigAnchor = `forwardRef(function({session:${sessionVar},isActive:${isActiveVar},`;
  const funcSigIdx = patched.indexOf(funcSigAnchor);
  if (funcSigIdx === -1) {
    console.log("  Could not find function signature anchor");
    return { patched, count };
  }

  // Match ){WORD(); — the function body opening and first statement
  const bodyOpenRe = /\)\{([\w$]+)\(\);/;
  const afterSig = patched.substring(funcSigIdx, funcSigIdx + 500);
  const bodyOpenMatch = afterSig.match(bodyOpenRe);
  if (!bodyOpenMatch || bodyOpenMatch.index === undefined) {
    console.log("  Could not find function body opening");
    return { patched, count };
  }
  const insertIdx = funcSigIdx + bodyOpenMatch.index + bodyOpenMatch[0].length;

  // Status tracking logic:
  //   - When busy: status = "running", clear from seen set (so it's green when done)
  //   - When pendingInput: status = "waiting"
  //   - When idle + active: add to seen set → "seen" (gray)
  //   - When idle + not active: check seen set → "seen" (gray) or "done" (green)
  const statusCode = [
    `var __cceSt=(window.__cceSeen=window.__cceSeen||new Set(),`,
    `${sessionVar}.busy.value?"running":`,
    `${sessionVar}.pendingInput.value?"waiting":`,
    `(${isActiveVar}?window.__cceSeen.add(${sessionVar}.sessionId.value):void 0,`,
    `window.__cceSeen.has(${sessionVar}.sessionId.value)?"seen":"done"));`,
    `if(${sessionVar}.busy.value||${sessionVar}.pendingInput.value)`,
    `window.__cceSeen.delete(${sessionVar}.sessionId.value);`,
  ].join("");

  patched = patched.substring(0, insertIdx) + statusCode + patched.substring(insertIdx);
  count++;
  console.log(`  Injected status tracking code`);

  // Step 5: Inject the dot element as first child of the session item button
  // Find: onMouseEnter:VAR}, which ends the button props, right before the children
  const btnClassAnchor = `className:\`\${${cssVar}.sessionItem}`;
  const btnClassIdx = patched.indexOf(btnClassAnchor, funcSigIdx);
  if (btnClassIdx === -1) {
    console.log("  Could not find button className anchor");
    return { patched, count };
  }

  const onMouseRe = /onMouse(?:Enter|Move):[\w$]+\},/;
  const afterBtnClass = patched.substring(btnClassIdx, btnClassIdx + 500);
  const onMouseMatch = afterBtnClass.match(onMouseRe);
  if (!onMouseMatch || onMouseMatch.index === undefined) {
    console.log("  Could not find onMouse* end of button props");
    return { patched, count };
  }
  const childrenStart = btnClassIdx + onMouseMatch.index + onMouseMatch[0].length;

  const dotElement =
    `${reactVar}.default.createElement("span",` +
    `{className:"cce-status-dot","data-status":__cceSt}),`;

  patched = patched.substring(0, childrenStart) + dotElement + patched.substring(childrenStart);
  count++;
  console.log(`  Injected status dot element`);

  return { patched, count };
}

// ── Webview CSS patches: sessions sidebar layout ──
function patchWebviewCss(css: string, jsCode: string): { patched: string; count: number } {
  let patched = css;
  let count = 0;

  const cssModuleRe = /(\w+)=\{overlay:"(overlay_\w+)",dropdown:"(dropdown_\w+)"\}/;
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
  const appCssRe = /(\w+)=\{root:"(root_\w+)",editorMode:"(editorMode_\w+)",body:"(body_\w+)",content:"(content_\w+)",sessionBody:"(sessionBody_\w+)"/;
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
    console.log("  Could not find includeSelection state owner pattern");
    return { patched, count };
  }

  const stateVar = ownerMatch[1];
  const setterVar = ownerMatch[2];
  console.log(`  Found includeSelection state owner: [${stateVar},${setterVar}]`);

  // Find the useState call matching BOTH the state var and setter: [VAR,SETTER]=REACT.useState(!0)
  const esc = (v: string) => v.replace(/[$]/g, "\\$");
  const stateRe = new RegExp(
    `\\[${esc(stateVar)},${esc(setterVar)}\\]=[\\w$]+\\.useState\\(!0\\)`
  );
  const stateMatch = patched.match(stateRe);

  if (stateMatch) {
    const original = stateMatch[0];
    const flipped = original.replace(".useState(!0)", ".useState(!1)");
    patched = patched.replace(original, flipped);
    count++;
    console.log(`  Changed ${original} → ${flipped}`);
  } else {
    // Check if already patched
    const alreadyRe = new RegExp(
      `\\[${esc(stateVar)},${esc(setterVar)}\\]=[\\w$]+\\.useState\\(!1\\)`
    );
    if (alreadyRe.test(patched)) {
      console.log("  Already patched: includeSelection default is !1");
    } else {
      console.log("  Could not find useState initializer for [${stateVar},${setterVar}]");
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

  // 1. Patch extension.js (feature flags)
  console.log("\n[extension.js]");
  const extCode = readFileSync(extJsBak, "utf-8");
  const extResult = patchExtensionJs(extCode);
  if (extResult.count > 0) {
    writeFileSync(extJs, extResult.patched, "utf-8");
    totalPatches += extResult.count;
  } else {
    console.log("  No feature flag patches needed.");
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

  console.log("\n[webview/index.js — status dots]");
  const dotsResult = patchSessionStatusDots(wvJsCode);
  wvJsCode = dotsResult.patched;
  wvJsCount += dotsResult.count;

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
