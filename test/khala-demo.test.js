import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const fixture = join(root, "data", "fixtures", "khala-demo.sqlite");
const builtFixture = join(root, "dist", "data", "fixtures", "khala-demo.sqlite");

test("/khala-demo displays the packaged archive and starts fresh on each invocation", async () => {
	await mkdir(join(root, "dist", "data", "fixtures"), { recursive: true });
	await copyFile(fixture, builtFixture);
	const previousDirectory = process.cwd();
	process.chdir("/tmp");
	try {
		const { default: khalaDemoExtension } = await import("../dist/extensions/khala-demo/demo.js");
		const commands = new Map();
		const notices = [];
		const pi = {
			registerCommand(name, command) {
				commands.set(name, command);
			},
		};
		khalaDemoExtension(pi);
		const context = {
			hasUI: false,
			mode: "print",
			ui: { notify: (message) => notices.push(message) },
		};
		const command = commands.get("khala-demo");
		assert.ok(command);
		await command.handler(undefined, context);
		await command.handler(undefined, context);
		assert.equal(notices.length, 2);
		assert.equal(notices[0], notices[1]);
		assert.match(notices[0], /succeeded\s+Respond to provider feedback/);
		assert.match(notices[0], /blocked/);
		assert.match(notices[0], /failed/);

		const pending = {};
		const interactiveContext = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify: (message) => notices.push(message),
				theme: { fg: (_color, text) => text, bold: (text) => text },
				custom: (factory) =>
					new Promise((resolve) => {
						pending.done = resolve;
						factory({ requestRender() {} }, interactiveContext.ui.theme, {}, resolve);
					}),
			},
		};
		const first = command.handler(undefined, interactiveContext);
		await command.handler(undefined, interactiveContext);
		assert.match(notices.at(-1), /already open/);
		pending.done(null);
		await first;
		assert.deepEqual(await readdir(join(root, "dist", "data", "fixtures")), ["khala-demo.sqlite"]);
	} finally {
		process.chdir(previousDirectory);
		await rm(join(root, "dist", "data"), { recursive: true, force: true });
	}
});
