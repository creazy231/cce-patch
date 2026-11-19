// @ts-check
'use strict';
// Prompts and their answers. Pure functions, no I/O.
//
//   classifyPending(requestMsg, now)    a `request` message of the host -> the prompt the phone shows
//   buildAnswer(pending, choice, opts)  the phone's choice -> the exact payload VS Code itself would send
//
// The payloads are the ones the webview's own buttons produce (Claude Code extension 2.1.327), so the
// CLI cannot tell a phone from VS Code. The phone sends a structured choice and the bridge builds the
// payload: it never forwards one the phone made up.

// Copied from the extension. The model reads these: a changed word is a changed behaviour.
const DENY = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
// Ends in a space; the reason follows.
const DENY_WITH_REASON = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ";
const KEEP_PLANNING = 'User chose to stay in plan mode and continue planning';

const ASK_USER_QUESTION = 'AskUserQuestion';
const EXIT_PLAN_MODE = 'ExitPlanMode';
const ALWAYS_LABEL = "Yes, and don't ask again";
const ALWAYS_LABEL_EDITS = 'Yes, allow all edits this session';

/**
 * A prompt waiting for the user, as the phone sees it (spec, "Bridge: phone protocol"). `input` is
 * what the tool was called with (a plan's text, the questions, ...), exactly as the host sent it:
 * an approved prompt sends it back as `updatedInput`, so it must not be shortened.
 * @typedef {{ requestId: string, kind: 'tool' | 'question' | 'plan' | 'dialog', toolName: string,
 *   input: Record<string, any>, suggestions: any[], canAlwaysAllow: boolean, alwaysLabel?: string,
 *   reason?: string, createdAt: number, dialogKind?: string }} Pending
 */
/**
 * What the phone chooses (`answer.choice` of the protocol).
 * @typedef {{ kind: 'allow' } | { kind: 'allowAlways' } | { kind: 'deny', reason?: string }
 *   | { kind: 'answers', answers: Record<string, string> }
 *   | { kind: 'approveAuto' } | { kind: 'approveManual' } | { kind: 'keepPlanning', feedback?: string }
 *   | { kind: 'cancel' }} Choice
 */
/**
 * `response` is the `response` of `{type: 'response', requestId, response}`; `mode`, when set, is a
 * permission mode to apply (`set_permission_mode`) before the response goes out.
 * @typedef {{ response: { type: 'tool_permission_response' | 'user_dialog_response', result: Record<string, any> }, mode?: string }} Answer
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} a string with something in it */
function isText(value) {
  return typeof value === 'string' && value !== '';
}

/** @param {unknown} value @returns {Record<string, any>} */
function asObject(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {Record<string, any>} request
 * @returns {string | undefined}
 */
function reasonOf(request) {
  return [request.reason, request.hookReason].find(isText);
}

/** The label of the "always" button: edits for the session when that is all the suggestion does. @param {any[]} suggestions */
function alwaysLabelOf(suggestions) {
  const only = suggestions.length === 1 ? suggestions[0] : undefined;
  return isRecord(only) && only.type === 'setMode' && only.mode === 'acceptEdits' ? ALWAYS_LABEL_EDITS : ALWAYS_LABEL;
}

/**
 * A `request` message of the host as a prompt for the phone, or null when it is not one the phone
 * can answer (another request type, no request id, no tool name).
 *
 * `kind`: `AskUserQuestion` is a question, `ExitPlanMode` a plan, any other tool a tool, and a
 * `user_dialog_request` a dialog (whose `dialogKind` is also its `toolName`, and whose `payload`
 * its `input`). The always-allow button exists for a tool with suggestions that the request does
 * not suppress and that no plugin raised, which is when the webview offers it.
 * @param {any} requestMsg  `{type: 'request', channelId, requestId, request}`
 * @param {number} [now]
 * @returns {Pending | null}
 */
function classifyPending(requestMsg, now = Date.now()) {
  if (!isRecord(requestMsg) || !isText(requestMsg.requestId) || !isRecord(requestMsg.request)) return null;
  const { requestId, request } = requestMsg;
  const reason = reasonOf(request);

  /** @type {Pending} */
  let pending;
  if (request.type === 'user_dialog_request') {
    if (!isText(request.dialogKind)) return null;
    pending = {
      requestId,
      kind: 'dialog',
      toolName: request.dialogKind,
      input: asObject(request.payload),
      suggestions: [],
      canAlwaysAllow: false,
      createdAt: now,
      dialogKind: request.dialogKind,
    };
  } else {
    // A request without a type that names a tool is read as a tool request; one of another type is not ours.
    if ((request.type !== undefined && request.type !== 'tool_permission_request') || !isText(request.toolName)) return null;
    const kind = request.toolName === ASK_USER_QUESTION ? 'question' : request.toolName === EXIT_PLAN_MODE ? 'plan' : 'tool';
    const suggestions = Array.isArray(request.suggestions) ? request.suggestions : [];
    // The webview withholds the option from a plugin's prompt (plugin !== undefined) as it does from a suppressed one.
    const canAlwaysAllow = kind === 'tool' && suggestions.length > 0 && !request.suppressAlwaysAllowRule && request.plugin === undefined;
    pending = { requestId, kind, toolName: request.toolName, input: asObject(request.inputs), suggestions, canAlwaysAllow, createdAt: now };
    if (canAlwaysAllow) pending.alwaysLabel = alwaysLabelOf(suggestions);
  }
  if (reason !== undefined) pending.reason = reason;
  return pending;
}

/** The only error `buildAnswer` throws. */
function invalidChoice() {
  return Object.assign(new Error('invalid_choice'), { code: 'invalid_choice' });
}

/**
 * What the user typed beside a "no": trimmed, or '' for nothing. Anything that is not text is refused.
 * @param {unknown} value
 */
function typedText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalidChoice();
  return value.trim();
}

