// Slash commands in the message field: when the list opens, which commands match what is typed, and how an ack's
// list is read. Pure functions, no I/O.

import type { SlashCommand } from "./protocol";

const BEING_TYPED = /^\/(\S*)$/;

/**
 * The command name being typed: what follows a leading "/" while the whole text is that slash and a name without
 * whitespace. Null otherwise (after a space the user is typing arguments; text before the slash is a message).
 */
export function slashQuery(text: string): string | null {
  const match = BEING_TYPED.exec(text);
  return match ? (match[1] ?? "") : null;
}

/** How well a command matches: 0 best; undefined when it doesn't. */
function score(command: SlashCommand, query: string): number | undefined {
  if (query === "") return 0;
  const name = command.name.toLowerCase();
  const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
  if (name.startsWith(query)) return 0;
  if (aliases.some((alias) => alias.startsWith(query)) || name.includes(query) || aliases.some((alias) => alias.includes(query))) return 1;
  if (command.description?.toLowerCase().includes(query)) return 2;
  return undefined;
}

/**
 * The commands matching `query` (case ignored), best first: the name starts with it; then an alias starts with it,
 * or the name or an alias contains it; then the description contains it. Alphabetical within each. All of them,
 * alphabetically, for "". The list given is left as it was.
 */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands
    .flatMap((command) => {
      const s = score(command, q);
      return s === undefined ? [] : [{ command, s }];
    })
    .sort((a, b) => a.s - b.s || a.command.name.localeCompare(b.command.name))
    .map(({ command }) => command);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** A Mac's list of commands, keeping only well-formed entries and their string fields; anything but a list is none. */
export function parseCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SlashCommand[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const name = text(raw.name);
    if (!name) return [];
    const command: SlashCommand = { name };
    const description = text(raw.description);
    if (description) command.description = description;
    const argumentHint = text(raw.argumentHint);
    if (argumentHint) command.argumentHint = argumentHint;
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => text(alias) !== undefined) : [];
    if (aliases.length > 0) command.aliases = aliases;
    const plugin = text(raw.plugin);
    if (plugin) command.plugin = plugin;
    return [command];
  });
}
