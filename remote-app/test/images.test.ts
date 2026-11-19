import { describe, expect, test } from "bun:test";
import { fitWithin, MAX_SIDE } from "../src/lib/images";

describe("fitWithin", () => {
  test("scales a 4032x3024 photo down to a 1568 px long side", () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: 1568, h: 1176 });
  });

  test("works for portrait photos too", () => {
    expect(fitWithin(3024, 4032)).toEqual({ w: 1176, h: 1568 });
    expect(fitWithin(2000, 2000)).toEqual({ w: 1568, h: 1568 });
  });

  test("leaves small images and images exactly at the limit unchanged", () => {
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(1568, 1000)).toEqual({ w: 1568, h: 1000 });
    expect(fitWithin(1, 1)).toEqual({ w: 1, h: 1 });
  });

  test("the limit is a parameter, default 1568", () => {
    expect(MAX_SIDE).toBe(1568);
    expect(fitWithin(1000, 500, 100)).toEqual({ w: 100, h: 50 });
  });

  test("rounds to whole pixels", () => {
    expect(fitWithin(1601, 1201)).toEqual({ w: 1568, h: 1176 });
    expect(fitWithin(1201, 1601)).toEqual({ w: 1176, h: 1568 });
  });

  test("never shrinks a side below one pixel", () => {
    expect(fitWithin(20000, 10)).toEqual({ w: 1568, h: 1 });
  });

  test("returns degenerate sizes untouched instead of dividing by zero", () => {
    expect(fitWithin(0, 0)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(Number.NaN, 5)).toEqual({ w: Number.NaN, h: 5 });
  });
});
