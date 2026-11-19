import { describe, expect, test } from "bun:test";
import { RemoteError } from "../src/lib/client";
import {
  answerErrorText,
  branchLabel,
  cleanName,
  errorCode,
  errorMessage,
  errorText,
  folderLabel,
  hostOf,
  isUnconfirmed,
  relativeTime,
  shortEditor,
  shortPath,
  toolLabel,
} from "../src/state/format";

describe("cleanName", () => {
  test("drops bidi overrides, control and invisible characters", () => {
    expect(cleanName("example‮cam.exe")).toBe("examplecam.exe");
    expect(cleanName("  example\u0000-mac​\n ")).toBe("example-mac");
  });
  test("falls back when nothing is left, cuts long names", () => {
    expect(cleanName("‮‏ ", "example-mac")).toBe("example-mac");
    expect([...cleanName("x".repeat(100))].length).toBe(60);
  });
});

test("hostOf shows host and port", () => {
  expect(hostOf("https://example-mac.tailnet-0000.ts.net:47821")).toBe("example-mac.tailnet-0000.ts.net:47821");
  expect(hostOf("not a url")).toBe("not a url");
});

test("shortEditor", () => {
  expect(shortEditor("Visual Studio Code - Insiders")).toBe("VS Code Insiders");
  expect(shortEditor("Visual Studio Code")).toBe("VS Code");
  expect(shortEditor("Cursor")).toBe("Cursor");
  expect(shortEditor(" ")).toBe("Editor");
});

test("shortPath and folderLabel", () => {
  expect(shortPath("/Users/someone/code/acme-api")).toBe("~/code/acme-api");
  expect(shortPath("/home/someone")).toBe("~");
  expect(shortPath("/opt/work")).toBe("/opt/work");
  expect(folderLabel(["/Users/someone/code/acme-web", "/Users/someone/code/acme-ui"])).toBe("~/code/acme-web +1");
  expect(folderLabel([])).toBe("No folder");
});

test("relativeTime", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  expect(relativeTime(now - 10_000, now)).toBe("now");
  expect(relativeTime(now - 4 * 60_000, now)).toBe("4m");
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  expect(relativeTime(0, now)).toBe("");
  expect(relativeTime(now - 30 * 86_400_000, now)).not.toBe("");
});

test("branchLabel shows a branch, not a detached or missing one (the CLI writes HEAD outside a git repo)", () => {
  expect(branchLabel("feat/rate-limit")).toBe("feat/rate-limit");
  expect(branchLabel("HEAD")).toBeNull();
  expect(branchLabel(undefined)).toBeNull();
  expect(branchLabel("  ")).toBeNull();
});

test("toolLabel shortens MCP tools", () => {
  expect(toolLabel("mcp__github__create_issue")).toBe("github · create_issue");
  expect(toolLabel("Bash")).toBe("Bash");
});

// Every code a version-1 bridge sends (error frames and ack errors, remote-bridge/lib/hub.js and
// window-agent.js), the app's own (client.ts, pairing input), and two older ones.
const BRIDGE_CODES = [
  // error frames
  "bad_code", "server_error", "unsupported_version", "bad_token", "bad_origin", "revoked", "disabled",
  "too_many_connections", "too_many_subscriptions", "snapshot_failed", "bad_request",
  // ack errors
  "unknown_project", "unknown_type", "unknown_method", "timeout", "closed", "no_handler", "not_pending", "invalid_choice",
  "not_running", "empty", "too_long", "bad_images", "bad_session", "unknown_session", "open_failed", "not_supported",
  "not_running_in_vscode",
];
const APP_CODES = ["not_connected", "connection_lost", "closed", "timeout", "unreachable", "bad_response", "invalid", "failed"];
const OLDER_CODES = ["gone", "no_channel"];

describe("error copy", () => {
  test("every code the bridge and the app use has its own sentence", () => {
    for (const code of [...BRIDGE_CODES, ...APP_CODES, ...OLDER_CODES]) {
      const text = errorText(code, "example-mac");
      expect(text).not.toContain("Something went wrong on");
      expect(text).not.toContain(`(${code})`);
      expect(text).toMatch(/^(?:[A-Z]|example-mac ).*[.?]$/); // a Mac's name stays as it is
    }
    expect(errorText("not_running_in_vscode")).toBe("Open this session in VS Code to wake it up.");
    expect(errorText("disabled", "example-mac")).toBe("Remote access was turned off on example-mac.");
    expect(errorText("unreachable", "example-mac")).toBe("Can't reach example-mac. Is Tailscale on on this phone?");
    expect(errorText("revoked", "example-mac")).toBe("This phone was removed on example-mac. Pair it again to use it.");
    expect(errorText("unsupported_version", "example-mac")).toContain("Run the patch again on the Mac");
  });

  test("a code this app doesn't know: the Mac's own words when it sent some, else the code", () => {
    expect(errorText("something_new", "example-mac", "The Mac's own sentence.")).toBe("The Mac's own sentence.");
    expect(errorText("something_new", "example-mac")).toBe("Something went wrong on example-mac (something_new).");
    // The Mac's words are cleaned like a name and kept short; an exception's text is never shown as a code.
    expect(errorText("x_y", "example-mac", "\u202eevil\u0000 text\n  here")).toBe("evil text here");
    expect([...errorText("x_y", "example-mac", "w".repeat(500))].length).toBe(200);
    expect(errorText("TypeError: Cannot read properties of undefined", "example-mac")).toBe("Something went wrong on example-mac.");
    // A known code keeps this app's copy.
    expect(errorText("revoked", "example-mac", "This phone was removed on the Mac.")).toBe(
      "This phone was removed on example-mac. Pair it again to use it.",
    );
  });

  test("without a Mac's name, sentences that start with it start with a capital", () => {
    expect(errorText("timeout")).toBe("The Mac took too long to answer.");
    expect(errorText("timeout", "your Mac")).toBe("Your Mac took too long to answer.");
    expect(errorText("timeout", "example-mac")).toBe("example-mac took too long to answer.");
  });

  test("unconfirmed: a timeout (the app's wait or the Mac's wait for VS Code) or a connection closed first", () => {
    expect(["timeout", "connection_lost", "closed"].every(isUnconfirmed)).toBe(true);
    expect(["not_connected", "unknown_session", "not_pending", "failed"].some(isUnconfirmed)).toBe(false);
    for (const code of ["timeout", "connection_lost", "closed"]) {
      // Neither "sent" nor "not sent": nobody knows which.
      expect(errorText(code, "example-mac")).not.toMatch(/\b(sent|not sent|didn't send|wasn't)\b/i);
    }
  });

  test("an answer that may have arrived says how the person will know; a refused one says why", () => {
    expect(answerErrorText("timeout", "example-mac")).toBe(
      "example-mac took too long to answer. If your answer arrived, this prompt goes away by itself.",
    );
    expect(answerErrorText("invalid_choice", "example-mac")).toBe(errorText("invalid_choice", "example-mac"));
  });

  test("errorCode reads a RemoteError-like code; errorMessage the Mac's words, if any", () => {
    expect(errorCode({ code: "timeout" })).toBe("timeout");
    expect(errorCode(new Error("x"))).toBe("failed");
    expect(errorCode(null)).toBe("failed");
    expect(errorMessage(new RemoteError("bad_code", "That pairing code is wrong."))).toBe("That pairing code is wrong.");
    expect(errorMessage(new RemoteError("timeout"))).toBe("");
    expect(errorMessage(new Error("x"))).toBe("");
  });
});
