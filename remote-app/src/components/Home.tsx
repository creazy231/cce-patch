// Home: the Mac and its open windows (projects), each with its sessions. Waiting sessions sort to the top
// of their project, and the page warms up (the ember) while anything needs you.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Project, SessionState, SessionSummary } from "../lib/protocol";
import { branchLabel, folderLabel, relativeTime, shortEditor } from "../state/format";
import { waitingCount } from "../state/store";
import { Branch, ChevronDown, ChevronRight, Ellipsis, Laptop, Plus, Sliders, Terminal } from "./icons";
import { ConnectionBanner, Sheet, StatusDot, memo, useApp, type SheetAction } from "./ui";

/** Remembered while a session is open, so coming back lands where the list was. */
let savedScroll = 0;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Waiting first; otherwise the Mac's order (most recent activity first). */
function ordered(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions.filter((s) => s.state === "waiting"), ...sessions.filter((s) => s.state !== "waiting")];
}

function counts(projects: Project[]): Record<SessionState, number> {
  const result: Record<SessionState, number> = { waiting: 0, running: 0, unread: 0, idle: 0 };
  for (const project of projects) for (const session of project.sessions) result[session.state]++;
  return result;
}

export function Home() {
  const { state, store } = useApp();
  const now = useNow(30_000);
  const scroller = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState<Project | null>(null);
  const [switching, setSwitching] = useState(false);
  const open = useMemo(() => (project: string, session: string) => store.openSession(project, session), [store]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = savedScroll;
    return () => {
      if (el) savedScroll = el.scrollTop;
    };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    const heading = title.current;
    if (!el || !heading || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(entry ? !entry.isIntersecting : false), {
      root: el,
      threshold: 0,
      rootMargin: "-8px 0px 0px 0px",
    });
    observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  const { projects, conn, macs } = state;
  const tally = useMemo(() => counts(projects), [projects]);
  const waiting = waitingCount(projects);
  const mac = store.macName;
  const several = macs.length > 1;

  const macActions: SheetAction[] = [
    ...macs.map((m) => ({
      label: m.name,
      icon: <Laptop size={20} />,
      checked: m.id === state.macId,
      run: () => store.switchMac(m.id),
    })),
    { label: "Pair another Mac", icon: <Plus size={20} />, tone: "accent" as const, run: () => store.navigate({ name: "pair" }) },
  ];

  return (
    <div class={`screen home ${waiting > 0 ? "ember" : ""}`}>
      <header class={`topbar ${scrolled ? "scrolled" : ""}`}>
        <div class="topbar-status">
          <span class={`conn conn-${conn}`} aria-hidden="true" />
          <span>
            {conn === "open"
              ? "Connected"
              : conn === "unauthorized"
                ? "Not paired"
                : state.remoteOff
                  ? "Turned off"
                  : conn === "connecting"
                    ? "Connecting"
                    : "Offline"}
          </span>
        </div>
        <div class="topbar-title" aria-hidden={!scrolled}>
          {mac}
        </div>
        <button type="button" class="icon-btn" onClick={() => store.navigate({ name: "settings" })} aria-label="Settings">
          <Sliders size={22} />
        </button>
      </header>

      <div class="scroll" ref={scroller}>
        <div class="hero">
          <button
            type="button"
            class="hero-title-btn"
            onClick={() => setSwitching(true)}
            aria-label={several ? `${mac}, switch Mac` : `${mac}, Mac actions`}
          >
            <h1 class="large-title" ref={title}>
              {mac}
            </h1>
            <ChevronDown size={20} stroke={2.4} class="hero-chevron" />
          </button>
          <Summary tally={tally} projects={projects.length} conn={conn} />
        </div>

        <ConnectionBanner />

        {projects.length === 0 ? (
          conn === "open" ? (
            <div class="empty">
              <div class="empty-mark" aria-hidden="true">
                <Terminal size={26} />
              </div>
              <h2>No windows open</h2>
              <p>
                Open a project in VS Code on {mac}, with the patched Claude Code. It shows up here by itself.
              </p>
            </div>
          ) : (
            <SkeletonProjects />
          )
        ) : (
          projects.map((project) => (
            <ProjectSection key={project.id} project={project} now={now} onMenu={setMenu} onOpen={open} />
          ))
        )}
      </div>

      {menu && (
        <Sheet
          title={menu.name}
          subtitle={`${shortEditor(menu.editor)} · ${folderLabel(menu.folders)}`}
          onClose={() => setMenu(null)}
          actions={[
            { label: "New session", icon: <Plus size={20} />, tone: "accent", run: () => store.newSession(menu.id) },
            ...(menu.claudeOpen
              ? []
              : [{ label: "Open Claude Code", icon: <Terminal size={20} />, run: () => void store.openClaude(menu.id) }]),
          ]}
        />
      )}
      {switching && <Sheet title="Macs" onClose={() => setSwitching(false)} actions={macActions} />}
    </div>
  );
}

function Summary({ tally, projects, conn }: { tally: Record<SessionState, number>; projects: number; conn: string }) {
  if (projects === 0) return <p class="summary">{conn === "open" ? "Nothing open right now" : " "}</p>;
  const parts: Array<[SessionState, string]> = [];
  if (tally.waiting) parts.push(["waiting", `${tally.waiting} need${tally.waiting === 1 ? "s" : ""} you`]);
  if (tally.running) parts.push(["running", `${tally.running} running`]);
  if (tally.unread) parts.push(["unread", `${tally.unread} done`]);
  return (
    <p class="summary">
      {parts.length === 0 ? (
        <span class="summary-part quiet">All quiet</span>
      ) : (
        parts.map(([state, text]) => (
          <span key={state} class={`summary-part s-${state}`}>
            <StatusDot state={state} label={false} />
            {text}
          </span>
        ))
      )}
      <span class="summary-part quiet">
        {projects} {projects === 1 ? "window" : "windows"}
      </span>
    </p>
  );
}

function SkeletonProjects() {
  return (
    <div class="skeleton" aria-hidden="true">
      {[3, 2].map((rows, i) => (
        <div key={i} class="project">
          <div class="sk-line w40 tall" />
          <div class="sk-line w60" />
          <div class="group">
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} class="row sk-row">
                <span class="sk-dot" />
                <div class="row-main">
                  <div class="sk-line w70" />
                  <div class="sk-line w40" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const ProjectSection = memo(function ProjectSection(props: {
  project: Project;
  now: number;
  onMenu: (project: Project) => void;
  onOpen: (project: string, session: string) => void;
}) {
  const { project, now } = props;
  const sessions = ordered(project.sessions);
  return (
    <section class="project" aria-label={project.name}>
      <div class="project-head">
        <div class="project-text">
          <h2 class="project-name">{project.name}</h2>
          <p class="project-meta">
            <span>{shortEditor(project.editor)}</span>
            <span class="sep" aria-hidden="true">
              ·
            </span>
            <span class="mono path">{folderLabel(project.folders)}</span>
          </p>
        </div>
        <button type="button" class="icon-btn subtle" onClick={() => props.onMenu(project)} aria-label={`Actions for ${project.name}`}>
          <Ellipsis size={22} />
        </button>
      </div>

      {!project.claudeOpen ? (
        <div class="group group-note">
          <p>Claude Code isn't open in this window.</p>
          <button type="button" class="pill-btn" onClick={() => props.onMenu(project)}>
            Open Claude Code
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <div class="group group-note">
          <p>No sessions yet.</p>
          <button type="button" class="pill-btn" onClick={() => props.onMenu(project)}>
            New session
          </button>
        </div>
      ) : (
        <ul class="group" role="list">
          {sessions.map((session) => (
            <li key={session.id}>
              <SessionRow session={session} now={now} onOpen={() => props.onOpen(project.id, session.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});

function SessionRow({ session, now, onOpen }: { session: SessionSummary; now: number; onOpen: () => void }) {
  const when = relativeTime(session.lastModified, now);
  const branch = branchLabel(session.gitBranch);
  const hasSub = Boolean(branch || session.worktree || session.pendingCount > 0);
  return (
    <button type="button" class="row" data-state={session.state} onClick={onOpen}>
      <StatusDot state={session.state} />
      <div class="row-main">
        <div class="row-top">
          <span class="row-title">{session.title || "Untitled"}</span>
          <time class="time">{when}</time>
        </div>
        {hasSub && (
          <div class="row-sub">
            {branch && (
              <span class="branch">
                <Branch size={13} stroke={2} />
                <span class="mono">{branch}</span>
              </span>
            )}
            {session.worktree && <span class="tag">worktree</span>}
            {session.pendingCount > 0 && (
              <span class="needs">{session.pendingCount > 1 ? `${session.pendingCount} prompts` : "Needs you"}</span>
            )}
          </div>
        )}
      </div>
      <ChevronRight size={16} stroke={2.2} class="row-chevron" />
    </button>
  );
}
