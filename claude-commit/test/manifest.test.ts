import { describe, expect, test } from "bun:test";
import manifest from "../package.json";

const menus = manifest.contributes.menus;
const commandIds = manifest.contributes.commands.map((c) => c.command);

describe("package.json", () => {
  test("asks for the input-box menu proposal", () => {
    expect(manifest.enabledApiProposals).toContain("contribSourceControlInputBoxMenu");
  });
  test("puts the button in the commit message box for Git repositories", () => {
    expect(menus["scm/inputBox"]).toEqual([{ command: "claudeCommit.generateCommitMessage", when: "scmProvider == git" }]);
  });
  test("the title-bar stop button takes the generate button's exact slot", () => {
    const [generate, cancel] = menus["scm/title"];
    // VS Code sorts unordered items by title, which would put "Cancel…" before ✓ and "Generate…" after it.
    expect(generate.group).toMatch(/^navigation@-?\d+$/);
    expect(cancel.group).toBe(generate.group);
    expect(generate.when).toContain("!claudeCommit.generating");
    expect(cancel.when).toContain(" claudeCommit.generating");
  });
  test("the title-bar fallback hides once the commit message box has the button", () => {
    for (const item of menus["scm/title"]) expect(item.when).toContain("!claudeCommit.inputBoxButton");
  });
  test("every menu entry points at a contributed command", () => {
    for (const items of Object.values(menus)) for (const item of items) expect(commandIds).toContain(item.command);
  });
});
