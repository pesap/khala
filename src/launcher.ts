import type { Sandbox } from "./executor.js";

interface LaunchRequest {
	sandbox: Sandbox;
	name: string;
	command: string;
	args: readonly string[];
}

interface LaunchedSession {
	id: string;
	sandbox: Sandbox;
	target?: string;
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

export type { LaunchedSession, LaunchRequest };
export { hasErrorCode, Launcher };
