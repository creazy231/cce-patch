import { describe, expect, test } from "bun:test";
import { DENY, DENY_WITH_REASON, KEEP_PLANNING, buildAnswer, classifyPending } from "../lib/answers.js";

const NOW = 1763550000000;

// The host's request messages, as comms.send() gets them (docs/superpowers/specs/2026-11-19-phone-remote-design.md,
// "What exists today").
const toolRequest = (toolName: string, inputs: unknown, request: Record<string, unknown> = {}, requestId = "r-1") => ({
  type: "request",
  channelId: "ch-1",
  requestId,
  request: {
    type: "tool_permission_request",
    toolName,
    inputs,
    suggestions: [],
    toolUseId: "toolu_01",
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    ...request,
  },
});

const dialogRequest = (request: Record<string, unknown> = {}, requestId = "r-2") => ({
  type: "request",
  channelId: "ch-1",
  requestId,
  request: { type: "user_dialog_request", dialogKind: "auto_mode_server_fallback", payload: { model: "claude-test" }, toolUseID: "toolu_02", ...request },
});

const BASH_INPUT = { command: "npm test", description: "Run tests" };
const BASH_RULE = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" };
const ACCEPT_EDITS = { type: "setMode", mode: "acceptEdits", destination: "session" };

const QUESTIONS = [
  {
    question: "Which package manager?",
    header: "Package manager",
    multiSelect: false,
    options: [
      { label: "pnpm", description: "Fast, disk-efficient" },
      { label: "npm", description: "The default" },
    ],
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    multiSelect: true,
    options: [
      { label: "lint", description: "ESLint" },
      { label: "test", description: "The unit tests" },
    ],
  },
];
const PLAN_INPUT = { plan: "1. Split the module\n2. Add tests" };

const bashPending = (suggestions: unknown[] = [BASH_RULE], request: Record<string, unknown> = {}) =>
  classifyPending(toolRequest("Bash", BASH_INPUT, { suggestions, ...request }), NOW)!;
const questionPending = () => classifyPending(toolRequest("AskUserQuestion", { questions: QUESTIONS }), NOW)!;
const planPending = () => classifyPending(toolRequest("ExitPlanMode", PLAN_INPUT), NOW)!;
const dialogPending = () => classifyPending(dialogRequest(), NOW)!;

const allowResult = (updatedInput: unknown, updatedPermissions: unknown[] = []) => ({
  type: "tool_permission_response",
  result: { behavior: "allow", updatedInput, updatedPermissions },
});
const denyResult = (message: string, interrupt: boolean) => ({
  type: "tool_permission_response",
  result: { behavior: "deny", message, interrupt },
});

describe("the deny texts", () => {
  // copied from the extension (2.1.327); the model reads them, so a changed word is a changed behaviour
  test("DENY", () => {
    expect(DENY).toBe(
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    );
  });

  test("DENY_WITH_REASON", () => {
    expect(DENY_WITH_REASON).toBe(
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ",
    );
  });

  test("KEEP_PLANNING", () => {
    expect(KEEP_PLANNING).toBe("User chose to stay in plan mode and continue planning");
  });
});

