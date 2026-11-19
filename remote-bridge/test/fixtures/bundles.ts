// Synthetic stand-ins for the Claude Code extension's minified bundles, written by hand for the
// patch tests (install.test.ts). They copy only the *shape* of the code the phone remote hooks
// into (2.1.327 and 2.1.220), with different minified names, and some names with `$` in them
// (esbuild emits those) so the anchors' identifier escaping is exercised. Not extension code.
//
// The webview snippets run under `evaluate` with a fake JSX runtime: components return plain
// element trees, so a test can check what a patched component renders.

// ── extension.js: the webview provider (one per window), with its `allComms=new Set` field ──

/** 2.1.327 shape: the provider extends a base class, and the field sits between others. */
export const EXTENSION_327 =
  "var Pv$=class{dispose(){}};var Ur=class{};" +
  "var Kq=class extends Pv$ {extensionUri;context;output;getSelection;disposables=[];allComms=new Set;" +
  "closedSurfaces=new Ur;watchedFiles=new Set;constructor(e,t,n){super();this.extensionUri=e;this.context=t;this.output=n}" +
  "send(e){for(let t of this.allComms)t.send(e)}};";

/** 2.1.220 shape: no base class, `allComms` followed by `webviews` and the session maps. */
export const EXTENSION_220 =
  `var Wd=class{extensionUri;context;output;settings;disposables=[];allComms=new Set;webviews=new Set;` +
  `sessionPanels=new Map;sessionStates=new Map;activeSessionId;constructor(e,t,r,n){this.extensionUri=e;` +
  `this.context=t;this.output=r;this.settings=n}get size(){return this.allComms.size}};`;

/** The provider class each extension snippet defines. */
export const EXTENSION_CLASS = { "327": "Kq", "220": "Wd" } as const;

// ── webview/index.js: the sessions list (Local / Web tabs) and the app's boot ──

/** The 2.1.327 list's CSS modules (and a decoy component), what comes before the list component. */
const HEAD_327 = [
  `var Zt={root:"root_Vb81Lx",header:"header_Vb81Lx"};`,
  `var Hq={root:"root_Zr4Kp1",sessionListOnly:"sessionListOnly_Zr4Kp1",searchRow:"searchRow_Zr4Kp1",` +
    `searchInput:"searchInput_Zr4Kp1",segmented:"segmented_Zr4Kp1",tab:"tab_Zr4Kp1",tabActive:"tabActive_Zr4Kp1",` +
    `tabIcon:"tabIcon_Zr4Kp1",content:"content_Zr4Kp1",sessionsList:"sessionsList_Zr4Kp1",sessionItem:"sessionItem_Zr4Kp1"};`,
  `function Wv({onSubmit:e,onBack:t}){let[n,o]=S$(""),[i,a]=S$("local"),[r,s]=S$("");` +
    `return jx("form",{className:Zt.root,onSubmit:()=>e(n,i,r),children:jx("input",{value:n,onChange:(z)=>o(z.target.value)})})}`,
].join("");

/** The 2.1.327 list's content element: the sessions, or "No web sessions yet" on the Web tab. */
const CONTENT_327 =
  `jx("div",{id:nL,className:\`\${Hq.content} \${n?Hq.sessionListOnly:""}\`,children:T==="remote"?` +
  `jx("div",{children:"No web sessions yet"}):jx("div",{className:Hq.sessionsList,children:e.map((z)=>` +
  `jx("button",{className:Hq.sessionItem,onClick:()=>o(z),children:z.title},z.id))})})`;

/** The 2.1.327 sessions list component `Pk`, with `content` as the last child of its root. */
const list327 = (content: string) =>
  `function Pk({sessions:e,authMethod:t,isSessionListOnly:n,onSelect:o}){bQ();` +
  `let w$=t==="claudeai",[R$,F$]=S$("local"),T=w$?R$:"local",[Q,V]=S$(""),Y=Ta(null);` +
  `return Jx("div",{ref:Y,className:Hq.root,onKeyDown:(z)=>{if(z.key==="Escape")V("")},role:n?"group":void 0,children:[` +
  `w$&&Jx("div",{className:Hq.segmented,children:[` +
  `Jx("button",{className:\`\${Hq.tab} \${T==="local"?Hq.tabActive:""}\`,"aria-pressed":T==="local",title:"Sessions on this Mac [local]",` +
  `onClick:()=>{Y.current=null,F$("local")},children:[jx(Gi,{className:Hq.tabIcon}),"Local"]}),` +
  `Jx("button",{className:\`\${Hq.tab} \${T==="remote"?Hq.tabActive:""}\`,"aria-pressed":T==="remote",` +
  `onClick:()=>{F$("remote")},children:[jx(Gk,{className:Hq.tabIcon}),"Web"]})]}),` +
  `Jx("div",{className:Hq.searchRow,children:[jx("input",{type:"text",value:Q,onChange:(z)=>V(z.target.value),` +
  `placeholder:"Search sessions…",className:Hq.searchInput})]}),` +
  `${content}]})}`;

