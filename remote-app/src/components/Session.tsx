// A session: header, the pinned todo list, the transcript, and the dock (prompt card + composer).
// Also the "new session" screen (no session yet: the first message starts it).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ImageUpload, SessionState } from "../lib/protocol";
import { buildTranscript, latestTodos, streamText, type Todos } from "../lib/transcript";
import { DOT_LABEL, sessionDot } from "../state/format";
import { findSession, waitingCount } from "../state/store";
import { Composer } from "./Composer";
import { ArrowDown, ChevronDown, Ellipsis, External, Stop, Terminal } from "./icons";
import { PromptCard } from "./PromptCard";
import { TodoList, Transcript } from "./Transcript";
import { ConnectionBanner, NavBar, Sheet, Spinner, StatusDot, useApp } from "./ui";

/** How close to the bottom still counts as "at the bottom" (new content then scrolls into view). */
const STICK_PX = 72;

export function Session() {
  const { state, store } = useApp();
  const view = state.view;
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [fresh, setFresh] = useState(false);
  const [menu, setMenu] = useState(false);

  const messages = view?.messages ?? [];
  const items = useMemo(() => buildTranscript(messages, null), [messages]);
  const stream = useMemo(() => (view ? streamText(view.stream) : ""), [view?.stream]);
  const todos = useMemo(() => latestTodos(messages), [messages]);

  const isNew = view?.session === null;
  const project = state.projects.find((p) => p.id === view?.project);
  const summary = view ? findSession(state.projects, view.project, view.session) : undefined;
  const sessionState: SessionState = summary?.state ?? view?.state ?? "idle";
  const turnOpen = !isNew && (sessionState === "running" || sessionState === "waiting" || stream.length > 0);
  const others = waitingCount(state.projects) - (sessionState === "waiting" ? 1 : 0);
  const pending = view?.pending[0];
  const connected = state.conn === "open";

  // Follow new content while at the bottom; otherwise offer the "New" pill.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setFresh(true);
  }, [items, stream, view?.loaded]);

  // The window's slash commands, fetched when the screen opens (and after a reconnect) so that typing "/" finds them.
  const viewProject = view?.project;
  useEffect(() => {
    if (connected && viewProject !== undefined) store.loadCommands(viewProject);
  }, [viewProject, connected, store]);

  // The dock or the keyboard changed the visible height: keep the bottom in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!view) return null;

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stuck.current && fresh) setFresh(false);
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = true;
    setFresh(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const title = isNew ? "New session" : summary?.title || "Session";
  const send = (text: string, images: ImageUpload[]): boolean => {
    if (!store.canSend()) return false;
    stuck.current = true;
    void store.send(text, images);
    return true;
  };
  const mac = store.macName;
  const starting = view.starting;
  const notice: { tone: "busy" | "info" | "warn"; text: string } | null = !isNew
    ? null
    : starting?.status === "sending"
      ? { tone: "busy", text: `Starting the session on ${mac}…` }
      : starting?.status === "started"
        ? { tone: "info", text: `Started on ${mac}. It shows up here in a moment.` }
        : starting?.status === "unconfirmed"
          ? { tone: "warn", text: `${mac} didn't confirm. If the session started, it opens here by itself.` }
          : connected && !project
            ? { tone: "warn", text: `This window isn't open on ${mac} anymore.` }
            : null;

  return (
    <div class="screen session">
      <NavBar
        onBack={() => store.back()}
        backBadge={others > 0 ? others : undefined}
        title={title}
        subtitle={
          <>
            {!isNew && (
              <span class={`state-pill s-${sessionDot(sessionState)}`}>
                <StatusDot state={sessionDot(sessionState)} label={false} />
                {DOT_LABEL[sessionDot(sessionState)]}
              </span>
            )}
            <span class="navbar-project">{project?.name ?? ""}</span>
          </>
        }
        right={
          isNew ? null : (
            <button type="button" class="icon-btn" onClick={() => setMenu(true)} aria-label="Session actions">
              <Ellipsis size={22} />
            </button>
          )
        }
      />
      {todos && <TodoBar todos={todos} />}
      <ConnectionBanner />

      <div class="scroll transcript-scroll" ref={scroller} onScroll={onScroll}>
        <div class="transcript">
          {view.truncatedBefore > 0 && (
            <p class="t-truncated">
              {view.truncatedBefore} earlier {view.truncatedBefore === 1 ? "message isn't" : "messages aren't"} shown here
            </p>
          )}
          {isNew && items.length === 0 ? (
            <div class="new-hint">
              <div class="new-mark" aria-hidden="true">
                <Terminal size={26} />
              </div>
              <h2>New session in {project?.name ?? "this window"}</h2>
              <p>Your first message starts it. It opens in a VS&nbsp;Code tab on {store.macName}, and you follow it here.</p>
            </div>
          ) : !view.loaded && items.length === 0 ? (
            <TranscriptSkeleton />
          ) : view.loaded && items.length === 0 && !stream ? (
            <p class="t-empty">No messages yet.</p>
          ) : (
            <Transcript
              items={items}
              stream={stream}
              activity={sessionState === "running" ? "running" : sessionState === "waiting" ? "waiting" : "idle"}
              outgoing={view.outgoing}
              onRetry={(uuid) => store.retry(uuid)}
              onDiscard={(uuid) => store.discard(uuid)}
            />
          )}
        </div>
      </div>

      <div class="dock">
        {fresh && (
          <button type="button" class="new-pill" onClick={toBottom}>
            <ArrowDown size={14} stroke={2.4} />
            New
          </button>
        )}
        {pending && (
          <PromptCard
            key={pending.requestId}
            pending={pending}
            count={view.pending.length}
            busy={view.answering[pending.requestId]}
            error={view.answerErrors[pending.requestId]}
            macName={store.macName}
            onAnswer={(choice) => void store.answer(pending, choice)}
            onOpenOnMac={() => view.session && void store.openOnMac(view.project, view.session)}
          />
        )}
        {notice && (
          <p class={`dock-note ${notice.tone}`} role="status">
            {notice.tone === "busy" && <Spinner size={13} />}
            {notice.text}
          </p>
        )}
        <Composer
          key={view.key}
          project={view.project}
          draftKey={`${view.project}/${view.session ?? "new"}`}
          running={turnOpen}
          ready={connected && store.canSend()}
          placeholder={isNew ? "What should Claude do?" : "Message Claude"}
          onSend={send}
          onStop={() => void store.interrupt()}
        />
      </div>

      {menu && view.session && (
        <Sheet
          title={title}
          subtitle={project?.name}
          onClose={() => setMenu(false)}
          actions={[
            {
              label: "Open on Mac",
              icon: <External size={20} />,
              run: () => view.session && void store.openOnMac(view.project, view.session),
            },
            ...(turnOpen ? [{ label: "Stop", icon: <Stop size={20} />, tone: "danger" as const, run: () => void store.interrupt() }] : []),
          ]}
        />
      )}
    </div>
  );
}

function TodoBar({ todos }: { todos: Todos }) {
  const [open, setOpen] = useState(false);
  const current = todos.items.find((item) => item.status === "in_progress");
  const allDone = todos.done === todos.total;
  const label = allDone ? "All done" : current ? current.activeForm || current.content : todos.items.find((i) => i.status === "pending")?.content ?? "";
  return (
    <div class={`todobar ${open ? "open" : ""}`}>
      <button type="button" class="todobar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="todobar-ring" style={{ "--p": `${Math.round((todos.done / Math.max(1, todos.total)) * 100)}` }} aria-hidden="true" />
        <span class="todobar-count">
          {todos.done}/{todos.total}
        </span>
        <span class="todobar-label">{label}</span>
        <ChevronDown size={16} stroke={2.2} class="todobar-chevron" />
      </button>
      <div class="todobar-panel">
        <div class="todobar-inner">
          <TodoList todos={todos} bare />
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div class="skeleton t-skeleton" aria-label="Loading the session" role="status">
      <div class="sk-bubble" />
      <div class="sk-line w90" />
      <div class="sk-line w70" />
      <div class="sk-line w40" />
      <div class="sk-tool" />
      <div class="sk-tool" />
      <div class="sk-line w80" />
    </div>
  );
}
