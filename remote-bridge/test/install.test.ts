import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_RUNTIME,
  REMOTE_DIR,
  installRemoteBridge,
  patchConnectionCss,
  patchExtensionRemote,
  patchWebviewConnection,
  removeRemoteBridge,
  turnChromeAutoAcceptOff,
  turnRemoteAccessOff,
} from "../install.ts";
import {
  EXTENSION_220,
  EXTENSION_327,
  EXTENSION_CLASS,
  WEBVIEW_220,
  WEBVIEW_327,
  WEBVIEW_327_CHILD,
  WEBVIEW_327_HOOK,
  WEBVIEW_CSS,
  WEBVIEW_NAMES,
  elements,
  evaluate,
  jsx,
  type El,
} from "./fixtures/bundles.ts";

/** Collects what a patch function logs instead of printing it. */
function logs() {
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  return { lines, log, text: () => lines.join("\n") };
}

/** Throws a SyntaxError if `code` doesn't parse. */
const parses = (code: string) => new Function(code);

const HOOK = 'require("./cce-remote/bridge.js").attach(p)';

describe("patchExtensionRemote", () => {
  for (const [version, code] of [["327", EXTENSION_327], ["220", EXTENSION_220]] as const) {
    test(`hooks the provider's allComms field (${version} shape)`, () => {
      const { log, text } = logs();
      const { patched, count } = patchExtensionRemote(code, log);
      expect(count).toBe(1);
      expect(patched).toContain(HOOK);
      expect(patched).not.toContain("allComms=new Set;");
      expect(() => parses(patched)).not.toThrow();
      expect(text()).toContain("allComms");
    });

    test(`the provider hands itself to the bridge and still gets its Set (${version} shape)`, () => {
      const { patched } = patchExtensionRemote(code, () => {});
      const required: string[] = [];
      const attached: unknown[] = [];
      const fakeRequire = (id: string) => {
        required.push(id);
        return { attach: (provider: unknown) => attached.push(provider) };
      };
      const Provider = new Function("require", `${patched}\nreturn ${EXTENSION_CLASS[version]};`)(fakeRequire);
      const provider = new Provider("uri", "context", "output", "settings");
      expect(required).toEqual(["./cce-remote/bridge.js"]);
      expect(attached).toEqual([provider]);
      expect(provider.allComms).toBeInstanceOf(Set);
      expect(provider.allComms.size).toBe(0);
    });

    test(`a missing or throwing bridge leaves the provider working (${version} shape)`, () => {
      const { patched } = patchExtensionRemote(code, () => {});
      const errors: unknown[][] = [];
      const fakeConsole = { error: (...args: unknown[]) => errors.push(args) };
      const fakeRequire = () => {
        throw new Error("Cannot find module './cce-remote/bridge.js'");
      };
      const Provider = new Function("require", "console", `${patched}\nreturn ${EXTENSION_CLASS[version]};`)(fakeRequire, fakeConsole);
      const provider = new Provider("uri", "context", "output", "settings");
      expect(provider.allComms).toBeInstanceOf(Set);
      expect(errors).toHaveLength(1);
      expect(errors[0][0]).toBe("[cce-remote]");
    });
  }

  test("a second run changes nothing and says it's already patched", () => {
    const once = patchExtensionRemote(EXTENSION_327, () => {}).patched;
    const { log, text } = logs();
    const { patched, count } = patchExtensionRemote(once, log);
    expect(count).toBe(0);
    expect(patched).toBe(once);
    expect(text()).toContain("Already patched");
  });

  test("no allComms=new Set: unchanged", () => {
    const code = EXTENSION_327.replace("allComms=new Set", "allComms=new WeakSet");
    const { log, text } = logs();
    const { patched, count } = patchExtensionRemote(code, log);
    expect(count).toBe(0);
    expect(patched).toBe(code);
    expect(text()).toMatch(/could not find/i);
  });

  test("two allComms=new Set: unchanged (which one is the provider is unknown)", () => {
    const code = EXTENSION_327 + EXTENSION_220;
    const { log, text } = logs();
    const { patched, count } = patchExtensionRemote(code, log);
    expect(count).toBe(0);
    expect(patched).toBe(code);
    expect(text()).toContain("2");
  });

  test("only the exact field name counts", () => {
    const code = EXTENSION_327.replace("allComms=new Set", "myallComms=new Set") ;
    expect(patchExtensionRemote(code, () => {}).count).toBe(0);
    const setish = EXTENSION_327.replace("allComms=new Set;", "allComms=new SetLike;");
    expect(patchExtensionRemote(setish, () => {}).count).toBe(0);
  });
});

