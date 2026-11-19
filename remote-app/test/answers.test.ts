import { describe, expect, test } from "bun:test";
import { answerText, buildAnswers, emptyDraft, isAnswered, parseQuestions, pick, setOther } from "../src/state/answers";
import type { Question } from "../src/lib/protocol";

const single: Question = {
  question: "Which date picker library should we use?",
  header: "Library",
  multiSelect: false,
  options: [{ label: "react-day-picker", description: "Small" }, { label: "A full UI kit" }, { label: "Keep our own" }],
};
const multi: Question = {
  question: "Which presets should the picker offer?",
  header: "Presets",
  multiSelect: true,
  options: [{ label: "Last 7 days" }, { label: "Last 30 days" }, { label: "This quarter" }],
};

describe("parseQuestions", () => {
  test("reads well-formed questions", () => {
    expect(parseQuestions({ questions: [single, multi] })).toEqual([single, multi]);
  });

  test("skips malformed entries and options, keeps descriptions only when they are strings", () => {
    const parsed = parseQuestions({
      questions: [
        null,
        { question: 7, options: [] },
        { question: "Q?", header: 3, multiSelect: "yes", options: [{ label: "A", description: 5 }, { nope: 1 }, "B"] },
      ],
    });
    expect(parsed).toEqual([{ question: "Q?", header: "", multiSelect: false, options: [{ label: "A" }] }]);
  });

  test("no questions array gives an empty list", () => {
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: "x" })).toEqual([]);
  });
});

describe("single select", () => {
  test("nothing picked is not an answer", () => {
    expect(isAnswered(single, emptyDraft())).toBe(false);
    expect(isAnswered(single, undefined)).toBe(false);
  });

  test("picking an option answers it, picking another replaces it", () => {
    let draft = pick(single, emptyDraft(), "react-day-picker");
    expect(isAnswered(single, draft)).toBe(true);
    expect(answerText(single, draft)).toBe("react-day-picker");
    draft = pick(single, draft, "Keep our own");
    expect(answerText(single, draft)).toBe("Keep our own");
  });

  test("Other needs text, and replaces the picked option", () => {
    let draft = pick(single, emptyDraft(), "A full UI kit");
    draft = setOther(single, draft, true);
    expect(draft.selected).toEqual([]);
    expect(isAnswered(single, draft)).toBe(false);
    draft = { ...draft, otherText: "  date-fns only  " };
    expect(isAnswered(single, draft)).toBe(true);
    expect(answerText(single, draft)).toBe("date-fns only");
  });

  test("picking an option after Other turns Other off", () => {
    let draft = setOther(single, emptyDraft(), true);
    draft = pick(single, draft, "Keep our own");
    expect(draft.other).toBe(false);
    expect(answerText(single, draft)).toBe("Keep our own");
  });
});

describe("multi select", () => {
  test("toggles options and joins the labels in option order", () => {
    let draft = pick(multi, emptyDraft(), "This quarter");
    draft = pick(multi, draft, "Last 7 days");
    expect(answerText(multi, draft)).toBe("Last 7 days, This quarter");
    draft = pick(multi, draft, "This quarter");
    expect(answerText(multi, draft)).toBe("Last 7 days");
    draft = pick(multi, draft, "Last 7 days");
    expect(isAnswered(multi, draft)).toBe(false);
  });

  test("Other adds the typed text at the end, and an empty Other blocks the answer", () => {
    let draft = pick(multi, emptyDraft(), "Last 30 days");
    draft = setOther(multi, draft, true);
    expect(draft.selected).toEqual(["Last 30 days"]);
    expect(isAnswered(multi, draft)).toBe(false);
    draft = { ...draft, otherText: "Year to date" };
    expect(isAnswered(multi, draft)).toBe(true);
    expect(answerText(multi, draft)).toBe("Last 30 days, Year to date");
  });

  test("Other alone with text is an answer", () => {
    const draft = { ...setOther(multi, emptyDraft(), true), otherText: "Rolling 90 days" };
    expect(isAnswered(multi, draft)).toBe(true);
    expect(answerText(multi, draft)).toBe("Rolling 90 days");
  });
});

describe("buildAnswers", () => {
  test("maps each question's text to its answer once every question is answered", () => {
    const drafts = [pick(single, emptyDraft(), "Keep our own"), pick(multi, pick(multi, emptyDraft(), "Last 7 days"), "Last 30 days")];
    expect(buildAnswers([single, multi], drafts)).toEqual({
      "Which date picker library should we use?": "Keep our own",
      "Which presets should the picker offer?": "Last 7 days, Last 30 days",
    });
  });

  test("returns null while a question is unanswered (Submit stays disabled)", () => {
    expect(buildAnswers([single, multi], [pick(single, emptyDraft(), "Keep our own")])).toBeNull();
    expect(buildAnswers([single, multi], [pick(single, emptyDraft(), "Keep our own"), emptyDraft()])).toBeNull();
  });

  test("no questions gives null", () => {
    expect(buildAnswers([], [])).toBeNull();
  });
});
