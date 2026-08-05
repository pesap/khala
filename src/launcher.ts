import { existsSync, readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "./executor.js";

const STARTUP_TIMEOUT_MS = 10_000;
const LAUNCHER_EXIT_MARKER_PARTS = 3;

type StartupRequest = Readonly<{ markerPath: string }>;

type LauncherExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

interface LaunchRequest {
	sandbox: Sandbox;
	name: string;
	command: string;
	args: readonly string[];
	startup?: StartupRequest;
}

interface LaunchedSession {
	id: string;
	sandbox: Sandbox;
	target?: string;
	ready?: Promise<void>;
	/** Resolves with the child exit observed after the launcher reported readiness. */
	exited?: Promise<LauncherExit>;
	/** Releases only resources created by this launch transaction. */
	cleanup?: () => Promise<void>;
}

abstract class Launcher {
	abstract launch(request: LaunchRequest): Promise<LaunchedSession>;
	abstract focus(target: string): Promise<void>;
	abstract close(target: string): Promise<void>;
}

function hasErrorCode(error: object, code: string): boolean {
	if (!("code" in error)) {
		return false;
	}
	return error.code === code;
}

function prepareStartupRequest(request: LaunchRequest): LaunchRequest {
	if (request.startup === undefined) {
		return request;
	}
	const bootstrap = fileURLToPath(new URL("./executor-bootstrap.js", import.meta.url));
	return {
		...request,
		command: process.execPath,
		args: [bootstrap, request.startup.markerPath, request.command, ...request.args],
	};
}

function waitForStartup(markerPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		let watcher: ReturnType<typeof watch> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			watcher?.close();
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};
		const inspect = () => {
			if (!existsSync(markerPath)) {
				if (Date.now() >= deadline) {
					finish(new Error("Observer child did not become ready within 10 seconds."));
				}
				return;
			}
			const marker = readFileSync(markerPath, "utf8").trim();
			if (marker === "ready") {
				finish();
				return;
			}
			if (marker.startsWith("exit:")) {
				finish(new Error(`Observer child exited during startup: ${marker.slice("exit:".length)}`));
			}
		};
		watcher = watch(dirname(markerPath), { persistent: false }, inspect);
		timeout = setTimeout(inspect, STARTUP_TIMEOUT_MS);
		inspect();
	});
}

function waitForExit(markerPath: string): Promise<LauncherExit> {
	return new Promise((resolve) => {
		let watcher: ReturnType<typeof watch> | undefined;
		const finish = (exit: LauncherExit) => {
			watcher?.close();
			resolve(exit);
		};
		const inspect = () => {
			if (!existsSync(markerPath)) {
				return;
			}
			const exit = parseLauncherExit(readFileSync(markerPath, "utf8").trim());
			if (exit !== undefined) {
				finish(exit);
			}
		};
		watcher = watch(dirname(markerPath), { persistent: false }, inspect);
		inspect();
	});
}

function parseLauncherExit(marker: string): LauncherExit | undefined {
	if (!marker.startsWith("exit:")) {
		return;
	}
	const [, code, signal] = marker.split(":", LAUNCHER_EXIT_MARKER_PARTS);
	let exitCode: number | null = null;
	if (code !== undefined && code !== "null") {
		const parsedCode = Number(code);
		if (Number.isInteger(parsedCode)) {
			exitCode = parsedCode;
		}
	}
	let exitSignal: NodeJS.Signals | null = null;
	if (signal !== undefined && signal !== "none") {
		exitSignal = signal as NodeJS.Signals;
	}
	return { code: exitCode, signal: exitSignal };
}

export type { LaunchedSession, LauncherExit, LaunchRequest, StartupRequest };
export { hasErrorCode, Launcher, prepareStartupRequest, waitForExit, waitForStartup };