/** Fake hooks for running a patched sessions list: each useState initial value maps to a state. */
function listEnv(version: "327" | "220", state: { tab?: string; conn?: boolean }, calls: unknown[][] = []) {
  const names = WEBVIEW_NAMES[version];
  const useState = (initial: unknown) => {
    if (initial === "local") return [state.tab ?? "local", (v: unknown) => calls.push(["setTab", v])];
    if (initial === false) return [state.conn ?? false, (v: unknown) => calls.push(["setConn", v])];
    return [initial, (v: unknown) => calls.push(["set", initial, v])];
  };
  const mount = () => {};
  return {
    env: {
      [names.useState]: useState,
      [names.jsxs]: jsx,
      [names.jsx]: jsx,
      bQ: () => {},
      Kn: () => {},
      Ta: (v: unknown) => ({ current: v }),
      Gi: "LocalIcon",
      Gk: "WebIcon",
      Pq: "LocalIcon",
      Aw: "WebIcon",
      Om: "SearchIcon",
      nL: "sessions-list",
      window: { __cceRemote: { mount } },
    },
    mount,
  };
}

function renderList(version: "327" | "220", code: string, state: { tab?: string; conn?: boolean }, authMethod: string, calls?: unknown[][]) {
  const names = WEBVIEW_NAMES[version];
  const { env, mount } = listEnv(version, state, calls);
  const { [names.list]: List } = evaluate(code, env, [names.list]);
  const props = version === "327"
    ? { sessions: [{ id: "s1", title: "First" }], authMethod, isSessionListOnly: false, onSelect: () => {} }
    : { localSessions: [{ id: "s1", title: "First" }], remoteSessions: [], authMethod, isSessionListOnly: false, onSelectSession: () => {} };
  const tree: El = List(props);
  return { tree, all: elements(tree), mount };
}

