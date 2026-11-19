// The card for what Claude is waiting for: a tool permission, questions, a plan, or a dialog that only
// VS Code can answer. One at a time, with a count; the labels match VS Code's.

import type { ComponentChildren } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Choice, Pending, Question } from "../lib/protocol";
import { toolSummary } from "../lib/transcript";
import { emptyDraft, isAnswered, parseQuestions, pick, setOther, type QuestionDraft } from "../state/answers";
import { actionOf, promptActions, type PromptAction } from "../state/choices";
import { answerErrorText, relativeTime, shortPath, toolLabel } from "../state/format";
import { Check } from "./icons";
import { Markdown } from "./Transcript";
import { Spinner } from "./ui";

export interface PromptCardProps {
  pending: Pending;
  count: number;
  /** The kind of choice being sent for this prompt, if any. */
  busy?: Choice["kind"];
  error?: string;
  macName: string;
  onAnswer: (choice: Choice) => void;
  onOpenOnMac: () => void;
}

export function PromptCard(props: PromptCardProps) {
  const { pending } = props;
  switch (pending.kind) {
    case "question":
      return <QuestionCard {...props} />;
    case "plan":
      return <PlanCard {...props} />;
    case "dialog":
      return <DialogCard {...props} />;
    default:
      return <ToolCard {...props} />;
  }
}

// ---- shared frame ----

/** Fades at the edges of the card's scrolling body while there is more to read above or below. */
function useScrollHints() {
  const ref = useRef<HTMLDivElement>(null);
  const [hints, setHints] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const above = el.scrollTop > 2;
      const below = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
      setHints((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  return { ref, hints };
}

function Frame(props: {
  kind: string;
  title: ComponentChildren;
  count: number;
  createdAt: number;
  tabs?: ComponentChildren;
  children?: ComponentChildren;
  actions: ComponentChildren;
  error?: string;
  macName: string;
}) {
  const age = relativeTime(props.createdAt);
  const { ref, hints } = useScrollHints();
  const hasBody = props.children !== undefined && props.children !== null;
  return (
    <section class={`prompt prompt-${props.kind}`} aria-label="Claude is waiting for you">
      <header class="pc-head">
        <span class="pc-pulse" aria-hidden="true" />
        <h2 class="pc-title">{props.title}</h2>
        <span class="pc-meta">
          {props.count > 1 && <span class="pc-count">1 of {props.count}</span>}
          {age && age !== "now" && <span class="pc-age">{age}</span>}
        </span>
      </header>
      {props.tabs}
      {hasBody && (
        <div class={`pc-scroll ${hints.above ? "more-above" : ""} ${hints.below ? "more-below" : ""}`}>
          <div class="pc-body" ref={ref}>
            <div class="pc-content">{props.children}</div>
          </div>
        </div>
      )}
      {props.error && (
        <p class="pc-error" role="alert">
          {answerErrorText(props.error, props.macName)}
        </p>
      )}
      <div class="pc-actions">{props.actions}</div>
    </section>
  );
}

function ActionButton(props: {
  tone: "primary" | "secondary" | "quiet";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <button
      type="button"
      class={`btn btn-${props.tone} ${props.class ?? ""}`}
      disabled={props.disabled}
      aria-busy={props.busy || undefined}
      onClick={props.onClick}
    >
      {props.busy ? <Spinner size={16} /> : null}
      <span>{props.children}</span>
    </button>
  );
}

/** A button for one of the card's actions (state/choices.ts holds its label and what it sends). */
function Act(props: {
  action: PromptAction | undefined;
  tone: "primary" | "secondary";
  busy: Choice["kind"] | undefined;
  onAnswer: (choice: Choice) => void;
  onOpen?: () => void;
  class?: string;
}) {
  const { action } = props;
  if (!action) return null;
  const { choice } = action;
  return (
    <ActionButton
      tone={props.tone}
      class={props.class}
      busy={choice !== null && props.busy === choice.kind}
      disabled={props.busy !== undefined || !action.enabled}
      onClick={() => (choice ? props.onAnswer(choice) : props.onOpen?.())}
    >
      {action.label}
    </ActionButton>
  );
}

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");

/** The lines of a diff side; a trailing newline doesn't add an empty line. */
const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

// ---- tool permission ----

function ToolDetail({ name, input }: { name: string; input: Record<string, unknown> }) {
  switch (name) {
    case "Bash":
      return (
        <>
          {str(input, "description") && <p class="pc-note">{str(input, "description")}</p>}
          <pre class="code pc-code">
            <code>{str(input, "command")}</code>
          </pre>
        </>
      );
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const edits =
        name === "MultiEdit" && Array.isArray(input.edits)
          ? (input.edits as Array<Record<string, unknown>>).filter((e) => e && typeof e === "object")
          : name === "Edit"
            ? [input]
            : [];
      return (
        <>
          <p class="pc-path mono">{shortPath(str(input, "file_path"))}</p>
          {name === "Write" ? (
            <pre class="code pc-code">
              <code>{str(input, "content")}</code>
            </pre>
          ) : (
            edits.map((edit, i) => (
              <pre key={i} class="code diff pc-code">
                <code>
                  {lines(str(edit, "old_string"))
                    .map((line, j) => (
                      <span key={`d${j}`} class="del">
                        {line || " "}
                        {"\n"}
                      </span>
                    ))}
                  {lines(str(edit, "new_string"))
                    .map((line, j) => (
                      <span key={`a${j}`} class="add">
                        {line || " "}
                        {"\n"}
                      </span>
                    ))}
                </code>
              </pre>
            ))
          )}
        </>
      );
    }
    case "Read":
    case "NotebookEdit":
      return <p class="pc-path mono">{shortPath(str(input, "file_path") || str(input, "notebook_path"))}</p>;
    case "WebFetch":
      // Plain text on purpose: the URL comes from the session and is never made a link.
      return (
        <>
          <p class="pc-path mono">{str(input, "url")}</p>
          {str(input, "prompt") && <p class="pc-note">{str(input, "prompt")}</p>}
        </>
      );
    default: {
      const summary = toolSummary(name, input);
      const keys = Object.keys(input);
      return (
        <>
          {summary && <p class="pc-path mono">{summary}</p>}
          {keys.length > 0 && (
            <pre class="code pc-code">
              <code>{JSON.stringify(input, null, 2)}</code>
            </pre>
          )}
        </>
      );
    }
  }
}

function ToolCard({ pending, count, busy, error, macName, onAnswer }: PromptCardProps) {
  const [reason, setReason] = useState("");
  const locked = busy !== undefined;
  const actions = promptActions(pending, { reason });
  const deny = actionOf(actions, "deny");
  return (
    <Frame
      kind="tool"
      count={count}
      createdAt={pending.createdAt}
      error={error}
      macName={macName}
      title={
        <>
          Allow <code class="pc-tool">{toolLabel(pending.toolName)}</code>?
        </>
      }
      actions={
        <>
          <Act action={actionOf(actions, "allow")} tone="primary" busy={busy} onAnswer={onAnswer} />
          <Act action={actionOf(actions, "allowAlways")} tone="secondary" busy={busy} onAnswer={onAnswer} />
          <form
            class="pc-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked && deny?.choice) onAnswer(deny.choice);
            }}
          >
            <input
              class="field"
              type="text"
              value={reason}
              onInput={(e) => setReason(e.currentTarget.value)}
              placeholder="Tell Claude what to do instead"
              aria-label="Reason for No (optional)"
              enterkeyhint="send"
              autocomplete="off"
              disabled={locked}
            />
            <Act action={deny} tone="secondary" class="btn-no" busy={busy} onAnswer={onAnswer} />
          </form>
        </>
      }
    >
      {pending.reason && <p class="pc-reason">{pending.reason}</p>}
      <ToolDetail name={pending.toolName} input={pending.input} />
    </Frame>
  );
}

