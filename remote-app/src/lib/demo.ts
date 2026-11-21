// Built-in fixture data for `?demo`: screenshots and UI tests without a Mac or a network.
// Everything here is fictional (projects "acme-api", "acme-web", "docs-site").

import type { ContentBlock, Pending, PhoneMessage, Project, SessionSummary, SnapshotFrame, UsageFrame } from "./protocol";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();

// ---- builders -----------------------------------------------------------------------------------

type Part = string | ContentBlock;
const block = (part: Part): ContentBlock => (typeof part === "string" ? { type: "text", text: part } : part);

const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id, name, input });
const done = (toolUseId: string, text: string): ContentBlock => ({ type: "tool_result", toolUseId, text });
const think = (text: string): ContentBlock => ({ type: "thinking", text });

// The IDE context the extension puts in front of a prompt (same wording as the real one).
const opened = (path: string) =>
  `<ide_opened_file>The user opened the file ${path} in the IDE. This may or may not be related to the current task.</ide_opened_file>`;
const selected = (path: string, from: number, to: number, code: string) =>
  `<ide_selection>The user selected the lines ${from} to ${to} from ${path}:\n${code}\n\nThis may or may not be related to the current task.</ide_selection>`;

/** Messages of one session with ids prefix-1, prefix-2, … */
function thread(prefix: string) {
  let n = 0;
  const uuid = () => `${prefix}-${++n}`;
  return {
    user: (...parts: Part[]): PhoneMessage => ({ uuid: uuid(), type: "user", content: parts.map(block) }),
    assistant: (...parts: Part[]): PhoneMessage => ({ uuid: uuid(), type: "assistant", content: parts.map(block) }),
    /** A message of a subagent, folded under the Task call `parent`. */
    sub: (parent: string, message: PhoneMessage): PhoneMessage => ({ ...message, parent }),
    result: (durationMs: number, costUsd: number, numTurns: number): PhoneMessage => ({
      uuid: uuid(),
      type: "result",
      result: { subtype: "success", isError: false, durationMs, costUsd, numTurns },
    }),
    compact: (): PhoneMessage => ({ uuid: uuid(), type: "system", subtype: "compact_boundary" }),
  };
}

let requests = 0;
function prompt(fields: Omit<Pending, "requestId" | "createdAt"> & { ageMs: number }): Pending {
  const { ageMs, ...rest } = fields;
  return { requestId: `demo-request-${++requests}`, createdAt: now - ageMs, ...rest };
}

// ---- sessions -----------------------------------------------------------------------------------

interface DemoSession {
  project: string;
  summary: Omit<SessionSummary, "pendingCount">;
  messages: PhoneMessage[];
  pending: Pending[];
}

const invoices = thread("inv");
const rateLimit = thread("rl");
const auth = thread("auth");
const config = thread("cfg");
const datePicker = thread("dp");
const router = thread("rt");
const exportsRename = thread("ex");
const darkMode = thread("dm");

const ROUTER_PLAN = [
  "## Move to the new router",
  "",
  "1. Add the router package next to the old one, behind a small compatibility layer.",
  "2. Move the routes one page at a time, starting with `/settings`.",
  "3. Replace every `<Link>` with the new component (a codemod handles 90 percent).",
  "4. Delete the old router once the last route is moved.",
  "",
  "**Risk:** deep links with query strings. We keep a redirect map for one release.",
].join("\n");

const DATE_PICKER_QUESTIONS = [
  {
    question: "Which date picker library should we use?",
    header: "Library",
    multiSelect: false,
    options: [
      { label: "react-day-picker", description: "Small and accessible; you style it yourself" },
      { label: "A full UI kit", description: "Ready-made look, but a large dependency" },
      { label: "Keep our own", description: "No new dependency, we keep maintaining it" },
    ],
  },
  {
    question: "Which presets should the picker offer?",
    header: "Presets",
    multiSelect: true,
    options: [{ label: "Last 7 days" }, { label: "Last 30 days" }, { label: "This quarter" }, { label: "Custom range only" }],
  },
];