describe("classifyPending: tools", () => {
  test("a Bash request with a rule to remember", () => {
    expect(classifyPending(toolRequest("Bash", BASH_INPUT, { suggestions: [BASH_RULE] }), NOW)).toStrictEqual({
      requestId: "r-1",
      kind: "tool",
      toolName: "Bash",
      input: BASH_INPUT,
      suggestions: [BASH_RULE],
      canAlwaysAllow: true,
      alwaysLabel: "Yes, and don't ask again",
      createdAt: NOW,
    });
  });

  test("createdAt is the time it is given", () => {
    expect(classifyPending(toolRequest("Bash", BASH_INPUT), 42)!.createdAt).toBe(42);
  });

  test("a lone setMode acceptEdits suggestion has its own label", () => {
    const pending = classifyPending(toolRequest("Edit", { file_path: "/work/demo/a.ts" }, { suggestions: [ACCEPT_EDITS] }), NOW)!;
    expect(pending.canAlwaysAllow).toBe(true);
    expect(pending.alwaysLabel).toBe("Yes, allow all edits this session");
  });

  test("setMode next to a rule, or another mode, gets the general label", () => {
    expect(bashPending([ACCEPT_EDITS, BASH_RULE]).alwaysLabel).toBe("Yes, and don't ask again");
    expect(bashPending([BASH_RULE, ACCEPT_EDITS]).alwaysLabel).toBe("Yes, and don't ask again");
    expect(bashPending([{ type: "setMode", mode: "default", destination: "session" }]).alwaysLabel).toBe("Yes, and don't ask again");
    expect(bashPending([ACCEPT_EDITS, ACCEPT_EDITS]).alwaysLabel).toBe("Yes, and don't ask again");
  });

  test("suppressAlwaysAllowRule turns the always option off, the suggestions stay", () => {
    const pending = bashPending([BASH_RULE], { suppressAlwaysAllowRule: true });
    expect(pending.canAlwaysAllow).toBe(false);
    expect(pending).not.toHaveProperty("alwaysLabel");
    expect(pending.suggestions).toEqual([BASH_RULE]);
  });

  test("without suggestions there is nothing to always allow", () => {
    for (const request of [{ suggestions: [] }, { suggestions: undefined }, { suggestions: null }, { suggestions: "nope" }]) {
      const pending = classifyPending(toolRequest("Bash", BASH_INPUT, request), NOW)!;
      expect(pending.canAlwaysAllow).toBe(false);
      expect(pending.suggestions).toEqual([]);
      expect(pending).not.toHaveProperty("alwaysLabel");
    }
  });

  test("reason is the request's reason, else the hook's", () => {
    expect(classifyPending(toolRequest("Bash", BASH_INPUT, { reason: "Claude wants to run tests", hookReason: "a hook" }), NOW)!.reason).toBe("Claude wants to run tests");
    expect(classifyPending(toolRequest("Bash", BASH_INPUT, { hookReason: "a hook asked" }), NOW)!.reason).toBe("a hook asked");
    expect(classifyPending(toolRequest("Bash", BASH_INPUT), NOW)).not.toHaveProperty("reason");
  });

  test("the input is the request's inputs, untouched", () => {
    const inputs = { command: "x".repeat(50000), nested: { list: [1, 2, 3] } };
    expect(classifyPending(toolRequest("Bash", inputs), NOW)!.input).toStrictEqual(inputs);
  });

  test("missing inputs are an empty object", () => {
    expect(classifyPending(toolRequest("Bash", undefined), NOW)!.input).toStrictEqual({});
  });
});

describe("classifyPending: a prompt a plugin raised", () => {
  // The webview treats `plugin !== undefined` like suppressAlwaysAllowRule and shows no always-allow button, but the
  // host still accepts the update, so the bridge is the only thing that keeps a phone from saving a rule VS Code withholds.
  // The host always sends the key: a string for a plugin's prompt, undefined for any other.
  const pluginPending = (plugin: unknown) =>
    classifyPending(toolRequest("mcp__demo__lookup", { query: "x" }, { suggestions: [BASH_RULE], plugin }), NOW)!;

  test("has no always-allow option, though it has suggestions", () => {
    const pending = pluginPending("demo@market");
    expect(pending.canAlwaysAllow).toBe(false);
    expect(pending).not.toHaveProperty("alwaysLabel");
    expect(pending.suggestions).toEqual([BASH_RULE]);
  });

  test("refuses allowAlways, and still allows and denies", () => {
    const pending = pluginPending("demo@market");
    expect(() => buildAnswer(pending, { kind: "allowAlways" })).toThrow("invalid_choice");
    expect(buildAnswer(pending, { kind: "allow" })).toStrictEqual({ response: allowResult({ query: "x" }) });
    expect(buildAnswer(pending, { kind: "deny" })).toStrictEqual({ response: denyResult(DENY, true) });
  });

  test("anything but undefined counts as a plugin, as in the webview", () => {
    for (const plugin of ["", "demo@market", null, 0, false]) expect(pluginPending(plugin).canAlwaysAllow).toBe(false);
  });

  test("a prompt whose plugin is undefined keeps the option", () => {
    const pending = pluginPending(undefined);
    expect(pending.canAlwaysAllow).toBe(true);
    expect(pending.alwaysLabel).toBe("Yes, and don't ask again");
    expect(buildAnswer(pending, { kind: "allowAlways" })).toStrictEqual({ response: allowResult({ query: "x" }, [BASH_RULE]) });
  });

  test("a request without the plugin key at all keeps the option too", () => {
    expect(bashPending([BASH_RULE]).canAlwaysAllow).toBe(true);
  });
});

