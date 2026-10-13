import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import {
  CancelledError,
  MAX_FILE_BYTES,
  collectDiffs,
  gatherContext,
  instructionEntriesFrom,
  readInstructions,
  readOriginalCode,
  recentCommitMessages,
  selectChanges,
  truncateDiff,
  untrackedPatch,
} from "../lib/context.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "claude-commit-ctx-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(join(root, "new.txt"), "hello\nworld");
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(root, "INSTR.md"), "  Use emoji  \n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const change = (file: string, status: number) => ({ uri: { fsPath: join(root, file) }, status });

/** Just enough of the git extension's Repository for the code under test. */
function fakeRepo(o: { index?: any[]; working?: any[]; untracked?: any[]; local?: string; global?: string; head?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    rootUri: { fsPath: root },
    state: {
      indexChanges: o.index ?? [],
      workingTreeChanges: o.working ?? [],
      untrackedChanges: o.untracked ?? [],
      HEAD: o.head === undefined ? { name: "main" } : o.head ? { name: o.head } : undefined,
    },
    status: async () => {
      calls.push("status");
    },
    diffIndexWithHEAD: async (p: string) => {
      calls.push(`index ${p}`);
      return `index-diff ${p}`;
    },
    diffWithHEAD: async (p: string) => {
      calls.push(`head ${p}`);
      return `head-diff ${p}`;
    },
    log: async (opts: { maxEntries: number; author?: string }) => {
      calls.push(`log ${opts.maxEntries} ${opts.author ?? "-"}`);
      return opts.author ? [{ message: "✨ Mine\n\nbody" }] : [{ message: "🔧 Theirs\n\nbody" }, { message: "first" }];
    },
    getConfig: async () => {
      if (o.local) return o.local;
      throw new Error("not set");
    },
    getGlobalConfig: async () => {
      if (o.global) return o.global;
      throw new Error("not set");
    },
  };
}

describe("selectChanges", () => {
  test("staged changes win", () => {
    expect(selectChanges({ indexChanges: [1], workingTreeChanges: [2], untrackedChanges: [3] })).toEqual([1]);
  });
  test("otherwise the working tree plus untracked files", () => {
    expect(selectChanges({ indexChanges: [], workingTreeChanges: [2], untrackedChanges: [3] })).toEqual([2, 3]);
  });
});

describe("untrackedPatch", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("matches Copilot's synthesized patch", () => {
    expect(untrackedPatch("a/b.txt", { size: 4, content: enc("x\ny\n") })).toBe(
      "diff --git a/a/b.txt b/a/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a/b.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n",
    );
  });
  test("marks a missing final newline", () => {
    expect(untrackedPatch("f", { size: 1, content: enc("x") })).toEndWith("@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n");
  });
  test("an empty file has only the header", () => {
    expect(untrackedPatch("f", { size: 0, content: enc("") })).toBe("diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n");
  });
  test("too large files are described, not inlined", () => {
    expect(untrackedPatch("big", { size: MAX_FILE_BYTES + 1 })).toContain("\\ File too large to diff (1024 KB)");
  });
  test("binary files are described, not inlined", () => {
    expect(untrackedPatch("bin", { size: 3, content: new Uint8Array([1, 0, 2]) })).toContain("Binary files /dev/null and b/bin differ");
  });
});

test("truncateDiff cuts at 100 000 chars like Copilot", () => {
  expect(truncateDiff("x".repeat(100_000))).toHaveLength(100_000);
  expect(truncateDiff("x".repeat(100_001))).toBe("x".repeat(100_000) + "\n... [diff truncated]\n");
});

