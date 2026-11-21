import { describe, expect, test } from "bun:test";
import { demoProjects, demoSnapshot } from "../src/lib/demo";
import type { UsageFrame } from "../src/lib/protocol";
import { DemoSource } from "../src/state/demo-source";
import { buildTranscript, latestTodos, type TranscriptItem } from "../src/lib/transcript";

const sessions = demoProjects.flatMap((project) => project.sessions.map((session) => ({ project, session })));

function kindsOf(items: TranscriptItem[]): string[] {
  return items.flatMap((item) => [item.kind, ...(item.kind === "tool" ? kindsOf(item.children) : [])]);
}

describe("demo data (?demo)", () => {
  test("has several projects, one of them without Claude Code open, and every session state", () => {
    expect(demoProjects.length).toBeGreaterThanOrEqual(3);
    expect(demoProjects.some((p) => !p.claudeOpen && p.sessions.length === 0)).toBe(true);
    expect(new Set(sessions.map((s) => s.session.state))).toEqual(new Set(["waiting", "running", "unread", "idle"]));
  });

  test("project and session ids are unique", () => {
    expect(new Set(demoProjects.map((p) => p.id)).size).toBe(demoProjects.length);
    expect(new Set(sessions.map((s) => s.session.id)).size).toBe(sessions.length);
  });

  test("a snapshot answers for every session, in the shape of the protocol's snapshot frame", () => {
    for (const { project, session } of sessions) {
      const snapshot = demoSnapshot(session.id);
      expect(snapshot).toMatchObject({ t: "snapshot", project: project.id, session: session.id, state: session.state, live: session.live });
      expect(snapshot.messages.length).toBeGreaterThan(0);
      expect(snapshot.truncatedBefore).toBe(0);
      expect(snapshot.pending.length).toBe(session.pendingCount);
    }
  });

  test("sessions that wait for the user have a pending prompt, and every prompt kind appears once", () => {
    const kinds = new Set<string>();
    for (const { session } of sessions) {
      const { pending } = demoSnapshot(session.id);
      if (session.state === "waiting") expect(pending.length).toBeGreaterThan(0);
      for (const p of pending) kinds.add(p.kind);
    }
    expect(kinds).toEqual(new Set(["tool", "question", "plan", "dialog"]));
  });

  test("prompts carry what the screens need", () => {
    const all = sessions.flatMap(({ session }) => demoSnapshot(session.id).pending);
    const bash = all.find((p) => p.kind === "tool" && p.toolName === "Bash")!;
    expect(typeof bash.input.command).toBe("string");
    expect(bash.canAlwaysAllow).toBe(true);
    expect(bash.alwaysLabel).toBe("Yes, and don't ask again");
    const edit = all.find((p) => p.kind === "tool" && p.toolName === "Edit")!;
    expect(edit.alwaysLabel).toBe("Yes, allow all edits this session");

    const question = all.find((p) => p.kind === "question")!;
    const questions = question.input.questions as Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }>;
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions.some((q) => q.multiSelect)).toBe(true);
    expect(questions.every((q) => q.header && q.options.length >= 2)).toBe(true);

    const plan = all.find((p) => p.kind === "plan")!;
    expect(String(plan.input.plan)).toContain("#");

    const dialog = all.find((p) => p.kind === "dialog")!;
    expect(dialog.dialogKind).toBeTruthy();
  });

  test("the transcripts cover every kind of item the session screen draws", () => {
    const kinds = new Set<string>();
    for (const { session } of sessions) {
      for (const kind of kindsOf(buildTranscript(demoSnapshot(session.id).messages))) kinds.add(kind);
    }
    for (const kind of ["user", "assistant-text", "thinking", "tool", "todos", "result", "compact"]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  test("one transcript has IDE chips, one has a subagent folded under its task, one has a pinned todo list", () => {
    const items = sessions.flatMap(({ session }) => buildTranscript(demoSnapshot(session.id).messages));
    expect(items.some((i) => i.kind === "user" && i.chips.length > 0)).toBe(true);
    expect(items.some((i) => i.kind === "tool" && i.children.length > 0)).toBe(true);
    const todos = sessions.map(({ session }) => latestTodos(demoSnapshot(session.id).messages)).filter(Boolean);
    expect(todos.length).toBeGreaterThan(0);
    expect(todos[0]!.total).toBeGreaterThan(todos[0]!.done);
  });

  test("an unknown session gets an empty snapshot, like a brand-new session", () => {
    expect(demoSnapshot("does-not-exist")).toMatchObject({ t: "snapshot", session: "does-not-exist", messages: [], pending: [], state: "idle" });
  });

  test("session times are recent and sorted data is plausible", () => {
    const now = Date.now();
    for (const { session } of sessions) {
      expect(session.lastModified).toBeLessThanOrEqual(now);
      expect(session.lastModified).toBeGreaterThan(now - 30 * 86_400_000);
    }
  });

  test("it is fictional: home-relative folders only, no e-mail addresses, hosts or addresses", () => {
    const json = JSON.stringify([demoProjects, ...sessions.map(({ session }) => demoSnapshot(session.id))]);
    for (const project of demoProjects) {
      for (const folder of project.folders) expect(folder.startsWith("~/")).toBe(true);
    }
    expect(json).not.toMatch(/\/Users\/|\/home\/|@|\.ts\.net|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe("DemoSource: usage", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  test("the demo sends usage after connecting and on usageRefresh", async () => {
    const source = new DemoSource({ speed: 0, liveStream: false });
    const frames: UsageFrame[] = [];
    source.on("usage", (frame) => frames.push(frame));
    source.connect();
    await tick();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "usage", state: "ok", fiveHour: { percent: 42 }, week: { percent: 18 }, account: "you@example.com" });
    source.usageRefresh();
    await tick();
    expect(frames).toHaveLength(2);
    source.close();
  });
});
