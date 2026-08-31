import { fileURLToPath } from "node:url";
import { openKhalaArchive, showKhalaArchive, type KhalaArchiveView } from "../../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEMO_ARCHIVE = fileURLToPath(new URL("../../data/fixtures/khala-demo.sqlite", import.meta.url));
let active = false;

export default function khalaDemoExtension(pi: ExtensionAPI): void {
	pi.registerCommand("khala-demo", {
		description: "Open the read-only Khala demo archive.",
		handler: async (_args, context: ExtensionContext) => {
			if (active) {
				context.ui.notify("The Khala demo is already open. Close it before opening it again.", "warning");
				return;
			}
			active = true;
			await runDemo(context);
		},
	});
}

async function runDemo(context: ExtensionContext): Promise<void> {
	let archive: KhalaArchiveView | undefined;
	try {
		archive = openKhalaArchive(DEMO_ARCHIVE);
		await showKhalaArchive(archive, context);
	} catch (error) {
		context.ui.notify(
			`Could not open the Khala demo: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	} finally {
		archive?.close();
		active = false;
	}
}