/** The 2.1.327 boot: the Session Manager's app root and the chat's, both with `sessions:c`. */
const BOOT_327 =
  `function Ex(){let a=Bz(),c=new Mk(a),d=new Lc(a);if(Ow(c),window.IS_SESSION_LIST_ONLY){` +
  `$Q.createRoot(document.querySelector("#root")).render(jx(Xa,{children:jx(Yb,{children:jx(Rl,{sessions:c,context:d,` +
  `sessionStates:a.sessionStates})})}));return}let p=document.querySelector("#root");` +
  `Ux(()=>{}),$Q.createRoot(document.querySelector("#root")).render(jx(Xa,{children:jx(Yb,{onError:Ep,` +
  `children:jx(Pk,{sessions:c,context:d})})}))}`;

/**
 * 2.1.327 shape. The tab state is derived (`T=w$?R$:"local"`), the row is only rendered for
 * claude.ai logins (`w$&&…`), the list content has an `id`, and the list's root has a `ref`
 * before its className. `Wv` is a decoy: another component with a `useState("local")`, like the
 * MCP server form in the real bundle. Both app roots (Session Manager, chat) pass `sessions:c`.
 */
export const WEBVIEW_327 = [HEAD_327, list327(CONTENT_327), BOOT_327].join("");

/**
 * The 2.1.327 shape after a plausible upstream refactor: the list's content moved into a child
 * component, `Pl`, defined after the list, which gets the tab and the sessions as props. The tab
 * state and the row stay in `Pk`, so the content can't see a state declared next to the tab's:
 * a hook there would throw a ReferenceError while rendering (React then drops the whole view).
 */
export const WEBVIEW_327_CHILD = [
  HEAD_327,
  list327(`jx(Pl,{tab:T,listOnly:n,sessions:e,onSelect:o})`),
  `function Pl({tab:T,listOnly:n,sessions:e,onSelect:o}){return Jx("div",{className:Hq.sessionsList,children:[jx("span",{}),` +
    `${CONTENT_327}]})}`,
  BOOT_327,
].join("");

/**
 * The 2.1.327 shape with the tab state moved into a custom hook, `Pj`, defined before the list.
 * The list's setter has the same minified name as the hook's (each function names its own), so
 * the tabs still call the setter of the nearest `useState("local")`: a state added next to it
 * would be declared in `Pj`, where the list can't see it.
 */
export const WEBVIEW_327_HOOK = [
  HEAD_327,
  `function Pj(){let[R$,F$]=S$("local"),u=Ta(null);return[R$,F$]}`,
  list327(CONTENT_327).replace(`[R$,F$]=S$("local"),`, `[R$,F$]=Pj(),`),
  BOOT_327,
].join("");

/**
 * 2.1.220 shape. No derived tab, the tab buttons have no `aria-pressed`, the list content has no
 * `id`, and the root's className comes first. `Vq` is a decoy root of another CSS module.
 */
