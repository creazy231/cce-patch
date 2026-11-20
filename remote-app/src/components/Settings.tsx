// Settings: the paired Macs (rename, remove), notifications, the app's version and its README.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Mac } from "../lib/macs";
import { ensureVapidKeys } from "../lib/push";
import { hostOf } from "../state/format";
import { DICTATION_LANGS, loadDictationLang, saveDictationLang, type DictationLangChoice } from "../lib/dictation";
import { displayText, measureDisplay } from "../lib/viewport";
import { pushStatusText } from "../state/push-status";
import { isStandalone, type PushState } from "../state/store";
import { Book, ChevronRight, Laptop, Plus } from "./icons";
import { NavBar, useApp } from "./ui";

export function Settings() {
  const { state, store } = useApp();
  // Made while Settings opens, so the tap on "Turn on notifications" can ask for permission first.
  useEffect(() => {
    store.refreshPushSupport();
    if (!state.demo && store.state.push.support === "ok") void ensureVapidKeys().catch(() => undefined);
  }, []);
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

        <h2 class="group-title">Notifications</h2>
        <Notifications push={state.push} demo={state.demo} macName={store.macName} />

        <h2 class="group-title">Dictation</h2>
        <DictationSettings />

        <h2 class="group-title">About</h2>
        <div class="group">
          <div class="kv">
            <span>Version</span>
            <span class="mono kv-value">{__APP_VERSION__}</span>
          </div>
          <div class="kv kv-wrap">
            <span>Display</span>
            <span class="mono kv-value kv-display">{displayText(measureDisplay(isStandalone()))}</span>
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

function Notifications({ push, demo, macName }: { push: PushState; demo: boolean; macName: string }) {
  const { store } = useApp();
  const guidance = demo
    ? "Notifications aren't available in the demo."
    : push.support === "not-installed"
      ? "Add CCE Remote to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications."
      : push.support === "unsupported"
        ? "This browser can't show notifications from CCE Remote. On iPhone they need iOS 16.4 or later."
        : push.support === "denied"
          ? "Notifications are blocked for CCE Remote. Allow them in the Settings app → Notifications → CCE Remote."
          : null;

  if (guidance) {
    return (
      <div class="group group-note">
        <p>{guidance}</p>
      </div>
    );
  }

  if (!push.on) {
    return (
      <>
        <button type="button" class="group-action" disabled={push.busy} onClick={() => void store.enablePush()}>
          Turn on notifications
        </button>
        <p class="fine settings-fine">Get a notification when Claude needs you or a session finishes.</p>
      </>
    );
  }

  return (
    <>
      <div class="group">
        <SwitchRow label="When Claude needs you" checked={push.prefs.waiting} onChange={(value) => void store.setPushPref("waiting", value)} />
        <SwitchRow label="When a session finishes" checked={push.prefs.done} onChange={(value) => void store.setPushPref("done", value)} />
        <SwitchRow
          label="Only when I'm away from the Mac"
          sub="After 2 minutes without keyboard or mouse use on the Mac"
          checked={push.prefs.onlyAway}
          onChange={(value) => void store.setPushPref("onlyAway", value)}
        />
        <SwitchRow
          label="Show details"
          sub="Project, session and question in the notification"
          checked={push.prefs.details}
          onChange={(value) => void store.setPushPref("details", value)}
        />
      </div>
      <div class="group">
        <div class="kv">
          <span>Status</span>
          <span class="kv-value">{pushStatusText(push, macName)}</span>
        </div>
      </div>
      <p class="fine settings-fine">Other paired Macs are set up the next time the app connects to them.</p>
      <div class="group">
        <button type="button" class="kv link" onClick={() => void store.testPush()}>
          <span class="kv-label">Send a test notification</span>
        </button>
        <button type="button" class="kv link" onClick={() => void store.disablePush()}>
          <span class="kv-label">Turn off notifications</span>
        </button>
      </div>
    </>
  );
}

function DictationSettings() {
  const [lang, setLang] = useState(() => loadDictationLang());
  return (
    <>
      <div class="group">
        <label class="kv">
          <span>Language</span>
          <select
            class="kv-select"
            value={lang}
            onChange={(event) => {
              const value = event.currentTarget.value as DictationLangChoice;
              setLang(value);
              saveDictationLang(value);
            }}
          >
            {DICTATION_LANGS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p class="fine settings-fine">Tap the microphone in the message field and speak. Your words appear in the field, and nothing is sent until you tap Send.</p>
    </>
  );
}

function SwitchRow({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label class="switch-row">
      <span class="switch-text">
        <span class="switch-label">{label}</span>
        {sub && <span class="switch-sub">{sub}</span>}
      </span>
      <input type="checkbox" role="switch" class="switch-input" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
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
