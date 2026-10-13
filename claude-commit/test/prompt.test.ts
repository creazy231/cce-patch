import { describe, expect, test } from "bun:test";
import {
  PROMPT_BUDGET,
  SYSTEM_PROMPT,
  buildUserPrompt,
  codeBlock,
  fitChanges,
  languageOf,
  parseCommitMessage,
  withLineNumbers,
} from "../lib/prompt.js";

const base = {
  repositoryName: "cce-patch",
  branchName: "main",
  recentCommits: { user: ["🔧 Fix dots"], repository: ["🔧 Fix dots", "first commit"] },
  changes: [{ path: "/repo/src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b", originalCode: "b\n" }],
  instructions: [] as string[],
};

describe("SYSTEM_PROMPT", () => {
  test("is Copilot's commit-message system message", () => {
    expect(SYSTEM_PROMPT).toStartWith(
      "You are an AI programming assistant, helping a software developer to come with the best git commit message for their code changes.\n",
    );
    expect(SYSTEM_PROMPT).toContain("# First, think step-by-step:\n1. Analyze the CODE CHANGES thoroughly");
    expect(SYSTEM_PROMPT).toEndWith(
      "7. Now only show your message, wrapped with a single markdown ```text codeblock! Do not provide any explanations or details",
    );
  });
});