export const WEBVIEW_220 = [
  `var Ah={root:"root_Hd3Wq0",toolName:"toolName_Hd3Wq0"};`,
  `function Vq({content:e}){return Ye("div",{className:Ah.root,children:[ye("span",{className:Ah.toolName,children:e})]})}`,
  `var cS={root:"root_Qm2Tn8",sessionListOnly:"sessionListOnly_Qm2Tn8",searchRow:"searchRow_Qm2Tn8",` +
    `searchIcon:"searchIcon_Qm2Tn8",searchInput:"searchInput_Qm2Tn8",segmented:"segmented_Qm2Tn8",tab:"tab_Qm2Tn8",` +
    `tabActive:"tabActive_Qm2Tn8",tabIcon:"tabIcon_Qm2Tn8",content:"content_Qm2Tn8",sessionsList:"sessionsList_Qm2Tn8",` +
    `sessionItem:"sessionItem_Qm2Tn8"};`,
  `function Lw({localSessions:e,remoteSessions:i,onSelectSession:l,authMethod:p,isSessionListOnly:v}){Kn();` +
    `let C=p==="claudeai",[y,x]=Rt("local"),[w,S]=Rt(""),He=y==="local"?e:i;` +
    `return Ye("div",{className:cS.root,onKeyDown:(U)=>{if(U.key==="Enter")U.preventDefault()},children:[` +
    `C&&Ye("div",{className:cS.segmented,children:[` +
    `Ye("button",{className:\`\${cS.tab} \${y==="local"?cS.tabActive:""}\`,onClick:()=>x("local"),` +
    `children:[ye(Pq,{className:cS.tabIcon}),"Local"]}),` +
    `Ye("button",{className:\`\${cS.tab} \${y==="remote"?cS.tabActive:""}\`,onClick:()=>x("remote"),` +
    `children:[ye(Aw,{className:cS.tabIcon}),"Web"]})]}),` +
    `Ye("div",{className:cS.searchRow,children:[ye(Om,{className:cS.searchIcon}),ye("input",{type:"text",value:w,` +
    `onChange:(U)=>S(U.target.value),placeholder:"Search sessions…",className:cS.searchInput})]}),` +
    `ye("div",{className:\`\${cS.content} \${v?cS.sessionListOnly:""}\`,children:He.length===0?` +
    `ye("div",{children:"No sessions yet"}):ye("div",{className:cS.sessionsList,children:He.map((U)=>` +
    `ye("button",{className:cS.sessionItem,onClick:()=>l(U),children:U.title},U.id))})})]})}`,
  `function Gt(){let e=Az(),l=void 0,c=new Hd(e);if(l=new Vk(e,c),window.IS_SESSION_LIST_ONLY){` +
    `Nb.createRoot(document.querySelector("#root")).render(ye(Qa,{children:ye(Ib,{children:ye(Rw,{sessions:l,context:c,` +
    `sessionStates:e.sessionStates})})}));return}let d=document.querySelector("#root");` +
    `Gq(()=>{}),Nb.createRoot(document.querySelector("#root")).render(ye(Qa,{children:ye(Ib,{children:ye(Tw,{sessions:l,` +
    `context:c})})}))}`,
].join("");

/** What each webview snippet calls things: the list component, its props, the boot function, helpers. */
export const WEBVIEW_NAMES = {
  "327": { list: "Pk", boot: "Ex", useState: "S$", jsxs: "Jx", jsx: "jx", root: "$Q", css: "Hq", hash: "Zr4Kp1" },
  "220": { list: "Lw", boot: "Gt", useState: "Rt", jsxs: "Ye", jsx: "ye", root: "Nb", css: "cS", hash: "Qm2Tn8" },
} as const;

/** Upstream rules for the sessions list classes (shortened), the CSS the Connection rules go after. */
export const WEBVIEW_CSS = (hash: string) =>
  `.root_${hash}{display:flex;flex-direction:column;flex:1}.searchRow_${hash}{display:flex}` +
  `.segmented_${hash}{display:flex;gap:2px;padding:2px}.tab_${hash}{display:flex;color:var(--app-secondary-foreground)}` +
  `.tab_${hash}.tabActive_${hash}{background:var(--app-menu-background);color:var(--app-primary-foreground)}` +
  `.content_${hash}{overflow-y:auto;user-select:none;flex:1}`;

/** A JSX element as the fake runtime builds it. */
export interface El {
  type: unknown;
  props: Record<string, any>;
  key: unknown;
}

/**
 * Runs a webview snippet with every free name it uses bound from `env` (unknown names throw when
 * reached), and returns the functions named in `exports`.
 */
export function evaluate(code: string, env: Record<string, unknown>, exports: string[]): Record<string, any> {
  // `with` is sloppy-mode only, which is what `new Function` bodies are.
  return new Function("env", `with(env){${code}\nreturn {${exports.join(",")}}}`)(env);
}

/** A JSX runtime that builds `El` trees (the key is the third argument, as with the automatic runtime). */
export const jsx = (type: unknown, props: Record<string, any>, key?: unknown): El => ({ type, props, key: key ?? null });

/** Every element in a tree, depth first (children may be elements, arrays, strings, false…). */
export function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as El;
  return [el, ...elements(el.props.children)];
}
