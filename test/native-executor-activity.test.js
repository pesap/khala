import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const pi = process.env.KHALA_NATIVE_PI ?? resolve("node_modules/.bin/pi");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

async function waitFor(screen, predicate) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const output = screen();
		if (predicate(output)) return output;
		await delay(100);
	}
	assert.fail(`Timed out waiting for Pi:\n${screen()}`);
}

for (const mode of ["fullscreen", "regular"]) {
 test(`native Pi preserves the prompt draft and cursor across Executor activity in ${mode} mode`, { skip: !hasTmux, timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-native-activity-"));
	const agent = join(root, "agent");
	const extension = join(root, "activity-fixture.ts");
	const socket = `khala-activity-${process.pid}-${mode}`;
	const session = "activity";
	const tmux = (...args) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
	const screen = () => tmux("capture-pane", "-p", "-t", session);
	const keys = (...args) => tmux("send-keys", "-t", session, ...args);
	try {
		await mkdir(agent);
		const workModule = pathToFileURL(resolve("dist/src/tui.js")).href;
		await writeFile(extension, `import { showKhala } from ${JSON.stringify(workModule)};
export default function(pi) {
 pi.registerShortcut("alt+o", { description: "Open deterministic activity fixture", handler: async (ctx) => {
  const work = { workId: "fixture", state: "active", revision: 1, terms: { title: "Fixture Work", objective: "Test the panel." }, nextAction: "Continue", execution: { executionId: "run", state: "running", pi: { sessionId: "fixture", sessionPath: "/fixture" } } };
  const service = { listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, nextAction: work.nextAction }], inspectWork: () => work, availableActions: () => [], observeExecutor: () => ({ snapshot: () => ({ state: "attached", entries: [...Array.from({ length: 20 }, (_, index) => ({ kind: "message", text: "Earlier entry " + index, truncated: false })), { kind: "message", text: "Deterministic fixture activity", truncated: false }], discarded: 12 }), close: () => {} }) };
  await showKhala(service, ctx);
 } });
}
`);
		tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "32", "-c", root,
			"env", `PI_CODING_AGENT_DIR=${agent}`, "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
			pi, "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--offline", "--no-session", "--no-approve", "--tui-mode", mode);
		await waitFor(screen, (output) => output.includes("activity-fixture.ts"));
		keys("-l", "draft tail");
		keys("Left", "Left", "Left", "Left", "Left");
		keys("M-o");
		await waitFor(screen, (output) => /^\s*→\s+Fixture Work\b/m.test(output));
		keys("Enter");
		await waitFor(screen, (output) => /^\s*Freshness\s+Saved revision/m.test(output));
		keys("Down");
		await waitFor(screen, (output) => /^\s*→\s+Executor activity\s*$/m.test(output));
		keys("Enter");
		await waitFor(screen, (output) => output.includes("Deterministic fixture activity"));
		tmux("resize-window", "-t", session, "-x", "40", "-y", "12");
		await waitFor(screen, (output) => ["Attached", "incomplete", "discarded", "Deterministic fixture activity", "escape"].every((text) => output.includes(text)));
		keys("Escape");
		await waitFor(screen, (output) => output.includes("Fixture Work") && output.includes("Executor activity") && output.includes("escape"));
		keys("Escape");
		await waitFor(screen, (output) => output.includes("Fixture Wo") && output.includes("escape"));
		tmux("resize-window", "-t", session, "-x", "100", "-y", "32");
		keys("Escape");
		await waitFor(screen, (output) => output.includes("draft tail"));
		keys("-l", "X");
		await waitFor(screen, (output) => output.includes("draftX tail"));
	} finally {
		try { tmux("kill-session", "-t", session); } catch { /* The owned session may already be gone. */ }
		await rm(root, { recursive: true, force: true });
	}
 });
}
