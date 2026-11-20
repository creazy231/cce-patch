// How the app reads the iPhone's viewport. Two iOS behaviours of home-screen apps shape this:
// - The keyboard: iOS shrinks `innerHeight` together with the visual viewport, so "innerHeight minus the
//   visual height" can't tell that the keyboard is open. The tallest visual height seen in the current
//   orientation can.
// - A short viewport: with content drawn under the status bar, iOS can report (and draw) a viewport that is
//   short by exactly the top inset (WebKit bugs 237961 and 301994). The strip below it belongs to iOS, so
//   the app can't paint there, and the home indicator sits in that strip, not over the app: the bottom
//   inset then counts as 0.

export interface ViewportSample {
  standalone: boolean;
  /** env(safe-area-inset-top), px. */
  sat: number;
  /** 100lvh, px: the full screen height in the iOS bug. */
  lvh: number;
  innerHeight: number;
  vvHeight: number;
  orientation: string;
}

export interface ViewportState {
  orientation: string;
  /** The tallest visual height seen in this orientation: the height without the keyboard. */
  baseline: number;
  short: boolean;
}

export interface ViewportResult {
  state: ViewportState;
  keyboardOpen: boolean;
  shortViewport: boolean;
}

/** A visual viewport this much shorter than the baseline has the keyboard open. */
const KEYBOARD_MIN_PX = 120;
/** How close the shortfall must be to the top inset to be the iOS bug. */
const SHORT_TOLERANCE_PX = 2;

function num(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function nextViewport(prev: ViewportState | null, s: ViewportSample): ViewportResult {
  const vvHeight = num(s.vvHeight);
  const sameOrientation = prev !== null && prev.orientation === s.orientation;
  const baseline = sameOrientation ? Math.max(prev.baseline, vvHeight) : vvHeight;
  const keyboardOpen = vvHeight > 0 && baseline - vvHeight > KEYBOARD_MIN_PX;
  let shortViewport: boolean;
  if (keyboardOpen) {
    shortViewport = sameOrientation ? prev.short : false;
  } else {
    const sat = num(s.sat);
    const lvh = num(s.lvh);
    const innerHeight = num(s.innerHeight);
    shortViewport = s.standalone && sat > 0 && lvh > 0 && innerHeight > 0 && Math.abs(lvh - innerHeight - sat) <= SHORT_TOLERANCE_PX;
  }
  return { state: { orientation: s.orientation, baseline, short: shortViewport }, keyboardOpen, shortViewport };
}

// ---- measuring ----------------------------------------------------------------------------------

/** A hidden element that measures 100lvh and the top and bottom insets. The caller removes it. */
export function createProbe(): HTMLElement {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:100lvh;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:content-box;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  return probe;
}

export function readProbe(probe: HTMLElement): { lvh: number; sat: number; sab: number } {
  const style = getComputedStyle(probe);
  return { lvh: parseFloat(style.height), sat: parseFloat(style.paddingTop), sab: parseFloat(style.paddingBottom) };
}

/** The screen's orientation, for nextViewport. */
export function orientationKey(): string {
  const type = (screen as Screen & { orientation?: { type?: string } }).orientation?.type;
  if (typeof type === "string" && type) return type;
  return String((window as Window & { orientation?: number }).orientation ?? "");
}

export interface DisplayInfo {
  screenW: number;
  screenH: number;
  innerHeight: number;
  outerHeight: number;
  clientHeight: number;
  vvHeight: number;
  vvTop: number;
  lvh: number;
  sat: number;
  sab: number;
  standalone: boolean;
}

/** Everything iOS reports about the viewport, for the Display row in Settings. */
export function measureDisplay(standalone: boolean): DisplayInfo {
  const probe = createProbe();
  try {
    const { lvh, sat, sab } = readProbe(probe);
    const vv = window.visualViewport;
    return {
      screenW: screen.width,
      screenH: screen.height,
      innerHeight: window.innerHeight,
      outerHeight: window.outerHeight,
      clientHeight: document.documentElement.clientHeight,
      vvHeight: vv ? vv.height : window.innerHeight,
      vvTop: vv ? vv.offsetTop : 0,
      lvh,
      sat,
      sab,
      standalone,
    };
  } finally {
    probe.remove();
  }
}

export function displayText(d: DisplayInfo): string {
  const r = (value: number) => Math.round(num(value));
  return (
    `screen ${r(d.screenW)}×${r(d.screenH)} · viewport ${r(d.innerHeight)} ` +
    `(visual ${r(d.vvHeight)} at ${r(d.vvTop)}, large ${r(d.lvh)}, outer ${r(d.outerHeight)}, client ${r(d.clientHeight)}) · ` +
    `insets ${r(d.sat)}/${r(d.sab)} · ${d.standalone ? "home screen" : "browser"}`
  );
}
