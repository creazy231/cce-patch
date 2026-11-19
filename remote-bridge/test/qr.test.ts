import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { qrSvgPath } from "../lib/qr.js";

type Qr = { size: number; path: string };

/** The dark modules as grid[y][x]. Fails when the path holds anything but the documented one-module squares. */
function modulesOf({ size, path: d }: Qr): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  let consumed = 0;
  for (const m of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    expect(x).toBeLessThan(size);
    expect(y).toBeLessThan(size);
    grid[y][x] = true;
    consumed += m[0].length;
  }
  expect(consumed).toBe(d.length);
  return grid;
}

const URL_TEXT = "https://example.com/#pair=abc";
const LEVEL_OF_BITS: Record<number, string> = { 1: "L", 0: "M", 3: "Q", 2: "H" };
const RANK: Record<string, number> = { L: 0, M: 1, Q: 2, H: 3 };

/** Decodes the 15 format bits (ISO/IEC 18004 section 7.9) from both places they are drawn. */
function readFormat(grid: boolean[][]) {
  const size = grid.length;
  const bit = (x: number, y: number) => (grid[y][x] ? 1 : 0);
  let first = 0;
  for (let i = 0; i <= 5; i++) first |= bit(8, i) << i;
  first |= bit(8, 7) << 6;
  first |= bit(8, 8) << 7;
  first |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) first |= bit(14 - i, 8) << i;
  let second = 0;
  for (let i = 0; i < 8; i++) second |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= bit(8, size - 15 + i) << i;
  const value = first ^ 0x5412;
  const data = value >> 10;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537); // BCH(15,5)
  return { first, second, bchValid: value === ((data << 10) | remainder), level: LEVEL_OF_BITS[data >> 3], mask: data & 7 };
}

describe("qrSvgPath", () => {
  test("encodes a pairing-sized URL as a path of one-module squares", () => {
    const qr = qrSvgPath(URL_TEXT);
    expect(Object.keys(qr).sort()).toEqual(["path", "size"]);
    expect(qr.size).toBeGreaterThanOrEqual(25);
    expect(qr.size).toBeLessThanOrEqual(57);
    expect((qr.size - 17) % 4).toBe(0); // 17 + 4 * version
    expect(qr.path.length).toBeGreaterThan(0);
    expect(qr.path).toMatch(/^[Mhvz0-9 -]+$/);
    const dark = modulesOf(qr).flat().filter(Boolean).length;
    expect(dark).toBeGreaterThan((qr.size * qr.size) / 4); // not blank, not solid
    expect(dark).toBeLessThan((qr.size * qr.size * 3) / 4);
  });

  test("is deterministic, and M is the default level", () => {
    expect(qrSvgPath(URL_TEXT)).toEqual(qrSvgPath(URL_TEXT));
    expect(qrSvgPath(URL_TEXT)).toEqual(qrSvgPath(URL_TEXT, "M"));
  });

  test("different texts give different symbols", () => {
    expect(qrSvgPath(URL_TEXT).path).not.toBe(qrSvgPath(`${URL_TEXT}x`).path);
  });

  test("a 300-character text fits in version 20 or less", () => {
    const text = `https://example.com/#pair=${"a".repeat(274)}`;
    expect(text.length).toBe(300);
    const qr = qrSvgPath(text);
    expect(qr.size).toBeLessThanOrEqual(17 + 4 * 20);
    expect(qr.path.length).toBeGreaterThan(0);
    modulesOf(qr);
  });

  test("has the QR code structure, which pins the module orientation (x right, y down)", () => {
    for (const text of [URL_TEXT, `https://example.com/#pair=${"b".repeat(274)}`, "A", "12345", "ÄÖÜ ✓ unicode"]) {
      const qr = qrSvgPath(text);
      const grid = modulesOf(qr);
      const { size } = qr;
      // Three 7x7 finder patterns (ring, gap, 3x3 core) with a light separator, none in the bottom-right corner.
      for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
        for (let dy = 0; dy < 7; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
            const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
            expect(grid[y0 + dy][x0 + dx]).toBe(ring || core);
          }
        }
      }
      for (let i = 0; i < 8; i++) {
        expect(grid[7][i]).toBe(false); // below the top-left finder
        expect(grid[i][7]).toBe(false); // right of it
        expect(grid[7][size - 1 - i]).toBe(false); // below the top-right finder
        expect(grid[i][size - 8]).toBe(false); // left of it
        expect(grid[size - 8][i]).toBe(false); // above the bottom-left finder
        expect(grid[size - 1 - i][7]).toBe(false); // right of it
      }
      // Timing patterns alternate along row 6 and column 6; the module at (8, size - 8) is always dark.
      for (let i = 8; i < size - 8; i++) {
        expect(grid[6][i]).toBe(i % 2 === 0);
        expect(grid[i][6]).toBe(i % 2 === 0);
      }
      expect(grid[size - 8][8]).toBe(true);
      // The format bits are a valid BCH codeword, drawn twice, at the places the standard puts them.
      const format = readFormat(grid);
      expect(format.bchValid).toBe(true);
      expect(format.second).toBe(format.first);
    }
  });

  test("the level is at least the one asked for, and a higher level makes a bigger symbol for a longer text", () => {
    const text = `https://example.com/#pair=${"c".repeat(124)}`;
    const sizes: number[] = [];
    for (const level of ["L", "M", "Q", "H"]) {
      const qr = qrSvgPath(text, level as "L");
      sizes.push(qr.size);
      expect(RANK[readFormat(modulesOf(qr)).level]).toBeGreaterThanOrEqual(RANK[level]);
    }
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes[0]).toBeLessThan(sizes[3]);
    expect(readFormat(modulesOf(qrSvgPath(text, "H"))).level).toBe("H");
    expect(readFormat(modulesOf(qrSvgPath(text, "L"))).level).toBe("L");
  });

  test("an empty text is still a (version 1) symbol", () => {
    expect(qrSvgPath("").size).toBe(21);
  });

  test("refuses what it cannot encode", () => {
    expect(() => qrSvgPath("x".repeat(3000))).toThrow(RangeError);
    for (const level of ["Z", "", "m", "LOW", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => qrSvgPath(URL_TEXT, level as "M")).toThrow(RangeError);
    }
    expect(() => qrSvgPath(undefined as unknown as string)).toThrow(TypeError);
    expect(() => qrSvgPath(42 as unknown as string)).toThrow(TypeError);
  });

  test("keeps the vendored generator's MIT license notice", () => {
    const vendored = fs.readFileSync(path.resolve(import.meta.dir, "../lib/vendor/qrcodegen.js"), "utf8");
    expect(vendored).toContain("Copyright (c) Project Nayuki. (MIT License)");
    expect(vendored).toContain("Permission is hereby granted, free of charge");
    expect(vendored).toContain("The above copyright notice and this permission notice shall be included in");
  });
});
