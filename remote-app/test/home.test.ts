import { describe, expect, test } from "bun:test";
import type { Project, SessionSummary } from "../src/lib/protocol";
import type { ReadState } from "../src/lib/readstate";
import { DOT_LABEL, sessionDot } from "../src/state/format";
import { dotState, homeSections, tally } from "../src/state/home";

const session = (id: string, state: SessionSummary["state"], lastModified: number): SessionSummary => ({
  id,
  title: id,
  lastModified,
  state,
  live: true,
  pendingCount: 0,
});
const project = (id: string, sessions: SessionSummary[], claudeOpen = true): Project => ({
  id,
  name: id.toUpperCase(),
  folders: [`~/${id}`],
  editor: "Visual Studio Code",
  claudeOpen,
  sessions,
});

describe("homeSections", () => {
  const a = project("a", [session("s1", "running", 100), session("s2", "idle", 900)]);
  const b = project("b", [session("s3", "waiting", 50), session("s4", "running", 300)]);

  test("active sessions from every window, waiting first, each group newest first", () => {
    const { active } = homeSections([a, b]);
    expect(active.map((row) => [row.project.id, row.session.id])).toEqual([
      ["b", "s3"],
      ["b", "s4"],
      ["a", "s1"],
    ]);
  });

  test("window lists keep only the rest, in the Mac's order", () => {
    const { windows } = homeSections([a, b]);
    expect(windows.map((w) => [w.project.id, w.sessions.map((s) => s.id), w.allActive])).toEqual([
      ["a", ["s2"], false],
      ["b", [], true],
    ]);
  });

  test("a window without sessions is not all active", () => {
    const { windows } = homeSections([project("c", [], false), project("d", [])]);
    expect(windows.map((w) => [w.sessions, w.allActive])).toEqual([
      [[], false],
      [[], false],
    ]);
  });

  test("the same session in two windows shows once per window", () => {
    const { active } = homeSections([project("a", [session("s1", "running", 1)]), project("b", [session("s1", "running", 1)])]);
    expect(active.map((row) => `${row.project.id}|${row.session.id}`)).toEqual(["a|s1", "b|s1"]);
  });
});

describe("dots", () => {
  const read: ReadState = { baseline: 1_000, seen: {} };

  test("waiting and running as they are; new when unread on this phone; the Mac's unread is idle", () => {
    expect(dotState(session("s", "waiting", 99_999), read)).toBe("waiting");
    expect(dotState(session("s", "running", 99_999), read)).toBe("running");
    expect(dotState(session("s", "unread", 500), read)).toBe("idle");
    expect(dotState(session("s", "unread", 3_001), read)).toBe("new");
    expect(dotState(session("s", "idle", 3_001), read)).toBe("new");
    expect(dotState(session("s", "idle", 3_001), null)).toBe("idle");
  });

  test("the tally counts new on this phone", () => {
    const projects = [
      project("a", [session("s1", "waiting", 1), session("s2", "running", 1), session("s3", "idle", 5_000)]),
      project("b", [session("s4", "running", 1), session("s5", "unread", 500)]),
    ];
    expect(tally(projects, read)).toEqual({ waiting: 1, running: 2, new: 1 });
  });

  test("the session screen shows the Mac's unread as idle", () => {
    expect(sessionDot("unread")).toBe("idle");
    expect(sessionDot("idle")).toBe("idle");
    expect(sessionDot("running")).toBe("running");
    expect(sessionDot("waiting")).toBe("waiting");
    expect(DOT_LABEL).toEqual({ waiting: "Needs you", running: "Running", new: "New", idle: "Idle" });
  });
});
