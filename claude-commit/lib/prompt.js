// @ts-check
'use strict';
// The prompt of the built-in Copilot "Generate Commit Message" button (Copilot Chat 0.70,
// gitCommitMessagePrompt + gitCommitMessageGenerator), rebuilt as plain text for Claude.

const { truncateDiff, PROMPT_BUDGET } = require('./context');

const SYSTEM_PROMPT = [
  'You are an AI programming assistant, helping a software developer to come with the best git commit message for their code changes.',
  "You excel in interpreting the purpose behind code changes to craft succinct, clear commit messages that adhere to the repository's guidelines.",
  '',
  '# First, think step-by-step:',
  "1. Analyze the CODE CHANGES thoroughly to understand what's been modified.",
  '2. Use the ORIGINAL CODE to understand the context of the CODE CHANGES. Use the line numbers to map the CODE CHANGES to the ORIGINAL CODE.',
  '3. Identify the purpose of the changes to answer the *why* for the commit messages, also considering the optionally provided RECENT USER COMMITS.',
  '4. Review the provided RECENT REPOSITORY COMMITS to identify established commit message conventions. Focus on the format and style, ignoring commit-specific details like refs, tags, and authors.',
  '5. Generate a thoughtful and succinct commit message for the given CODE CHANGES. It MUST follow the established writing conventions. 6. Remove any meta information like issue references, tags, or author names from the commit message. The developer will add them.',
  '7. Now only show your message, wrapped with a single markdown ```text codeblock! Do not provide any explanations or details',
].join('\n');

/**
 * @typedef {object} PromptChange
 * @property {string} path  absolute path of the changed file
 * @property {string} diff  unified diff of the change
 * @property {string} [originalCode]  the file's current content ("ORIGINAL CODE")
 */

/**
 * @typedef {object} PromptInput
 * @property {string} repositoryName
 * @property {string} branchName
 * @property {{ user: string[], repository: string[] }} recentCommits
 * @property {PromptChange[]} changes
 * @property {string[]} instructions  the user's custom commit-message instructions
 * @property {boolean} [multiRoot]
 */

/**
 * @param {string} name
 * @param {string} body
 */
const tag = (name, body) => `<${name}>\n${body.replace(/\n+$/, '')}\n</${name}>\n`;

/** @type {Record<string, string>} */
const LANGUAGES = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', lua: 'lua', dart: 'dart', vue: 'vue',
  svelte: 'svelte',
};
const HASH_COMMENT = new Set(['python', 'ruby', 'shell', 'yaml', 'toml', 'dockerfile', 'makefile']);
const DASH_COMMENT = new Set(['sql', 'lua']);
const MARKUP_COMMENT = new Set(['markdown', 'html', 'xml', 'vue', 'svelte']);

/**
 * The code-fence language for a file path.
 * @param {string} filePath
 */
function languageOf(filePath) {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^makefile$/i.test(name)) return 'makefile';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return LANGUAGES[ext] ?? ext;
}

/**
 * Copilot's `filepath:` line, written as a comment in the file's language.
 * @param {string} language
 * @param {string} filePath
 */
function filePathComment(language, filePath) {
  if (HASH_COMMENT.has(language)) return `# filepath: ${filePath}`;
  if (DASH_COMMENT.has(language)) return `-- filepath: ${filePath}`;
  if (MARKUP_COMMENT.has(language)) return `<!-- filepath: ${filePath} -->`;
  if (language === 'css') return `/* filepath: ${filePath} */`;
  return `// filepath: ${filePath}`;
}

/**
 * A fenced code block like Copilot's: the fence is longer than any fence inside the code.
 * @param {string} language
 * @param {string} code
 * @param {string} [filePath]
 */
