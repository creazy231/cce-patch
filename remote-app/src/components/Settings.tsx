// Settings: the paired Macs (rename, remove), the app's version and its README.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Mac } from "../lib/macs";
import { hostOf } from "../state/format";
import { Book, ChevronRight, Laptop, Plus } from "./icons";
import { NavBar, useApp } from "./ui";

export function Settings() {
  const { state, store } = useApp();
  return (
    <div class="screen settings">
      <NavBar onBack={() => store.back()} title="Settings" />
      <div class="scroll">
        <h2 class="group-title">Paired Macs</h2>
        {state.macs.length === 0 ? (
          <div class="group group-note">
            <p>No Mac is paired with this phone.</p>
          </div>
        ) : (
          <ul class="group" role="list">
            {state.macs.map((mac) => (
              <li key={mac.id}>
                <MacRow mac={mac} selected={mac.id === state.macId} conn={state.conn} />
              </li>
            ))}
          </ul>
        )}
        <button type="button" class="group-action" onClick={() => store.navigate({ name: "pair" })}>
          <Plus size={18} stroke={2.2} />
          Pair another Mac
        </button>

        <h2 class="group-title">About</h2>
        <div class="group">
          <div class="kv">
            <span>Version</span>
            <span class="mono kv-value">{__APP_VERSION__}</span>
          </div>
          <button type="button" class="kv link" onClick={() => store.navigate({ name: "readme" })}>
            <span class="kv-label">
              <Book size={18} />
              Read me
            </span>
            <ChevronRight size={16} stroke={2.2} class="row-chevron" />
          </button>
        </div>
        <p class="fine settings-fine">
          CCE Remote talks to your Mac directly over Tailscale. Your sessions never pass through the server that hosts this app.
        </p>

        {state.demo && (
          <div class="notice demo-note">
            <div>
              <strong>This is the demo.</strong>
              <span>Everything here is made-up data and nothing leaves this page.</span>
            </div>
            <button type="button" class="banner-btn" onClick={() => location.assign(location.pathname)}>
              Leave the demo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MacRow({ mac, selected, conn }: { mac: Mac; selected: boolean; conn: string }) {
  const { store } = useApp();
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const [name, setName] = useState(mac.name);
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (mode === "rename") field.current?.focus();
  }, [mode]);
  const status = !selected ? "" : conn === "open" ? "Connected" : conn === "connecting" ? "Connecting" : conn === "unauthorized" ? "Not paired anymore" : "Offline";

  if (mode === "rename") {
    return (
      <form
        class="mac-row editing"
        onSubmit={(event) => {
          event.preventDefault();
          store.renameMac(mac.id, name);
          setMode("view");
        }}
      >
        <input
          class="field"
          type="text"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
          ref={field}
          aria-label="Name for this Mac"
          maxLength={60}
        />
        <div class="mac-buttons">
          <button type="button" class="link-btn quiet" onClick={() => (setName(mac.name), setMode("view"))}>
            Cancel
          </button>
          <button type="submit" class="link-btn" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div class={`mac-row ${mode === "remove" ? "confirming" : ""}`}>
      <div class="mac-main">
        <span class="mac-icon" aria-hidden="true">
          <Laptop size={20} />
        </span>
        <div class="mac-text">
          <div class="mac-name">{mac.name}</div>
          <div class="mac-host mono">{hostOf(mac.url)}</div>
          {status && <div class={`mac-status ${conn === "open" ? "ok" : ""}`}>{status}</div>}
        </div>
      </div>
      {mode === "view" && (
        <div class="mac-actions">
          <button type="button" class="link-btn" onClick={() => setMode("rename")}>
            Rename
          </button>
          <button type="button" class="link-btn danger" onClick={() => setMode("remove")}>
            Remove
          </button>
        </div>
      )}
      {mode === "remove" && (
        <div class="mac-confirm" role="alert">
          <p>
            Remove {mac.name}? This phone forgets the pairing. To use this Mac again, pair it again. You can also remove the phone in the Mac's
            Connection tab.
          </p>
          <div class="mac-buttons">
            <button type="button" class="link-btn quiet" onClick={() => setMode("view")}>
              Keep
            </button>
            <button type="button" class="link-btn danger" onClick={() => store.removeMac(mac.id)}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
