import { describe, expect, test } from "bun:test";
import { displayText, nextViewport, type ViewportSample } from "../src/lib/viewport";

// The user's iPhone in the home-screen app: 852 pt screen, 59 pt status bar, iOS reporting 793.
const short: ViewportSample = { standalone: true, sat: 59, lvh: 852, innerHeight: 793, vvHeight: 793, orientation: "portrait-primary" };

describe("nextViewport", () => {
  test("the first sample is the baseline, with the keyboard closed", () => {
    const r = nextViewport(null, { ...short, sat: 0 });
    expect(r.state.baseline).toBe(793);
    expect(r.keyboardOpen).toBe(false);
  });

  test("a keyboard is seen even when innerHeight shrinks with the visual viewport", () => {
    const first = nextViewport(null, short);
    const r = nextViewport(first.state, { ...short, innerHeight: 455, vvHeight: 455 });
    expect(r.keyboardOpen).toBe(true);
    expect(r.state.baseline).toBe(793);
  });

  test("small height changes are not a keyboard", () => {
    const first = nextViewport(null, short);
    expect(nextViewport(first.state, { ...short, vvHeight: 700 }).keyboardOpen).toBe(false);
  });

  test("turning the phone starts a new baseline instead of seeing a keyboard", () => {
    const first = nextViewport(null, short);
    const r = nextViewport(first.state, { ...short, sat: 0, lvh: 393, innerHeight: 393, vvHeight: 393, orientation: "landscape-primary" });
    expect(r.keyboardOpen).toBe(false);
    expect(r.state.baseline).toBe(393);
  });

  test("a viewport short by exactly the top inset is the iOS bug", () => {
    expect(nextViewport(null, short).shortViewport).toBe(true);
    expect(nextViewport(null, { ...short, lvh: 853 }).shortViewport).toBe(true); // within 2 pt
  });

  test("anything else is not the bug", () => {
    expect(nextViewport(null, { ...short, standalone: false }).shortViewport).toBe(false);
    expect(nextViewport(null, { ...short, sat: 0 }).shortViewport).toBe(false);
    expect(nextViewport(null, { ...short, innerHeight: 852, vvHeight: 852 }).shortViewport).toBe(false);
    expect(nextViewport(null, { ...short, lvh: 823 }).shortViewport).toBe(false);
    expect(nextViewport(null, { ...short, lvh: 0 }).shortViewport).toBe(false); // no lvh support
  });

  test("while the keyboard is open the last answer is kept", () => {
    const first = nextViewport(null, short);
    const open = nextViewport(first.state, { ...short, innerHeight: 455, vvHeight: 455 });
    expect(open.shortViewport).toBe(true);
    const plain = nextViewport(null, { ...short, sat: 0 });
    expect(nextViewport(plain.state, { ...short, sat: 0, innerHeight: 455, vvHeight: 455 }).shortViewport).toBe(false);
  });

  test("measurements that aren't numbers mean no keyboard and no bug", () => {
    const r = nextViewport(null, { ...short, sat: NaN, lvh: NaN, innerHeight: NaN, vvHeight: NaN });
    expect(r.keyboardOpen).toBe(false);
    expect(r.shortViewport).toBe(false);
    const after = nextViewport(nextViewport(null, short).state, { ...short, vvHeight: NaN });
    expect(after.keyboardOpen).toBe(false);
  });
});

describe("displayText", () => {
  test("puts every measurement on one line, in whole numbers", () => {
    const text = displayText({
      screenW: 393,
      screenH: 852,
      innerHeight: 793.4,
      outerHeight: 852,
      clientHeight: 793,
      vvHeight: 792.6,
      vvTop: 0,
      lvh: 852,
      sat: 59,
      sab: 34,
      standalone: true,
    });
    expect(text).toBe("screen 393×852 · viewport 793 (visual 793 at 0, large 852, outer 852, client 793) · insets 59/34 · home screen");
  });

  test("says when it runs in a browser tab", () => {
    const text = displayText({ screenW: 1, screenH: 2, innerHeight: 3, outerHeight: 4, clientHeight: 5, vvHeight: 6, vvTop: 7, lvh: 8, sat: 0, sab: 0, standalone: false });
    expect(text.endsWith("· browser")).toBe(true);
  });
});
