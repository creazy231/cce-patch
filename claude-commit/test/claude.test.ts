import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeError, buildArgs, buildEnv, parseResult, resolveClaudeBinary, runClaude } from "../lib/claude.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-commit-cli-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An executable file; with a body it is a fake `claude` shell script. */
function executable(file: string, body = ""): string {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const success = (result: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

test("buildArgs: one-shot, isolated, JSON output", () => {
  expect(buildArgs({ model: "haiku", systemPrompt: "SYS" })).toEqual([
    "-p", "--model", "haiku", "--safe-mode", "--tools", "", "--disable-slash-commands",
    "--no-session-persistence", "--output-format", "json", "--system-prompt", "SYS",
  ]);
});

test("buildEnv drops nested-session variables, adds the user's, skips non-essential traffic", () => {
  const env = buildEnv(
    { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_CODE_SSE_PORT: "1", ENABLE_IDE_INTEGRATION: "true" },
    [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy" }, { name: "", value: "x" }, null],
  );
  expect(env).toEqual({ PATH: "/bin", ANTHROPIC_BASE_URL: "https://proxy", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
});

test("buildEnv drops the session plumbing a parent Claude Code session or the Claude Code extension leaves behind", () => {
  // CLAUDE_AGENT_SDK_VERSION is set on the shared extension-host env by the Claude Code extension;
  // the rest arrive when the editor was started from inside a Claude Code session.
  const inherited = {
    CLAUDE_AGENT_SDK_VERSION: "0.3.296", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_PID: "1", CLAUDE_CODE_EXECPATH: "/x", CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_EFFORT: "max",
  };
  const kept = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k" };
  expect(buildEnv({ ...inherited, ...kept })).toEqual({ ...kept, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
});

describe("resolveClaudeBinary", () => {
  test("the configured path, then the Claude Code extension's binary, then PATH", () => {
    const configured = executable(join(dir, "configured", "claude"));
    const ext = join(dir, "ext");
    const bundled = executable(join(ext, "resources", "native-binary", "claude"));
    const binDir = join(dir, "bin");
    const onPath = executable(join(binDir, "claude"));

    expect(resolveClaudeBinary({ configuredPath: configured, claudeCodeExtensionPath: ext, envPath: binDir })).toBe(configured);
    expect(resolveClaudeBinary({ configuredPath: join(dir, "nope"), claudeCodeExtensionPath: ext, envPath: binDir })).toBe(bundled);
    expect(resolveClaudeBinary({ claudeCodeExtensionPath: join(dir, "no-ext"), envPath: binDir })).toBe(onPath);
    expect(resolveClaudeBinary({ envPath: join(dir, "empty") })).toBeUndefined();
  });
  test("expands ~ in the configured path", () => {
    // os.homedir() reads HOME once at startup, so resolve in a child process with its own HOME.
    const home = join(dir, "home");
    const file = executable(join(home, "bin", "claude"));
    const lib = JSON.stringify(join(import.meta.dir, "..", "lib", "claude.js"));
    const script = `const { resolveClaudeBinary } = require(${lib}); process.stdout.write(String(resolveClaudeBinary({ configuredPath: "~/bin/claude", envPath: "" })));`;
    const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(child.stdout).toBe(file);
  });
  test("skips files that are not executable", () => {
    const file = join(dir, "noexec", "claude");
    mkdirSync(join(dir, "noexec"));
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    expect(resolveClaudeBinary({ envPath: join(dir, "noexec") })).toBeUndefined();
  });
});

describe("parseResult", () => {
  test("the result text", () => {
    expect(parseResult(success("hi") + "\n", "", 0)).toBe("hi");
  });
  test("verbose array output", () => {
    expect(parseResult(JSON.stringify([{ type: "system" }, JSON.parse(success("hi"))]), "", 0)).toBe("hi");
  });
  test("is_error becomes a ClaudeError with a login hint", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    expect(() => parseResult(out, "", 1)).toThrow(ClaudeError);
    expect(() => parseResult(out, "", 1)).toThrow(/Not logged in · Please run \/login.*log in\./);
  });
  test("an errors[] result shows its errors, not just the subtype", () => {
    const out = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["queryParams builder failed: x", "second"] });
    expect(() => parseResult(out, "", 1)).toThrow("queryParams builder failed: x\nsecond");
  });
  test("an error terminal reason is an error even when is_error is false", () => {
    const out = JSON.stringify({ type: "result", subtype: "success", is_error: false, terminal_reason: "turn_setup_failed", result: "Setup failed: no model" });
    expect(() => parseResult(out, "", 0)).toThrow("Setup failed: no model");
    expect(parseResult(JSON.stringify({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "ok" }), "", 0)).toBe("ok");
  });
  test("without JSON, the end of stderr", () => {
    expect(() => parseResult("", "warning\nboom", 2)).toThrow("warning\nboom");
    expect(() => parseResult("", "", 2)).toThrow("Claude Code exited with code 2");
  });
});

describe.skipIf(process.platform === "win32")("runClaude", () => {
  const run = (binary: string, extra: Record<string, unknown> = {}) =>
    runClaude({ binary, args: ["-p", "--model", "haiku"], env: { PATH: process.env.PATH }, input: "PROMPT", cwd: dir, ...extra });

  test("passes the args and the prompt on stdin, returns the result", async () => {
    const seen = join(dir, "seen");
    const json = success("```text\nfix\n```");
    const cli = executable(join(dir, "ok", "claude"), `echo "$@" > "${seen}.args"; cat > "${seen}.stdin"; printf '%s\\n' '${json}'`);
    expect(await run(cli)).toBe("```text\nfix\n```");
    expect(readFileSync(`${seen}.args`, "utf8").trim()).toBe("-p --model haiku");
    expect(readFileSync(`${seen}.stdin`, "utf8")).toBe("PROMPT");
  });
  test("a failing CLI rejects with its message", async () => {
    const cli = executable(join(dir, "fail", "claude"), `cat > /dev/null; echo "boom" >&2; exit 3`);
    await expect(run(cli)).rejects.toThrow("boom");
  });
  test("cancelling kills the CLI and resolves undefined", async () => {
    const cli = executable(join(dir, "slow", "claude"), `cat > /dev/null; exec sleep 30`);
    let fire = () => {};
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: () => void) => {
        fire = cb;
        return { dispose() {} };
      },
    };
    const started = Date.now();
    const pending = run(cli, { token });
    setTimeout(() => {
      token.isCancellationRequested = true;
      fire();
    }, 100);
    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  test("an already cancelled token never starts the CLI", async () => {
    const marker = join(dir, "started");
    const cli = executable(join(dir, "never", "claude"), `touch "${marker}"`);
    expect(await run(cli, { token: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) } })).toBeUndefined();
    expect(() => readFileSync(marker)).toThrow();
  });
  test("gives up after the timeout", async () => {
    const cli = executable(join(dir, "hang", "claude"), `cat > /dev/null; exec sleep 30`);
    await expect(run(cli, { timeoutMs: 200 })).rejects.toThrow("did not answer");
  });
  test("a missing binary rejects", async () => {
    await expect(run(join(dir, "does-not-exist"))).rejects.toThrow("Could not start Claude Code");
  });
});
