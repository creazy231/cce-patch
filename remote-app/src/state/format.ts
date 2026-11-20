// Small text helpers for the screens: names, paths, times and the copy for error codes.

import type { SessionState } from "../lib/protocol";

// Control characters, bidi overrides and invisible marks. A Mac's name arrives from a pairing link or
// from the Mac itself; these could make it render as something it isn't.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** A name that is safe to show: no control or bidi characters, at most 60 characters. */
export function cleanName(name: string, fallback = "Mac"): string {
  const clean = name.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return clean ? [...clean].slice(0, 60).join("") : fallback;
}

/** host:port of an address, for showing where the phone connects to. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** "Visual Studio Code - Insiders" → "VS Code Insiders". */
export function shortEditor(name: string): string {
  const text = name.trim();
  const vscode = /^visual studio code(?:\s*-\s*(.+))?$/i.exec(text);
  if (vscode) return vscode[1] ? `VS Code ${vscode[1]}` : "VS Code";
  return text || "Editor";
}

/** A home folder becomes ~. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** The first folder of a window, with "+2" when it has more. */
export function folderLabel(folders: readonly string[]): string {
  const first = folders[0];
  if (!first) return "No folder";
  return folders.length > 1 ? `${shortPath(first)} +${folders.length - 1}` : shortPath(first);
}

/** now, 4m, 3h, 2d, then a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Math.max(0, now - ms);
  if (diff < 45_000) return "now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * What a session's dot shows in the app. Waiting and running come from the Mac; "new" is this phone's own read
 * state (activity not shown here yet), which replaces the Mac's "unread" (not viewed in VS Code).
 */
export type DotState = "waiting" | "running" | "new" | "idle";

export const DOT_LABEL: Record<DotState, string> = {
  waiting: "Needs you",
  running: "Running",
  new: "New",
  idle: "Idle",
};

/** The dot for a state as the Mac reports it, where the phone's read state doesn't apply (the open session). */
export function sessionDot(state: SessionState): DotState {
  return state === "waiting" || state === "running" ? state : "idle";
}

/** `mcp__github__create_issue` → "github · create_issue". */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** The code of an error from the client (RemoteError) or anything else. */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "failed";
}

/** The Mac's own words for an error (a RemoteError made from an error frame carries them), or "". */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error) || !("code" in error)) return "";
  return error.message !== error.code ? error.message : "";
}

/**
 * Codes after which nobody can tell whether the Mac carried the request out: no answer in time (the app's
 * own wait, or the Mac's wait for VS Code), or the connection to the Mac or to its VS Code window closed
 * first. The copy for them never says "sent" or "not sent".
 */
const UNCONFIRMED = new Set(["timeout", "connection_lost", "closed"]);

export function isUnconfirmed(code: string): boolean {
  return UNCONFIRMED.has(code);
}

/** Text from the Mac for the screen: no control or bidi characters, one line, at most 200 characters. */
function cleanMessage(message: string): string {
  const clean = message.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : clean;
}

/**
 * What an error code means, in a sentence the person can act on. `message` is the Mac's own text for it
 * (error frames carry one): used for a code this app doesn't know yet.
 */
export function errorText(code: string, mac = "the Mac", message = ""): string {
  // "the Mac" / "your Mac" start some sentences; a Mac's own name is left as it is.
  const Mac = /^(?:the|your) /.test(mac) ? mac.charAt(0).toUpperCase() + mac.slice(1) : mac;
  switch (code) {
    // Who this phone is: the Mac won't take it (any more), so pairing again is the fix.
    case "bad_token":
      return `${Mac} doesn't accept this phone anymore. Pair it again.`;
    case "bad_origin":
      return `This phone was paired with ${mac} from another address of this app. Pair it again here.`;
    case "revoked":
      return `This phone was removed on ${mac}. Pair it again to use it.`;
    // Pairing.
    case "bad_code":
      return "That code didn't work. A code works once and expires after 10 minutes: make a new one on the Mac.";
    case "server_error":
      return `${Mac} couldn't save the pairing. Make a new code on the Mac and try again.`;
    case "invalid":
      return "That isn't a CCE Remote pairing link or code.";
    // The connection.
    case "not_connected":
      return `Not connected to ${mac}.`;
    case "connection_lost":
      return "The connection dropped.";
    case "closed":
      return `The connection closed before ${mac} answered.`;
    case "timeout":
      return `${Mac} took too long to answer.`;
    case "unreachable":
      return `Can't reach ${mac}. Is Tailscale on on this phone?`;
    case "disabled":
      return `Remote access was turned off on ${mac}.`;
    case "too_many_connections":
      return `${Mac} closed this connection: this phone had too many open. Close CCE Remote in other tabs.`;
    case "unsupported_version":
      return `This app and ${mac} speak different versions. Run the patch again on the Mac, then reopen this app.`;
    case "bad_response":
      return "The Mac sent an answer this app doesn't understand. Update the patch on the Mac.";
    // A session, a prompt, a message.
    case "gone":
      return "That isn't open on the Mac anymore.";
    case "unknown_project":
      return `That VS Code window isn't open on ${mac} anymore.`;
    case "unknown_session":
      return `${Mac} doesn't have this session anymore.`;
    case "snapshot_failed":
      return `Couldn't load this session from ${mac}. Open it again to retry.`;
    case "not_pending":
      return "That was already answered, maybe in VS Code.";
    case "invalid_choice":
      return `${Mac} couldn't use that answer for this prompt. Answer it in VS Code.`;
    case "no_channel":
    case "not_running":
      return "Claude Code isn't running this session right now.";
    case "not_running_in_vscode":
      return "Open this session in VS Code to wake it up.";
    case "open_failed":
      return `VS Code on ${mac} couldn't open Claude Code.`;
    case "no_handler":
      return "That VS Code window isn't ready yet. Try again in a moment.";
    case "empty":
      return "There's nothing to send.";
    case "too_long":
      return "That message is too long to send. Shorten it and try again.";
    case "bad_images":
      return `${Mac} didn't accept the photos. Try fewer or smaller ones.`;
    // This app and the Mac's bridge don't match.
    case "bad_request":
    case "bad_session":
      return `${Mac} didn't understand that request. Reload this app, or run the patch again on the Mac.`;
    case "unknown_type":
    case "unknown_method":
      return `${Mac} can't do that yet. Run the patch again on the Mac, then reload VS Code.`;
    case "not_supported":
      return `Claude Code on ${mac} doesn't support this. Run the patch again on the Mac.`;
    case "too_many_subscriptions":
      return `This phone has too many sessions open on ${mac} at once. Close the app and open it again.`;
    case "failed":
      return "Something went wrong.";
    default: {
      const text = cleanMessage(message);
      if (text) return text;
      // A code is a short identifier; anything else (an exception's text from the Mac) isn't shown.
      return /^[a-z][a-z0-9_]{0,40}$/.test(code) ? `Something went wrong on ${mac} (${code}).` : `Something went wrong on ${mac}.`;
    }
  }
}

/** An answer that failed: when it may have arrived after all, the card says how the person will know. */
export function answerErrorText(code: string, mac?: string): string {
  const text = errorText(code, mac);
  return isUnconfirmed(code) ? `${text} If your answer arrived, this prompt goes away by itself.` : text;
}

/** The branch to show for a session, or null: the CLI records "HEAD" for a folder that is not a git repo (or a detached head). */
export function branchLabel(branch: string | undefined): string | null {
  const name = branch?.trim();
  return name && name !== "HEAD" ? name : null;
}
