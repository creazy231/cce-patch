import { PROTOCOL_VERSION } from "./protocol";

/** The port the bridge serves on, on the Mac's Tailscale address. */
export const DEFAULT_PORT = 47821;

/** The bridge's pairing code: 8 characters from this alphabet, shown as XXXX-XXXX. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export interface PairingInput {
  /** Normalised address of the Mac, e.g. https://example-mac.tailnet-0000.ts.net:47821 */
  url: string;
  /** The code without separators, upper case. */
  code: string;
  /** The Mac's name from the link, or the first label of its host name. */
  name: string;
}

/**
 * Turns what a person typed or pasted into an address the app may connect to.
 * Adds https:// and the default port; refuses http:// except for localhost and 127.0.0.1
 * (development), other schemes and credentials. Path, query and fragment are dropped.
 */
export function normalizeMacUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:") {
    if (!local) return null;
  } else if (url.protocol !== "https:") {
    return null;
  }

  // URL parsing drops a port that equals the scheme's default (":443"), so read it from the text too.
  const authority = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  const explicit = url.port || /:(\d+)$/.exec(authority)?.[1];
  const port = explicit ? Number(explicit) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return `${url.protocol}//${url.hostname}:${port}`;
}

/** Upper case, everything outside the code alphabet dropped (as the bridge does); null unless 8 characters remain. */
function normalizeCode(input: string): string | null {
  let code = "";
  for (const ch of input.toUpperCase()) if (CODE_ALPHABET.includes(ch)) code += ch;
  return code.length === CODE_LENGTH ? code : null;
}

function hostLabel(url: string): string {
  const host = new URL(url).hostname;
  return /^[\d.]+$/.test(host) || host.startsWith("[") ? host : (host.split(".")[0] || host);
}

function decodeBase64Url(input: string): string | null {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(input)) return null;
  const b64 = input.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    // The Mac's name may be non-ASCII: the payload is UTF-8, not Latin-1.
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function fromPayload(encoded: string): PairingInput | null {
  const json = decodeBase64Url(encoded);
  if (json === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { v, u, c, n } = data as Record<string, unknown>;
  if (v !== PROTOCOL_VERSION || typeof u !== "string" || typeof c !== "string") return null;
  const url = normalizeMacUrl(u);
  const code = normalizeCode(c);
  if (!url || !code) return null;
  const name = typeof n === "string" && n.trim() ? n.trim().slice(0, 80) : hostLabel(url);
  return { url, code, name };
}

/**
 * Reads a pairing from whatever was scanned or pasted:
 * a full link (`<app>/#pair=<payload>`), a bare `#pair=<payload>` fragment, the raw base64url payload,
 * or an address and a code typed by hand (`https://host:47821 ABCD-EFGH`).
 * Returns null when it is none of these, or when the address or code could not be right.
 */
export function parsePairingInput(text: string): PairingInput | null {
  const input = text.trim();
  if (!input) return null;

  const fragment = /(?:^|[#?&])pair=([^&\s#]*)/.exec(input);
  if (fragment) return fromPayload(fragment[1] ?? "");

  const manual = /^(\S+)\s+([\s\S]+)$/.exec(input);
  if (manual) {
    const url = normalizeMacUrl(manual[1] ?? "");
    const code = normalizeCode(manual[2] ?? "");
    return url && code ? { url, code, name: hostLabel(url) } : null;
  }

  return fromPayload(input);
}

/** A name for this device, shown in the Mac's list of paired devices. */
export function defaultDeviceName(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): string {
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android phone";
  // An iPad in "desktop" mode reports a Mac, but only an iPad has a touch screen.
  if (/Macintosh|Mac OS X/.test(userAgent)) return touchPoints > 1 ? "iPad" : "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  if (/Linux|X11/.test(userAgent)) return "Linux PC";
  return "Phone";
}
