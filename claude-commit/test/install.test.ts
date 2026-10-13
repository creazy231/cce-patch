import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EXTENSION_ID,
  addProposedApi,
  buildVsix,
  crc32,
  hasClaudeCodicon,
  isUpToDate,
  parseJsonc,
  removeProposedApi,
  selectEditors,
  withIcon,
  zip,
} from "../install.ts";

// VS Code Insiders' default argv.json, as found in ~/.vscode-insiders/argv.json.
const DEFAULT_ARGV = `// This configuration file allows you to pass permanent command line arguments to VS Code.
// Only a subset of arguments is currently supported to reduce the likelihood of breaking
// the installation.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
//
// NOTE: Changing this file requires a restart of VS Code.
{
	// Use software rendering instead of hardware accelerated rendering.
	// This can help in cases where you see rendering issues in VS Code.
	// "disable-hardware-acceleration": true,

	// Allows to disable crash reporting.
	// Should restart the app if the value is changed.
	"enable-crash-reporter": true,

	// Unique id used for correlating crash reports sent from this instance.
	// Do not edit this value.
	"crash-reporter-id": "2f804824-7ae6-4b15-899e-c1caffe34172"
}`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-commit-install-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const unzip = (...args: string[]) => spawnSync("unzip", args, { encoding: "utf8" });

describe("zip / VSIX", () => {
  test("crc32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
  });
  test("unzip reads the archive back", () => {
    const file = join(dir, "t.zip");
    writeFileSync(file, zip([["a.txt", Buffer.from("hello")], ["dir/b.txt", Buffer.from("wörld")]]));
    expect(unzip("-t", file).status).toBe(0);
    expect(unzip("-p", file, "dir/b.txt").stdout).toBe("wörld");
  });
  test("buildVsix lays out a VSIX", () => {
    const file = join(dir, "t.vsix");
    const manifest = { name: "n", publisher: "p", version: "1.0.0", displayName: "N & co", description: "<d>", engines: { vscode: "^1.90.0" }, enabledApiProposals: ["x"] };
    writeFileSync(file, buildVsix(manifest, { "extension.js": Buffer.from("x"), "lib/a.js": Buffer.from("a") }));
    expect(unzip("-Z1", file).stdout.trim().split("\n")).toEqual([
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/package.json",
      "extension/extension.js",
      "extension/lib/a.js",
    ]);
    const vsixManifest = unzip("-p", file, "extension.vsixmanifest").stdout;
    expect(vsixManifest).toContain('<Identity Language="en-US" Id="n" Version="1.0.0" Publisher="p"/>');
    expect(vsixManifest).toContain("<DisplayName>N &amp; co</DisplayName>");
    expect(vsixManifest).toContain('Value="x"');
    expect(JSON.parse(unzip("-p", file, "extension/package.json").stdout)).toEqual(manifest);
  });
});

describe("argv.json", () => {
  const id = EXTENSION_ID;
  test("adds the id, keeps the comments, and is idempotent", () => {
    const next = addProposedApi(DEFAULT_ARGV, id);
    expect(parseJsonc(next)["enable-proposed-api"]).toEqual([id]);
    expect(parseJsonc(next)["crash-reporter-id"]).toBe("2f804824-7ae6-4b15-899e-c1caffe34172");
    expect(next).toContain("// NOTE: Changing this file requires a restart of VS Code.");
    expect(addProposedApi(next, id)).toBe(next);
  });
  test("removing restores the original byte for byte", () => {
    expect(removeProposedApi(addProposedApi(DEFAULT_ARGV, id), id)).toBe(DEFAULT_ARGV);
  });
  test("joins an existing list, and removal keeps the other ids", () => {
    const text = `{\n\t"enable-proposed-api": ["other.ext"]\n}`;
    const next = addProposedApi(text, id);
    expect(parseJsonc(next)["enable-proposed-api"]).toEqual([id, "other.ext"]);
    expect(parseJsonc(removeProposedApi(next, id))["enable-proposed-api"]).toEqual(["other.ext"]);
  });
  test("ignores a commented-out key", () => {
    const text = `{\n\t// "enable-proposed-api": ["x"],\n\t"a": 1\n}`;
    const next = addProposedApi(text, id);
    expect(next).toContain(`// "enable-proposed-api": ["x"],`);
    expect(parseJsonc(next)).toEqual({ "enable-proposed-api": [id], a: 1 });
  });
  test("an empty object", () => {
    expect(parseJsonc(addProposedApi("{}", id))).toEqual({ "enable-proposed-api": [id] });
  });
  test("refuses a value that is not a list", () => {
    expect(() => addProposedApi(`{"enable-proposed-api": "x"}`, id)).toThrow();
  });
  test("removing an id that is not there changes nothing", () => {
    expect(removeProposedApi(DEFAULT_ARGV, id)).toBe(DEFAULT_ARGV);
  });
});

