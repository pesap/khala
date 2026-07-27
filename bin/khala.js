#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const compiledPath = fileURLToPath(new URL("dist/src/khala-setup.js", packageRoot));
const sourcePath = fileURLToPath(new URL("src/khala-setup.ts", packageRoot));
const loaderPath = fileURLToPath(new URL("ts-loader.js", import.meta.url));
const userArgs = process.argv.slice(2);
const args = existsSync(compiledPath)
  ? [compiledPath, ...userArgs]
  : ["--experimental-strip-types", "--loader", loaderPath, sourcePath, ...userArgs];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) {
  console.error(`khala: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
