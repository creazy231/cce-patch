// The question form (AskUserQuestion): what counts as an answer, and the answers map the bridge expects.
// Same rules as VS Code: every question needs an answer before "Submit answers"; several picks are joined
// with ", " in option order; "Other" is replaced by the typed text.

import type { Question, QuestionOption } from "../lib/protocol";

/** What the person picked for one question so far. */
export interface QuestionDraft {
  /** Labels of the picked options (one at most for a single-select question). */
  selected: string[];
  /** "Other" is picked. */
  other: boolean;
  otherText: string;
}

export const emptyDraft = (): QuestionDraft => ({ selected: [], other: false, otherText: "" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The questions of a pending prompt; malformed entries (a bridge of another version) are skipped. */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  const questions: Question[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== "string" || !raw.question.trim()) continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(raw.options)) {
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.label !== "string" || !option.label) continue;
        options.push(typeof option.description === "string" ? { label: option.label, description: option.description } : { label: option.label });
      }
    }
    questions.push({
      question: raw.question,
      header: typeof raw.header === "string" ? raw.header : "",
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** Taps an option: a single-select question takes it (and drops Other); a multi-select one toggles it. */
export function pick(question: Question, draft: QuestionDraft, label: string): QuestionDraft {
  if (!question.multiSelect) return { ...draft, selected: [label], other: false };
  const selected = draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label];
  return { ...draft, selected };
}

/** Turns "Other" on or off. On a single-select question it replaces the picked option. */
export function setOther(question: Question, draft: QuestionDraft, on: boolean): QuestionDraft {
  if (!question.multiSelect && on) return { ...draft, selected: [], other: true };
  return { ...draft, other: on };
}

export function isAnswered(question: Question, draft: QuestionDraft | undefined): boolean {
  if (!draft) return false;
  if (draft.other && !draft.otherText.trim()) return false;
  const picked = question.options.filter((o) => draft.selected.includes(o.label)).length;
  return picked > 0 || draft.other;
}

/** The answer text for one question: the picked labels in option order, then the Other text. */
export function answerText(question: Question, draft: QuestionDraft): string {
  const parts = question.options.filter((o) => draft.selected.includes(o.label)).map((o) => o.label);
  if (draft.other && draft.otherText.trim()) parts.push(draft.otherText.trim());
  return parts.join(", ");
}

/** `{[question text]: answer}` once every question is answered; null before that. */
export function buildAnswers(questions: readonly Question[], drafts: readonly (QuestionDraft | undefined)[]): Record<string, string> | null {
  if (questions.length === 0) return null;
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const draft = drafts[index];
    if (!draft || !isAnswered(question, draft)) return null;
    answers[question.question] = answerText(question, draft);
  }
  return answers;
}
