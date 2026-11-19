// Pairing: scan the QR code from the Mac's Connection tab, paste its link, or type address and code.
// The confirmation shows the Mac's host (from the address), not only the name the link carries.

import { useState } from "preact/hooks";
import { parsePairingInput } from "../lib/pairing";
import { cleanName, errorText, hostOf } from "../state/format";
import { isStandalone } from "../state/store";
import { ChevronRight, ClipboardIcon, Keyboard, Laptop, Scan, Wifi } from "./icons";
import { Scanner } from "./Scanner";
import { NavBar, Spinner, useApp } from "./ui";

const formatCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const NETWORK_ERRORS = new Set(["unreachable", "timeout", "connection_lost"]);

export function Pair() {
  const { state, store } = useApp();
  const { pair } = state;
  const canGoBack = state.macs.length > 0;
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [pasteBox, setPasteBox] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pasted, setPasted] = useState("");

  const onBack = canGoBack ? () => store.back() : undefined;

  if (pair.input && pair.fromLink && !isStandalone() && !pair.inBrowser) {
    return (
      <div class="screen pair">
        <NavBar onBack={onBack} />
        <div class="scroll">
          <div class="pair-hero">
            <img class="app-icon" src="/icons/icon-192.png" alt="" width={72} height={72} />
            <h1 class="large-title">One step first</h1>
            <p class="lede">
              Add CCE Remote to your Home Screen first (Share → Add to Home Screen), then open it and scan the code again.
            </p>
          </div>
          <ol class="steps">
            <li>
              <span class="step-n">1</span>
              <span>
                Tap <strong>Share</strong> in Safari's toolbar.
              </span>
            </li>
            <li>
              <span class="step-n">2</span>
              <span>
                Choose <strong>Add to Home Screen</strong>.
              </span>
            </li>
            <li>
              <span class="step-n">3</span>
              <span>
                Open <strong>CCE Remote</strong> from the Home Screen and scan the QR code on your Mac again.
              </span>
            </li>
          </ol>
          <p class="fine">The Home Screen app keeps its own storage, so a pairing made here in the browser doesn't carry over to it.</p>
          <button type="button" class="btn btn-secondary wide" onClick={() => store.pairInBrowser()}>
            Pair in this browser instead
          </button>
        </div>
      </div>
    );
  }

  if (pair.input) {
    const { input } = pair;
    const name = cleanName(input.name, hostOf(input.url));
    const networkError = pair.error !== null && NETWORK_ERRORS.has(pair.error);
    return (
      <div class="screen pair">
        <NavBar onBack={pair.busy ? undefined : () => store.cancelPair()} />
        <div class="scroll">
          <div class="confirm">
            <div class="confirm-mark" aria-hidden="true">
              <Laptop size={30} />
            </div>
            <h1 class="confirm-title">Pair with {name}?</h1>
            <p class="confirm-host mono">{hostOf(input.url)}</p>
            <p class="confirm-code">
              Code <span class="mono">{formatCode(input.code)}</span>
            </p>
            <p class="fine">Only pair with your own Mac: this phone will be able to drive Claude Code on it.</p>
          </div>
          {pair.error && (
            <div class={`notice ${networkError ? "" : "notice-error"}`} role="alert">
              {networkError && <Wifi size={20} />}
              <div>
                <strong>{errorText(pair.error, name, pair.errorMessage)}</strong>
                {networkError && <span>Open the Tailscale app on this phone and check that it's connected, then try again.</span>}
              </div>
            </div>
          )}
          <div class="confirm-actions">
            <button type="button" class="btn btn-primary wide" disabled={pair.busy} onClick={() => void store.confirmPair()}>
              {pair.busy ? <Spinner size={16} /> : null}
              <span>{pair.busy ? "Pairing…" : pair.error ? "Try again" : "Pair"}</span>
            </button>
            <button type="button" class="btn btn-quiet wide" disabled={pair.busy} onClick={() => store.cancelPair()}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const paste = async () => {
    store.clearPairError();
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error("empty");
      store.beginPair(text);
    } catch {
      // No clipboard access (or nothing in it): a field to paste into by hand.
      setPasteBox(true);
      setManual(false);
    }
  };

  return (
    <div class="screen pair">
      <NavBar onBack={onBack} />
      <div class="scroll">
        <div class="pair-hero">
          <img class="app-icon" src="/icons/icon-192.png" alt="" width={72} height={72} />
          <h1 class="large-title">Pair with your Mac</h1>
          <p class="lede">
            In VS Code on your Mac, open Claude Code's sessions panel and its <strong>Connection</strong> tab, then <strong>Connect with Tailscale</strong>.
            It shows a QR code and a pairing code.
          </p>
        </div>

        <div class="options">
          <button type="button" class="option" onClick={() => setScanning(true)}>
            <span class="option-icon">
              <Scan size={22} />
            </span>
            <span class="option-text">
              <strong>Scan the QR code</strong>
              <span>With this phone's camera</span>
            </span>
            <ChevronRight size={16} stroke={2.2} class="option-chevron" />
          </button>
          <button type="button" class="option" onClick={() => void paste()}>
            <span class="option-icon">
              <ClipboardIcon size={22} />
            </span>
            <span class="option-text">
              <strong>Paste the link</strong>
              <span>After “Copy link” on the Mac</span>
            </span>
            <ChevronRight size={16} stroke={2.2} class="option-chevron" />
          </button>
          <button
            type="button"
            class={`option ${manual ? "open" : ""}`}
           
            aria-expanded={manual}
            onClick={() => {
              setManual(!manual);
              setPasteBox(false);
              store.clearPairError();
            }}
          >
            <span class="option-icon">
              <Keyboard size={22} />
            </span>
            <span class="option-text">
              <strong>Enter address and code</strong>
              <span>Type what the Connection tab shows</span>
            </span>
            <ChevronRight size={16} stroke={2.2} class="option-chevron" />
          </button>
        </div>

        {manual && (
          <form
            class="form"
            onSubmit={(event) => {
              event.preventDefault();
              store.beginPair(`${address.trim()} ${code.trim()}`);
            }}
          >
            <label class="form-row">
              <span>Address</span>
              <input
                class="field"
                type="text"
                inputMode="url"
                value={address}
                onInput={(e) => setAddress(e.currentTarget.value)}
                placeholder="example-mac.tailnet-0000.ts.net"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                autocomplete="off"
                required
              />
            </label>
            <label class="form-row">
              <span>Code</span>
              <input
                class="field mono code-field"
                type="text"
                value={code}
                onInput={(e) => setCode(e.currentTarget.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                autocapitalize="characters"
                autocorrect="off"
                spellcheck={false}
                autocomplete="one-time-code"
                maxLength={12}
                required
              />
            </label>
            <button type="submit" class="btn btn-primary wide" disabled={!address.trim() || !code.trim()}>
              Continue
            </button>
          </form>
        )}

        {pasteBox && (
          <form
            class="form"
            onSubmit={(event) => {
              event.preventDefault();
              store.beginPair(pasted);
            }}
          >
            <label class="form-row">
              <span>Pairing link</span>
              <textarea
                class="field paste-field"
                value={pasted}
                rows={3}
                onInput={(e) => setPasted(e.currentTarget.value)}
                placeholder="Touch and hold here, then Paste"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
              />
            </label>
            <button type="submit" class="btn btn-primary wide" disabled={!pasted.trim()}>
              Continue
            </button>
          </form>
        )}

        {pair.error && (
          <div class="notice notice-error" role="alert">
            <div>
              <strong>{errorText(pair.error, undefined, pair.errorMessage)}</strong>
              <span>Use the QR code, the copied link, or the address and code exactly as the Connection tab shows them.</span>
            </div>
          </div>
        )}

        <p class="pair-foot">
          <Wifi size={16} />
          <span>Tailscale has to be on on this phone, in the same tailnet as the Mac.</span>
        </p>
      </div>

      {scanning && (
        <Scanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            if (!parsePairingInput(text)) return false;
            setScanning(false);
            store.beginPair(text);
            return true;
          }}
        />
      )}
    </div>
  );
}
