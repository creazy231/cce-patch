import { describe, expect, test } from "bun:test";
import { standaloneGap } from "../src/lib/viewport";

const base = { standalone: true, sat: 59, lvh: 852, innerHeight: 793, keyboardOpen: false, last: 0 };

describe("standaloneGap", () => {
  test("returns the top inset when the viewport is short by exactly it", () => {
    expect(standaloneGap({ ...base })).toBe(59);
  });
  test("returns 0 when the viewport is already the full screen", () => {
    expect(standaloneGap({ ...base, innerHeight: 852 })).toBe(0);
  });
  test("returns 0 in a Safari tab", () => {
    expect(standaloneGap({ ...base, standalone: false, lvh: 932, innerHeight: 852 })).toBe(0);
  });
  test("returns 0 when no content sits under the status bar", () => {
    expect(standaloneGap({ ...base, sat: 0 })).toBe(0);
  });
  test("returns 0 when the shortfall is not the top inset", () => {
    expect(standaloneGap({ ...base, lvh: 823 })).toBe(0);
  });
  test("keeps the gap measured while the keyboard was closed", () => {
    expect(standaloneGap({ ...base, innerHeight: 500, keyboardOpen: true, last: 59 })).toBe(59);
  });
  test("returns 0 for non-finite measurements", () => {
    expect(standaloneGap({ ...base, sat: NaN })).toBe(0);
    expect(standaloneGap({ ...base, lvh: Infinity })).toBe(0);
    expect(standaloneGap({ ...base, innerHeight: NaN })).toBe(0);
    expect(standaloneGap({ ...base, keyboardOpen: true, last: NaN })).toBe(0);
  });
});
