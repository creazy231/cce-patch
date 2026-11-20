// The home screen's lists: one Active list across every window (waiting first, then running, each newest first),
// and each window with the rest of its sessions in the Mac's order. Plus the dot each session shows.

import type { Project, SessionSummary } from "../lib/protocol";
import { isNew, type ReadState } from "../lib/readstate";
import type { DotState } from "./format";

export interface ActiveRow {
  project: Project;
  session: SessionSummary;
}

export interface WindowSection {
  project: Project;
  /** The window's sessions that aren't active, in the Mac's order (most recent activity first). */
  sessions: SessionSummary[];
  /** The window has sessions, and all of them are in the Active list. */
  allActive: boolean;
}

const isActive = (session: SessionSummary) => session.state === "waiting" || session.state === "running";

/** The Active list and the window sections. */
export function homeSections(projects: readonly Project[]): { active: ActiveRow[]; windows: WindowSection[] } {
  const waiting: ActiveRow[] = [];
  const running: ActiveRow[] = [];
  const windows: WindowSection[] = [];
  for (const project of projects) {
    const rest: SessionSummary[] = [];
    for (const session of project.sessions) {
      if (session.state === "waiting") waiting.push({ project, session });
      else if (session.state === "running") running.push({ project, session });
      else rest.push(session);
    }
    windows.push({ project, sessions: rest, allActive: project.sessions.length > 0 && rest.length === 0 });
  }
  const newestFirst = (a: ActiveRow, b: ActiveRow) => b.session.lastModified - a.session.lastModified;
  return { active: [...waiting.sort(newestFirst), ...running.sort(newestFirst)], windows };
}

/** The dot of a session on the home screen: waiting and running as the Mac says, else new or idle by this phone's read state. */
export function dotState(session: SessionSummary, read: ReadState | null): DotState {
  if (isActive(session)) return session.state as "waiting" | "running";
  return isNew(session, read) ? "new" : "idle";
}

/** How many sessions wait, run, or are new on this phone, over every window. */
export function tally(projects: readonly Project[], read: ReadState | null): { waiting: number; running: number; new: number } {
  const out = { waiting: 0, running: 0, new: 0 };
  for (const project of projects) {
    for (const session of project.sessions) {
      const dot = dotState(session, read);
      if (dot !== "idle") out[dot]++;
    }
  }
  return out;
}