/** A patched bundle without the runtime and the attach hooks: what the tab's hooks changed. */
const withoutAttach = (patched: string) =>
  patched
    .slice(CONNECTION_RUNTIME.length)
    .replaceAll(/\(window\.__cceRemote&&window\.__cceRemote\.attach\([\w$]+\),([\w$]+)\)\.createRoot\(/g, "$1.createRoot(");

const classOf = (el: El) => String(el.props.className ?? "");
const hasClass = (el: El, name: string) => classOf(el).split(/\s+/).includes(name);

describe("patchWebviewConnection", () => {
  for (const [version, code] of [["327", WEBVIEW_327], ["220", WEBVIEW_220]] as const) {
    const names = WEBVIEW_NAMES[version];
    const css = (k: string) => `${k}_${names.hash}`;

    test(`hooks both app roots and adds the tab (${version} shape)`, () => {
      const { log, text } = logs();
      const { patched, count, checks } = patchWebviewConnection(code, log);
      expect(checks).toEqual({ attach: true, tab: true });
      expect(count).toBeGreaterThan(0);
      expect(() => parses(patched)).not.toThrow();
      expect(patched).toContain('"Connection"');
      expect(patched).toContain("__cceConn");
      expect(patched).toContain("cce-no-web");
      expect(patched.split("window.__cceRemote.attach(").length - 1).toBe(2);
      expect(patched).toContain(CONNECTION_RUNTIME);
      expect(text()).toMatch(/Connection tab/);
    });

    test(`the runtime comes first, so it exists when the app boots (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      expect(patched.startsWith(CONNECTION_RUNTIME)).toBe(true);
    });

    test(`both app roots hand their sessions to the runtime (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      for (const listOnly of [false, true]) {
        const attached: unknown[] = [];
        const roots: unknown[] = [];
        const env = {
          window: { __cceRemote: { attach: (s: unknown) => attached.push(s) }, IS_SESSION_LIST_ONLY: listOnly },
          document: { querySelector: () => "#root element" },
          [names.root]: { createRoot: (el: unknown) => ({ render: (tree: unknown) => roots.push([el, tree]) }) },
          [names.jsx]: jsx,
          Bz: () => ({ sessionStates: [] }),
          Az: () => ({ sessionStates: [] }),
          Mk: function Mk(this: any) { this.kind = "sessions"; },
          Vk: function Vk(this: any) { this.kind = "sessions"; },
          Lc: function Lc() {},
          Hd: function Hd() {},
          Ow: () => {},
          Ux: () => {},
          Gq: () => {},
          Ep: () => {},
          Xa: "Xa", Yb: "Yb", Rl: "Rl", Pk: "Pk", Qa: "Qa", Ib: "Ib", Rw: "Rw", Tw: "Tw",
        };
        const { [names.boot]: boot } = evaluate(patched.slice(CONNECTION_RUNTIME.length), env, [names.boot]);
        boot();
        expect(roots).toHaveLength(1);
        expect(attached).toHaveLength(1);
        expect((attached[0] as any).kind).toBe("sessions");
        // The very sessions object the app renders with.
        const rendered = elements((roots[0] as any)[1]).find((el) => el.props.sessions);
        expect(rendered?.props.sessions).toBe(attached[0]);
      }
    });

    test(`the tab row shows Local, Web and Connection (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      const { all } = renderList(version, patched, {}, "claudeai");
      const row = all.find((el) => classOf(el).startsWith(css("segmented")))!;
      expect(row).toBeDefined();
      expect(hasClass(row, "cce-no-web")).toBe(false);
      expect(hasClass(row, "cce-conn-on")).toBe(false);
      const tabs = (row.props.children as El[]).filter(Boolean);
      expect(tabs.map((t) => elements(t).flatMap((e) => [e.props.children].flat()).filter((c) => typeof c === "string"))).toEqual([
        ["Local"],
        ["Web"],
        ["Connection"],
      ]);
      const conn = tabs[2];
      expect(hasClass(conn, css("tab"))).toBe(true);
      expect(hasClass(conn, "cce-conn-tab")).toBe(true);
      expect(hasClass(conn, css("tabActive"))).toBe(false);
      expect(conn.props["aria-pressed"]).toBe(false);
      // The list is shown, with its own content element and no Connection classes.
      const content = all.find((el) => classOf(el).startsWith(css("content")))!;
      expect(hasClass(content, "cce-conn")).toBe(false);
      expect(all.some((el) => hasClass(el, css("sessionItem")))).toBe(true);
      const root = all.find((el) => hasClass(el, css("root")))!;
      expect(hasClass(root, "cce-conn-root")).toBe(false);
    });

    test(`other logins get the row too, without the Web tab (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      const { all } = renderList(version, patched, {}, "apiKey");
      const row = all.find((el) => classOf(el).startsWith(css("segmented")))!;
      expect(row).toBeDefined();
      expect(hasClass(row, "cce-no-web")).toBe(true);
      // Upstream hid the whole row; the original code still does.
      const original = renderList(version, code, {}, "apiKey");
      expect(original.all.some((el) => classOf(el).startsWith(css("segmented")))).toBe(false);
    });

    test(`clicking Connection opens it; clicking Local or Web closes it (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      const calls: unknown[][] = [];
      const { all } = renderList(version, patched, {}, "claudeai", calls);
      const row = all.find((el) => classOf(el).startsWith(css("segmented")))!;
      const [local, , conn] = (row.props.children as El[]).filter(Boolean);
      conn.props.onClick();
      expect(calls).toEqual([["setConn", true]]);

      // The row's capture handler: a click on another tab (or its icon) closes Connection…
      const target = (inConnTab: boolean, isButton = true) => ({
        closest: (sel: string) => (sel === ".cce-conn-tab" ? (inConnTab ? {} : null) : sel === "button" && isButton ? {} : null),
      });
      calls.length = 0;
      row.props.onClickCapture({ target: target(false) });
      expect(calls).toEqual([["setConn", false]]);
      // …a click on the Connection tab or on the row's empty space doesn't.
      calls.length = 0;
      row.props.onClickCapture({ target: target(true) });
      row.props.onClickCapture({ target: target(false, false) });
      row.props.onClickCapture({ target: null });
      expect(calls).toEqual([]);
      // The tabs' own handlers are untouched.
      local.props.onClick();
      expect(calls).toEqual([["setTab", "local"]]);
    });

    test(`with Connection open the content is the runtime's element (${version} shape)`, () => {
      const { patched } = patchWebviewConnection(code, () => {});
      const { all, mount } = renderList(version, patched, { conn: true }, "claudeai");
      const row = all.find((el) => classOf(el).startsWith(css("segmented")))!;
      expect(hasClass(row, "cce-conn-on")).toBe(true);
      const conn = (row.props.children as El[]).filter(Boolean)[2];
      expect(hasClass(conn, css("tabActive"))).toBe(true);
      expect(conn.props["aria-pressed"]).toBe(true);
      const view = all.find((el) => hasClass(el, "cce-conn"))!;
      expect(view).toBeDefined();
      expect(hasClass(view, css("content"))).toBe(true);
      expect(view.props.ref).toBe(mount);
      expect(view.props.children).toBeUndefined();
      // Keyed, so React mounts a fresh element instead of reusing the list's.
      expect(view.key).toBe("cce-conn");
      expect(all.some((el) => hasClass(el, css("sessionItem")))).toBe(false);
      const root = all.find((el) => hasClass(el, css("root")))!;
      expect(hasClass(root, "cce-conn-root")).toBe(true);
    });

    test(`where the Connection state isn't declared, what the tab adds reads as closed and never throws (${version} shape)`, () => {
      // The second safety net behind the scope check: a read of an undeclared name throws while
      // rendering, and React then drops the whole view.
      const { patched } = patchWebviewConnection(code, () => {});
      const undeclared = patched.replace(`[__cceConn,__cceSetConn]=${names.useState}(!1),`, "");
      expect(undeclared).not.toBe(patched);
      expect(undeclared).not.toContain("[__cceConn,__cceSetConn]=");
      const calls: unknown[][] = [];
      const { all } = renderList(version, undeclared, {}, "claudeai", calls);
      const row = all.find((el) => classOf(el).startsWith(css("segmented")))!;
      expect(hasClass(row, "cce-conn-on")).toBe(false);
      const conn = (row.props.children as El[]).filter(Boolean)[2];
      expect(hasClass(conn, css("tabActive"))).toBe(false);
      expect(conn.props["aria-pressed"]).toBe(false);
      expect(() => conn.props.onClick()).not.toThrow();
      const otherTab = { closest: (sel: string) => (sel === "button" ? {} : null) };
      expect(() => row.props.onClickCapture({ target: otherTab })).not.toThrow();
      expect(calls).toEqual([]);
      // The list is shown, as without the patch.
      expect(all.some((el) => hasClass(el, "cce-conn"))).toBe(false);
      expect(all.some((el) => hasClass(el, css("sessionItem")))).toBe(true);
      expect(hasClass(all.find((el) => hasClass(el, css("root")))!, "cce-conn-root")).toBe(false);
    });

    test(`without the list content nothing of the tab is added (${version} shape)`, () => {
      const broken = code.replace(`className:\`\${${names.css}.content} `, `className:\`\${${names.css}.list} `);
      expect(broken).not.toBe(code);
      const { log, text } = logs();
      const { patched, checks } = patchWebviewConnection(broken, log);
      expect(checks).toEqual({ attach: true, tab: false });
      expect(() => parses(patched)).not.toThrow();
      expect(patched).not.toContain("__cceConn");
      expect(patched).not.toContain("cce-no-web");
      expect(patched).not.toContain('"Connection"');
      // Only the attach hooks and the runtime differ.
      expect(withoutAttach(patched)).toBe(broken);
      expect(text()).toMatch(/content/);
    });

    test(`a bundle without any anchor is left alone (${version} shape)`, () => {
      const bare = code
        .replaceAll('document.querySelector("#root")', 'document.getElementById("root")')
        .replace(`${names.css}.segmented`, `${names.css}.tabs`);
      const { log, text } = logs();
      const { patched, count, checks } = patchWebviewConnection(bare, log);
      expect(checks).toEqual({ attach: false, tab: false });
      expect(count).toBe(0);
      expect(patched).toBe(bare);
      expect(text()).toMatch(/could not/i);
    });

    test(`a second run changes nothing (${version} shape)`, () => {
      const once = patchWebviewConnection(code, () => {}).patched;
      const { log, text } = logs();
      const again = patchWebviewConnection(once, log);
      expect(again.patched).toBe(once);
      expect(again.count).toBe(0);
      expect(again.checks).toEqual({ attach: true, tab: true });
      expect(text()).toContain("Already patched");
    });
  }

  test("picks the sessions list's tab state, not another component's useState(\"local\")", () => {
    const { patched } = patchWebviewConnection(WEBVIEW_327, () => {});
    expect(patched).toContain('[i,a]=S$("local"),[r,s]');
    expect(patched).toContain('[R$,F$]=S$("local"),[__cceConn,__cceSetConn]=S$(!1),T=w$?R$:"local"');
  });

  test("picks the state whose setter the tabs call, even when another \"local\" state is nearer", () => {
    const code = WEBVIEW_327.replace('T=w$?R$:"local",', 'T=w$?R$:"local",[Lq,Mq]=S$("local"),');
    expect(code).not.toBe(WEBVIEW_327);
    const { patched, checks } = patchWebviewConnection(code, () => {});
    expect(checks.tab).toBe(true);
    expect(patched).toContain('[R$,F$]=S$("local"),[__cceConn,__cceSetConn]=S$(!1),');
    expect(patched).toContain('[Lq,Mq]=S$("local"),[Q,V]');
  });

  test("two tab rows: ambiguous, the tab isn't added", () => {
    const list = WEBVIEW_327.match(/function Pk\(.*?(?=function Ex\()/)![0];
    const twice = WEBVIEW_327.replace(list, list + list.replace("function Pk(", "function Pk2("));
    const { checks, patched } = patchWebviewConnection(twice, () => {});
    expect(checks.tab).toBe(false);
    expect(patched).not.toContain("__cceConn");
  });

  test("a root not preceded by { , ; or ) is not hooked (it could change what the code means), and the check fails", () => {
    const code = WEBVIEW_327.replace('Ux(()=>{}),$Q.createRoot(', "Ux(()=>{});\n$Q.createRoot(");
    const { log, text } = logs();
    const { patched, checks } = patchWebviewConnection(code, log);
    // The chat's root can't reach the bridge: the Connection tab there would say so.
    expect(checks).toEqual({ attach: false, tab: true });
    expect(patched.split("window.__cceRemote.attach(").length - 1).toBe(1);
    expect(() => parses(patched)).not.toThrow();
    expect(text()).toMatch(/1 of 2 app roots/);
  });

  test("a root without a sessions prop fails the check, the other root is still hooked", () => {
    const code = WEBVIEW_327.replace("jx(Rl,{sessions:c,context:d,", "jx(Rl,{context:d,");
    expect(code).not.toBe(WEBVIEW_327);
    const { log, text } = logs();
    const { patched, checks } = patchWebviewConnection(code, log);
    expect(checks).toEqual({ attach: false, tab: true });
    expect(patched.split("window.__cceRemote.attach(").length - 1).toBe(1);
    expect(() => parses(patched)).not.toThrow();
    expect(text()).toMatch(/1 of 2 app roots/);
  });

  test("a second run of a partly hooked bundle still fails the check", () => {
    const once = patchWebviewConnection(WEBVIEW_327.replace("jx(Rl,{sessions:c,context:d,", "jx(Rl,{context:d,"), () => {}).patched;
    const again = patchWebviewConnection(once, () => {});
    expect(again.patched).toBe(once);
    expect(again.checks).toEqual({ attach: false, tab: true });
  });

  test("the list's content in a child component: the tab isn't added, the child still renders", () => {
    // The reviewer's shape: a hook into the content would read the Connection state in `Pl`,
    // where it isn't declared, and the ReferenceError would take the whole view down.
    const { log, text } = logs();
    const { patched, checks } = patchWebviewConnection(WEBVIEW_327_CHILD, log);
    expect(checks).toEqual({ attach: true, tab: false });
    expect(() => parses(patched)).not.toThrow();
    expect(patched).not.toContain("__cceConn");
    expect(patched).not.toContain('"Connection"');
    expect(withoutAttach(patched)).toBe(WEBVIEW_327_CHILD);
    expect(text()).toMatch(/list content in the tab state's function/);
    // Rendered as React would: the list, then its child.
    const { env } = listEnv("327", {});
    const { Pk, Pl } = evaluate(patched.slice(CONNECTION_RUNTIME.length), env, ["Pk", "Pl"]);
    const tree = Pk({ sessions: [{ id: "s1", title: "First" }], authMethod: "claudeai", isSessionListOnly: false, onSelect: () => {} });
    const child = elements(tree).find((el) => el.type === Pl)!;
    expect(child).toBeDefined();
    const items = elements(Pl(child.props)).filter((el) => hasClass(el, "sessionItem_Zr4Kp1"));
    expect(items).toHaveLength(1);
  });

  test("the tab state in a custom hook: the tab isn't added (the list can't see a state declared there)", () => {
    const { log, text } = logs();
    const { patched, checks } = patchWebviewConnection(WEBVIEW_327_HOOK, log);
    expect(checks).toEqual({ attach: true, tab: false });
    expect(() => parses(patched)).not.toThrow();
    expect(patched).not.toContain("__cceConn");
    expect(withoutAttach(patched)).toBe(WEBVIEW_327_HOOK);
    expect(text()).toMatch(/in the tab state's function/);
  });

  test("a list root outside the tab state's function: the tab isn't added", () => {
    // The list's root loses its class to a wrapper component defined right before the list.
    const code = WEBVIEW_327.replace("className:Hq.root,onKeyDown:", "onKeyDown:").replace(
      "function Pk(",
      'function Pw({children:c}){return jx("div",{className:Hq.root,children:c})}function Pk(',
    );
    expect(code.split("className:Hq.root,").length - 1).toBe(1);
    expect(code).toContain("function Pw(");
    const { log, text } = logs();
    const { patched, checks } = patchWebviewConnection(code, log);
    expect(checks).toEqual({ attach: true, tab: false });
    expect(patched).not.toContain("__cceConn");
    expect(withoutAttach(patched)).toBe(code);
    expect(text()).toMatch(/sessions list root in the tab state's function/);
  });

  test("regular expressions, comments and divisions in the list don't hide where its function ends", () => {
    const code = WEBVIEW_327.replace('T=w$?R$:"local",', 'T=w$?R$:"local"/* ) ] } " \' ` */,')
      .replace('[Q,V]=S$(""),', '[Q,V]=S$(""),q$=/[\\]"\'(){}`]/g,d$=e.length/2/1,')
      .replace('onKeyDown:(z)=>{if(z.key==="Escape")V("")}', 'onKeyDown:(z)=>{if(z.key==="Escape"){V("")}/[(]/.test("")}')
      .replace('"Web"]})]}),', '"Web"]})]}),// ) ] } "\n');
    expect(code.length).toBeGreaterThan(WEBVIEW_327.length + 60);
    expect(() => parses(code)).not.toThrow();
    const { patched, checks } = patchWebviewConnection(code, () => {});
    expect(checks).toEqual({ attach: true, tab: true });
    expect(() => parses(patched)).not.toThrow();
    for (const conn of [false, true]) {
      const { all } = renderList("327", patched.slice(CONNECTION_RUNTIME.length), { conn }, "claudeai");
      expect(all.some((el) => hasClass(el, "cce-conn"))).toBe(conn);
    }
  });

  test("a row whose array can't be closed is not touched", () => {
    // The row's array meets a `)` where its `]` should be.
    const code = WEBVIEW_327.replace('"Web"]})]})', '"Web"]}))})');
    expect(code).not.toBe(WEBVIEW_327);
    const { checks, patched } = patchWebviewConnection(code, () => {});
    expect(checks.tab).toBe(false);
    expect(patched).not.toContain("__cceConn");
  });

  test("brackets inside strings and template literals don't confuse the row's array", () => {
    // The fixture's Local tab has `title:"Sessions on this Mac [local]"` and template literals.
    const { patched } = patchWebviewConnection(WEBVIEW_327, () => {});
    expect(patched).toMatch(/"Web"\]\}\),Jx\("button",\{className:`\$\{Hq\.tab\} cce-conn-tab /);
  });
});

describe("patchConnectionCss", () => {
  test("styles the tab row and the view with the bundle's own class names", () => {
    const { hash } = WEBVIEW_NAMES["327"];
    const css = WEBVIEW_CSS(hash);
    const { log } = logs();
    const { patched, count } = patchConnectionCss(css, WEBVIEW_327, log);
    expect(count).toBe(1);
    expect(patched.startsWith(css)).toBe(true);
    const added = patched.slice(css.length);
    expect(added).toContain(`.cce-conn-on>.tab_${hash}.tabActive_${hash}:not(.cce-conn-tab){`);
    expect(added).toContain(`.cce-no-web>.tab_${hash}:nth-child(2){display:none}`);
    expect(added).toContain(`.cce-conn-root>.searchRow_${hash}{display:none}`);
    for (const cls of ["cce-conn", "cce-conn-view", "cce-conn-primary", "cce-conn-qr", "cce-conn-input", "cce-conn-notice", "cce-conn-device"]) {
      expect(added).toContain(`.${cls}`);
    }
    // Theme colours come from VS Code's tokens only.
    const vars = [...added.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(10);
    expect(vars.filter((v) => !v.startsWith("--vscode-"))).toEqual([]);
    expect(added).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    // Balanced braces: every rule is closed.
    expect(added.split("{").length).toBe(added.split("}").length);
  });

  test("2.1.220 class names", () => {
    const { hash } = WEBVIEW_NAMES["220"];
    const { patched } = patchConnectionCss("", WEBVIEW_220, () => {});
    expect(patched).toContain(`.cce-conn-root>.searchRow_${hash}{display:none}`);
    expect(patched).toContain(`.cce-no-web>.tab_${hash}:nth-child(2)`);
  });

  test("without the sessions list classes only the view styles go in", () => {
    const { log, text } = logs();
    const { patched, count } = patchConnectionCss(".a{b:c}", "var x={};", log);
    expect(count).toBe(1);
    expect(patched).toContain(".cce-conn-view");
    expect(patched).not.toContain("cce-conn-on>");
    expect(text()).toMatch(/could not find/i);
  });
});

describe("installRemoteBridge / removeRemoteBridge", () => {
  let dir: string;
  let src: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cce-remote-install-"));
    src = join(dir, "remote-bridge");
    const files: Record<string, string> = {
      "bridge.js": "'use strict';\nexports.attach = () => {};\n",
      "lib/a.js": "'use strict';\n",
      "lib/vendor/b.js": "'use strict';\n",
      "lib/vendor/LICENSE": "MIT\n",
      "lib/notes.md": "not code\n",
      LICENSE: "MIT\n",
      "NOTICE.txt": "QR encoder: MIT\n",
      "install.ts": "export {};\n",
      "webview-runtime.js": "(function(){})();\n",
      "test/a.test.ts": "\n",
      "test/helper.js": "\n",
      "README.md": "\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(src, path, ".."), { recursive: true });
      writeFileSync(join(src, path), text);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Every file under `root`, as sorted relative paths. */
  const listed = (root: string, rel = ""): string[] =>
    readdirSync(join(root, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? listed(root, join(rel, e.name)) : [join(rel, e.name)]))
      .sort();

  test("copies bridge.js, lib/**/*.js and the licence files, nothing else", () => {
    const ext = join(dir, "ext-a");
    mkdirSync(ext);
    const count = installRemoteBridge(ext, src);
    expect(REMOTE_DIR).toBe("cce-remote");
    expect(listed(join(ext, REMOTE_DIR))).toEqual([
      "LICENSE",
      "NOTICE.txt",
      "bridge.js",
      "lib/a.js",
      "lib/vendor/LICENSE",
      "lib/vendor/b.js",
    ]);
    expect(count).toBe(6);
  });

  test("removes stale files first", () => {
    const ext = join(dir, "ext-b");
    mkdirSync(join(ext, REMOTE_DIR, "lib"), { recursive: true });
    writeFileSync(join(ext, REMOTE_DIR, "lib", "old.js"), "stale\n");
    installRemoteBridge(ext, src);
    expect(existsSync(join(ext, REMOTE_DIR, "lib", "old.js"))).toBe(false);
    expect(existsSync(join(ext, REMOTE_DIR, "bridge.js"))).toBe(true);
  });

  test("no bridge.js in the source: nothing installed, an old copy removed", () => {
    const ext = join(dir, "ext-c");
    const empty = join(dir, "empty-src");
    mkdirSync(join(empty, "lib"), { recursive: true });
    writeFileSync(join(empty, "lib", "a.js"), "\n");
    mkdirSync(join(ext, REMOTE_DIR), { recursive: true });
    writeFileSync(join(ext, REMOTE_DIR, "bridge.js"), "old\n");
    expect(installRemoteBridge(ext, empty)).toBe(0);
    expect(existsSync(join(ext, REMOTE_DIR))).toBe(false);
  });

  test("symlinks in the source are not followed", () => {
    const linked = join(dir, "linked-src");
    mkdirSync(join(linked, "lib"), { recursive: true });
    writeFileSync(join(linked, "bridge.js"), "\n");
    symlinkSync(join(src, "lib", "a.js"), join(linked, "lib", "link.js"));
    const ext = join(dir, "ext-d");
    mkdirSync(ext);
    expect(installRemoteBridge(ext, linked)).toBe(1);
    expect(listed(join(ext, REMOTE_DIR))).toEqual(["bridge.js"]);
  });

  test("removeRemoteBridge deletes the folder, and says whether there was one", () => {
    const ext = join(dir, "ext-e");
    mkdirSync(ext);
    installRemoteBridge(ext, src);
    expect(removeRemoteBridge(ext)).toBe(true);
    expect(existsSync(join(ext, REMOTE_DIR))).toBe(false);
    expect(removeRemoteBridge(ext)).toBe(false);
  });
});

describe("turnRemoteAccessOff (--revert)", () => {
  const FAKE_CLI = join(import.meta.dir, "fixtures", "fake-tailscale.sh");
  // A call that forgot its env lands here, never in ~/.cce-remote or at a real Tailscale CLI.
  const GUARDED = ["CCE_REMOTE_HOME", "CCE_REMOTE_PORT", "CCE_REMOTE_TAILSCALE"] as const;
  const outer: Record<string, string | undefined> = {};
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cce-remote-revert-"));
    for (const key of GUARDED) outer[key] = process.env[key];
    process.env.CCE_REMOTE_HOME = join(root, "guard-home");
    delete process.env.CCE_REMOTE_PORT;
    process.env.CCE_REMOTE_TAILSCALE = join(root, "no-tailscale");
  });
  afterAll(() => {
    for (const key of GUARDED) {
      if (outer[key] === undefined) delete process.env[key];
      else process.env[key] = outer[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const SECRET = "ab".repeat(32);
  const ON = {
    version: 1,
    enabled: true,
    port: 47821,
    secret: SECRET,
    appUrl: "https://cce-remote.example.com",
    devices: [{ id: "a1b2c3d4e5f60718", name: "iPhone", tokenHash: "00".repeat(32), origin: "https://cce-remote.example.com", createdAt: 1, lastSeenAt: 2 }],
  };

  let cases = 0;
  /** A state dir (with `state`, when given) and a fake Tailscale serving `served`. */
  function setup(state?: object | string, { mode = "ok", served = [] as number[], port }: { mode?: string; served?: number[]; port?: string } = {}) {
    const dir = join(root, `case-${++cases}`);
    const home = join(dir, "home");
    const tsState = join(dir, "tailscale");
    mkdirSync(tsState, { recursive: true });
    if (state !== undefined) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(join(home, "state.json"), typeof state === "string" ? state : JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    }
    for (const p of served) writeFileSync(join(tsState, `serve-${p}`), `http://127.0.0.1:${p}`);
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      CCE_REMOTE_HOME: home,
      CCE_REMOTE_TAILSCALE: FAKE_CLI,
      FAKE_TS_STATE_DIR: tsState,
      FAKE_TS_MODE: mode,
      ...(port ? { CCE_REMOTE_PORT: port } : {}),
    };
    const file = join(home, "state.json");
    return {
      env,
      home,
      file,
      state: () => JSON.parse(readFileSync(file, "utf8")),
      calls: () => (existsSync(join(tsState, "calls")) ? readFileSync(join(tsState, "calls"), "utf8").trim().split("\n") : []),
      served: (p: number) => existsSync(join(tsState, `serve-${p}`)),
    };
  }

  test("remote access on: turned off in the state file, and serve turned off", async () => {
    const t = setup(ON, { served: [47821] });
    const { log, text } = logs();
    const result = await turnRemoteAccessOff(log, { env: t.env });
    expect(result).toEqual({ wasOn: true, serveOff: true });
    // Only `enabled` changes: the pairings, the secret and the app address stay for a later patch.
    expect(t.state()).toEqual({ ...ON, enabled: false });
    expect(t.served(47821)).toBe(false);
    expect(t.calls()).toContain("serve --https=47821 off");
    expect(text()).toMatch(/turned it off/i);
    expect(text()).toMatch(/serve.*47821.*off|off.*serve.*47821/i);
  });

  test("the Claude in Chrome switch on: turned off, everything else kept, remote access and Tailscale left alone", () => {
    const t = setup({ ...ON, enabled: false, chromeAutoAccept: true }, { served: [47821] });
    const { log, text } = logs();
    expect(turnChromeAutoAcceptOff(log, { env: t.env })).toBe(true);
    expect(t.state()).toEqual({ ...ON, enabled: false, chromeAutoAccept: false });
    expect(t.calls()).toEqual([]);
    expect(text()).toContain("Claude in Chrome auto-accept was on: turned it off");
  });

  test("the switch off, a file that isn't JSON, or no state file: nothing is written", () => {
    for (const state of [{ ...ON, chromeAutoAccept: false }, ON, { ...ON, chromeAutoAccept: "yes" }, "{ not json"]) {
      const t = setup(state);
      const before = readFileSync(t.file, "utf8");
      const { log, text } = logs();
      expect(turnChromeAutoAcceptOff(log, { env: t.env })).toBe(false);
      expect(readFileSync(t.file, "utf8")).toBe(before);
      expect(text()).toContain("Claude in Chrome auto-accept is off");
    }
    const none = setup();
    expect(turnChromeAutoAcceptOff(logs().log, { env: none.env })).toBe(false);
    expect(existsSync(none.home)).toBe(false);
  });

  test("serve already off: still reported as off", async () => {
    const t = setup(ON);
    const { log } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: true, serveOff: true });
    expect(t.state().enabled).toBe(false);
  });

  test("remote access off: nothing changes and Tailscale isn't asked", async () => {
    const t = setup({ ...ON, enabled: false }, { served: [47821] });
    const before = readFileSync(t.file, "utf8");
    const { log, text } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: false, serveOff: null });
    expect(readFileSync(t.file, "utf8")).toBe(before);
    expect(t.calls()).toEqual([]);
    expect(text()).toMatch(/off/);
  });

  test("no state file: nothing is created and Tailscale isn't asked", async () => {
    const t = setup();
    const { log } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: false, serveOff: null });
    expect(existsSync(t.home)).toBe(false);
    expect(t.calls()).toEqual([]);
  });

  test("a state file that isn't JSON is left as it is", async () => {
    const t = setup("{ not json");
    const { log } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: false, serveOff: null });
    expect(readFileSync(t.file, "utf8")).toBe("{ not json");
    expect(readdirSync(t.home)).toEqual(["state.json"]);
    expect(t.calls()).toEqual([]);
  });

  test("serve can't be turned off: remote access is still off, and the command to run is printed", async () => {
    const t = setup(ON, { mode: "fail", served: [47821] });
    const { log, text } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: true, serveOff: false });
    expect(t.state().enabled).toBe(false);
    expect(text()).toContain("tailscale serve --https=47821 off");
    expect(text()).toMatch(/is Tailscale running/);
  });

  test("the port is the state's, or CCE_REMOTE_PORT's", async () => {
    const a = setup({ ...ON, port: 50123 }, { served: [50123] });
    await turnRemoteAccessOff(() => {}, { env: a.env });
    expect(a.calls()).toContain("serve --https=50123 off");
    expect(a.served(50123)).toBe(false);
    const b = setup({ ...ON, port: 50123 }, { served: [50999], port: "50999" });
    await turnRemoteAccessOff(() => {}, { env: b.env });
    expect(b.calls()).toContain("serve --https=50999 off");
    expect(b.served(50999)).toBe(false);
  });

  test("a Tailscale that doesn't answer is given up on after the time limit", async () => {
    const t = setup(ON);
    const { log, text } = logs();
    const hanging = { serveOff: () => new Promise<{ ok: boolean; error?: string }>(() => {}) };
    const started = Date.now();
    expect(await turnRemoteAccessOff(log, { env: t.env, tailscale: hanging, timeoutMs: 50 })).toEqual({ wasOn: true, serveOff: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.state().enabled).toBe(false);
    expect(text()).toContain("tailscale serve --https=47821 off");
  });

  test("no Tailscale CLI: remote access is still off, and the command to run is printed", async () => {
    const t = setup(ON);
    t.env.CCE_REMOTE_TAILSCALE = join(root, "missing", "tailscale");
    const { log, text } = logs();
    expect(await turnRemoteAccessOff(log, { env: t.env })).toEqual({ wasOn: true, serveOff: false });
    expect(t.state().enabled).toBe(false);
    expect(text()).toContain("tailscale serve --https=47821 off");
  });
});