describe("classifyPending: question, plan and dialog", () => {
  test("AskUserQuestion is a question, and never always-allowable", () => {
    const pending = classifyPending(toolRequest("AskUserQuestion", { questions: QUESTIONS }, { suggestions: [BASH_RULE] }), NOW)!;
    expect(pending.kind).toBe("question");
    expect(pending.toolName).toBe("AskUserQuestion");
    expect(pending.input).toStrictEqual({ questions: QUESTIONS });
    expect(pending.canAlwaysAllow).toBe(false);
    expect(pending).not.toHaveProperty("alwaysLabel");
  });

  test("ExitPlanMode is a plan", () => {
    const pending = classifyPending(toolRequest("ExitPlanMode", PLAN_INPUT, { suggestions: [ACCEPT_EDITS] }), NOW)!;
    expect(pending.kind).toBe("plan");
    expect(pending.toolName).toBe("ExitPlanMode");
    expect(pending.input).toStrictEqual(PLAN_INPUT);
    expect(pending.canAlwaysAllow).toBe(false);
  });

  test("a dialog uses its kind as the tool name and its payload as the input", () => {
    expect(classifyPending(dialogRequest(), NOW)).toStrictEqual({
      requestId: "r-2",
      kind: "dialog",
      toolName: "auto_mode_server_fallback",
      input: { model: "claude-test" },
      suggestions: [],
      canAlwaysAllow: false,
      createdAt: NOW,
      dialogKind: "auto_mode_server_fallback",
    });
  });

  test("a dialog has a reason when it was given one", () => {
    expect(classifyPending(dialogRequest({ reason: "the server is busy" }), NOW)!.reason).toBe("the server is busy");
    expect(classifyPending(dialogRequest({ hookReason: "a hook" }), NOW)!.reason).toBe("a hook");
  });

  test("a dialog without a payload has an empty input", () => {
    expect(classifyPending(dialogRequest({ payload: undefined }), NOW)!.input).toStrictEqual({});
  });
});

