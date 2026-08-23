#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runKhalaSetup } = await jiti.import("../src/config.ts");
await runKhalaSetup(process.argv.slice(2));
