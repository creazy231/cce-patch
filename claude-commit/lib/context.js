// @ts-check
'use strict';
// Gathers what the commit-message prompt needs from a git-extension Repository, the way the
// built-in Copilot button does (GitCommitMessageServiceImpl + GitDiffService, Copilot Chat 0.70).

const fs = require('fs/promises');
const path = require('path');

/** Copilot cuts a single file's diff at this many chars. */
const MAX_DIFF_CHARS = 100_000;
/** Copilot doesn't inline untracked files bigger than this; also the cap for original code. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Char budget for original code + diffs: ~75k tokens, which keeps Haiku fast. */
const PROMPT_BUDGET = 300_000;

/** The git extension's `Status` values that matter here (extensions/git/src/api/git.d.ts). */
const Status = { INDEX_ADDED: 1, INDEX_COPIED: 4, UNTRACKED: 7 };

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * @param {string} diff
 * @param {number} [max]
 */
function truncateDiff(diff, max = MAX_DIFF_CHARS) {
  return diff.length > max ? `${diff.substring(0, max)}\n... [diff truncated]\n` : diff;
}

/**
 * Staged changes if there are any, else the working tree plus untracked files.
 * @template T
 * @param {{ indexChanges: T[], workingTreeChanges: T[], untrackedChanges?: T[] }} state
 * @returns {T[]}
 */
function selectChanges(state) {
  return state.indexChanges.length > 0
    ? state.indexChanges
    : [...state.workingTreeChanges, ...(state.untrackedChanges ?? [])];
}

/** @param {Uint8Array} bytes */
const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

/**
 * The patch Copilot synthesizes for an untracked file.
 * @param {string} relPath  path relative to the repository root, with forward slashes
 * @param {{ size: number, content?: Uint8Array }} file  content is left out when the file is too large
 */