const SESSIONS: DemoSession[] = [
  {
    project: "demo-acme-api",
    summary: {
      id: "demo-session-invoices",
      title: "Fix flaky invoice export test",
      lastModified: now - 2 * MINUTE,
      state: "waiting",
      live: true,
      gitBranch: "fix/invoice-export",
    },
    messages: [
      invoices.user(
        opened("~/code/acme-api/src/invoices/export.test.ts"),
        "The invoice export test fails every few runs on CI. Can you find out why and fix it?",
      ),
      invoices.assistant(
        think("Flaky tests are usually about time, ordering or shared state. Start with the test and the exporter."),
        "I'll start with the test and the exporter.",
      ),
      invoices.assistant(
        use("inv-grep", "Grep", { pattern: "exportInvoices", path: "~/code/acme-api/src" }),
        use("inv-read", "Read", { file_path: "~/code/acme-api/src/invoices/export.ts" }),
      ),
      invoices.user(
        done("inv-grep", "src/invoices/export.ts:14\nsrc/invoices/export.test.ts:9\nsrc/routes/invoices.ts:31"),
        done(
          "inv-read",
          "export async function exportInvoices(accountId: string) {\n  const rows = await db.query(\"select * from invoices where account_id = $1\", [accountId]);\n  return toCsv(rows);\n}",
        ),
      ),
      invoices.assistant(
        use("inv-todos", "TodoWrite", {
          todos: [
            { content: "Reproduce the flaky export test", status: "completed", activeForm: "Reproducing the flaky export test" },
            { content: "Find the source of the ordering difference", status: "completed", activeForm: "Finding the source of the ordering difference" },
            { content: "Sort invoices before exporting", status: "in_progress", activeForm: "Sorting invoices before exporting" },
            { content: "Add a regression test", status: "pending", activeForm: "Adding a regression test" },
            { content: "Run the full invoice suite", status: "pending", activeForm: "Running the full invoice suite" },
          ],
        }),
      ),
      invoices.user(done("inv-todos", "Todos have been modified successfully.")),
      invoices.assistant(
        "Found it: the query has no `order by`, so the database may return rows in a different order between runs, and the test compares the CSV line by line. I'll sort by `issued_at`, then `id`.",
        use("inv-edit", "Edit", {
          file_path: "~/code/acme-api/src/invoices/export.ts",
          old_string: 'where account_id = $1", [accountId]',
          new_string: 'where account_id = $1 order by issued_at, id", [accountId]',
        }),
      ),
      invoices.user(done("inv-edit", "The file ~/code/acme-api/src/invoices/export.ts has been updated.")),
      invoices.assistant(
        "Now a regression test that shuffles the rows first, and a run of the invoice tests.",
        use("inv-add-test", "Edit", {
          file_path: "~/code/acme-api/src/invoices/export.test.ts",
          old_string: "describe(\"exportInvoices\", () => {",
          new_string: "describe(\"exportInvoices\", () => {\n  it(\"does not depend on the order the database returns\", async () => {\n    // shuffle, export, compare\n  });\n",
        }),
        use("inv-run", "Bash", { command: "npm test -- --run invoices", description: "Run the invoice tests" }),
      ),
    ],
    pending: [
      prompt({
        kind: "tool",
        toolName: "Edit",
        input: {
          file_path: "~/code/acme-api/src/invoices/export.test.ts",
          old_string: "describe(\"exportInvoices\", () => {",
          new_string: "describe(\"exportInvoices\", () => {\n  it(\"does not depend on the order the database returns\", async () => {\n    // shuffle, export, compare\n  });\n",
        },
        suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        canAlwaysAllow: true,
        alwaysLabel: "Yes, allow all edits this session",
        ageMs: 40 * SECOND,
      }),
      prompt({
        kind: "tool",
        toolName: "Bash",
        input: { command: "npm test -- --run invoices", description: "Run the invoice tests" },
        suggestions: [{ type: "addRules", behavior: "allow", destination: "localSettings" }],
        canAlwaysAllow: true,
        alwaysLabel: "Yes, and don't ask again",
        ageMs: 39 * SECOND,
      }),
    ],
  },

  {
    project: "demo-acme-api",
    summary: {
      id: "demo-session-ratelimit",
      title: "Add rate limiting to /v1/orders",
      lastModified: now - 20 * SECOND,
      state: "running",
      live: true,
      gitBranch: "feat/rate-limit",
      worktree: "rate-limit",
    },
    messages: [
      rateLimit.user("Add rate limiting to POST /v1/orders: 60 requests per minute per API key, and a 429 with a Retry-After header."),
      rateLimit.assistant(
        think("Check how middleware is wired and whether a limiter already exists before writing one."),
        "Let me check how middleware is wired up, and whether we already have a limiter.",
      ),
      rateLimit.assistant(
        use("rl-task", "Task", {
          description: "Find existing middleware and limiter code",
          subagent_type: "Explore",
          prompt: "Look for middleware registration and any existing rate limiting in ~/code/acme-api/src.",
        }),
      ),
      rateLimit.sub("rl-task", rateLimit.user("Look for middleware registration and any existing rate limiting in ~/code/acme-api/src.")),
      rateLimit.sub("rl-task", rateLimit.assistant(use("rl-grep", "Grep", { pattern: "rateLimit|limiter", path: "~/code/acme-api/src" }))),
      rateLimit.sub("rl-task", rateLimit.user(done("rl-grep", "No matches found"))),
      rateLimit.sub("rl-task", rateLimit.assistant(use("rl-read", "Read", { file_path: "~/code/acme-api/src/middleware/index.ts" }))),
      rateLimit.sub("rl-task", rateLimit.user(done("rl-read", "export const middleware = [cors(), json(), auth()];"))),
      rateLimit.sub("rl-task", rateLimit.assistant("No limiter yet. Middleware is an ordered array in src/middleware/index.ts.")),
      rateLimit.user(
        done(
          "rl-task",
          "There is no rate limiting yet. Middleware is an ordered array in src/middleware/index.ts; auth() runs last, so a limiter keyed by API key has to come after it.",
        ),
      ),
      rateLimit.assistant(
        "No limiter exists, and order matters: `auth()` runs last, so the limiter goes after it. Writing the middleware now.",
        use("rl-write", "Write", {
          file_path: "~/code/acme-api/src/middleware/rate-limit.ts",
          content:
            "export function rateLimit({ perMinute }: { perMinute: number }) {\n  const hits = new Map<string, number[]>();\n  return (req, res, next) => {\n    // sliding window per API key\n    next();\n  };\n}\n",
        }),
      ),
      rateLimit.user(done("rl-write", "File created successfully at: ~/code/acme-api/src/middleware/rate-limit.ts")),
      rateLimit.assistant(
        "Wiring it in and running the linter.",
        use("rl-edit", "Edit", {
          file_path: "~/code/acme-api/src/middleware/index.ts",
          old_string: "[cors(), json(), auth()]",
          new_string: "[cors(), json(), auth(), rateLimit({ perMinute: 60 })]",
        }),
        use("rl-lint", "Bash", { command: "npm run lint", description: "Lint the project" }),
      ),
      rateLimit.user(done("rl-edit", "The file ~/code/acme-api/src/middleware/index.ts has been updated.")),
    ],
    pending: [],
  },

  {
    project: "demo-acme-api",
    summary: {
      id: "demo-session-auth",
      title: "Explain the auth middleware",
      lastModified: now - 3 * HOUR,
      state: "unread",
      live: false,
      gitBranch: "main",
    },
    messages: [
      auth.user(
        selected("~/code/acme-api/src/middleware/auth.ts", 12, 31, "export function auth() {\n  return async (req, res, next) => {\n    // ...\n  };\n}"),
        "Explain what this middleware does and where it can fail.",
      ),
      auth.assistant(
        [
          "`auth()` is the last step before routing. It reads the `Authorization` header and attaches the account to the request:",
          "",
          "1. Reads the bearer token.",
          "2. Looks the key up in the `api_keys` table (cached for 60 seconds).",
          "3. Rejects with `401` when the key is missing, expired or revoked.",
          "",
          "```ts",
          "const account = await keys.lookup(token);",
          'if (!account) throw new HttpError(401, "invalid_key");',
          "```",
          "",
          "Where it can fail:",
          "",
          "- **Cache lag**: a revoked key keeps working for up to 60 seconds.",
          "- **Clock skew**: `expiresAt` is compared with the server clock.",
          "- **Missing header**: answers `401` instead of `400`, which hides client bugs.",
        ].join("\n"),
      ),
      auth.result(42 * SECOND, 0.06, 1),
    ],
    pending: [],
  },

  {
    project: "demo-acme-api",
    summary: {
      id: "demo-session-config",
      title: "Refactor config loading",
      lastModified: now - 2 * DAY,
      state: "idle",
      live: false,
      gitBranch: "refactor/config",
    },
    messages: [
      config.compact(),
      config.user(
        "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nThe user is moving config loading into src/config/load.ts. Done: the loader and its tests. Left: remove the old readEnv() helper and update two imports.",
      ),
      config.user("Where were we?"),
      config.assistant("We were moving config loading into `src/config/load.ts`. What is left: remove the old `readEnv()` helper and update two imports."),
      config.result(8 * SECOND, 0.02, 1),
    ],
    pending: [],
  },

  {
    project: "demo-acme-web",
    summary: {
      id: "demo-session-datepicker",
      title: "Which date picker should we use?",
      lastModified: now - 5 * MINUTE,
      state: "waiting",
      live: true,
      gitBranch: "feat/report-range",
    },
    messages: [
      datePicker.user("We need a date range picker for the reports page. Which library should we use? Ask me if it depends on my preferences."),
      datePicker.assistant(
        "It depends on a couple of choices, so let me ask.",
        use("dp-ask", "AskUserQuestion", { questions: DATE_PICKER_QUESTIONS }),
      ),
    ],
    pending: [
      prompt({
        kind: "question",
        toolName: "AskUserQuestion",
        input: { questions: DATE_PICKER_QUESTIONS },
        canAlwaysAllow: false,
        ageMs: 4 * MINUTE,
      }),
    ],
  },

  {
    project: "demo-acme-web",
    summary: {
      id: "demo-session-router",
      title: "Plan: move to the new router",
      lastModified: now - 12 * MINUTE,
      state: "waiting",
      live: true,
      gitBranch: "chore/router",
    },
    messages: [
      router.user("Plan the move from the old router to the new one. Don't change anything yet."),
      router.assistant(
        use("rt-glob", "Glob", { pattern: "src/**/routes*.tsx" }),
        use("rt-grep", "Grep", { pattern: "from \"old-router\"", path: "~/code/acme-web/src" }),
      ),
      router.user(
        done("rt-glob", "src/app/routes.tsx\nsrc/settings/routes.tsx"),
        done("rt-grep", "src/app/routes.tsx:3\nsrc/settings/routes.tsx:2\nsrc/components/NavLink.tsx:1"),
      ),
      router.assistant(
        "There are two route files and one shared link component, so this is a small migration. Here is the plan.",
        use("rt-plan", "ExitPlanMode", { plan: ROUTER_PLAN }),
      ),
    ],
    pending: [
      prompt({
        kind: "plan",
        toolName: "ExitPlanMode",
        input: { plan: ROUTER_PLAN },
        canAlwaysAllow: false,
        ageMs: 11 * MINUTE,
      }),
    ],
  },

  {
    project: "demo-acme-web",
    summary: {
      id: "demo-session-exports",
      title: "Rename the exports in the UI kit",
      lastModified: now - 25 * MINUTE,
      state: "waiting",
      live: true,
      gitBranch: "chore/ui-exports",
    },
    messages: [
      exportsRename.user("Rename `Btn` to `Button` everywhere in ~/code/acme-ui and keep a deprecated alias."),
      exportsRename.assistant("Renaming the component and adding the alias, then updating the imports."),
    ],
    pending: [
      prompt({
        kind: "dialog",
        toolName: "dialog",
        dialogKind: "refusal_fallback_prompt",
        input: {},
        canAlwaysAllow: false,
        ageMs: 24 * MINUTE,
      }),
    ],
  },

  {
    project: "demo-acme-web",
    summary: {
      id: "demo-session-dark",
      title: "Dark mode polish",
      lastModified: now - 26 * HOUR,
      state: "idle",
      live: false,
      gitBranch: "feat/dark-mode",
    },
    messages: [
      darkMode.user(opened("~/code/acme-web/src/styles/theme.css"), "The dark theme's borders look too bright. Can you tone them down?"),
      darkMode.assistant(
        "I lowered the border contrast in the dark palette:",
        use("dm-edit", "Edit", {
          file_path: "~/code/acme-web/src/styles/theme.css",
          old_string: "--border: #3a3f47;",
          new_string: "--border: #2b2f36;",
        }),
      ),
      darkMode.user(done("dm-edit", "The file ~/code/acme-web/src/styles/theme.css has been updated.")),
      darkMode.assistant("Done. Borders in the dark theme are now `#2b2f36`; the light theme is unchanged."),
      darkMode.result(19 * SECOND, 0.03, 2),
    ],
    pending: [],
  },
];

