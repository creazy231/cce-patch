import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { h, options, render } from "preact";
import type { SlashCommand } from "../src/lib/protocol";
import type { AppState, CommandsEntry, Store } from "../src/state/store";

// The list and the message field rendered by Preact into a jsdom document (Preact creates elements through the
// global document; the field needs to be in the document to take the focus).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
const previous = { window: g.window, document: g.document, raf: options.requestAnimationFrame };
let SlashCommands: typeof import("../src/components/SlashCommands").SlashCommands;
let Composer: typeof import("../src/components/Composer").Composer;
let AppContext: typeof import("../src/components/ui").AppContext;

beforeAll(async () => {
  g.window = dom.window;
  g.document = dom.window.document;
  // Effects run after the next frame, as in a browser (jsdom has no requestAnimationFrame).
  options.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
  ({ SlashCommands } = await import("../src/components/SlashCommands"));
  ({ Composer } = await import("../src/components/Composer"));
  ({ AppContext } = await import("../src/components/ui"));
});

afterAll(() => {
  g.window = previous.window;
  g.document = previous.document;
  options.requestAnimationFrame = previous.raf;
  dom.window.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const ready = (list: SlashCommand[]): CommandsEntry => ({ status: "ready", list, at: 1 });
const REVIEW: SlashCommand = { name: "review", argumentHint: "[pr]", description: "Review a pull request" };
const COMPACT: SlashCommand = { name: "compact", description: "Compact the conversation" };

describe("SlashCommands", () => {
  let ran: SlashCommand[];
  let inserted: SlashCommand[];
  let retries: number;

  beforeEach(() => {
    ran = [];
    inserted = [];
    retries = 0;
  });

  function list(props: Partial<Parameters<typeof SlashCommands>[0]> = {}): Element {
    const box = dom.window.document.createElement("div");
    const items = props.items ?? [COMPACT, REVIEW];
    render(
      h(SlashCommands, {
        id: "cmds",
        entry: ready(items),
        items,
        highlighted: -1,
        disabled: false,
        onRun: (c) => ran.push(c),
        onInsert: (c) => inserted.push(c),
        onRetry: () => retries++,
        ...props,
      }),
      box,
    );
    return box;
  }
  const rows = (box: Element) => [...box.querySelectorAll('[role="option"]')];

  test("rows show /name, the argument hint, the description and the plugin", () => {
    const deploy = { name: "ops:deploy", argumentHint: "[env]", description: "Ship it", plugin: "ops" };
    const text = rows(list({ items: [deploy] }))[0]!.textContent ?? "";
    for (const part of ["/ops:deploy", "[env]", "Ship it", "ops"]) expect(text).toContain(part);
  });

  test("tapping a row runs it", () => {
    (rows(list())[0] as HTMLElement).click();
    expect(ran).toEqual([COMPACT]);
  });

  test("rows keep the field's focus", () => {
    const row = rows(list())[0]!;
    for (const type of ["mousedown", "pointerdown"]) {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      row.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  test("only rows with an argument hint have the insert button, and it inserts", () => {
    const box = list();
    expect(box.querySelector('[aria-label="Add arguments to /compact"]')).toBeNull();
    const insert = box.querySelector('[aria-label="Add arguments to /review"]') as HTMLElement;
    expect(insert).not.toBeNull();
    insert.click();
    expect(inserted).toEqual([REVIEW]);
    expect(ran).toEqual([]);
  });

  test("disabled: rows don't run", () => {
    const box = list({ disabled: true });
    for (const row of rows(box)) expect(row.getAttribute("aria-disabled")).toBe("true");
    (rows(box)[0] as HTMLElement).click();
    expect(ran).toEqual([]);
  });

  test("the highlighted row is marked", () => {
    const box = list({ highlighted: 1 });
    expect(rows(box).map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  test.each([
    ["loading, with no list yet", { entry: { status: "loading", list: [], at: 0 } as CommandsEntry, items: [] }, "Loading commands…"],
    ["an empty list", { entry: ready([]), items: [] }, "No slash commands in this window yet"],
    ["nothing matching", { entry: ready([COMPACT]), items: [] }, "No matching command"],
    ["a Mac that can't list them", { entry: { status: "unsupported", list: [], at: 0 } as CommandsEntry, items: [] }, "This Mac can't list commands yet. Typing one still works."],
  ])("the note for %s", (_label, props, note) => {
    const box = list(props);
    expect(rows(box)).toHaveLength(0);
    expect(box.textContent?.trim()).toBe(note);
  });

  test("a failed load says so, and a tap tries again", () => {
    const box = list({ entry: { status: "failed", list: [], at: 0 }, items: [] });
    expect(box.textContent?.trim()).toBe("Couldn't load commands. Tap to try again.");
    (box.querySelector("button") as HTMLElement).click();
    expect(retries).toBe(1);
  });
});

describe("Composer: the list in the message field", () => {
  let box: HTMLElement;
  let loads: string[];
  let sent: Array<[string, unknown[]]>;
  let accept: boolean;

  function mount(commands: Record<string, CommandsEntry> = { p1: ready([COMPACT, REVIEW]) }) {
    box = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(box);
    loads = [];
    sent = [];
    accept = true;
    const store = { draft: () => "", setDraft: () => {}, toast: () => {}, loadCommands: (project: string) => loads.push(project) } as unknown as Store;
    const state = { commands, conn: "open" } as unknown as AppState;
    render(
      h(
        AppContext.Provider,
        { value: { store, state } },
        h(Composer, {
          project: "p1",
          draftKey: "p1/s1",
          running: false,
          ready: true,
          placeholder: "Message Claude",
          onSend: (text: string, images: unknown[]) => {
            sent.push([text, images]);
            return accept;
          },
          onStop: () => {},
        }),
      ),
      box,
    );
    return box.querySelector("textarea") as HTMLTextAreaElement;
  }
  async function type(area: HTMLTextAreaElement, value: string) {
    area.focus();
    area.value = value;
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await tick(); // the render
    await tick(); // its effects
  }
  const listbox = () => box.querySelector('[role="listbox"]');
  const option = (name: string) => [...box.querySelectorAll('[role="option"]')].find((row) => row.textContent?.includes(`/${name}`)) as HTMLElement;

  test("typing / opens the list and asks for the window's commands", async () => {
    const area = mount();
    expect(listbox()).toBeNull();
    await type(area, "/");
    expect([...box.querySelectorAll('[role="option"]')]).toHaveLength(2);
    expect(loads).toContain("p1");
    expect(area.getAttribute("aria-controls")).toBe(listbox()!.id);
  });

  test("run sends through the normal send, and clears the field once it was taken", async () => {
    const area = mount();
    await type(area, "/");
    option("compact").click();
    await tick();
    expect(sent).toEqual([["/compact", []]]);
    expect(area.value).toBe("");
  });

  test("a run that wasn't taken keeps the field", async () => {
    const area = mount();
    accept = false;
    await type(area, "/");
    option("compact").click();
    await tick();
    expect(sent).toEqual([["/compact", []]]);
    expect(area.value).toBe("/");
  });

  test("insert puts /review and a space in the field and closes the list", async () => {
    const area = mount();
    await type(area, "/re");
    (box.querySelector('[aria-label="Add arguments to /review"]') as HTMLElement).click();
    await tick();
    expect(area.value).toBe("/review ");
    expect(listbox()).toBeNull();
    expect(sent).toEqual([]);
  });

  test("the list narrows as the name is typed, and closes after a space", async () => {
    const area = mount();
    await type(area, "/rev");
    expect([...box.querySelectorAll('[role="option"]')].map((row) => row.textContent)).toEqual([expect.stringContaining("/review")]);
    await type(area, "/review 12");
    expect(listbox()).toBeNull();
  });

  test("Enter right after the name changed runs the first match, never a highlight left from before", async () => {
    // A hardware keyboard (a precise pointer), as on a desktop or an iPad with a trackpad.
    const win = dom.window as unknown as { matchMedia?: (query: string) => { matches: boolean } };
    const before = win.matchMedia;
    win.matchMedia = (query: string) => ({ matches: query === "(pointer: fine)" });
    try {
      const area = mount({ p1: ready([COMPACT, { name: "context" }, REVIEW]) });
      await type(area, "/");
      const press = (key: string) => area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      press("ArrowDown");
      await tick();
      press("ArrowDown"); // the third row: /review
      await tick();
      area.value = "/c";
      area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await tick(); // rendered, but nothing that runs after the frame yet
      press("Enter");
      await tick();
      expect(sent).toEqual([["/compact", []]]);
    } finally {
      win.matchMedia = before;
    }
  });

  test("blur closes the list", async () => {
    const area = mount();
    await type(area, "/");
    expect(listbox()).not.toBeNull();
    area.blur();
    await tick();
    expect(listbox()).toBeNull();
  });
});