function untrackedPatch(relPath, file) {
  const lines = [`diff --git a/${relPath} b/${relPath}`, 'new file mode 100644', '--- /dev/null', `+++ b/${relPath}`];
  if (file.size > MAX_FILE_BYTES || !file.content) {
    lines.push(`\\ File too large to diff (${Math.round(file.size / 1024)} KB)`);
  } else if (isBinary(file.content)) {
    lines.push(`Binary files /dev/null and b/${relPath} differ`);
  } else {
    const text = Buffer.from(file.content).toString('utf8');
    if (text.length > 0) {
      const body = text.split('\n');
      if (text.endsWith('\n')) body.pop();
      lines.push(`@@ -0,0 +1,${body.length} @@`, ...body.map((line) => `+${line}`));
      if (!text.endsWith('\n')) lines.push('\\ No newline at end of file');
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} root
 * @param {string} file
 */
async function readUntracked(root, file) {
  const relPath = path.relative(root, file).split(path.sep).join('/');
  try {
    const { size } = await fs.stat(file);
    return untrackedPatch(relPath, { size, content: size > MAX_FILE_BYTES ? undefined : await fs.readFile(file) });
  } catch {
    return untrackedPatch(relPath, { size: 0, content: new Uint8Array() });
  }
}

/**
 * Per-file diffs, exactly like Copilot's GitDiffService.getChangeDiffs.
 * @param {any} repo  git extension Repository
 * @param {any[]} changes
 * @param {{ isCancellationRequested: boolean }} [token]
 * @returns {Promise<{ path: string, diff: string }[]>}
 */
async function collectDiffs(repo, changes, token) {
  const diffs = [];
  for (const change of changes) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const file = change.uri.fsPath;
    let diff;
    if (change.status <= Status.INDEX_COPIED) diff = await repo.diffIndexWithHEAD(file);
    else if (change.status === Status.UNTRACKED) diff = await readUntracked(repo.rootUri.fsPath, file);
    else diff = await repo.diffWithHEAD(file);
    diffs.push({ path: file, diff: truncateDiff(String(diff ?? '')) });
  }
  return diffs;
}

/**
 * Subjects of the repository's last 5 commits and of the current user's last 5.
 * @param {any} repo
 * @returns {Promise<{ repository: string[], user: string[] }>}
 */
async function recentCommitMessages(repo) {
  const subject = (/** @type {{ message: string }} */ commit) => commit.message.split('\n')[0];
  /** @type {{ repository: string[], user: string[] }} */
  const result = { repository: [], user: [] };
  try {
    result.repository = (await repo.log({ maxEntries: 5 })).map(subject);
    const author =
      (await repo.getConfig('user.name').catch(() => undefined)) ||
      (await repo.getGlobalConfig('user.name').catch(() => undefined));
    if (author) result.user = (await repo.log({ maxEntries: 5, author })).map(subject);
  } catch {
    // Copilot ignores these failures too (e.g. a repository without commits).
  }
  return result;
}

/**
 * The file's current content, for the prompt's "ORIGINAL CODE". Undefined for deleted,
 * binary, unreadable or too large files.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Promise<string | undefined>}
 */
async function readOriginalCode(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const { size } = await fs.stat(file);
    if (size > Math.min(maxBytes, MAX_FILE_BYTES)) return undefined;
    const bytes = await fs.readFile(file);
    return isBinary(bytes) ? undefined : bytes.toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * The instruction entries Copilot uses: the folder, workspace and user values of the setting
 * joined (from `inspect()`), not just the effective one.
 * @param {{ workspaceFolderValue?: unknown, workspaceValue?: unknown, globalValue?: unknown } | undefined} inspected
 * @returns {unknown[]}
 */
function instructionEntriesFrom(inspected) {
  const scopes = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue];
  return scopes.flatMap((value) => (Array.isArray(value) ? value : []));
}

/**
 * Copilot's `github.copilot.chat.commitMessageGeneration.instructions`: each `{ file }` entry
 * read from every workspace folder that has it, then the `{ text }` entries. Every entry counts
 * once, and language-tagged entries never apply to commit messages.
 * @param {unknown} entries
 * @param {string[]} roots  the workspace folders
 * @returns {Promise<string[]>}
 */
async function readInstructions(entries, roots) {
  if (!Array.isArray(entries)) return [];
  const fromFiles = [];
  const fromText = [];
  const seenFiles = new Set();
  const seenTexts = new Set();
  for (const entry of entries) {
    if (typeof entry?.file === 'string' && entry.file.trim() && !seenFiles.has(entry.file)) {
      seenFiles.add(entry.file);
      if (!entry.language) {
        for (const root of roots) {
          const text = await fs.readFile(path.join(root, entry.file), 'utf8').then((t) => t.trim(), () => '');
          if (text) fromFiles.push(text);
        }
      }
    }
    if (typeof entry?.text === 'string' && !seenTexts.has(entry.text)) {
      seenTexts.add(entry.text);
      if (!entry.language && entry.text.trim()) fromText.push(entry.text.trim());
    }
  }
  return [...fromFiles, ...fromText];
}

/**
 * Everything buildUserPrompt needs, or undefined when there is nothing to commit.
 * @param {{ repo: any, instructionEntries?: unknown, workspaceRoots?: string[], token?: { isCancellationRequested: boolean }, budget?: number }} options
 * @returns {Promise<import('./prompt').PromptInput | undefined>}
 */
async function gatherContext({ repo, instructionEntries = [], workspaceRoots = [], token, budget = PROMPT_BUDGET }) {
  try {
    await repo.status();
  } catch {
    // Use the state we already have.
  }
  const changes = selectChanges(repo.state);
  if (changes.length === 0) return undefined;
  const diffs = await collectDiffs(repo, changes, token);
  const recentCommits = await recentCommitMessages(repo);
  if (token?.isCancellationRequested) throw new CancelledError();

  const root = repo.rootUri.fsPath;
  const promptChanges = [];
  // Read only as much original code as fits next to the diffs: the prompt budget would drop the
  // rest anyway, and a huge change set must not pull every file into memory.
  let room = budget - diffs.reduce((n, d) => n + d.diff.length, 0);
  for (const [i, { path: file, diff }] of diffs.entries()) {
    if (token?.isCancellationRequested) throw new CancelledError();
    // A new file's diff already is the whole file, so its "original code" would only repeat it.
    const isNew = changes[i].status === Status.UNTRACKED || changes[i].status === Status.INDEX_ADDED;
    const originalCode = isNew || room <= 0 ? undefined : await readOriginalCode(file, room);
    if (originalCode !== undefined) room -= originalCode.length;
    promptChanges.push({ path: file, diff, originalCode });
  }
  return {
    repositoryName: path.basename(root),
    branchName: repo.state.HEAD?.name ?? '',
    recentCommits,
    changes: promptChanges,
    instructions: await readInstructions(instructionEntries, workspaceRoots.length > 0 ? workspaceRoots : [root]),
    multiRoot: workspaceRoots.length > 1,
  };
}

module.exports = {
  MAX_DIFF_CHARS,
  MAX_FILE_BYTES,
  PROMPT_BUDGET,
  Status,
  CancelledError,
  truncateDiff,
  selectChanges,
  untrackedPatch,
  collectDiffs,
  recentCommitMessages,
  readOriginalCode,
  readInstructions,
  instructionEntriesFrom,
  gatherContext,
};