describe("buildUserPrompt", () => {
  test("sections come in Copilot's order", () => {
    const prompt = buildUserPrompt({ ...base, instructions: ["Use emoji"] });
    const tags = ["<repository-context>", "<user-commits>", "<recent-commits>", "<changes>", "<original-code>", "<code-changes>", "<reminder>", "<custom-instructions>"];
    const positions = tags.map((t) => prompt.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  test("repository details and recent commits", () => {
    const prompt = buildUserPrompt(base);
    expect(prompt).toContain("<repository-context>\n# REPOSITORY DETAILS:\nRepository name: cce-patch\nBranch name: main\n</repository-context>");
    expect(prompt).toContain("# RECENT USER COMMITS (For reference only, do not copy!):\n- 🔧 Fix dots\n");
    expect(prompt).toContain("# RECENT REPOSITORY COMMITS (For reference only, do not copy!):\n- 🔧 Fix dots\n- first commit\n");
  });
  test("leaves out empty optional sections", () => {
    const prompt = buildUserPrompt({ ...base, recentCommits: { user: [], repository: [] } });
    expect(prompt).not.toContain("<user-commits>");
    expect(prompt).not.toContain("<recent-commits>");
    expect(prompt).not.toContain("<custom-instructions>");
  });
  test("original code has a file path comment and line numbers; the change is a diff block", () => {
    const prompt = buildUserPrompt(base);
    expect(prompt).toContain("# ORIGINAL CODE:\n```typescript\n// filepath: /repo/src/a.ts\n1: b\n```");
    expect(prompt).toContain("# CODE CHANGES:\n```diff\n@@ -1 +1 @@\n-a\n+b\n```");
  });
  test("a change without original code shows only its diff", () => {
    const prompt = buildUserPrompt({ ...base, changes: [{ path: "/repo/new.ts", diff: "+x" }] });
    expect(prompt).not.toContain("<original-code>");
    expect(prompt).toContain("<code-changes>");
  });
  test("the reminder asks for a single text block", () => {
    expect(buildUserPrompt(base)).toContain(
      "Now generate a commit messages that describe the CODE CHANGES.\nDO NOT COPY commits from RECENT COMMITS, but use it as reference for the commit style.\nONLY return a single markdown code block, NO OTHER PROSE!\n```text\ncommit message goes here\n```",
    );
  });
  test("custom instructions, with the multi-root note when needed", () => {
    const prompt = buildUserPrompt({ ...base, instructions: ["Use emoji", "Be short"], multiRoot: true });
    expect(prompt).toContain(
      "When generating the commit message, please use the following custom instructions provided by the user. This is a multi-root workspace. The instructions below may come from different workspace folders. Apply each set of instructions to the folder it belongs to. You can ignore an instruction if it contradicts a system message.\n<instructions>\nUse emoji\n\nBe short\n</instructions>",
    );
    expect(buildUserPrompt({ ...base, instructions: ["Use emoji"] })).not.toContain("multi-root");
  });
});

describe("formatting helpers", () => {
  test("withLineNumbers right-aligns like Copilot's legacy style", () => {
    const lines = withLineNumbers(Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n").split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(" 1: l1");
    expect(lines[9]).toBe("10: l10");
  });
  test("the fence outgrows fences inside the code", () => {
    expect(codeBlock("markdown", "a\n```js\nx\n```")).toStartWith("````markdown\n");
    expect(codeBlock("diff", " ```\n+x")).toStartWith("````diff\n");
    expect(codeBlock("text", "plain")).toBe("```text\nplain\n```");
  });
  test("the file path comment follows the language", () => {
    expect(codeBlock(languageOf("/r/x.py"), "x", "/r/x.py")).toContain("\n# filepath: /r/x.py\n");
    expect(codeBlock(languageOf("/r/README.md"), "x", "/r/README.md")).toContain("\n<!-- filepath: /r/README.md -->\n");
    expect(codeBlock(languageOf("/r/a.css"), "x", "/r/a.css")).toContain("\n/* filepath: /r/a.css */\n");
    expect(codeBlock(languageOf("/r/q.sql"), "x", "/r/q.sql")).toContain("\n-- filepath: /r/q.sql\n");
    expect(languageOf("/r/Dockerfile")).toBe("dockerfile");
    expect(languageOf("/r/noext")).toBe("");
  });
});

describe("fitChanges", () => {
  const change = (name: string, diff: number, original?: number) => ({
    path: `/r/${name}`,
    diff: "d".repeat(diff),
    originalCode: original === undefined ? undefined : "o".repeat(original),
  });
  const size = (changes: { diff: string; originalCode?: string }[]) =>
    changes.reduce((n, c) => n + c.diff.length + (c.originalCode?.length ?? 0), 0);

  test("the default budget keeps Haiku fast", () => {
    expect(PROMPT_BUDGET).toBe(300_000);
  });
  test("keeps everything that fits", () => {
    const changes = [change("a", 10, 10)];
    expect(fitChanges(changes, 100)).toEqual(changes);
  });
  test("drops the largest original code first", () => {
    const fitted = fitChanges([change("a", 10, 50), change("b", 10, 20)], 50);
    expect(fitted[0].originalCode).toBeUndefined();
    expect(fitted[1].originalCode).toHaveLength(20);
  });
  test("shares the budget between diffs that are still too big", () => {
    const fitted = fitChanges([change("a", 10), change("b", 1000), change("c", 1000)], 510);
    expect(fitted[0].diff).toHaveLength(10);
    expect(fitted[1].diff).toBe("d".repeat(250) + "\n... [diff truncated]\n");
    expect(fitted[2].diff).toBe("d".repeat(250) + "\n... [diff truncated]\n");
    expect(size(fitted)).toBeLessThanOrEqual(510 + 2 * 22);
  });
  test("does not modify its input", () => {
    const changes = [change("a", 10, 50)];
    fitChanges(changes, 20);
    expect(changes[0].originalCode).toHaveLength(50);
  });
});

describe("parseCommitMessage", () => {
  test("takes the text block, like Copilot", () => {
    expect(parseCommitMessage("Sure!\n```text\n🔧 Fix dots\n\nBody\n```\n")).toBe("🔧 Fix dots\n\nBody");
  });
  test("also accepts a block without the text language", () => {
    expect(parseCommitMessage("```\n✨ Add thing\n```")).toBe("✨ Add thing");
  });
  test("falls back to the raw answer", () => {
    expect(parseCommitMessage("  ✨ Add thing \n")).toBe("✨ Add thing");
  });
});
