#!/usr/bin/env bun
/**
 * Installs the Claude Commit Message extension (this folder) into your editors.
 *
 * Usage: bun run claude-commit/install.ts [insiders|code|cursor|codium ...] [--uninstall]
 *   Without editor names it targets every editor that has the Claude Code extension.
 *
 * For each editor it packs a VSIX, installs it with the editor's command-line tool, and adds the
 * extension to "enable-proposed-api" in the editor's argv.json. That flag lets the button sit in
 * the commit message box; it applies after the editor's next full restart. Until then the
 * button is in the title bar of the "Changes" view.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { isDeepStrictEqual } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const EXTENSION_ID = "cce-patch.claude-commit-message";
const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ["extension.js", "lib/context.js", "lib/prompt.js", "lib/claude.js", "README.md"];
const ARGV_COMMENT = "Lets the Claude Commit Message button (cce-patch) sit in the Source Control commit message box.";

type Editor = { key: string; label: string; dataDir: string; app: string; cli: string; pathCli: string };

const EDITORS: Editor[] = [
  { key: "insiders", label: "VS Code Insiders", dataDir: ".vscode-insiders", app: "Visual Studio Code - Insiders.app", cli: "code", pathCli: "code-insiders" },
  { key: "code", label: "VS Code", dataDir: ".vscode", app: "Visual Studio Code.app", cli: "code", pathCli: "code" },
  { key: "cursor", label: "Cursor", dataDir: ".cursor", app: "Cursor.app", cli: "cursor", pathCli: "cursor" },
  { key: "codium", label: "VSCodium", dataDir: ".vscode-oss", app: "VSCodium.app", cli: "codium", pathCli: "codium" },
];

// ── zip with stored (uncompressed) entries: all a VSIX needs ──

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: [string, Uint8Array][]): Buffer {
  const DOS_DATE_1980_01_01 = 0x21;
  const UTF8_NAMES = 0x0800;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, Buffer.from(data));

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// ── VSIX ──

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildVsix(manifest: any, files: Record<string, Uint8Array>): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>' +
    '<Default Extension=".md" ContentType="text/markdown"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n';
  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/>
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${xml((manifest.extensionDependencies ?? []).join(","))}"/>
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="${xml((manifest.enabledApiProposals ?? []).join(","))}"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`;
  return zip([
    ["[Content_Types].xml", Buffer.from(contentTypes)],
    ["extension.vsixmanifest", Buffer.from(vsixManifest)],
    ["extension/package.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
    ...Object.entries(files).map(([file, data]): [string, Uint8Array] => [`extension/${file}`, data]),
  ]);
}

/** The manifest with the generate command's icon replaced (for editors without $(claude)). */
export function withIcon(manifest: any, icon: string): any {
  const copy = structuredClone(manifest);
  for (const command of copy.contributes.commands) {
    if (command.command === "claudeCommit.generateCommitMessage") command.icon = icon;
  }
  return copy;
}

/** Whether a workbench bundle registers the $(claude) codicon (VS Code ≥ 1.134 does). */
export function hasClaudeCodicon(workbenchJs: string): boolean {
  return /\bclaude:[\w$]+\("claude",\d+\)/.test(workbenchJs);
}

/**
 * Whether an editor's extensions folder already has exactly this manifest (ignoring VS Code's
 * __metadata) and these files, still listed in extensions.json: an uninstall leaves the folder.
 */
export function isUpToDate(extensionsDir: string, manifest: any, files: Record<string, Uint8Array>): boolean {
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const folder = `${id}-${manifest.version}`;
  const dir = join(extensionsDir, folder);
  try {
    const registry = JSON.parse(readFileSync(join(extensionsDir, "extensions.json"), "utf8"));
    const listed =
      Array.isArray(registry) &&
      registry.some(
        (e: any) =>
          String(e?.identifier?.id).toLowerCase() === id &&
          e.version === manifest.version &&
          (e.relativeLocation === folder || String(e.location?.path ?? e.location?.fsPath ?? "").endsWith(folder)),
      );
    if (!listed) return false;
    const { __metadata, ...installed } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!isDeepStrictEqual(installed, manifest)) return false;
    return Object.entries(files).every(([file, data]) => Buffer.from(data).equals(readFileSync(join(dir, file))));
  } catch {
    return false;
  }
}

