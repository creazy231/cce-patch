// @ts-check
'use strict';
// The pairing QR code. The text is encoded by the vendored Project Nayuki generator (MIT, see
// vendor/qrcodegen.js) and handed to the Connection tab as one SVG path, so the bridge needs no
// image code and the webview only has to draw it.

/**
 * The part of the vendored generator that is used here (it comes without type declarations).
 * @typedef {{ size: number, getModule(x: number, y: number): boolean }} QrSymbol
 * @typedef {{ QrCode: { encodeText(text: string, ecl: unknown): QrSymbol, Ecc: Record<'LOW' | 'MEDIUM' | 'QUARTILE' | 'HIGH', unknown> } }} QrCodeGenerator
 */
const { QrCode } = /** @type {QrCodeGenerator} */ (/** @type {unknown} */ (require('./vendor/qrcodegen.js')));

/** @typedef {'L' | 'M' | 'Q' | 'H'} EccLevel  error correction: about 7, 15, 25 and 30 percent of the symbol can be damaged */

/** @type {Record<EccLevel, unknown>} */
const LEVELS = {
  L: QrCode.Ecc.LOW,
  M: QrCode.Ecc.MEDIUM,
  Q: QrCode.Ecc.QUARTILE,
  H: QrCode.Ecc.HIGH,
};

/**
 * Encodes a text as a QR code and returns it as an SVG path: one unit square (`M x y h1 v1 h-1 z`)
 * per dark module, in a `size` x `size` grid with x to the right and y down. There is no quiet zone;
 * the caller adds the margin (a viewBox of `-4 -4 size+8 size+8`). The smallest version that holds
 * the text is used, and `ecc` is the lowest error correction level wanted: a symbol that has room
 * left in its version is given a higher one. The same text always gives the same symbol.
 * Throws a RangeError for a text too long for a QR code (about 2300 bytes at level M) or an
 * unknown level, and a TypeError for a text that is not a string.
 * @param {string} text
 * @param {EccLevel} [ecc]
 * @returns {{ size: number, path: string }}
 */
function qrSvgPath(text, ecc = 'M') {
  if (typeof text !== 'string') throw new TypeError('the QR code text must be a string');
  if (!Object.prototype.hasOwnProperty.call(LEVELS, ecc)) throw new RangeError(`unknown error correction level: ${String(ecc)}`);
  const qr = QrCode.encodeText(text, LEVELS[ecc]);
  /** @type {string[]} */
  const squares = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) squares.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return { size: qr.size, path: squares.join('') };
}

module.exports = { qrSvgPath };