// ---- questions (AskUserQuestion) ----

function QuestionCard({ pending, count, busy, error, macName, onAnswer }: PromptCardProps) {
  const questions = useMemo(() => parseQuestions(pending.input), [pending.input]);
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => emptyDraft()));
  const otherInput = useRef<HTMLInputElement>(null);
  const locked = busy !== undefined;
  const submit = actionOf(promptActions(pending, { drafts }), "submit");
  const question: Question | undefined = questions[page];
  const draft = drafts[page] ?? emptyDraft();

  // A layout effect, so the focus happens in the tap's own turn (iOS opens the keyboard only then).
  useLayoutEffect(() => {
    if (draft.other) otherInput.current?.focus({ preventScroll: true });
  }, [draft.other, page]);

  if (!question) {
    return (
      <Frame kind="question" count={count} createdAt={pending.createdAt} error={error} macName={macName} title="Claude has a question" actions={null}>
        <p class="pc-note">This question can't be shown here. Answer it in VS Code.</p>
      </Frame>
    );
  }

  const update = (next: QuestionDraft, advance = false) => {
    const all = drafts.map((d, i) => (i === page ? next : d));
    setDrafts(all);
    if (advance && !question.multiSelect) {
      // Like VS Code: picking an answer moves on to the next unanswered question.
      const nextOpen = questions.findIndex((q, i) => i > page && !isAnswered(q, all[i]));
      if (nextOpen >= 0) setTimeout(() => setPage(nextOpen), 180);
    }
  };

  return (
    <Frame
      kind="question"
      count={count}
      createdAt={pending.createdAt}
      error={error}
      macName={macName}
      title={questions.length > 1 ? `Claude has ${questions.length} questions` : "Claude has a question"}
      tabs={
        questions.length > 1 ? (
          <div class="pc-tabs" role="tablist" aria-label="Questions">
            {questions.map((q, i) => (
              <button
                type="button"
                key={i}
                role="tab"
                aria-selected={i === page}
                class={`pc-tab ${i === page ? "on" : ""} ${isAnswered(q, drafts[i]) ? "answered" : ""}`}
                onClick={() => setPage(i)}
              >
                {isAnswered(q, drafts[i]) && <Check size={12} stroke={2.8} />}
                <span>{q.header || `Question ${i + 1}`}</span>
              </button>
            ))}
          </div>
        ) : null
      }
      actions={<Act action={submit} tone="primary" busy={busy} onAnswer={onAnswer} />}
    >
      <div class="q" key={page}>
        {questions.length === 1 && question.header && <span class="q-header">{question.header}</span>}
        <p class="q-text">{question.question}</p>
        <p class="q-hint">{question.multiSelect ? "Pick any that apply" : "Pick one"}</p>
        <div class="q-options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
          {question.options.map((option) => {
            const on = draft.selected.includes(option.label);
            return (
              <button
                type="button"
                key={option.label}
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                class={`q-option ${on ? "on" : ""}`}
                disabled={locked}
                onClick={() => update(pick(question, draft, option.label), !on)}
              >
                <span class={`q-mark ${question.multiSelect ? "box" : "radio"}`} aria-hidden="true">
                  {on && (question.multiSelect ? <Check size={12} stroke={3} /> : <span class="q-dot" />)}
                </span>
                <span class="q-label">
                  <span class="q-label-text">{option.label}</span>
                  {option.description && <span class="q-desc">{option.description}</span>}
                </span>
              </button>
            );
          })}
          <div class={`q-option q-other ${draft.other ? "on" : ""}`}>
            <button
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={draft.other}
              class="q-other-toggle"
              disabled={locked}
              onClick={() => update(setOther(question, draft, question.multiSelect ? !draft.other : true))}
            >
              <span class={`q-mark ${question.multiSelect ? "box" : "radio"}`} aria-hidden="true">
                {draft.other && (question.multiSelect ? <Check size={12} stroke={3} /> : <span class="q-dot" />)}
              </span>
              <span class="q-label">
                <span class="q-label-text">Other</span>
              </span>
            </button>
            {draft.other && (
              <input
                ref={otherInput}
                class="field q-other-field"
                type="text"
                value={draft.otherText}
                placeholder="Type your answer"
                aria-label="Your answer"
                autocomplete="off"
                enterkeyhint="done"
                disabled={locked}
                onInput={(e) => update({ ...draft, otherText: e.currentTarget.value })}
              />
            )}
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ---- plan approval (ExitPlanMode) ----

function PlanCard({ pending, count, busy, error, macName, onAnswer }: PromptCardProps) {
  const [feedback, setFeedback] = useState("");
  const locked = busy !== undefined;
  const plan = str(pending.input, "plan");
  const actions = promptActions(pending, { feedback });
  const keepPlanning = actionOf(actions, "keepPlanning");
  return (
    <Frame
      kind="plan"
      count={count}
      createdAt={pending.createdAt}
      error={error}
      macName={macName}
      title="Ready to code?"
      actions={
        <>
          <Act action={actionOf(actions, "approveAuto")} tone="primary" busy={busy} onAnswer={onAnswer} />
          <Act action={actionOf(actions, "approveManual")} tone="secondary" busy={busy} onAnswer={onAnswer} />
          <form
            class="pc-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked && keepPlanning?.choice) onAnswer(keepPlanning.choice);
            }}
          >
            <input
              class="field"
              type="text"
              value={feedback}
              onInput={(e) => setFeedback(e.currentTarget.value)}
              placeholder="What should change? (optional)"
              aria-label="Feedback for the plan (optional)"
              enterkeyhint="send"
              autocomplete="off"
              disabled={locked}
            />
            <Act action={keepPlanning} tone="secondary" busy={busy} onAnswer={onAnswer} />
          </form>
        </>
      }
    >
      <div class="pc-plan">{plan ? <Markdown text={plan} /> : <p class="pc-note">The plan is empty.</p>}</div>
    </Frame>
  );
}

// ---- dialogs only VS Code can answer ----

function DialogCard({ pending, count, busy, error, macName, onAnswer, onOpenOnMac }: PromptCardProps) {
  const actions = promptActions(pending);
  const kind = pending.dialogKind ? pending.dialogKind.replace(/_/g, " ") : "";
  return (
    <Frame
      kind="dialog"
      count={count}
      createdAt={pending.createdAt}
      error={error}
      macName={macName}
      title={"Claude Code needs an answer in VS\u00a0Code"}
      actions={
        <>
          <Act action={actionOf(actions, "openInVsCode")} tone="primary" busy={busy} onAnswer={onAnswer} onOpen={onOpenOnMac} />
          <Act action={actionOf(actions, "cancel")} tone="secondary" busy={busy} onAnswer={onAnswer} />
        </>
      }
    >
      <p class="pc-note">
        This prompt{kind ? <> (<span class="mono">{kind}</span>)</> : null} can only be answered on {macName}. “Answer this in VS&nbsp;Code” brings
        the session to the front there.
      </p>
    </Frame>
  );
}
