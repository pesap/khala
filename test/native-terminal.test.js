import assert from "node:assert/strict";
import { test } from "node:test";
import { selectNativeListItem } from "./helpers/native-terminal.mjs";

test("native list selection ignores unrelated redraws before the selected row moves", async () => {
	let screen = "→ First\n  Target\nold status";
	let moves = 0;
	const keys = [];
	const terminal = {
		screen: () => screen,
		keys: (key) => {
			keys.push(key);
			if (key !== "Down") return;
			moves += 1;
			if (moves === 1) {
				setTimeout(() => { screen = "→ First\n  Target\nnew status"; }, 20);
				setTimeout(() => { screen = "  First\n→ Target\nnew status"; }, 150);
			}
		},
	};
	await selectNativeListItem(terminal, "Target", () => screen);
	assert.deepEqual(keys, ["Down", "Enter"]);
});