test("withIcon swaps only the generate command's icon and leaves the input alone", () => {
  const manifest = {
    contributes: {
      commands: [
        { command: "claudeCommit.generateCommitMessage", icon: "$(claude)" },
        { command: "claudeCommit.cancel", icon: "$(debug-stop)" },
      ],
    },
  };
  const swapped = withIcon(manifest, "$(sparkle)");
  expect(swapped.contributes.commands.map((c: { icon: string }) => c.icon)).toEqual(["$(sparkle)", "$(debug-stop)"]);
  expect(manifest.contributes.commands[0].icon).toBe("$(claude)");
});

describe("isUpToDate", () => {
  const manifest = { name: "n", publisher: "p", version: "1.0.0", contributes: { commands: [{ command: "claudeCommit.generateCommitMessage", icon: "$(claude)" }] } };
  const files = { "extension.js": Buffer.from("x"), "lib/a.js": Buffer.from("a") };
  /**
   * An editor's extensions folder as VS Code leaves it: p.n-1.0.0/ with the files and the manifest
   * plus VS Code's __metadata, and (unless uninstalled) an entry in extensions.json.
   */
  const extensionsDir = (name: string, { m = manifest, f = files, listed = true }: { m?: any; f?: Record<string, Buffer>; listed?: boolean } = {}) => {
    const root = join(dir, name);
    const target = join(root, "p.n-1.0.0");
    mkdirSync(join(target, "lib"), { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify({ ...m, __metadata: { installedTimestamp: 1, size: 9 } }));
    for (const [file, data] of Object.entries(f)) writeFileSync(join(target, file), data);
    const entry = { identifier: { id: "p.n" }, version: "1.0.0", relativeLocation: "p.n-1.0.0", location: { path: target } };
    writeFileSync(join(root, "extensions.json"), JSON.stringify(listed ? [entry] : []));
    return root;
  };
  test("an identical install is up to date (VS Code's __metadata aside)", () => {
    expect(isUpToDate(extensionsDir("same"), manifest, files)).toBe(true);
  });
  test("a changed file, a changed manifest or no install at all is not", () => {
    expect(isUpToDate(extensionsDir("file", { f: { ...files, "lib/a.js": Buffer.from("b") } }), manifest, files)).toBe(false);
    expect(isUpToDate(extensionsDir("icon"), withIcon(manifest, "$(sparkle)"), files)).toBe(false);
    expect(isUpToDate(join(dir, "missing"), manifest, files)).toBe(false);
  });
  test("an uninstalled copy that VS Code left on disk is not (extensions.json no longer lists it)", () => {
    expect(isUpToDate(extensionsDir("uninstalled", { listed: false }), manifest, files)).toBe(false);
  });
});

describe("selectEditors", () => {
  test("named editors, by key or by patch.ts label", () => {
    expect(selectEditors(["insiders", "Cursor"], dir).map((e) => e.key)).toEqual(["insiders", "cursor"]);
  });
  test("without names, every editor that has the Claude Code extension", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".vscode", "extensions", "anthropic.claude-code-2.1.0"), { recursive: true });
    mkdirSync(join(home, ".cursor", "extensions", "someone.else-1.0.0"), { recursive: true });
    expect(selectEditors(undefined, home).map((e) => e.key)).toEqual(["code"]);
    expect(selectEditors([], home).map((e) => e.key)).toEqual(["code"]);
  });
});

test("hasClaudeCodicon recognizes the codicon registry entry", () => {
  expect(hasClaudeCodicon('openai:fe("openai",60545),claude:fe("claude",60546),')).toBe(true);
  expect(hasClaudeCodicon('openai:fe("openai",60545),')).toBe(false);
});
