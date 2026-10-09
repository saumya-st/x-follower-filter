import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

if (existsSync(outdir)) rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Static assets: manifest, icons, HTML, CSS.
cpSync("public", outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
};

const builds = [
  // Content script must be a classic script (no ESM imports at runtime), so IIFE.
  { ...common, format: "iife", entryPoints: { "content/index": "src/content/index.ts" }, outdir },
  { ...common, entryPoints: { "background/service-worker": "src/background/service-worker.ts" }, outdir },
  {
    ...common,
    entryPoints: {
      "ui/panel/panel": "src/ui/panel/panel.ts",
      "ui/options/options": "src/ui/options/options.ts",
    },
    outdir,
  },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("watching...");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log("built to", outdir);
}