describe("classifyPending: request types", () => {
  test("a request of another type is not a prompt, even when it names a tool", () => {
    const message = { type: "request", channelId: "ch-1", requestId: "r-3", request: { type: "something_else", toolName: "Bash", inputs: BASH_INPUT } };
    expect(classifyPending(message, NOW)).toBeNull();
  });

  test("a request that names a tool but has no type is read as a tool request", () => {
    const message = { type: "request", channelId: "ch-1", requestId: "r-3", request: { toolName: "Bash", inputs: BASH_INPUT, suggestions: [BASH_RULE] } };
    expect(classifyPending(message, NOW)).toMatchObject({ kind: "tool", toolName: "Bash", canAlwaysAllow: true });
  });

  test("createdAt defaults to the clock", () => {
    const before = Date.now();
    const createdAt = classifyPending(toolRequest("Bash", BASH_INPUT))!.createdAt;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("classifyPending: what is not a prompt", () => {
  test("other requests, and messages that can't be answered, are null", () => {
    const cases: unknown[] = [
      { type: "request", channelId: "ch-1", requestId: "r-3", request: { type: "set_permission_mode", mode: "default" } },
      { type: "request", channelId: "ch-1", requestId: "r-3" },
      { type: "request", channelId: "ch-1", request: { type: "tool_permission_request", toolName: "Bash", inputs: BASH_INPUT } },
      { type: "request", channelId: "ch-1", requestId: "r-3", request: { type: "tool_permission_request", inputs: BASH_INPUT } },
      { type: "request", channelId: "ch-1", requestId: "r-3", request: { type: "user_dialog_request", payload: {} } },
      null,
      undefined,
      "request",
    ];
    for (const message of cases) expect(classifyPending(message as any, NOW)).toBeNull();
  });
});

describe("buildAnswer: tools", () => {
  test("allow", () => {
    const pending = bashPending();
    expect(buildAnswer(pending, { kind: "allow" })).toStrictEqual({ response: allowResult(BASH_INPUT) });
  });

  test("allowAlways sends the suggestions", () => {
    expect(buildAnswer(bashPending([BASH_RULE]), { kind: "allowAlways" })).toStrictEqual({ response: allowResult(BASH_INPUT, [BASH_RULE]) });
  });

  test("allowAlways with a session setMode also asks for that mode", () => {
    expect(buildAnswer(bashPending([ACCEPT_EDITS]), { kind: "allowAlways" })).toStrictEqual({
      response: allowResult(BASH_INPUT, [ACCEPT_EDITS]),
      mode: "acceptEdits",
    });
    expect(buildAnswer(bashPending([BASH_RULE, ACCEPT_EDITS]), { kind: "allowAlways" })).toStrictEqual({
      response: allowResult(BASH_INPUT, [BASH_RULE, ACCEPT_EDITS]),
      mode: "acceptEdits",
    });
  });

  test("the mode is the one of the setMode suggestion", () => {
    const plan = { type: "setMode", mode: "plan", destination: "session" };
    expect(buildAnswer(bashPending([plan]), { kind: "allowAlways" }).mode).toBe("plan");
  });

  test("a setMode that is saved somewhere else changes no mode now", () => {
    const saved = { type: "setMode", mode: "acceptEdits", destination: "localSettings" };
    const answer = buildAnswer(bashPending([saved]), { kind: "allowAlways" });
    expect(answer).toStrictEqual({ response: allowResult(BASH_INPUT, [saved]) });
  });

  test("allowAlways without suggestions throws", () => {
    expect(() => buildAnswer(bashPending([]), { kind: "allowAlways" })).toThrow("invalid_choice");
  });

  test("allowAlways throws when the request suppresses the rule", () => {
    expect(() => buildAnswer(bashPending([BASH_RULE], { suppressAlwaysAllowRule: true }), { kind: "allowAlways" })).toThrow("invalid_choice");
  });

  test("allowAlways works on a pending that has suggestions and says nothing about canAlwaysAllow", () => {
    const pending = { requestId: "r-9", kind: "tool", toolName: "Bash", input: BASH_INPUT, suggestions: [BASH_RULE], createdAt: NOW };
    expect(buildAnswer(pending as any, { kind: "allowAlways" })).toStrictEqual({ response: allowResult(BASH_INPUT, [BASH_RULE]) });
  });

  test("allowAlways throws for a pending with nothing to remember, whatever it says about canAlwaysAllow", () => {
    for (const extra of [{}, { canAlwaysAllow: true }, { suggestions: [] }, { suggestions: [], canAlwaysAllow: true }, { suggestions: "nope", canAlwaysAllow: true }]) {
      const pending = { requestId: "r-9", kind: "tool", toolName: "Bash", input: BASH_INPUT, createdAt: NOW, ...extra };
      expect(() => buildAnswer(pending as any, { kind: "allowAlways" })).toThrow("invalid_choice");
    }
  });

  test("a pending without an input answers with an empty one", () => {
    const pending = { requestId: "r-9", kind: "tool", toolName: "Bash", suggestions: [], canAlwaysAllow: false, createdAt: NOW };
    expect(buildAnswer(pending as any, { kind: "allow" })).toStrictEqual({ response: allowResult({}) });
  });

  test("the answer does not share its suggestions array with the pending", () => {
    const pending = bashPending([BASH_RULE]);
    const answer = buildAnswer(pending, { kind: "allowAlways" });
    (answer.response.result as any).updatedPermissions.push("x");
    expect(pending.suggestions).toEqual([BASH_RULE]);
  });

  test("deny", () => {
    expect(buildAnswer(bashPending(), { kind: "deny" })).toStrictEqual({ response: denyResult(DENY, true) });
  });

  test("deny with a reason", () => {
    expect(buildAnswer(bashPending(), { kind: "deny", reason: "use pnpm" })).toStrictEqual({ response: denyResult(DENY_WITH_REASON + "use pnpm", false) });
  });

  test("a reason is trimmed, and a blank one is no reason", () => {
    expect(buildAnswer(bashPending(), { kind: "deny", reason: "  use pnpm \n" }).response.result).toEqual({ behavior: "deny", message: DENY_WITH_REASON + "use pnpm", interrupt: false });
    for (const reason of ["", "   ", "\n\t", null, undefined]) {
      expect(buildAnswer(bashPending(), { kind: "deny", reason } as any)).toStrictEqual({ response: denyResult(DENY, true) });
    }
  });

  test("a reason that is not text is refused", () => {
    for (const reason of [5, true, {}, ["use pnpm"]]) {
      expect(() => buildAnswer(bashPending(), { kind: "deny", reason } as any)).toThrow("invalid_choice");
    }
  });

  test("the answer works from a pending that came through JSON, like the hub's", () => {
    const pending = JSON.parse(JSON.stringify(bashPending()));
    expect(buildAnswer(pending, { kind: "allow" })).toStrictEqual({ response: allowResult(BASH_INPUT) });
  });

  test("question and plan choices on a tool are refused", () => {
    for (const choice of [
      { kind: "answers", answers: {} },
      { kind: "approveAuto" },
      { kind: "approveManual" },
      { kind: "keepPlanning" },
      { kind: "cancel" },
    ]) {
      expect(() => buildAnswer(bashPending(), choice as any)).toThrow("invalid_choice");
    }
  });
});

describe("buildAnswer: questions", () => {
  const ANSWERS = { "Which package manager?": "pnpm", "Which checks should run?": "lint, test" };

  test("answers go into updatedInput next to the questions", () => {
    expect(buildAnswer(questionPending(), { kind: "answers", answers: ANSWERS })).toStrictEqual({
      response: allowResult({ questions: QUESTIONS, answers: ANSWERS }),
    });
  });

  test("an answer typed for Other is passed on as it is", () => {
    const answers = { "Which package manager?": "yarn  berry ", "Which checks should run?": " lint, typecheck" };
    const answer = buildAnswer(questionPending(), { kind: "answers", answers });
    expect((answer.response.result as any).updatedInput.answers).toStrictEqual(answers);
  });

  test("a question named like an Object method needs a real answer of its own", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const pending = classifyPending(toolRequest("AskUserQuestion", { questions: [{ question: name, header: "h", multiSelect: false, options: [] }] }), NOW)!;
      expect(() => buildAnswer(pending, { kind: "answers", answers: {} })).toThrow("invalid_choice");
      const answers = JSON.parse(`{${JSON.stringify(name)}: "yes"}`); // JSON.parse makes __proto__ an own key
      const answer = buildAnswer(pending, { kind: "answers", answers });
      const given = (answer.response.result as any).updatedInput.answers;
      expect(Object.keys(given)).toEqual([name]);
      expect(Object.getOwnPropertyDescriptor(given, name)!.value).toBe("yes");
    }
  });

  test("a missing answer throws", () => {
    expect(() => buildAnswer(questionPending(), { kind: "answers", answers: { "Which package manager?": "pnpm" } })).toThrow("invalid_choice");
    expect(() => buildAnswer(questionPending(), { kind: "answers", answers: {} })).toThrow("invalid_choice");
  });

  test("a blank answer throws", () => {
    for (const blank of ["", "   ", "\n"]) {
      expect(() => buildAnswer(questionPending(), { kind: "answers", answers: { ...ANSWERS, "Which checks should run?": blank } })).toThrow("invalid_choice");
    }
  });

  test("an answer that is not text throws", () => {
    for (const bad of [5, null, ["lint"], { label: "lint" }]) {
      expect(() => buildAnswer(questionPending(), { kind: "answers", answers: { ...ANSWERS, "Which checks should run?": bad } } as any)).toThrow("invalid_choice");
    }
  });

  test("answers must be an object", () => {
    for (const answers of [undefined, null, "pnpm", ["pnpm", "lint"], 5]) {
      expect(() => buildAnswer(questionPending(), { kind: "answers", answers } as any)).toThrow("invalid_choice");
    }
  });

  test("answers to questions that were not asked are dropped", () => {
    const answer = buildAnswer(questionPending(), { kind: "answers", answers: { ...ANSWERS, "Something else?": "yes" } });
    expect(answer).toStrictEqual({ response: allowResult({ questions: QUESTIONS, answers: ANSWERS }) });
  });

  test("questions that can't be read throw", () => {
    for (const inputs of [{}, { questions: [] }, { questions: "x" }, { questions: [{ header: "no question text" }] }, { questions: [null] }]) {
      const pending = classifyPending(toolRequest("AskUserQuestion", inputs), NOW)!;
      expect(() => buildAnswer(pending, { kind: "answers", answers: ANSWERS })).toThrow("invalid_choice");
      expect(() => buildAnswer(pending, { kind: "answers", answers: { ...ANSWERS, undefined: "x", null: "y" } })).toThrow("invalid_choice");
    }
  });

  test("deny works like it does for a tool", () => {
    expect(buildAnswer(questionPending(), { kind: "deny" })).toStrictEqual({ response: denyResult(DENY, true) });
    expect(buildAnswer(questionPending(), { kind: "deny", reason: "not now" })).toStrictEqual({ response: denyResult(DENY_WITH_REASON + "not now", false) });
  });

  test("a tool choice on a question throws", () => {
    expect(() => buildAnswer(questionPending(), { kind: "allow" })).toThrow("invalid_choice");
    expect(() => buildAnswer(questionPending(), { kind: "allowAlways" })).toThrow("invalid_choice");
  });

  test("plan and dialog choices on a question throw", () => {
    for (const choice of [{ kind: "approveAuto" }, { kind: "approveManual" }, { kind: "keepPlanning" }, { kind: "cancel" }]) {
      expect(() => buildAnswer(questionPending(), choice as any)).toThrow("invalid_choice");
    }
  });
});

describe("buildAnswer: plans", () => {
  test("approveAuto sets acceptEdits first", () => {
    expect(buildAnswer(planPending(), { kind: "approveAuto" })).toStrictEqual({ response: allowResult(PLAN_INPUT), mode: "acceptEdits" });
  });

  test("approveAuto sets auto when the window has auto mode", () => {
    expect(buildAnswer(planPending(), { kind: "approveAuto" }, { autoMode: true })).toStrictEqual({ response: allowResult(PLAN_INPUT), mode: "auto" });
    expect(buildAnswer(planPending(), { kind: "approveAuto" }, { autoMode: false }).mode).toBe("acceptEdits");
    expect(buildAnswer(planPending(), { kind: "approveAuto" }, {}).mode).toBe("acceptEdits");
  });

  test("approveManual goes back to default mode and remembers that for the session", () => {
    expect(buildAnswer(planPending(), { kind: "approveManual" })).toStrictEqual({
      response: allowResult(PLAN_INPUT, [{ type: "setMode", mode: "default", destination: "session" }]),
      mode: "default",
    });
  });

  test("autoMode changes nothing for approveManual", () => {
    expect(buildAnswer(planPending(), { kind: "approveManual" }, { autoMode: true }).mode).toBe("default");
  });

  test("keepPlanning", () => {
    expect(buildAnswer(planPending(), { kind: "keepPlanning" })).toStrictEqual({ response: denyResult(KEEP_PLANNING, true) });
  });

  test("keepPlanning with feedback", () => {
    expect(buildAnswer(planPending(), { kind: "keepPlanning", feedback: "split it" })).toStrictEqual({ response: denyResult(DENY_WITH_REASON + "split it", false) });
  });

  test("blank feedback is no feedback, and feedback must be text", () => {
    for (const feedback of ["", "  ", null, undefined]) {
      expect(buildAnswer(planPending(), { kind: "keepPlanning", feedback } as any)).toStrictEqual({ response: denyResult(KEEP_PLANNING, true) });
    }
    expect(() => buildAnswer(planPending(), { kind: "keepPlanning", feedback: 5 } as any)).toThrow("invalid_choice");
  });

  test("tool, question and dialog choices on a plan throw", () => {
    for (const choice of [{ kind: "allow" }, { kind: "allowAlways" }, { kind: "deny" }, { kind: "answers", answers: {} }, { kind: "cancel" }]) {
      expect(() => buildAnswer(planPending(), choice as any)).toThrow("invalid_choice");
    }
  });
});

describe("buildAnswer: dialogs", () => {
  test("cancel", () => {
    expect(buildAnswer(dialogPending(), { kind: "cancel" })).toStrictEqual({ response: { type: "user_dialog_response", result: { behavior: "cancelled" } } });
  });

  test("every other choice throws", () => {
    for (const choice of [{ kind: "allow" }, { kind: "allowAlways" }, { kind: "deny" }, { kind: "answers", answers: {} }, { kind: "approveAuto" }, { kind: "keepPlanning" }]) {
      expect(() => buildAnswer(dialogPending(), choice as any)).toThrow("invalid_choice");
    }
  });
});

describe("buildAnswer: bad input", () => {
  test("a choice that is not a choice throws invalid_choice", () => {
    for (const choice of [undefined, null, "allow", 5, [], {}, { kind: 5 }, { kind: "nonsense" }, { kind: "ALLOW" }]) {
      let error: any;
      try {
        buildAnswer(bashPending(), choice as any);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("invalid_choice");
    }
  });

  test("a pending of an unknown kind throws", () => {
    const pending = { ...bashPending(), kind: "mystery" };
    expect(() => buildAnswer(pending as any, { kind: "allow" })).toThrow("invalid_choice");
    expect(() => buildAnswer(null as any, { kind: "allow" })).toThrow("invalid_choice");
  });

  test("does not change the pending", () => {
    const pending = bashPending([BASH_RULE, ACCEPT_EDITS]);
    const before = JSON.stringify(pending);
    buildAnswer(pending, { kind: "allowAlways" });
    buildAnswer(pending, { kind: "allow" });
    buildAnswer(pending, { kind: "deny", reason: "no" });
    expect(JSON.stringify(pending)).toBe(before);
  });
});
