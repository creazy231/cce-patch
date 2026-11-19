// What each prompt button says and sends. The labels are VS Code's; the bridge turns the Choice into the
// exact payload VS Code would send. PromptCard draws these; the tests pin every label to its Choice.

import type { Choice, Pending } from "../lib/protocol";
import { buildAnswers, parseQuestions, type QuestionDraft } from "./answers";

export type ActionId = "allow" | "allowAlways" | "deny" | "approveAuto" | "approveManual" | "keepPlanning" | "openInVsCode" | "cancel" | "submit";

export interface PromptAction {
  id: ActionId;
  label: string;
  /** What the button sends; null when it sends nothing ("Answer this in VS Code" opens the session instead). */
  choice: Choice | null;
  /** False while it can't be pressed (not every question answered yet). */
  enabled: boolean;
}

/** What the person typed or picked on the card so far. */
export interface Typed {
  /** The tool prompt's reason field (sent with No). */
  reason?: string;
  /** The plan's feedback field (sent with No, keep planning). */
  feedback?: string;
  /** The question form's picks, one per question. */
  drafts?: readonly (QuestionDraft | undefined)[];
}

const action = (id: ActionId, label: string, choice: Choice | null, enabled = true): PromptAction => ({ id, label, choice, enabled });

/** VS Code's default always-label, and its words for where an always-allow rule is kept ("Yes, allow … for <where>"). */
const ALWAYS = "Yes, and don't ask again";
const SCOPES: Readonly<Record<string, string>> = {
  session: "this session",
  localSettings: "this project (just you)",
  projectSettings: "this project (shared)",
  userSettings: "all projects",
};

/** Where the always-allow choice keeps its rule, in VS Code's words: when every suggestion keeps it in the same known place. */
function alwaysScope(suggestions: unknown): string | null {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
  const places = new Set(suggestions.map((s) => (s && typeof s === "object" ? (s as { destination?: unknown }).destination : undefined)));
  const [place] = places;
  return places.size === 1 && typeof place === "string" && Object.hasOwn(SCOPES, place) ? SCOPES[place]! : null;
}

/** The always-button's label: the Mac's, or VS Code's default; the default says where the rule is kept when that is clear. */
function alwaysLabel(pending: Pending): string {
  const label = pending.alwaysLabel || ALWAYS;
  const scope = label === ALWAYS ? alwaysScope(pending.suggestions) : null;
  return scope ? `${label} for ${scope}` : label;
}

export function promptActions(pending: Pending, typed: Typed = {}): PromptAction[] {
  switch (pending.kind) {
    case "question": {
      const answers = buildAnswers(parseQuestions(pending.input), typed.drafts ?? []);
      return [action("submit", "Submit answers", answers ? { kind: "answers", answers } : null, answers !== null)];
    }
    case "plan": {
      const feedback = typed.feedback?.trim();
      return [
        action("approveAuto", "Yes, and auto-accept edits", { kind: "approveAuto" }),
        action("approveManual", "Yes, manually approve edits", { kind: "approveManual" }),
        action("keepPlanning", "No, keep planning", feedback ? { kind: "keepPlanning", feedback } : { kind: "keepPlanning" }),
      ];
    }
    case "dialog":
      return [action("openInVsCode", "Answer this in VS Code", null), action("cancel", "Cancel", { kind: "cancel" })];
    default: {
      const reason = typed.reason?.trim();
      return [
        action("allow", "Yes", { kind: "allow" }),
        ...(pending.canAlwaysAllow ? [action("allowAlways", alwaysLabel(pending), { kind: "allowAlways" })] : []),
        action("deny", "No", reason ? { kind: "deny", reason } : { kind: "deny" }),
      ];
    }
  }
}

/** One action by id, for laying the card out. */
export function actionOf(actions: readonly PromptAction[], id: ActionId): PromptAction | undefined {
  return actions.find((a) => a.id === id);
}
