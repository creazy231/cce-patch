// Claude's Markdown → safe HTML. Two layers: marked never passes raw HTML from a message through (it is
// shown as text) and renders no images (no remote loads); DOMPurify then keeps a short list of tags, a few
// Markdown classes (never the app's own) and only http(s)/mailto links, which open outside the app.

import DOMPurify from "dompurify";
import { Marked } from "marked";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Raw HTML in a message is text, never markup.
    html({ text }) {
      return escapeHtml(text);
    },
    // No images: they would load from anywhere. The alt text stands in.
    image({ text }) {
      return text ? `<span class="md-image">${escapeHtml(text)}</span>` : "";
    },
  },
});

const SAFE_LINK = /^(?:https?:|mailto:)/i;

/**
 * The classes Markdown output may keep, by tag: a code block's language (marked), GitHub's task-list
 * classes, and the alt-text span this file renders. Every other class goes: the app's own (btn, banner,
 * toast …) would let a message dress text up as the app's buttons or notices.
 */
const KEPT_CLASSES: Readonly<Record<string, RegExp>> = {
  code: /^language-[\w+#.-]{1,40}$/,
  span: /^md-image$/,
  ul: /^contains-task-list$/,
  ol: /^contains-task-list$/,
  li: /^task-list-item$/,
  input: /^task-list-item-checkbox$/,
};

function keptClasses(tag: string, value: string): string {
  const rule = KEPT_CLASSES[tag.toLowerCase()];
  return rule ? value.split(/\s+/).filter((name) => rule.test(name)).join(" ") : "";
}

const CONFIG = {
  ALLOWED_TAGS: [
    "a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "code", "pre",
    "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "span", "input",
  ],
  ALLOWED_ATTR: ["href", "title", "start", "type", "checked", "disabled", "align", "colspan", "rowspan", "class"],
  // No ALLOWED_URI_REGEXP here: DOMPurify checks every attribute value against it (type="checkbox", start="3"
  // would go). Its default already drops script URLs; the hook below keeps only http(s) and mailto links.
  ALLOW_DATA_ATTR: false,
};

let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const classes = node.getAttribute("class");
    if (classes !== null) {
      const kept = keptClasses(node.nodeName, classes);
      if (kept) node.setAttribute("class", kept);
      else node.removeAttribute("class");
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href && SAFE_LINK.test(href.trim())) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else {
        node.removeAttribute("href");
      }
    } else if (node.tagName === "INPUT") {
      // Only the task-list checkboxes marked makes, read-only.
      if (node.getAttribute("type") === "checkbox") node.setAttribute("disabled", "");
      else node.remove();
    }
  });
}

/** The second layer on its own: an allowlist of tags, attributes and Markdown classes; only http(s) and mailto links, opened outside. */
export function sanitizeHtml(html: string): string {
  hook();
  return DOMPurify.sanitize(html, CONFIG);
}

// Messages don't change once complete, so their HTML is kept (bounded).
const cache = new Map<string, string>();
const CACHE_MAX = 400;

export function renderMarkdown(text: string, { cacheable = true } = {}): string {
  const hit = cacheable ? cache.get(text) : undefined;
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = sanitizeHtml(marked.parse(text, { async: false }));
  } catch {
    html = `<p>${escapeHtml(text)}</p>`;
  }
  if (cacheable) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, html);
  }
  return html;
}
