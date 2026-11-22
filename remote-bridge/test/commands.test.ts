import { describe, expect, test } from "bun:test";
import { toSlashCommands } from "../lib/commands.js";

// Entries as Claude Code reports them (extension 2.1.330: the window's `config.commands`, a running session's
// `supportedCommands()`): {name, description, argumentHint, aliases?, builtin?, plugin?}.
describe("toSlashCommands", () => {
  test("keeps name, description, argumentHint, aliases and plugin", () => {
    const raw = [{ name: "review", description: "Review a PR", argumentHint: "[pr]", aliases: ["rv"], builtin: true, plugin: "gh" }];
    expect(toSlashCommands(raw)).toEqual([{ name: "review", description: "Review a PR", argumentHint: "[pr]", aliases: ["rv"], plugin: "gh" }]);
  });

  test("leaves out empty and non-string fields", () => {
    expect(toSlashCommands([{ name: "a", description: "", argumentHint: "", aliases: [], plugin: 7 }])).toEqual([{ name: "a" }]);
    expect(toSlashCommands([{ name: "b", aliases: ["x", 3, ""] }])).toEqual([{ name: "b", aliases: ["x"] }]);
  });

  test("drops entries without a usable name", () => {
    expect(toSlashCommands([null, 1, {}, { name: "" }, { name: 5 }, { name: "ok" }])).toEqual([{ name: "ok" }]);
  });

  test("shared names take the alias ending in :name", () => {
    const raw = [{ name: "deploy" }, { name: "deploy", plugin: "ops", aliases: ["ops:deploy"] }, { name: "lint" }];
    const out = toSlashCommands(raw);
    expect(out.map((c) => c.name)).toEqual(["deploy", "lint", "ops:deploy"]);
    expect(out[2]).toEqual({ name: "ops:deploy", plugin: "ops", aliases: ["ops:deploy"] });
  });

  test("a later entry with the same name replaces the earlier one", () => {
    expect(toSlashCommands([{ name: "x", description: "one" }, { name: "x", description: "two" }])).toEqual([{ name: "x", description: "two" }]);
  });

  test("sorted by name", () => {
    expect(toSlashCommands([{ name: "zeta" }, { name: "Alpha" }, { name: "beta" }]).map((c) => c.name)).toEqual(["Alpha", "beta", "zeta"]);
  });

  test("not an array: []", () => {
    for (const raw of [undefined, null, {}, "x"]) expect(toSlashCommands(raw)).toEqual([]);
  });
});
