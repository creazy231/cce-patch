import { render } from "preact";
import { App } from "./app";
import { parseOpenLink } from "./lib/push";
import { Store } from "./state/store";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/home.css";
import "./styles/session.css";
import "./styles/markdown.css";
import "./styles/pair.css";

const params = new URLSearchParams(location.search);
const demo = params.has("demo");

// `?demo&inset=59,34`: pretend there are safe areas (notch, home indicator) for screenshots on a desktop.
const inset = demo ? /^(\d{1,3}),(\d{1,3})$/.exec(params.get("inset") ?? "") : null;
if (inset) {
  document.documentElement.style.setProperty("--sat", `${inset[1]}px`);
  document.documentElement.style.setProperty("--sab", `${inset[2]}px`);
}

const store = new Store({ demo });
store.start();
render(<App store={store} />, document.getElementById("app")!);

// The service worker keeps the app shell available offline; development runs without it.
if ("serviceWorker" in navigator) {
  // A tap on a notification: the worker posts the session's link, the app opens it.
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "cce-open" || typeof data.url !== "string") return;
    const link = parseOpenLink(new URL(data.url, location.origin).search);
    if (link) store.openFromLink(link);
  });
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    });
  }
}
