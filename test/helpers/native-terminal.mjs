import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { openKhalaArchive } from "../../dist/src/archive-view.js";
import { archivePath } from "../../dist/src/config.js";
import { packageRoot } from "./native-workflow.mjs";

export async function waitUntil(read, accepts, diagnostic) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const value = read();
		if (accepts(value)) return value;
		await setTimeout(100);
	}
	assert.fail(diagnostic());
}

export async function selectNativeListItem(terminal, label, diagnostic) {
	const selected = (screen) => screen.split("\n").some((line) => line.trim() === `→ ${label}`);
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const screen = terminal.screen();
		if (selected(screen)) {
			terminal.keys("Enter");
			return;
		}
		terminal.keys("Down");
		await waitUntil(terminal.screen, (next) => next !== screen, diagnostic);
	}
	assert.fail(`Could not select native TUI item ${label}.`);
}

export function createNativeTerminal(fixture) {
	const session = `khala-native-${process.pid}-${Date.now()}`;
	const path = archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project);
	const tmux = (...args) => execFileSync("tmux", ["-L", `khala-native-${process.pid}`, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const screen = () => tmux("capture-pane", "-p", "-t", session);
	const keys = (...values) => tmux("send-keys", "-t", session, ...values);
	const send = (text) => { keys("-l", text); keys("Enter"); };
	const readWork = () => {
		if (!existsSync(path)) return undefined;
		const archive = openKhalaArchive(path);
		try { return archive.listWork().length === 0 ? undefined : archive.inspectWork("native-execution"); }
		finally { archive.close(); }
	};
	const start = async () => {
		tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "36", "-c", fixture.project,
			"env", `PI_CODING_AGENT_DIR=${fixture.agent}`, `PATH=${fixture.bin}:${process.env.PATH}`,
			join(packageRoot, "node_modules/.bin/pi"), "-ne", "-ns", "-np", "-nc", "--no-themes", "--offline", "-a", "--no-session", "-e", join(packageRoot, "src/index.ts"), "--model", "fixture/user", "--thinking", "off");
		await waitUntil(screen, (value) => value.includes("khala:"), screen);
	};
	const close = () => {
		try { tmux("kill-session", "-t", session); } catch { /* The owned terminal may already have exited. */ }
	};
	const crash = () => process.kill(Number(tmux("display-message", "-p", "-t", session, "#{pane_pid}").trim()), "SIGKILL");
	const waitForExit = () => waitUntil(() => {
		try { tmux("has-session", "-t", session); return false; } catch { return true; }
	}, Boolean, screen);
	return { screen, keys, send, readWork, start, close, crash, waitForExit };
}
