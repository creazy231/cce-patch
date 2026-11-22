import { describe, expect, test } from "bun:test";
import { composerKey, parseCommands, rankCommands, slashQuery } from "../src/lib/commands";
import type { SlashCommand } from "../src/lib/protocol";

describe("slashQuery: the command name being typed", () => {
  test.each([
    ["/", ""],
    ["/com", "com"],
    ["/ops:deploy", "ops:deploy"],
  ])("%p → %p", (text, query) => {
    expect(slashQuery(text)).toBe(query);
  });

  test.each([["/compact now"], ["/a\nb"], ["hi /x"], [""], [" /x"], ["compact"]])("%p → null (not a name being typed)", (text) => {
    expect(slashQuery(text)).toBeNull();
  });
});

describe("rankCommands", () => {
  const list: SlashCommand[] = [
    { name: "compact" },
    { name: "context", description: "Show context usage" },
    { name: "init", description: "compact the repo notes" },
    { name: "ops:deploy", aliases: ["ship"] },
    { name: "Config" },
  ];
  const names = (query: string) => rankCommands(list, query).map((c) => c.name);

  test("a bare slash lists everything, alphabetically", () => {
    expect(names("")).toEqual(["compact", "Config", "context", "init", "ops:deploy"]);
  });

  test("name prefixes first, alphabetically, then description matches", () => {
    expect(names("co")).toEqual(["compact", "Config", "context", "init"]);
  });

  test("an alias or a part of the name matches", () => {
    expect(names("shi")).toEqual(["ops:deploy"]); // the alias starts with it
    expect(names("hip")).toEqual(["ops:deploy"]); // the alias contains it
    expect(names("deploy")).toEqual(["ops:deploy"]); // the name contains it
  });

  test("case doesn't matter", () => {
    expect(names("COMP")).toEqual(["compact", "init"]);
  });

  test("nothing matching: none", () => {
    expect(names("zzz")).toEqual([]);
  });

  test("the list itself is left as it was", () => {
    rankCommands(list, "co");
    expect(list.map((c) => c.name)).toEqual(["compact", "context", "init", "ops:deploy", "Config"]);
  });
});

describe("parseCommands: what a Mac's ack carries", () => {
  test("keeps well-formed entries and their string fields only", () => {
    expect(parseCommands([{ name: "a", description: "d", aliases: ["x", 2], plugin: "p", extra: 1 }, { name: "" }, {}, "x", null])).toEqual([
      { name: "a", description: "d", aliases: ["x"], plugin: "p" },
    ]);
    expect(parseCommands([{ name: "b", argumentHint: "[n]", description: 5, aliases: "x" }])).toEqual([{ name: "b", argumentHint: "[n]" }]);
  });

  test("anything but a list is no commands", () => {
    for (const value of [undefined, null, {}, "x", 3]) expect(parseCommands(value)).toEqual([]);
  });
});

describe("composerKey: the message field's keys while the list may be open", () => {
  const key = (k: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) => ({ key: k, shiftKey: false, isComposing: false, ...extra });

  test("↓ and ↑ move and wrap", () => {
    expect(composerKey(key("ArrowDown"), true, 3, 0, true)).toEqual({ action: "move", highlighted: 1 });
    expect(composerKey(key("ArrowDown"), true, 3, 2, true)).toEqual({ action: "move", highlighted: 0 });
    expect(composerKey(key("ArrowUp"), true, 3, 0, true)).toEqual({ action: "move", highlighted: 2 });
  });

  test("Enter runs the highlighted command on a hardware keyboard", () => {
    expect(composerKey(key("Enter"), true, 3, 1, true)).toEqual({ action: "run", highlighted: 1 });
  });

  test("Enter without a match sends what was typed", () => {
    expect(composerKey(key("Enter"), true, 0, 0, true)).toEqual({ action: "send", highlighted: 0 });
  });

  test("closed: Enter sends on a hardware keyboard, as today", () => {
    expect(composerKey(key("Enter"), false, 3, 0, true)).toEqual({ action: "send", highlighted: 0 });
  });

  test("Enter on a phone keeps today's newline", () => {
    expect(composerKey(key("Enter"), true, 3, 0, false)).toEqual({ action: "none", highlighted: 0 });
    expect(composerKey(key("Enter"), false, 3, 0, false)).toEqual({ action: "none", highlighted: 0 });
  });

  test("Escape closes an open list, and does nothing otherwise", () => {
    expect(composerKey(key("Escape"), true, 3, 1, false)).toEqual({ action: "close", highlighted: 1 });
    expect(composerKey(key("Escape"), false, 3, 1, false)).toEqual({ action: "none", highlighted: 1 });
  });

  test("Shift+Enter and composition do nothing special", () => {
    expect(composerKey(key("Enter", { shiftKey: true }), true, 3, 0, true)).toEqual({ action: "none", highlighted: 0 });
    expect(composerKey(key("Enter", { isComposing: true }), true, 3, 0, true)).toEqual({ action: "none", highlighted: 0 });
    expect(composerKey(key("ArrowDown", { isComposing: true }), true, 3, 0, true)).toEqual({ action: "none", highlighted: 0 });
  });

  test("arrows leave the caret alone while the list is closed, or empty", () => {
    expect(composerKey(key("ArrowDown"), false, 3, 0, true)).toEqual({ action: "none", highlighted: 0 });
    expect(composerKey(key("ArrowDown"), true, 0, 0, true)).toEqual({ action: "none", highlighted: 0 });
  });
});
