// The phone protocol (version 1): the shapes the bridge sends and receives over the WebSocket.
// The bridge lives in remote-bridge/ and is built separately; these types mirror its contract
// (docs/superpowers/specs/2026-11-19-phone-remote-design.md, "Bridge: phone protocol").

import type { PushPrefs, PushSetup } from "./push";

export const PROTOCOL_VERSION = 1;

// ---- projects and sessions ----------------------------------------------------------------------

export type SessionState = "waiting" | "running" | "unread" | "idle";

export interface SessionSummary {
  id: string;
  title: string;
  /** Epoch milliseconds. */
  lastModified: number;
  state: SessionState;
  live: boolean;
  gitBranch?: string;
  worktree?: string;
  /** How many prompts wait for an answer. */
  pendingCount: number;
}

/** One open editor window. */
export interface Project {
  id: string;
  name: string;
  folders: string[];
  editor: string;
  /** False when Claude Code isn't open in that window (no sessions then). */
  claudeOpen: boolean;
  sessions: SessionSummary[];
}

// ---- transcript entries -------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; text: string; isError?: boolean }
  | { type: "image"; omitted: true }
  | { type: "document"; title?: string };

export interface PhoneResult {
  subtype: string;
  isError: boolean;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
}

/** One transcript entry, already trimmed by the bridge. */
export interface PhoneMessage {
  uuid: string;
  type: "user" | "assistant" | "result" | "system";
  ts?: string;
  content?: ContentBlock[];
  /** Only "compact_boundary" reaches the phone. */
  subtype?: string;
  /** The CLI's replay of a prompt (same uuid as the message that was sent). */
  isReplay?: boolean;
  /** The tool_use id of the Task/Agent call a subagent message belongs to. */
  parent?: string;
  result?: PhoneResult;
}

/** Live partial output. `text` only comes with `content_block_delta`. */
export interface StreamEvent {
  type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_stop";
  index?: number;
  text?: string;
}

// ---- prompts waiting for the user ---------------------------------------------------------------

export type PendingKind = "tool" | "question" | "plan" | "dialog";

export interface Pending {
  requestId: string;
  kind: PendingKind;
  toolName: string;
  /** question: `questions` (see Question); plan: `plan` (Markdown); tool: the tool's input. */
  input: Record<string, unknown>;
  suggestions?: unknown[];
  canAlwaysAllow: boolean;
  alwaysLabel?: string;
  reason?: string;
  createdAt: number;
  dialogKind?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** An entry of `Pending.input.questions` for kind "question". */
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** What the phone sends back with `answer`; the bridge builds the exact VS Code payload from it. */
export type Choice =
  | { kind: "allow" }
  | { kind: "allowAlways" }
  | { kind: "deny"; reason?: string }
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "approveAuto" }
  | { kind: "approveManual" }
  | { kind: "keepPlanning"; feedback?: string }
  | { kind: "cancel" };

// ---- frames -------------------------------------------------------------------------------------

export interface ImageUpload {
  mediaType: string;
  /** Base64, without a data: prefix. */
  data: string;
}

/** Phone to Mac. */
export type ClientMsg =
  | { t: "pair"; code: string; device: string }
  | { t: "hello"; v: number; deviceId: string; token: string }
  | { t: "sub"; project: string; session: string }
  | { t: "unsub"; project: string; session: string }
  | { t: "send"; id: string; project: string; session: string | null; text: string; images?: ImageUpload[] }
  | { t: "answer"; id: string; project: string; session: string; requestId: string; choice: Choice }
  | { t: "interrupt"; id: string; project: string; session: string }
  | { t: "open"; id: string; project: string; session: string }
  | { t: "openClaude"; id: string; project: string }
  | { t: "push_set"; id: string; subscription: PushSetup["subscription"]; vapid: PushSetup["vapid"]; subject: string; prefs: PushPrefs }
  | { t: "push_clear"; id: string }
  | { t: "push_test"; id: string }
  | { t: "visibility"; visible: boolean }
  | { t: "ping" };

/** The answer to `send`, `answer`, `interrupt`, `open`, `openClaude` and the push requests. */
export interface Ack {
  t: "ack";
  id: string;
  ok: boolean;
  error?: string;
  /** push_test: the push service's HTTP status, when the Mac got one. */
  status?: number;
  /** push_test: why a status-0 failure happened (refused, too_large, invalid, network, timeout, aborted). */
  reason?: string;
  /** send: the session the message went to (the new one for a new session). */
  session?: string;
  /** send: the uuid of the user message the bridge injected; the CLI replays it with `isReplay`. */
  uuid?: string;
}

export interface PairedFrame {
  t: "paired";
  deviceId: string;
  token: string;
  mac: { name: string };
}

export interface WelcomeFrame {
  t: "welcome";
  v: number;
  mac: { name: string };
  /** This Mac holds a push subscription for this phone. */
  push?: boolean;
}

export interface ProjectsFrame {
  t: "projects";
  projects: Project[];
}

export interface SnapshotFrame {
  t: "snapshot";
  project: string;
  session: string;
  messages: PhoneMessage[];
  pending: Pending[];
  state: SessionState;
  live: boolean;
  /** How many older messages were cut off. */
  truncatedBefore: number;
}

export interface MessageFrame {
  t: "msg";
  project: string;
  session: string;
  message: PhoneMessage;
}

export interface StreamFrame {
  t: "stream";
  project: string;
  session: string;
  event: StreamEvent;
}

/** The full list of open prompts of a session, sent whenever it changes. */
export interface PendingFrame {
  t: "pending";
  project: string;
  session: string;
  pending: Pending[];
}

/**
 * Before the welcome: bad_code, server_error (pairing); unsupported_version, bad_token, bad_origin (hello).
 * After it: revoked, disabled, too_many_connections, too_many_subscriptions, snapshot_failed, bad_request.
 * `message` is the Mac's own text for it.
 */
export interface ErrorFrame {
  t: "error";
  code: string;
  message: string;
  /** snapshot_failed: the session it is about. */
  project?: string;
  session?: string;
}

export interface PongFrame {
  t: "pong";
}

/** Mac to phone. */
export type ServerMsg =
  | PairedFrame
  | WelcomeFrame
  | ProjectsFrame
  | SnapshotFrame
  | MessageFrame
  | StreamFrame
  | PendingFrame
  | Ack
  | ErrorFrame
  | PongFrame;
