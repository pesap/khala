import { cp } from "node:fs/promises";

const root = new URL("../", import.meta.url);
// TypeScript emits code only; compiled entry points resolve these resources beside it.
for (const path of ["package.json", "system-prompts", "data/fixtures"]) {
	await cp(new URL(path, root), new URL(`dist/${path}`, root), { recursive: true });
}
