// A small stand-in for the browser DOM and clock, enough to run webview-runtime.js under bun test
// (no DOM library: the repo has no dependencies). It covers what the runtime uses: createElement/NS,
// text nodes, appendChild/removeChild/replaceChild, textContent, className, attributes, a few
// element properties, events that bubble, focus, and timers driven by hand. Not a test file itself.

export type Child = FakeElement | FakeText;

export class FakeText {
  parentNode: FakeElement | null = null;
  readonly nodeType = 3;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

export interface FakeEvent {
  type: string;
  target: FakeElement;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  childNodes: Child[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: FakeEvent) => void>> = {};
  className = "";
  disabled = false;
  value = "";
  type = "";
  placeholder = "";
  title = "";
  spellcheck = true;
  selectionStart = 0;
  selectionEnd = 0;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
    readonly namespaceURI = "http://www.w3.org/1999/xhtml",
  ) {}

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      add: (name: string) => {
        if (!names().includes(name)) this.className = [...names(), name].join(" ");
      },
      remove: (name: string) => {
        this.className = names().filter((n) => n !== name).join(" ");
      },
    };
  }

  get firstChild(): Child | null {
    return this.childNodes[0] ?? null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value !== "" && value != null) this.appendChild(new FakeText(String(value)));
  }

  get isConnected(): boolean {
    return this.ownerDocument.documentElement.contains(this);
  }

  appendChild<T extends Child>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends Child>(child: T, ref: Child | null): T {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const at = this.childNodes.indexOf(ref);
    if (at < 0) throw new Error("insertBefore: the reference node is not a child");
    child.parentNode = this;
    this.childNodes.splice(at, 0, child);
    return child;
  }

  removeChild<T extends Child>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    // Taking the focused element out of the document blurs it, as in a browser.
    const active = this.ownerDocument.activeElement;
    if (child instanceof FakeElement && active && child.contains(active)) this.ownerDocument.activeElement = this.ownerDocument.body;
    return child;
  }

  replaceChild<T extends Child>(next: Child, old: T): T {
    this.insertBefore(next, old);
    return this.removeChild(old);
  }

  contains(node: Child | null): boolean {
    for (let n: Child | FakeElement | null = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  focus() {
    if (this.isConnected) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  /** Fires an event at this element that bubbles to the document root. */
  dispatch(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    for (let node: FakeElement | null = this; node && !event.propagationStopped; node = node.parentNode) {
      for (const listener of [...(node.listeners[type] ?? [])]) listener.call(node, event);
    }
    return event;
  }

  /** A user click: nothing happens on a disabled button. */
  click() {
    if (!this.disabled) this.dispatch("click");
  }
}

export class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this, "HTML");
    this.body = this.documentElement.appendChild(new FakeElement(this, "BODY"));
    this.activeElement = this.body;
  }

  createElement(tag: string) {
    return new FakeElement(this, tag.toUpperCase());
  }

  createElementNS(namespace: string, tag: string) {
    return new FakeElement(this, tag, namespace);
  }

  createTextNode(text: string) {
    return new FakeText(text);
  }
}

/** Every element under `root` (itself included) that matches. */
export function findAll(root: FakeElement, match: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement) => {
    if (match(el)) out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}

/** The first element with this class. */
export const byClass = (root: FakeElement, name: string) => findAll(root, (el) => el.classList.contains(name))[0];

/** The first button with this text. */
export const button = (root: FakeElement, text: string) =>
  findAll(root, (el) => el.tagName === "BUTTON" && el.textContent === text)[0];

/** Lets every promise that can settle now do so (they all run before the next macrotask). */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers and a clock that only move when a test says so. */
export class FakeClock {
  now = Date.UTC(2026, 10, 19, 12, 0, 0);
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  readonly setTimeout = (fn: () => void, ms = 0) => this.add(fn, ms);
  readonly setInterval = (fn: () => void, ms = 0) => this.add(fn, ms, Math.max(1, ms));
  readonly clearTimeout = (id: number) => void this.timers.delete(id);
  readonly clearInterval = (id: number) => void this.timers.delete(id);

  /** Timers still waiting to run. */
  get pending() {
    return this.timers.size;
  }

  /** A `Date` whose `now()` is this clock (and `new Date(ms)` still works). */
  get Date(): DateConstructor {
    const clock = this;
    const FakeDate = function (this: unknown, ...args: any[]) {
      return args.length ? new (Date as any)(...args) : new Date(clock.now);
    } as unknown as DateConstructor;
    FakeDate.now = () => clock.now;
    return FakeDate;
  }

  /**
   * Moves time forward, running every timer that comes due, in order. Pending promises settle
   * before each timer and at the end, as they would between a real event loop's tasks.
   */
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.now = end;
    await settle();
  }

  private add(fn: () => void, ms: number, every?: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), fn, every });
    return id;
  }
}
