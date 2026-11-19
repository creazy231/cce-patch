import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

// DOMPurify binds to the global window when it is first loaded: a jsdom window stands in for the browser
// (DOMPurify's own tests run on jsdom; happy-dom mis-sanitised, which the "really running" test below catches).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.com/" });
let renderMarkdown: (text: string) => string;
let sanitizeHtml: (html: string) => string;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  const previous = g.window;
  g.window = dom.window;
  ({ renderMarkdown, sanitizeHtml } = await import("../src/components/markdown"));
  g.window = previous;
});

afterAll(() => {
  dom.window.close();
});

/** The elements of the sanitised HTML, for asserting on attributes. */
function parse(html: string) {
  const box = dom.window.document.createElement("div");
  box.innerHTML = html;
  return box;
}

describe("the sanitizer (raw HTML in, safe HTML out)", () => {
  test("is really running (not the no-DOM passthrough)", () => {
    expect(sanitizeHtml("<p>ok<script>x()</script></p>")).toBe("<p>ok</p>");
  });

  test("drops scripts, event handlers, images, frames, SVG and forms", () => {
    const html = sanitizeHtml(
      [
        "<script>window.pwned = 1</script>",
        '<img src="x" onerror="window.pwned = 2">',
        '<svg onload="window.pwned = 3"><script>window.pwned = 4</script></svg>',
        '<iframe src="https://example.com"></iframe>',
        '<form action="https://example.com"><button>go</button></form>',
        '<object data="x"></object><embed src="x">',
        "<style>body{display:none}</style>",
      ].join(""),
    );
    expect(html).not.toMatch(/<(script|img|svg|iframe|form|button|object|embed|style)\b/i);
    expect(html).not.toMatch(/onerror|onload|pwned/i);
  });

  test("drops style and event attributes from allowed tags", () => {
    expect(sanitizeHtml('<p style="position:fixed" onclick="x()" title="t">text</p>')).toBe('<p title="t">text</p>');
  });

  test("classes: the app's own never pass, so a message can't dress text up as the app's buttons or banners", () => {
    const html = sanitizeHtml(
      [
        '<p class="btn btn-primary">a</p>',
        '<a href="https://example.com" class="banner-btn">b</a>',
        '<span class="toast toast-error">c</span>',
        '<strong class="pc-actions">d</strong>',
        '<ul class="sheet"><li class="sheet-label">e</li></ul>',
        '<p class="md-image">f</p>',
        '<pre class="language-ts">g</pre>',
        '<code class="language-">h</code>',
      ].join(""),
    );
    expect(html).not.toContain("class=");
  });

  test("classes: only a code block's language, task-list classes and the alt-text span keep theirs", () => {
    const box = parse(
      sanitizeHtml(
        [
          '<pre><code class="language-ts btn">x</code></pre>',
          '<span class="md-image banner">alt</span>',
          '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox btn" disabled> todo</li></ul>',
        ].join(""),
      ),
    );
    expect(box.querySelector("code")!.getAttribute("class")).toBe("language-ts");
    expect(box.querySelector("span")!.getAttribute("class")).toBe("md-image");
    expect(box.querySelector("ul")!.getAttribute("class")).toBe("contains-task-list");
    expect(box.querySelector("li")!.getAttribute("class")).toBe("task-list-item");
    expect(box.querySelector("input")!.getAttribute("class")).toBe("task-list-item-checkbox");
  });

  test("links: only http(s) and mailto keep their href, and they open outside the app", () => {
    for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "/relative", "tel:+100"]) {
      const a = parse(sanitizeHtml(`<a href="${bad}">x</a>`)).querySelector("a")!;
      expect(a.hasAttribute("href")).toBe(false);
      expect(a.textContent).toBe("x");
    }
    for (const good of ["https://example.com/docs", "http://example.com", "mailto:owner@example.com"]) {
      const a = parse(sanitizeHtml(`<a href="${good}" target="_self" rel="opener">x</a>`)).querySelector("a")!;
      expect(a.getAttribute("href")).toBe(good);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  test("inputs: only read-only checkboxes (task lists) stay", () => {
    expect(sanitizeHtml('<input type="text" value="x">')).toBe("");
    const box = parse(sanitizeHtml('<input type="checkbox" checked>'));
    const input = box.querySelector("input")!;
    expect(input.getAttribute("type")).toBe("checkbox");
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  test("keeps the attributes Markdown needs: ordered list start, table alignment, code language", () => {
    const html = sanitizeHtml('<ol start="3"><li>a</li></ol><table><tr><td align="right">1</td></tr></table><pre><code class="language-ts">x</code></pre>');
    expect(html).toContain('start="3"');
    expect(html).toContain('align="right"');
    expect(html).toContain('class="language-ts"');
  });
});

describe("renderMarkdown (Markdown in)", () => {
  test("raw HTML in a message is shown as text, never parsed", () => {
    const html = renderMarkdown('hello <script>window.pwned = 1</script> <img src=x onerror="window.pwned = 2"> <a href="https://evil.example">raw</a>');
    expect(html).not.toMatch(/<(script|img)\b/i);
    expect(html).not.toContain('<a href="https://evil.example"');
    expect(html).toContain("&lt;script&gt;");
  });

  test("Markdown links with unsafe schemes lose their href; https and mailto open outside", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)"]) {
      const a = parse(renderMarkdown(`[click](${bad})`)).querySelector("a");
      expect(a?.hasAttribute("href") ?? false).toBe(false);
    }
    const a = parse(renderMarkdown("[docs](https://example.com/docs) and <mailto:owner@example.com>")).querySelectorAll("a");
    expect([...a].map((link) => [link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])).toEqual([
      ["https://example.com/docs", "_blank", "noopener noreferrer"],
      ["mailto:owner@example.com", "_blank", "noopener noreferrer"],
    ]);
  });

  test("images become their alt text: nothing loads from anywhere", () => {
    const html = renderMarkdown("![a diagram](https://example.com/x.png)");
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain('<span class="md-image">a diagram</span>');
  });

  test("a code block keeps its language class; Markdown has no other way to set one", () => {
    const code = parse(renderMarkdown("```ts\nconst x = 1;\n```")).querySelector("code")!;
    expect(code.getAttribute("class")).toBe("language-ts");
    expect(renderMarkdown("**bold** _em_ `code` [link](https://example.com)\n\n> quote")).not.toContain("class=");
  });

  test("task lists keep their read-only checkboxes", () => {
    const boxes = parse(renderMarkdown("- [x] done\n- [ ] todo")).querySelectorAll("input");
    expect(boxes.length).toBe(2);
    expect([...boxes].every((box) => box.hasAttribute("disabled"))).toBe(true);
  });
});
