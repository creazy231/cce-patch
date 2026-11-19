import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

// The config runs in Node; its file helpers are loaded by name so that type-checking needs no Node types.
interface Fs {
  readFile(path: string | URL, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
}
const FS_MODULE = "node:fs/promises";
const loadFs = (): Promise<Fs> => import(/* @vite-ignore */ FS_MODULE);

/** A short, stable id for a list of file names (they carry content hashes already). */
function buildId(files: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of files.join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Fills public/sw.js's placeholders in the build output: the build id (the cache name, so every deploy
 * gets a fresh cache and drops the old one) and the hashed files to precache for offline use.
 */
function serviceWorker(): Plugin {
  let assets: string[] = [];
  return {
    name: "cce-remote-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      assets = Object.keys(bundle)
        .filter((file) => file.startsWith("assets/"))
        .sort()
        .map((file) => `/${file}`);
    },
    async writeBundle(options) {
      const fs = await loadFs();
      const path = `${options.dir ?? "dist"}/sw.js`;
      const source = await fs.readFile(path, "utf8");
      const filled = source.replace('"__CCE_BUILD__"', JSON.stringify(buildId(assets))).replace('["__CCE_ASSETS__"]', JSON.stringify(assets));
      if (filled.includes("__CCE_BUILD__") || filled.includes("__CCE_ASSETS__")) this.error("sw.js: build placeholders not found");
      await fs.writeFile(path, filled);
    },
  };
}

export default defineConfig(async () => {
  const fs = await loadFs();
  const { version } = JSON.parse(await fs.readFile(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  return {
    plugins: [preact(), serviceWorker()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
  };
});
