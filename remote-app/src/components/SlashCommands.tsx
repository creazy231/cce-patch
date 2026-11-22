// The list above the message field while a slash command is being typed: the window's slash commands that match,
// best first. A tap runs one (the composer sends `/name`); a command that takes arguments also has a button that
// puts it in the field to finish. Rows keep the field's focus, so the keyboard stays up and the tap lands.

import type { SlashCommand } from "../lib/protocol";
import type { CommandsEntry } from "../state/store";
import { ArrowUpLeft } from "./icons";
import { Spinner } from "./ui";

export interface SlashCommandsProps {
  /** The listbox's id, for the field's aria-controls. */
  id: string;
  /** The window's commands as the phone holds them (undefined: not asked for yet). */
  entry: CommandsEntry | undefined;
  /** The commands matching what is typed, best first. */
  items: SlashCommand[];
  /** The row a hardware keyboard has selected; -1 for none. */
  highlighted: number;
  /** Sending isn't possible right now (as when Send is disabled): rows don't run. */
  disabled: boolean;
  onRun(command: SlashCommand): void;
  onInsert(command: SlashCommand): void;
  onRetry(): void;
}

/** Pressing a row must not take the focus from the field: the list would close before the tap lands. */
const keepFocus = (event: Event) => event.preventDefault();

/** The id of a row, for the field's aria-activedescendant. */
export const optionId = (listId: string, index: number) => `${listId}-${index}`;

export function SlashCommands({ id, entry, items, highlighted, disabled, onRun, onInsert, onRetry }: SlashCommandsProps) {
  const hasList = (entry?.list.length ?? 0) > 0;
  let note: string | null = null;
  if (items.length === 0) {
    if (entry?.status === "unsupported") note = "This Mac can't list commands yet. Typing one still works.";
    else if (entry?.status === "failed" && !hasList) {
      return (
        <div class="slash-commands">
          <button type="button" class="slash-note slash-retry" onMouseDown={keepFocus} onPointerDown={keepFocus} onClick={onRetry}>
            Couldn't load commands. Tap to try again.
          </button>
        </div>
      );
    } else if (!entry || (entry.status === "loading" && !hasList)) note = "Loading commands…";
    else if (!hasList) note = "No slash commands in this window yet";
    else note = "No matching command";
  }
  if (note !== null) {
    return (
      <div class="slash-commands">
        <p class="slash-note" role="status">
          {note === "Loading commands…" && <Spinner size={14} />}
          {note}
        </p>
      </div>
    );
  }
  return (
    <div class="slash-commands">
      <ul id={id} class="slash-list" role="listbox" aria-label="Slash commands">
        {items.map((command, index) => (
          <li
            key={command.name}
            id={optionId(id, index)}
            role="option"
            class={index === highlighted ? "slash-row highlighted" : "slash-row"}
            aria-selected={index === highlighted ? "true" : "false"}
            aria-disabled={disabled ? "true" : undefined}
            onMouseDown={keepFocus}
            onPointerDown={keepFocus}
            onClick={() => {
              if (!disabled) onRun(command);
            }}
          >
            <span class="slash-text">
              <span class="slash-head">
                <span class="slash-name">/{command.name}</span>
                {command.argumentHint && <span class="slash-hint">{command.argumentHint}</span>}
                {command.plugin && <span class="slash-plugin">{command.plugin}</span>}
              </span>
              {command.description && <span class="slash-desc">{command.description}</span>}
            </span>
            {command.argumentHint && (
              <button
                type="button"
                class="slash-insert"
                aria-label={`Add arguments to /${command.name}`}
                onClick={(event) => {
                  event.stopPropagation(); // the row would run it
                  onInsert(command);
                }}
              >
                <ArrowUpLeft size={18} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