describe("collectDiffs", () => {
  test("picks the diff source by status", async () => {
    const repo = fakeRepo();
    const a = join(root, "src/a.ts");
    const diffs = await collectDiffs(repo, [change("src/a.ts", 0), change("src/a.ts", 3), change("src/a.ts", 5), change("new.txt", 7)]);
    expect(repo.calls).toEqual([`index ${a}`, `index ${a}`, `head ${a}`]);
    expect(diffs[0]).toEqual({ path: a, diff: `index-diff ${a}` });
    expect(diffs[3]).toEqual({
      path: join(root, "new.txt"),
      diff: "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n",
    });
  });
  test("stops when cancelled", async () => {
    await expect(collectDiffs(fakeRepo(), [change("src/a.ts", 0)], { isCancellationRequested: true })).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("recentCommitMessages", () => {
  test("subjects of the repository's and the user's last 5 commits", async () => {
    const repo = fakeRepo({ local: "Tobias" });
    expect(await recentCommitMessages(repo)).toEqual({ repository: ["🔧 Theirs", "first"], user: ["✨ Mine"] });
    expect(repo.calls).toEqual(["log 5 -", "log 5 Tobias"]);
  });
  test("falls back to the global user.name", async () => {
    const repo = fakeRepo({ global: "Global Me" });
    await recentCommitMessages(repo);
    expect(repo.calls).toContain("log 5 Global Me");
  });
  test("without a user.name there are no user commits", async () => {
    const repo = fakeRepo();
    expect((await recentCommitMessages(repo)).user).toEqual([]);
    expect(repo.calls).toEqual(["log 5 -"]);
  });
});

describe("readOriginalCode", () => {
  test("reads text files", async () => {
    expect(await readOriginalCode(join(root, "src/a.ts"))).toBe("const a = 1;\n");
  });
  test("skips binary and missing files", async () => {
    expect(await readOriginalCode(join(root, "bin.dat"))).toBeUndefined();
    expect(await readOriginalCode(join(root, "gone.ts"))).toBeUndefined();
  });
});

describe("readInstructions", () => {
  test("file entries first, then text entries, like Copilot; missing or empty ones are skipped", async () => {
    const entries = [{ text: " Be short " }, { file: "INSTR.md" }, { file: "missing.md" }, { text: "" }, "junk", null];
    expect(await readInstructions(entries, ["/nowhere", root])).toEqual(["Use emoji", "Be short"]);
  });
  test("language-tagged entries never apply to commit messages", async () => {
    const entries = [{ text: "TS only", language: "typescript" }, { file: "INSTR.md", language: "markdown" }, { text: "Plain" }];
    expect(await readInstructions(entries, [root])).toEqual(["Plain"]);
  });
  test("a file is read from every workspace folder that has it; each entry counts once", async () => {
    const second = mkdtempSync(join(tmpdir(), "claude-commit-ctx2-"));
    writeFileSync(join(second, "INSTR.md"), "Second\n");
    const entries = [{ file: "INSTR.md" }, { file: "INSTR.md" }, { text: "A" }, { text: "A" }];
    expect(await readInstructions(entries, [root, second])).toEqual(["Use emoji", "Second", "A"]);
    rmSync(second, { recursive: true, force: true });
  });
  test("a setting that is not a list gives nothing", async () => {
    expect(await readInstructions(undefined, [root])).toEqual([]);
  });
});

describe("instructionEntriesFrom", () => {
  test("joins the folder, workspace and user values like Copilot (not just the effective one)", () => {
    const inspected = { defaultValue: [{ text: "d" }], globalValue: [{ text: "g" }], workspaceValue: [{ text: "w" }], workspaceFolderValue: [{ text: "f" }] };
    expect(instructionEntriesFrom(inspected)).toEqual([{ text: "f" }, { text: "w" }, { text: "g" }]);
  });
  test("tolerates missing or malformed values", () => {
    expect(instructionEntriesFrom(undefined)).toEqual([]);
    expect(instructionEntriesFrom({ globalValue: "nope", workspaceValue: [{ text: "w" }] })).toEqual([{ text: "w" }]);
  });
});

describe("gatherContext", () => {
  test("nothing to commit", async () => {
    const repo = fakeRepo();
    expect(await gatherContext({ repo })).toBeUndefined();
    expect(repo.calls).toEqual(["status"]);
  });
  test("everything the prompt needs", async () => {
    const repo = fakeRepo({ working: [change("src/a.ts", 5)], untracked: [change("new.txt", 7)], local: "Tobias" });
    const input = await gatherContext({ repo, instructionEntries: [{ text: "Use emoji" }], workspaceRoots: [root] });
    expect(input).toEqual({
      repositoryName: basename(root),
      branchName: "main",
      recentCommits: { repository: ["🔧 Theirs", "first"], user: ["✨ Mine"] },
      changes: [
        { path: join(root, "src/a.ts"), diff: `head-diff ${join(root, "src/a.ts")}`, originalCode: "const a = 1;\n" },
        { path: join(root, "new.txt"), diff: expect.stringContaining("+hello"), originalCode: undefined },
      ],
      instructions: ["Use emoji"],
      multiRoot: false,
    });
  });
  test("new files carry no original code (their diff already is the whole file)", async () => {
    const repo = fakeRepo({ index: [change("src/a.ts", 1)] });
    expect((await gatherContext({ repo }))?.changes[0].originalCode).toBeUndefined();
  });
  test("reads no original code when the diffs alone fill the budget", async () => {
    const repo = fakeRepo({ working: [change("src/a.ts", 5)] });
    expect((await gatherContext({ repo, budget: 10 }))?.changes[0].originalCode).toBeUndefined();
  });
  test("reads original code only while it fits next to the diffs", async () => {
    writeFileSync(join(root, "src", "b.ts"), "x".repeat(40));
    const repo = fakeRepo({ working: [change("src/a.ts", 5), change("src/b.ts", 5)] });
    const diffs = `head-diff ${join(root, "src/a.ts")}`.length + `head-diff ${join(root, "src/b.ts")}`.length;
    const input = await gatherContext({ repo, budget: diffs + "const a = 1;\n".length + 5 });
    expect(input?.changes.map((c) => c.originalCode)).toEqual(["const a = 1;\n", undefined]);
  });
  test("checks for cancellation while reading original code", async () => {
    // The first two checks (one per diff, one after the recent commits) pass; the next one is the reading loop's.
    let checks = 0;
    const token = { get isCancellationRequested() { return ++checks > 2; } };
    const repo = fakeRepo({ working: [change("src/a.ts", 5)] });
    await expect(gatherContext({ repo, token })).rejects.toBeInstanceOf(CancelledError);
  });
  test("a detached HEAD has an empty branch name", async () => {
    const repo = fakeRepo({ index: [change("src/a.ts", 0)], head: "" });
    expect((await gatherContext({ repo }))?.branchName).toBe("");
  });
});
