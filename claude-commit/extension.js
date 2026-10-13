// @ts-check
'use strict';
// "Generate Commit Message with Claude": the built-in Source Control ✨ button, answered by
// Claude through the user's Claude Code login instead of Copilot.

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { gatherContext, instructionEntriesFrom, CancelledError } = require('./lib/context');
const { SYSTEM_PROMPT, buildUserPrompt, fitChanges, parseCommitMessage } = require('./lib/prompt');
const { ClaudeError, resolveClaudeBinary, buildArgs, buildEnv, runClaude } = require('./lib/claude');

const INPUT_BOX_PROPOSAL = 'contribSourceControlInputBoxMenu';

/** @type {vscode.LogOutputChannel} */
let log;
/** @type {vscode.CancellationTokenSource | undefined} */
let running;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  log = vscode.window.createOutputChannel('Claude Commit Message', { log: true });
  // VS Code empties enabledApiProposals when it doesn't grant them. So this tells whether the
  // button sits in the commit message box (argv.json "enable-proposed-api" + a restart) or
  // has to fall back to the title bar of the "Changes" view.
  const inputBox = (context.extension.packageJSON.enabledApiProposals ?? []).includes(INPUT_BOX_PROPOSAL);
  log.info(`Activated. Input-box button: ${inputBox ? 'yes' : 'no (title-bar button instead)'}`);
  void vscode.commands.executeCommand('setContext', 'claudeCommit.inputBoxButton', inputBox);
  void setGenerating(false);
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('claudeCommit.generateCommitMessage', generate),
    vscode.commands.registerCommand('claudeCommit.cancel', () => {
      log.info('Cancel requested');
      running?.cancel();
    }),
  );
}

function deactivate() {
  running?.cancel();
}

/** @param {boolean} value */
function setGenerating(value) {
  return vscode.commands.executeCommand('setContext', 'claudeCommit.generating', value);
}

/**
 * The command. From the commit message box: (rootUri, resourceGroups, token). From the title
 * bar: (SourceControl). From the command palette: no arguments.
 * @param {unknown} [target]
 * @param {unknown} [_groups]
 * @param {vscode.CancellationToken} [token]
 */
async function generate(target, _groups, token) {
  running?.cancel(); // a new run replaces a running one, like the commit message box does
  const cts = new vscode.CancellationTokenSource();
  running = cts;
  const subscription = typeof token?.onCancellationRequested === 'function'
    ? token.onCancellationRequested(() => cts.cancel())
    : undefined;
  void setGenerating(true);
  try {
    const repo = await resolveRepository(target);
    if (!repo || cts.token.isCancellationRequested) return;
    const message = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl },
      () => generateFor(repo, cts.token),
    );
    if (cts.token.isCancellationRequested) {
      log.info('Cancelled');
    } else if (message) {
      repo.inputBox.value = message;
      log.info(`Message: ${message.split('\n')[0]}`);
    }
  } catch (err) {
    if (cts.token.isCancellationRequested || err instanceof CancelledError) return;
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    void vscode.window.showErrorMessage(err instanceof ClaudeError ? message : `Could not generate a commit message: ${message}`);
  } finally {
    subscription?.dispose();
    if (running === cts) {
      running = undefined;
      void setGenerating(false);
    }
    cts.dispose();
  }
}

/** The git extension's API, or undefined when Git is disabled. */
async function gitApi() {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return undefined;
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.enabled ? exports.getAPI(1) : undefined;
}

/**
 * Like Copilot: the given root, else the only repository, else the active editor's. When that
 * leaves several, the selected one or a quick pick.
 * @param {unknown} target  a Uri (commit message box) or a SourceControl (title bar)
 */
async function resolveRepository(target) {
  const git = await gitApi();
  if (!git) throw new Error('the built-in Git extension is disabled.');
  /** @type {any} */
  const t = target;
  const rootUri = t instanceof vscode.Uri ? t : t?.rootUri instanceof vscode.Uri ? t.rootUri : undefined;
  if (!rootUri && git.repositories.length === 1) return git.repositories[0];

  const uri = rootUri ?? vscode.window.activeTextEditor?.document.uri;
  const repo = uri ? git.getRepository(uri) ?? (await git.openRepository?.(uri)) : null;
  if (repo) return repo;
  if (git.repositories.length === 0) {
    void vscode.window.showInformationMessage('Open a Git repository to generate a commit message.');
    return undefined;
  }
  const selected = git.repositories.filter((/** @type {any} */ r) => r.ui.selected);
  if (selected.length === 1) return selected[0];
  const pick = await vscode.window.showQuickPick(
    git.repositories.map((/** @type {any} */ r) => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repo: r })),
    { placeHolder: 'Generate a commit message for which repository?' },
  );
  return pick?.repo;
}

/**
 * @param {any} repo  git extension Repository
 * @param {vscode.CancellationToken} token
 * @returns {Promise<string | undefined>}
 */
async function generateFor(repo, token) {
  const settings = vscode.workspace.getConfiguration('claudeCommit', repo.rootUri);
  const input = await gatherContext({
    repo,
    // The same custom instructions the built-in button uses, from every settings scope.
    instructionEntries: instructionEntriesFrom(
      vscode.workspace.getConfiguration('github.copilot.chat.commitMessageGeneration', repo.rootUri).inspect('instructions'),
    ),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    token,
  });
  if (token.isCancellationRequested) return undefined;
  if (!input) {
    void vscode.window.showInformationMessage('Cannot generate a commit message because there are no changes.');
    return undefined;
  }

  const binary = resolveClaudeBinary({
    configuredPath: settings.get('claudePath'),
    claudeCodeExtensionPath: vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath,
  });
  if (!binary) {
    throw new ClaudeError('Claude Code was not found. Install the Claude Code extension, or set "claudeCommit.claudePath" to your claude executable.');
  }
  const model = settings.get('model') || 'haiku';
  const prompt = buildUserPrompt({ ...input, changes: fitChanges(input.changes) });
  const started = Date.now();
  log.info(`Asking ${model} via ${binary} (${input.changes.length} file(s), ${prompt.length} chars)`);
  const answer = await runClaude({
    binary,
    args: buildArgs({ model, systemPrompt: SYSTEM_PROMPT }),
    env: buildEnv(process.env, vscode.workspace.getConfiguration('claudeCode').get('environmentVariables')),
    input: prompt,
    cwd: os.tmpdir(),
    token,
  });
  if (answer === undefined) return undefined;
  log.info(`Answered in ${Date.now() - started} ms`);
  return parseCommitMessage(answer) || undefined;
}

module.exports = { activate, deactivate };
