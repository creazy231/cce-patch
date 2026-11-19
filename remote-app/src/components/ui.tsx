// Shared pieces: the store context, a small memo, status dots, spinners, the action sheet, the
// connection banner and toasts.

import { Component, createContext, h, type ComponentChildren, type FunctionComponent } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";
import type { SessionState } from "../lib/protocol";
import { STATE_LABEL, errorText } from "../state/format";
import type { AppState, Store, Toast } from "../state/store";
import { Check, ChevronLeft, Refresh, Wifi } from "./icons";

// ---- store context ----

export interface AppContextValue {
  store: Store;
  state: AppState;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside <AppContext.Provider>");
  return value;
}

// ---- memo (preact/compat's would patch Preact globally) ----

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/** Skips re-rendering while every prop is the same (`Object.is`). */
export function memo<P extends object>(render: FunctionComponent<P>): FunctionComponent<P> {
  class Memo extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      return !shallowEqual(this.props as Record<string, unknown>, next as Record<string, unknown>);
    }
    override render() {
      return h(render, this.props as P);
    }
  }
  return Memo as unknown as FunctionComponent<P>;
}

// ---- small things ----

export function StatusDot({ state, label = true }: { state: SessionState; label?: boolean }) {
  return label ? (
    <span class={`dot dot-${state}`} role="img" aria-label={STATE_LABEL[state]} />
  ) : (
    <span class={`dot dot-${state}`} aria-hidden="true" />
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} role={label ? "status" : undefined} aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

/** The screen's top bar: back on the left, a title, an action on the right. */
export function NavBar(props: {
  title?: ComponentChildren;
  subtitle?: ComponentChildren;
  onBack?: () => void;
  backBadge?: number;
  right?: ComponentChildren;
  class?: string;
}) {
  return (
    <header class={`navbar ${props.class ?? ""}`}>
      <div class="navbar-side">
        {props.onBack && (
          <button
            type="button"
            class="icon-btn back"
            onClick={props.onBack}
            aria-label={props.backBadge ? `Back, ${props.backBadge} more need you` : "Back"}
          >
            <ChevronLeft size={24} stroke={2.2} />
            {props.backBadge ? (
              <span class="back-badge" aria-hidden="true">
                {props.backBadge}
              </span>
            ) : null}
          </button>
        )}
      </div>
      <div class="navbar-title">
        {props.title !== undefined && <div class="navbar-t">{props.title}</div>}
        {props.subtitle !== undefined && <div class="navbar-s">{props.subtitle}</div>}
      </div>
      <div class="navbar-side right">{props.right}</div>
    </header>
  );
}

// ---- action sheet ----

export interface SheetAction {
  label: string;
  icon?: ComponentChildren;
  tone?: "default" | "danger" | "accent";
  checked?: boolean;
  run: () => void;
}

/** An iOS-style action sheet. Tapping outside or Cancel closes it. */
export function Sheet(props: { title?: string; subtitle?: string; actions: SheetAction[]; onClose: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="sheet-layer" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title ?? "Actions"} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-group">
          {props.title && (
            <div class="sheet-head">
              <div class="sheet-title">{props.title}</div>
              {props.subtitle && <div class="sheet-subtitle">{props.subtitle}</div>}
            </div>
          )}
          {props.actions.map((action, index) => (
            <button
              type="button"
              key={action.label}
              ref={index === 0 ? first : undefined}
              class={`sheet-action ${action.tone ?? "default"}`}
              onClick={() => {
                props.onClose();
                action.run();
              }}
            >
              {action.icon && <span class="sheet-icon">{action.icon}</span>}
              <span class="sheet-label">{action.label}</span>
              {action.checked && <Check size={18} class="sheet-check" />}
            </button>
          ))}
        </div>
        <button type="button" class="sheet-cancel" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- connection banner ----

/** Why the Mac doesn't accept this phone, under "doesn't accept this phone anymore". */
function refusedBecause(code: string | undefined): string {
  if (code === "revoked") return "It was removed in the Connection tab on the Mac.";
  if (code === "bad_origin") return "It was paired from another address of this app.";
  return "It was unpaired on the Mac, or the pairing is from another browser.";
}

/** Shown under the top bar while the Mac isn't connected. Hidden while the first connect is quick. */
export function ConnectionBanner() {
  const { state, store } = useApp();
  const { conn, refusal } = state;
  if (conn === "open" || !state.macId) return null;
  const mac = store.macName;
  if (conn === "unauthorized") {
    return (
      <div class="banner banner-error" role="alert">
        <div class="banner-text">
          <strong>{mac} doesn't accept this phone anymore.</strong>
          <span>{refusedBecause(refusal?.code)}</span>
        </div>
        <button type="button" class="banner-btn" onClick={() => store.navigate({ name: "pair" })}>
          Pair again
        </button>
      </div>
    );
  }
  if (state.remoteOff) {
    // The Mac turned remote access off (Disconnect in the Connection tab); the app keeps retrying.
    return (
      <div class="banner" role="status">
        <span class="banner-icon">
          <Wifi size={18} />
        </span>
        <div class="banner-text">
          <strong>Remote access is off on {mac}.</strong>
          <span>Turn it on in Claude Code's Connection tab on the Mac. This app reconnects by itself.</span>
        </div>
      </div>
    );
  }
  if (refusal) {
    // The Mac answered, but ended the connection (unsupported_version, …): the app keeps retrying.
    return (
      <div class="banner banner-error" role="alert">
        <div class="banner-text">
          <strong>{errorText(refusal.code, mac, refusal.message)}</strong>
          <span>Retrying by itself.</span>
        </div>
        <button type="button" class="banner-btn" onClick={() => store.reconnect()} aria-label="Retry now">
          <Refresh size={18} />
        </button>
      </div>
    );
  }
  if (conn === "connecting") {
    return (
      <div class="banner banner-quiet delayed" role="status">
        <span class="banner-icon">
          <span class="spinner" style={{ width: "14px", height: "14px" }}>
            <span aria-hidden="true" />
          </span>
        </span>
        <div class="banner-text">
          <strong>Connecting to {mac}…</strong>
        </div>
      </div>
    );
  }
  return (
    <div class="banner" role="status">
      <span class="banner-icon">
        <Wifi size={18} />
      </span>
      <div class="banner-text">
        <strong>Can't reach {mac}.</strong>
        <span>Is Tailscale on on this phone? Retrying by itself.</span>
      </div>
      <button type="button" class="banner-btn" onClick={() => store.reconnect()} aria-label="Retry now">
        <Refresh size={18} />
      </button>
    </div>
  );
}

// ---- toasts ----

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