// ---- exports ------------------------------------------------------------------------------------

const PROJECT_INFO: Array<Omit<Project, "sessions">> = [
  {
    id: "demo-acme-api",
    name: "acme-api",
    folders: ["~/code/acme-api"],
    editor: "Visual Studio Code - Insiders",
    claudeOpen: true,
  },
  {
    id: "demo-acme-web",
    name: "acme-web",
    folders: ["~/code/acme-web", "~/code/acme-ui"],
    editor: "Cursor",
    claudeOpen: true,
  },
  {
    id: "demo-docs-site",
    name: "docs-site",
    folders: ["~/code/docs-site"],
    editor: "Visual Studio Code",
    claudeOpen: false,
  },
];

/** Three windows: two with sessions in every state, one where Claude Code isn't open. */
export const demoProjects: Project[] = PROJECT_INFO.map((info) => ({
  ...info,
  sessions: SESSIONS.filter((s) => s.project === info.id).map((s) => ({ ...s.summary, pendingCount: s.pending.length })),
}));

/** What the Mac sends after `sub` for a demo session; an unknown id gives an empty, idle session. */
/**
 * The demo's usage meter: a 5-hour limit at 42 % resetting in 2 h 13 min, the week at 18 % resetting in 3 days, for
 * a fictional account.
 */
export function demoUsage(at: number): UsageFrame {
  return {
    t: "usage",
    state: "ok",
    fiveHour: { percent: 42, resetsAt: at + 2 * HOUR + 13 * MINUTE },
    week: { percent: 18, resetsAt: at + 3 * DAY },
    at,
    account: "you@example.com",
  };
}

export function demoSnapshot(sessionId: string): SnapshotFrame {
  const demo = SESSIONS.find((s) => s.summary.id === sessionId);
  return {
    t: "snapshot",
    project: demo?.project ?? "",
    session: sessionId,
    messages: demo?.messages ?? [],
    pending: demo?.pending ?? [],
    state: demo?.summary.state ?? "idle",
    live: demo?.summary.live ?? false,
    truncatedBefore: 0,
  };
}