function codeBlock(language, code, filePath) {
  const longest = Math.max(0, ...Array.from(code.matchAll(/^\s*(`{3,})/gm), (m) => m[1].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const header = filePath ? `${filePathComment(language, filePath)}\n` : '';
  return `${fence}${language}\n${header}${code.replace(/^\n+|\s+$/g, '')}\n${fence}`;
}

/**
 * Copilot's "legacy" line numbers: right-aligned, then ": ".
 * @param {string} text
 */
function withLineNumbers(text) {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}: ${line}`).join('\n');
}

/** @param {string[]} items */
const bullets = (items) => items.map((item) => `- ${item}\n`).join('');

/**
 * The user message of Copilot's commit-message prompt.
 * @param {PromptInput} input
 */
function buildUserPrompt(input) {
  const parts = [
    tag('repository-context', `# REPOSITORY DETAILS:\nRepository name: ${input.repositoryName}\nBranch name: ${input.branchName}`),
  ];
  if (input.recentCommits.user.length > 0) {
    parts.push(tag('user-commits', `# RECENT USER COMMITS (For reference only, do not copy!):\n${bullets(input.recentCommits.user)}`));
  }
  if (input.recentCommits.repository.length > 0) {
    parts.push(tag('recent-commits', `# RECENT REPOSITORY COMMITS (For reference only, do not copy!):\n${bullets(input.recentCommits.repository)}`));
  }
  const changes = input.changes.map((change) => {
    const original = change.originalCode === undefined
      ? ''
      : tag('original-code', `# ORIGINAL CODE:\n${codeBlock(languageOf(change.path), withLineNumbers(change.originalCode), change.path)}`);
    return original + tag('code-changes', `# CODE CHANGES:\n${codeBlock('diff', change.diff)}`);
  });
  parts.push(tag('changes', changes.join('')));
  parts.push(tag('reminder', [
    'Now generate a commit messages that describe the CODE CHANGES.',
    'DO NOT COPY commits from RECENT COMMITS, but use it as reference for the commit style.',
    'ONLY return a single markdown code block, NO OTHER PROSE!',
    codeBlock('text', 'commit message goes here'),
  ].join('\n')));
  if (input.instructions.length > 0) {
    let intro = 'When generating the commit message, please use the following custom instructions provided by the user.';
    if (input.multiRoot) {
      intro += ' This is a multi-root workspace. The instructions below may come from different workspace folders. Apply each set of instructions to the folder it belongs to.';
    }
    intro += ' You can ignore an instruction if it contradicts a system message.';
    parts.push(tag('custom-instructions', `${intro}\n${tag('instructions', input.instructions.join('\n\n'))}`));
  }
  return parts.join('');
}

/**
 * Fit original code and diffs into `budget` chars the way Copilot's prompt priorities do:
 * original code (priority 800) goes before diffs (900), largest first. If the diffs alone are
 * still too big, each one gets a fair share of the budget.
 * @param {PromptChange[]} changes
 * @param {number} [budget]
 * @returns {PromptChange[]}
 */
function fitChanges(changes, budget = PROMPT_BUDGET) {
  const fitted = changes.map((change) => ({ ...change }));
  const size = () => fitted.reduce((n, c) => n + c.diff.length + (c.originalCode?.length ?? 0), 0);
  const withOriginal = fitted
    .filter((c) => c.originalCode !== undefined)
    .sort((a, b) => (b.originalCode?.length ?? 0) - (a.originalCode?.length ?? 0));
  for (const change of withOriginal) {
    if (size() <= budget) return fitted;
    delete change.originalCode;
  }
  if (size() <= budget) return fitted;

  let remaining = budget;
  const bySize = [...fitted].sort((a, b) => a.diff.length - b.diff.length);
  bySize.forEach((change, i) => {
    const share = Math.floor(remaining / (bySize.length - i));
    remaining -= Math.min(change.diff.length, share);
    if (change.diff.length > share) change.diff = truncateDiff(change.diff, share);
  });
  return fitted;
}

/**
 * Copilot's response parsing: the content of the ```text block, else the raw answer.
 * A block without the `text` language is accepted too.
 * @param {string} response
 */
function parseCommitMessage(response) {
  const block =
    /^```text\s*([\s\S]+?)\s*```$/m.exec(response) ??
    /^```[\w-]*[ \t]*\n([\s\S]+?)\n\s*```[ \t]*$/m.exec(response);
  return (block ? block[1] : response).trim();
}

module.exports = {
  SYSTEM_PROMPT,
  PROMPT_BUDGET,
  buildUserPrompt,
  codeBlock,
  withLineNumbers,
  languageOf,
  fitChanges,
  parseCommitMessage,
};
