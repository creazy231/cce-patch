// @ts-check
'use strict';
// Runs one prompt through the Claude Code CLI (`claude -p`) with the user's Claude Code login.
// Safe mode keeps CLAUDE.md, hooks, plugins and MCP servers out of the one-shot call.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class ClaudeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** @param {string} file */
function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The claude executable: the configured path, else the binary bundled with the Claude Code
 * extension, else the first `claude` on PATH.
 * @param {{ configuredPath?: string, claudeCodeExtensionPath?: string, envPath?: string }} options
 * @returns {string | undefined}
 */
function resolveClaudeBinary({ configuredPath, claudeCodeExtensionPath, envPath = process.env.PATH ?? '' }) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (claudeCodeExtensionPath) candidates.push(path.join(claudeCodeExtensionPath, 'resources', 'native-binary', exe));
  for (const dir of envPath.split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  return candidates.find(isExecutable);
}

/** @param {{ model: string, systemPrompt: string }} options */
function buildArgs({ model, systemPrompt }) {
  return [
    '-p',
    '--model', model,
    '--safe-mode', // no CLAUDE.md, hooks, plugins or MCP servers; the login still works
    '--tools', '', // a commit message needs no tools
    '--disable-slash-commands',
    '--no-session-persistence', // keep these calls out of the session list
    '--output-format', 'json',
    '--system-prompt', systemPrompt,
  ];
}

/**
 * Session plumbing that would tie the CLI to another Claude Code session or IDE, or carry over
 * its effort level. The Claude Code extension sets CLAUDE_AGENT_SDK_VERSION on the shared
 * extension-host env; the rest arrive when the editor was started from inside a session.
 */
const NESTED_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ENABLE_IDE_INTEGRATION',
  'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_EFFORT',
];

/**
 * @param {NodeJS.ProcessEnv} base
 * @param {unknown} [extra]  the Claude Code extension's `claudeCode.environmentVariables` ({ name, value }[])
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv(base, extra = []) {
  const env = { ...base };
  for (const name of NESTED_SESSION_ENV) delete env[name];
  if (Array.isArray(extra)) {
    for (const variable of extra) {
      if (variable && typeof variable.name === 'string' && variable.name) env[variable.name] = String(variable.value ?? '');
    }
  }
  // Skips telemetry and update checks, which otherwise add ~1.4 s to every call.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/** The terminal reasons the CLI itself counts as errors (Claude Code 2.1.296). */
const ERROR_TERMINAL_REASONS = new Set([
  'blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error', 'model_error', 'api_error',
  'malformed_tool_use_exhausted', 'budget_exhausted', 'structured_output_retry_exhausted',
  'tool_deferred_unavailable', 'turn_setup_failed',
]);

/** @param {string} message */
function describeError(message) {
  return /log ?in|auth|api key|credential|401|oauth/i.test(message)
    ? `${message} (Run \`claude\` in a terminal and log in.)`
    : message;
}

/**
 * The answer from `--output-format json`, or a ClaudeError.
 * @param {string} stdout
 * @param {string} stderr
 * @param {number | null} code
 * @returns {string}
 */
function parseResult(stdout, stderr, code) {
  const output = stdout.trim();
  /** @type {any} */
  let result;
  for (const candidate of [output, output.split('\n').pop() ?? '']) {
    try {
      const value = JSON.parse(candidate);
      result = Array.isArray(value) ? value.findLast((m) => m?.type === 'result') : value;
    } catch {
      result = undefined;
    }
    if (result?.type === 'result') break;
    result = undefined;
  }
  if (result) {
    if (result.is_error || result.subtype !== 'success' || ERROR_TERMINAL_REASONS.has(result.terminal_reason)) {
      const errors = Array.isArray(result.errors) ? result.errors.join('\n') : '';
      throw new ClaudeError(describeError(String(result.result || errors || result.subtype || 'Claude Code reported an error')));
    }
    return String(result.result ?? '');
  }
  const detail = (stderr.trim() || output).split('\n').slice(-5).join('\n');
  throw new ClaudeError(describeError(detail || `Claude Code exited with code ${code}`));
}

/**
 * Run `claude` once with `input` on stdin.
 * @param {{ binary: string, args: string[], env: NodeJS.ProcessEnv, input: string, cwd: string,
 *   token?: { isCancellationRequested: boolean, onCancellationRequested?: Function }, timeoutMs?: number }} options
 * @returns {Promise<string | undefined>} the answer, or undefined when cancelled
 */
function runClaude({ binary, args, env, input, cwd, token, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) return resolve(undefined);
    let stdout = '';
    let stderr = '';
    /** @type {'running' | 'cancelled' | 'timeout' | 'done'} */
    let state = 'running';
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stop = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      state = 'timeout';
      stop();
    }, timeoutMs);
    const subscription = typeof token?.onCancellationRequested === 'function'
      ? token.onCancellationRequested(() => {
          if (state !== 'running') return;
          state = 'cancelled';
          stop();
          resolve(undefined);
        })
      : undefined;
    const cleanUp = () => {
      clearTimeout(timer);
      subscription?.dispose?.();
    };

    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      cleanUp();
      if (state !== 'running') return;
      state = 'done';
      reject(new ClaudeError(`Could not start Claude Code (${binary}): ${err.message}`));
    });
    child.on('close', (code) => {
      cleanUp();
      if (state === 'timeout') return reject(new ClaudeError(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      if (state !== 'running') return;
      state = 'done';
      try {
        resolve(parseResult(stdout, stderr, code));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.on('error', () => {
      // The CLI exited before reading all of its input; 'close' reports why.
    });
    child.stdin.end(input);
  });
}

module.exports = { ClaudeError, resolveClaudeBinary, buildArgs, buildEnv, parseResult, runClaude };
