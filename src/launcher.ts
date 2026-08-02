import { existsSync, readFileSync, unlinkSync, watch } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "./executor.js";

const STARTUP_TIMEOUT_MS = 10_000;

type StartupRequest = Readonly<{ markerPath: string }>;

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
	ready?: Promise<void> | undefined;
	/** Releases only resources created by this launch transaction. */
	cleanup?: () => Promise<void>;
}

abstract class Launcher {
	abstract launch(request: LaunchRequest): Promise<LaunchedSession>;
	abstract focus(target: string): Promise<void>;
	abstract close(target: string): Promise<void>;
	send(_target: string, _message: string): Promise<void> {
		return Promise.reject(new Error("This launcher does not support sending messages to an active Executor."));
	}
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
			if (watcher !== undefined) {
				watcher.close();
			}
			try {
				unlinkSync(markerPath);
			} catch {
				// Sandbox cleanup owns missing markers.
			}
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};
		const inspect = () => {
			if (!existsSync(markerPath)) {
				if (Date.now() >= deadline) {
					finish(new Error("Executor child did not become ready within 10 seconds."));
				}
				return;
			}
			const marker = readFileSync(markerPath, "utf8").trim();
			if (marker === "ready") {
				finish();
				return;
			}
			if (marker.startsWith("exit:")) {
				finish(new Error(`Executor child exited during startup: ${marker.slice("exit:".length)}`));
			}
		};
		watcher = watch(dirname(markerPath), { persistent: false }, inspect);
		timeout = setTimeout(() => inspect(), STARTUP_TIMEOUT_MS);
		inspect();
	});
}

export type { LaunchedSession, LaunchRequest, StartupRequest };
export { hasErrorCode, Launcher, prepareStartupRequest, waitForStartup };
