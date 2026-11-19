import { describe, expect, test } from "bun:test";
import type { Pending, Question } from "../src/lib/protocol";
import { emptyDraft, pick, setOther } from "../src/state/answers";
import { promptActions } from "../src/state/choices";

const base = { requestId: "r1", input: {}, canAlwaysAllow: false, createdAt: 1 };
const tool = (extra: Partial<Pending> = {}): Pending => ({ ...base, kind: "tool", toolName: "Bash", input: { command: "npm test" }, ...extra });

// Every button: its exact label and the exact Choice it sends (toStrictEqual: no stray `reason: undefined`).
describe("tool permission", () => {
  test("Yes, the offered always-label, No", () => {
    const actions = promptActions(tool({ canAlwaysAllow: true, alwaysLabel: "Yes, allow all edits this session" }));
    expect(actions).toStrictEqual([
      { id: "allow", label: "Yes", choice: { kind: "allow" }, enabled: true },
      { id: "allowAlways", label: "Yes, allow all edits this session", choice: { kind: "allowAlways" }, enabled: true },
      { id: "deny", label: "No", choice: { kind: "deny" }, enabled: true },
    ]);
  });

  test("no always-button unless the prompt offers it", () => {
    expect(promptActions(tool()).map((a) => a.id)).toEqual(["allow", "deny"]);
  });

  test("an always-button without a label from the Mac says VS Code's default", () => {
    expect(promptActions(tool({ canAlwaysAllow: true }))[1]).toStrictEqual({
      id: "allowAlways",
      label: "Yes, and don't ask again",
      choice: { kind: "allowAlways" },
      enabled: true,
    });
  });

  test("the generic always-label says where the rule is kept, in VS Code's words, when every suggestion keeps it in one place", () => {
    const rule = (destination: string) => ({ type: "addRules", rules: [{ toolName: "Read", ruleContent: "//work/demo/**" }], behavior: "allow", destination });
    const label = (extra: Partial<Pending>) => promptActions(tool({ canAlwaysAllow: true, alwaysLabel: "Yes, and don't ask again", ...extra }))[1]!.label;
    expect(label({ suggestions: [rule("session")] })).toBe("Yes, and don't ask again for this session");
    expect(label({ suggestions: [rule("localSettings"), rule("localSettings")] })).toBe("Yes, and don't ask again for this project (just you)");
    expect(label({ suggestions: [rule("projectSettings")] })).toBe("Yes, and don't ask again for this project (shared)");
    expect(label({ suggestions: [rule("userSettings")] })).toBe("Yes, and don't ask again for all projects");
    // Two places, an unknown one, or none: VS Code's plain default.
    expect(label({ suggestions: [rule("session"), rule("userSettings")] })).toBe("Yes, and don't ask again");
    expect(label({ suggestions: [rule("somewhere")] })).toBe("Yes, and don't ask again");
    expect(label({ suggestions: [] })).toBe("Yes, and don't ask again");
    // A label that names its scope already is left alone.
    expect(label({ alwaysLabel: "Yes, allow all edits this session", suggestions: [rule("session")] })).toBe("Yes, allow all edits this session");
  });

  test("No carries the typed reason, trimmed; a blank reason sends a plain No", () => {
    const deny = (reason: string) => promptActions(tool(), { reason }).find((a) => a.id === "deny")!.choice;
    expect(deny("  use pnpm instead  ")).toStrictEqual({ kind: "deny", reason: "use pnpm instead" });
    expect(deny("   ")).toStrictEqual({ kind: "deny" });
  });
});

describe("plan approval", () => {
  const plan: Pending = { ...base, kind: "plan", toolName: "ExitPlanMode", input: { plan: "## Plan" } };

  test("the three buttons and what they send", () => {
    expect(promptActions(plan)).toStrictEqual([
      { id: "approveAuto", label: "Yes, and auto-accept edits", choice: { kind: "approveAuto" }, enabled: true },
      { id: "approveManual", label: "Yes, manually approve edits", choice: { kind: "approveManual" }, enabled: true },
      { id: "keepPlanning", label: "No, keep planning", choice: { kind: "keepPlanning" }, enabled: true },
    ]);
  });

  test("No, keep planning carries the typed feedback", () => {
    const keep = promptActions(plan, { feedback: " split step 3 " }).find((a) => a.id === "keepPlanning")!;
    expect(keep.choice).toStrictEqual({ kind: "keepPlanning", feedback: "split step 3" });
  });
});

describe("dialog only VS Code can answer", () => {
  test("Answer this in VS Code opens the session (no answer), Cancel cancels", () => {
    const dialog: Pending = { ...base, kind: "dialog", toolName: "dialog", dialogKind: "refusal_fallback_prompt" };
    expect(promptActions(dialog)).toStrictEqual([
      { id: "openInVsCode", label: "Answer this in VS Code", choice: null, enabled: true },
      { id: "cancel", label: "Cancel", choice: { kind: "cancel" }, enabled: true },
    ]);
  });
});

describe("questions", () => {
  const questions: Question[] = [
    { question: "Which library?", header: "Library", multiSelect: false, options: [{ label: "react-day-picker" }, { label: "Keep our own" }] },
    { question: "Which presets?", header: "Presets", multiSelect: true, options: [{ label: "Last 7 days" }, { label: "Last 30 days" }] },
  ];
  const question: Pending = { ...base, kind: "question", toolName: "AskUserQuestion", input: { questions } };

  test("Submit answers stays disabled until every question has an answer", () => {
    expect(promptActions(question, { drafts: [pick(questions[0]!, emptyDraft(), "Keep our own")] })).toStrictEqual([
      { id: "submit", label: "Submit answers", choice: null, enabled: false },
    ]);
  });

  test("then it sends every question's answer", () => {
    const drafts = [
      pick(questions[0]!, emptyDraft(), "react-day-picker"),
      { ...setOther(questions[1]!, pick(questions[1]!, emptyDraft(), "Last 30 days"), true), otherText: "Year to date" },
    ];
    expect(promptActions(question, { drafts })).toStrictEqual([
      {
        id: "submit",
        label: "Submit answers",
        choice: { kind: "answers", answers: { "Which library?": "react-day-picker", "Which presets?": "Last 30 days, Year to date" } },
        enabled: true,
      },
    ]);
  });
});
