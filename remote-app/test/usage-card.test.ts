import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { h, render } from "preact";
import type { UsageFrame } from "../src/lib/protocol";

// The card rendered by Preact into a jsdom document (Preact creates elements through the global document).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
const previous = { window: g.window, document: g.document };
let UsageCard: typeof import("../src/components/UsageCard").UsageCard;

beforeAll(async () => {
  g.window = dom.window;
  g.document = dom.window.document;
  ({ UsageCard } = await import("../src/components/UsageCard"));
});

afterAll(() => {
  g.window = previous.window;
  g.document = previous.document;
  dom.window.close();
});

const MAC_NOW = new Date(2026, 10, 20, 9, 0).getTime();

/** The card as rendered for `usage`. */
function card(usage: UsageFrame): Element {
  const box = dom.window.document.createElement("div");
  render(h(UsageCard, { usage, macNow: MAC_NOW }), box);
  return box.querySelector(".usage-card")!;
}

describe("UsageCard: the account", () => {
  test("is the first line, above the limits", () => {
    const shown = card({ t: "usage", state: "ok", fiveHour: { percent: 42 }, account: "ada@example.com" });
    expect(shown.firstElementChild!.textContent).toBe("ada@example.com");
    expect(shown.querySelectorAll(".usage-row")).toHaveLength(1);
  });

  test("is shown above the note while there are no numbers yet", () => {
    const shown = card({ t: "usage", state: "none", account: "ada@example.com" });
    expect([...shown.children].map((child) => child.textContent)).toEqual([
      "ada@example.com",
      "No usage numbers yet. They show up once Claude Code has run a session on this Mac.",
    ]);
  });

  test("has no line when the Mac doesn't say", () => {
    const shown = card({ t: "usage", state: "ok", fiveHour: { percent: 42 } });
    expect(shown.firstElementChild!.classList.contains("usage-row")).toBe(true);
    expect(shown.textContent).not.toContain("@");
  });
});