/**
 * @param {Record<string, any>} updatedInput
 * @param {any[]} updatedPermissions
 * @returns {Answer['response']}
 */
function allow(updatedInput, updatedPermissions) {
  return { type: 'tool_permission_response', result: { behavior: 'allow', updatedInput, updatedPermissions } };
}

/**
 * A "no": with the user's words it carries them and does not interrupt the turn, without it the
 * plain text does, and the turn stops.
 * @param {string} reason  what the user typed, trimmed
 * @param {string} plain  the text for a "no" without a reason
 * @returns {Answer['response']}
 */
function deny(reason, plain) {
  const result = reason
    ? { behavior: 'deny', message: DENY_WITH_REASON + reason, interrupt: false }
    : { behavior: 'deny', message: plain, interrupt: true };
  return { type: 'tool_permission_response', result };
}

/** @param {Pending} pending @param {Record<string, any>} input @param {Record<string, any>} choice @returns {Answer} */
function answerTool(pending, input, choice) {
  switch (choice.kind) {
    case 'allow':
      return { response: allow(input, []) };
    case 'allowAlways': {
      const suggestions = Array.isArray(pending.suggestions) ? pending.suggestions : [];
      if (suggestions.length === 0 || pending.canAlwaysAllow === false) throw invalidChoice();
      /** @type {Answer} */
      const answer = { response: allow(input, suggestions.slice()) };
      // VS Code applies a mode suggestion for the session before it answers.
      const setMode = suggestions.find((s) => isRecord(s) && s.type === 'setMode' && s.destination === 'session' && isText(s.mode));
      if (setMode) answer.mode = setMode.mode;
      return answer;
    }
    case 'deny':
      return { response: deny(typedText(choice.reason), DENY) };
    default:
      throw invalidChoice();
  }
}

/** @param {Record<string, any>} input @param {Record<string, any>} choice @returns {Answer} */
function answerQuestion(input, choice) {
  switch (choice.kind) {
    case 'answers': {
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0 || !isRecord(choice.answers)) throw invalidChoice();
      // Every question needs an answer, as the Submit button of VS Code wants. Others are dropped.
      const entries = questions.map((q) => {
        const text = isRecord(q) ? q.question : undefined;
        if (!isText(text)) throw invalidChoice();
        const answer = choice.answers[text]; // an inherited property is never a string, so a missing answer fails below
        if (typeof answer !== 'string' || answer.trim() === '') throw invalidChoice();
        return [text, answer];
      });
      return { response: allow({ questions, answers: Object.fromEntries(entries) }, []) };
    }
    case 'deny':
      return { response: deny(typedText(choice.reason), DENY) };
    default:
      throw invalidChoice();
  }
}

/** @param {Record<string, any>} input @param {Record<string, any>} choice @param {boolean} autoMode @returns {Answer} */
function answerPlan(input, choice, autoMode) {
  switch (choice.kind) {
    case 'approveAuto':
      return { response: allow(input, []), mode: autoMode ? 'auto' : 'acceptEdits' };
    case 'approveManual':
      return { response: allow(input, [{ type: 'setMode', mode: 'default', destination: 'session' }]), mode: 'default' };
    case 'keepPlanning':
      return { response: deny(typedText(choice.feedback), KEEP_PLANNING) };
    default:
      throw invalidChoice();
  }
}

/** @param {Record<string, any>} choice @returns {Answer} */
function answerDialog(choice) {
  if (choice.kind !== 'cancel') throw invalidChoice();
  return { response: { type: 'user_dialog_response', result: { behavior: 'cancelled' } } };
}

/**
 * The payload for the phone's choice on a prompt, as `{response, mode?}` (see Answer). Throws
 * `Error('invalid_choice')` when the choice does not fit the prompt: a choice of another kind of
 * prompt, always-allow without suggestions, a question that has no answer, text that is not text.
 * @param {Pending} pending
 * @param {Choice} choice
 * @param {{ autoMode?: boolean }} [options]  autoMode: the window has auto mode, which the plan's
 *   "approve and auto-accept" then switches to instead of acceptEdits
 * @returns {Answer}
 */
function buildAnswer(pending, choice, options) {
  if (!isRecord(pending) || !isRecord(choice)) throw invalidChoice();
  const input = asObject(pending.input);
  switch (pending.kind) {
    case 'tool':
      return answerTool(pending, input, choice);
    case 'question':
      return answerQuestion(input, choice);
    case 'plan':
      return answerPlan(input, choice, Boolean(options && options.autoMode));
    case 'dialog':
      return answerDialog(choice);
    default:
      throw invalidChoice();
  }
}

module.exports = { DENY, DENY_WITH_REASON, KEEP_PLANNING, classifyPending, buildAnswer };
