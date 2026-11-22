import { describe, expect, test } from "bun:test";
import { parseCommands, rankCommands, slashQuery } from "../src/lib/commands";
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
