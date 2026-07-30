#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const packageRootPath = fileURLToPath(packageRoot);
const compiledPath = fileURLToPath(new URL("dist/src/khala-setup.js", packageRoot));
const sourcePath = fileURLToPath(new URL("src/khala-setup.ts", packageRoot));
const loaderPath = fileURLToPath(new URL("ts-loader.js", import.meta.url));
const userArgs = process.argv.slice(2);
const isInstalledPackage = packageRootPath.split(sep).includes("node_modules");
const isSourceCheckout = !isInstalledPackage && existsSync(new URL(".git", packageRoot)) && existsSync(sourcePath);
let args;

if (isSourceCheckout) {
  // Prefer the checkout source so `node bin/khala.js` cannot silently run stale dist output.
  args = ["--experimental-strip-types", "--loader", loaderPath, sourcePath, ...userArgs];
} else if (existsSync(compiledPath)) {
  args = [compiledPath, ...userArgs];
} else {
  console.error(
    "khala: compiled setup entry is missing; reinstall @pesap/khala or run `npm run build` in a source checkout.",
  );
  process.exitCode = 1;
}

if (args !== undefined) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`khala: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