// ── argv.json (JSON with comments) ──

/** [start, end) of every comment, skipping strings. */
function commentRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (text.startsWith("//", i)) {
      const start = i;
      while (i < text.length && text[i] !== "\n") i++;
      ranges.push([start, i]);
    } else if (text.startsWith("/*", i)) {
      const start = i;
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
      ranges.push([start, i + 1]);
    }
  }
  return ranges;
}

export function parseJsonc(text: string): any {
  let stripped = "";
  let last = 0;
  for (const [start, end] of commentRanges(text)) {
    stripped += text.slice(last, start);
    last = end;
  }
  stripped += text.slice(last);
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

/** The first match of `pattern` that is not inside a comment. */
function findOutsideComments(text: string, pattern: RegExp): RegExpExecArray | null {
  const comments = commentRanges(text);
  const re = new RegExp(pattern.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index;
    if (!comments.some(([start, end]) => at >= start && at < end)) return m;
  }
  return null;
}

/** argv.json with `id` added to "enable-proposed-api", comments and formatting kept. */
export function addProposedApi(text: string, id: string): string {
  const parsed = parseJsonc(text);
  const current = parsed["enable-proposed-api"];
  if (current !== undefined && !Array.isArray(current)) throw new Error('"enable-proposed-api" in argv.json is not a list');
  if (current?.includes(id)) return text;

  let result: string;
  const list = findOutsideComments(text, /"enable-proposed-api"\s*:\s*\[/);
  if (list) {
    const at = list.index + list[0].length;
    result = text.slice(0, at) + JSON.stringify(id) + (current.length > 0 ? ", " : "") + text.slice(at);
  } else {
    const open = findOutsideComments(text, /\{/);
    if (!open) throw new Error("argv.json has no top-level object");
    const at = open.index + 1;
    const tail = Object.keys(parsed).length > 0 ? "," : "\n";
    result = `${text.slice(0, at)}\n\t// ${ARGV_COMMENT}\n\t"enable-proposed-api": [${JSON.stringify(id)}]${tail}${text.slice(at)}`;
  }
  if (!parseJsonc(result)["enable-proposed-api"]?.includes(id)) throw new Error("could not update argv.json");
  return result;
}

/** argv.json without `id` in "enable-proposed-api"; undoes addProposedApi exactly when it can. */
export function removeProposedApi(text: string, id: string): string {
  const current = parseJsonc(text)["enable-proposed-api"];
  if (!Array.isArray(current) || !current.includes(id)) return text;
  const rest = current.filter((x: unknown) => x !== id);

  let result: string | undefined;
  const inserted = `\n\t// ${ARGV_COMMENT}\n\t"enable-proposed-api": [${JSON.stringify(id)}]`;
  for (const tail of [",", "\n"]) {
    if (rest.length === 0 && text.includes(inserted + tail)) result = text.replace(inserted + tail, "");
  }
  if (result === undefined) {
    const list = findOutsideComments(text, /"enable-proposed-api"\s*:\s*\[[^\]]*\]/);
    if (!list) throw new Error('could not find "enable-proposed-api" in argv.json');
    result = text.slice(0, list.index) + `"enable-proposed-api": ${JSON.stringify(rest)}` + text.slice(list.index + list[0].length);
  }
  if (parseJsonc(result)["enable-proposed-api"]?.includes(id)) throw new Error("could not update argv.json");
  return result;
}

// ── Editors ──

function findApp(editor: Editor): string | undefined {
  return [join("/Applications", editor.app), join(homedir(), "Applications", editor.app)].find((p) => existsSync(p));
}

function findCli(editor: Editor, app: string | undefined): string | undefined {
  if (app) {
    const bundled = join(app, "Contents", "Resources", "app", "bin", editor.cli);
    if (existsSync(bundled)) return bundled;
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [editor.pathCli], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

function hasClaudeCode(editor: Editor, home: string): boolean {
  const dir = join(home, editor.dataDir, "extensions");
  return existsSync(dir) && readdirSync(dir).some((name) => name.startsWith("anthropic.claude-code-"));
}

/** The named editors (keys like "insiders" or patch.ts labels like "VS Code Insiders"), else every editor with Claude Code. */
export function selectEditors(only: string[] | undefined, home: string): Editor[] {
  return only?.length
    ? EDITORS.filter((e) => only.includes(e.key) || only.includes(e.label))
    : EDITORS.filter((e) => hasClaudeCode(e, home));
}

function run(cli: string, args: string[], okIfOutput?: RegExp): void {
  const result = spawnSync(cli, args, { encoding: "utf8", shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 && !(okIfOutput && okIfOutput.test(output))) {
    throw new Error(`${cli} ${args.join(" ")} failed:\n${output || result.error?.message || `exit code ${result.status}`}`);
  }
}

function editArgv(editor: Editor, edit: (text: string) => string): void {
  const file = join(homedir(), editor.dataDir, "argv.json");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{\n}\n";
  const next = edit(text);
  if (next !== text) writeFileSync(file, next);
}

function installInto(editor: Editor, manifest: any, files: Record<string, Uint8Array>): string {
  const app = findApp(editor);
  const cli = findCli(editor, app);
  if (!cli) throw new Error(`command-line tool "${editor.pathCli}" not found`);
  const workbench = app && join(app, "Contents", "Resources", "app", "out", "vs", "workbench", "workbench.desktop.main.js");
  const noClaudeIcon = !!workbench && existsSync(workbench) && !hasClaudeCodicon(readFileSync(workbench, "utf8"));
  const variant = noClaudeIcon ? withIcon(manifest, "$(sparkle)") : manifest;
  if (isUpToDate(join(homedir(), editor.dataDir, "extensions"), variant, files)) {
    editArgv(editor, (text) => addProposedApi(text, EXTENSION_ID));
    return `✓ ${editor.label}: ${EXTENSION_ID} ${manifest.version} is up to date`;
  }
  const vsix = join(mkdtempSync(join(tmpdir(), "claude-commit-")), `${EXTENSION_ID}-${manifest.version}.vsix`);
  writeFileSync(vsix, buildVsix(variant, files));
  run(cli, ["--install-extension", vsix, "--force"]);
  editArgv(editor, (text) => addProposedApi(text, EXTENSION_ID));
  return (
    `✓ ${editor.label}: installed ${EXTENSION_ID} ${manifest.version}` +
    (noClaudeIcon ? " (this editor has no $(claude) icon, so it uses $(sparkle))" : "") +
    `\n  The button is in the "Changes" title bar now and moves into the commit message box after a full restart of ${editor.label}.`
  );
}

function uninstallFrom(editor: Editor): string {
  const cli = findCli(editor, findApp(editor));
  if (!cli) throw new Error(`command-line tool "${editor.pathCli}" not found`);
  run(cli, ["--uninstall-extension", EXTENSION_ID], /not installed/i);
  editArgv(editor, (text) => removeProposedApi(text, EXTENSION_ID));
  return `✓ ${editor.label}: uninstalled ${EXTENSION_ID}`;
}

/**
 * Install (or uninstall) the button in the named editors (keys or patch.ts labels), or in every
 * editor that has the Claude Code extension. Prints one line per editor; false if any failed.
 */
export function installCommitButton({ only, uninstall = false }: { only?: string[]; uninstall?: boolean } = {}): boolean {
  const targets = selectEditors(only, homedir());
  if (targets.length === 0) {
    console.error(`No editor with the Claude Code extension found. Name one: ${EDITORS.map((e) => e.key).join(", ")}`);
    return false;
  }
  const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  const files = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(HERE, file))]));
  let ok = true;
  for (const editor of targets) {
    try {
      console.log(uninstall ? uninstallFrom(editor) : installInto(editor, manifest, files));
    } catch (err) {
      ok = false;
      console.error(`✗ ${editor.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return ok;
}

function main(): void {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith("--"));
  const unknown = names.filter((n) => !EDITORS.some((e) => e.key === n));
  if (unknown.length > 0) {
    console.error(`Unknown editor: ${unknown.join(", ")}. Choose from: ${EDITORS.map((e) => e.key).join(", ")}`);
    process.exit(1);
  }
  process.exit(installCommitButton({ only: names, uninstall: args.includes("--uninstall") }) ? 0 : 1);
}

if (import.meta.main ?? process.argv[1]?.endsWith("install.ts")) main();
