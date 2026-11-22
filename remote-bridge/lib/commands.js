// @ts-check
'use strict';
// Slash commands: Claude Code's list of a window's commands as the phone gets it. Pure functions, no I/O.
//
//   toSlashCommands(raw)   Claude Code's entries -> the commands VS Code's `/` menu shows, by the name it shows
//
// The entries come from extension 2.1.330, either the window's config (`comms.settledConfig.commands`, its stored
// copy, its `config` promise) or a running session's `query.supportedCommands()`. Both have the same shape,
// {name, description, argumentHint, aliases?, builtin?, plugin?}. VS Code's webview lists them under "Slash
// Commands" by their invocation, which is the name, or, for a name that more than one command has, the alias that
// ends in `:<name>` (the plugin-prefixed form). Its registry keeps the last entry for an invocation, and the
// section is sorted by label.
//
// What this returns is only shaped, not bounded: the hub checks lengths, counts and characters before anything
// reaches a phone.

/**
 * One command as the phone gets it. `name` is what goes after the `/`.
 * @typedef {{ name: string, description?: string, argumentHint?: string, aliases?: string[], plugin?: string }} SlashCommand
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {value is string} */
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * The window's commands as VS Code's `/` menu shows them: by VS Code's name for each, a later entry replacing an
 * earlier one with the same name, sorted by name. Entries without a name and fields that are empty or not strings
 * are left out; anything that is not a list gives [].
 * @param {unknown} raw
 * @returns {SlashCommand[]}
 */
function toSlashCommands(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = raw.filter((entry) => isRecord(entry) && isText(entry.name));
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  /** @type {Map<string, SlashCommand>} */
  const byName = new Map();
  for (const entry of entries) {
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter(isText) : [];
    const shared = (counts.get(entry.name) ?? 0) > 1;
    const name = (shared && aliases.find((alias) => alias.endsWith(`:${entry.name}`))) || entry.name;
    /** @type {SlashCommand} */
    const command = { name };
    if (isText(entry.description)) command.description = entry.description;
    if (isText(entry.argumentHint)) command.argumentHint = entry.argumentHint;
    if (aliases.length > 0) command.aliases = aliases;
    if (isText(entry.plugin)) command.plugin = entry.plugin;
    byName.delete(name); // a later entry replaces the earlier one, as in VS Code's registry
    byName.set(name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { toSlashCommands };
