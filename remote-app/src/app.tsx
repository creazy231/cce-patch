// The app shell: one Store, the current screen, toasts, and a frame that follows the visible viewport
// (so the composer sits on the keyboard instead of under it).

import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { Home } from "./components/Home";
import { Pair } from "./components/Pair";
import { Readme } from "./components/Readme";
import { Session } from "./components/Session";
import { Settings } from "./components/Settings";
import { AppContext, Toasts } from "./components/ui";
import type { AppState, Store } from "./state/store";

function useStoreState(store: Store): AppState {
  const [, setTick] = useState(0);
  const rendered = store.state;
  useLayoutEffect(() => {
    const rerender = () => setTick((tick) => tick + 1);
    const off = store.subscribe(rerender);
    if (store.state !== rendered) rerender();
    return off;
  }, [store]);
  return store.state;
}

/**
 * Sizes the app to the visual viewport. iOS keeps the layout viewport when the keyboard opens and pans the
 * visual one instead: the frame takes its height and offset, so the dock stays right above the keyboard.
 */
function useViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      const height = vv ? vv.height : window.innerHeight;
      const top = vv ? Math.max(0, vv.offsetTop) : 0;
      root.style.setProperty("--app-h", `${Math.round(height)}px`);
      root.style.setProperty("--app-top", `${Math.round(top)}px`);
      root.dataset.kb = window.innerHeight - height > 120 ? "1" : "0";
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
}

function CurrentScreen({ state }: { state: AppState }) {
  switch (state.route.name) {
    case "session":
    case "new":
      return <Session />;
    case "pair":
      return <Pair />;
    case "settings":
      return <Settings />;
    case "readme":
      return <Readme />;
    default:
      return state.macs.length ? <Home /> : <Pair />;
  }
}

export function App({ store }: { store: Store }) {
  const state = useStoreState(store);
  useViewport();
  // A session keeps its screen when a new session gets its id (same view), so nothing remounts then.
  const screenKey = state.view ? `view-${state.view.key}` : state.route.name;
  return (
    <AppContext.Provider value={{ store, state }}>
      <div class="frame" data-nav={state.nav}>
        <CurrentScreen key={screenKey} state={state} />
      </div>
      <Toasts toasts={state.toasts} />
    </AppContext.Provider>
  );
}
