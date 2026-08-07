#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const args = process.argv.slice(2);

if (args[0] === "litellm") {
	const { runKhalaLitellm } = await jiti.import("../src/khala-litellm.ts");
	await runKhalaLitellm(args.slice(1));
} else {
	const { runKhalaSetup } = await jiti.import("../src/khala-setup.ts");
	await runKhalaSetup(args);
}
