import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import type { RuntimeBinding } from "./ports.js";

const SENSITIVE_ENVIRONMENT_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i;

export function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const key of Object.keys(environment)) {
		if (SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
	}
	return environment;
}
export function readProcessStartTime(processId: number | undefined): string | undefined {
	if (processId === undefined || process.platform === "win32") return undefined;
	return readUnixProcessStartTime(processId);
}

function readUnixProcessStartTime(processId: number): string | undefined {
	const linuxStartTime = readLinuxProcessStartTime(processId);
	return linuxStartTime ?? readPsProcessStartTime(processId);
}

function readLinuxProcessStartTime(processId: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
		const endOfCommand = stat.lastIndexOf(")");
		return stat
			.slice(endOfCommand + 2)
			.trim()
			.split(/\s+/)[19];
	} catch {
		return undefined;
	}
}

function readPsProcessStartTime(processId: number): string | undefined {
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(processId)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value.length === 0 ? undefined : value;
	} catch {
		return undefined;
	}
}
const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_POLL_MS = 25;

export async function terminateProcessGroup(
	processGroupId: number | undefined,
	processStartTime: string | undefined,
	leaderAlreadyExited = false,
): Promise<void> {
	assertSupportedProcessPlatform();
	const ownedProcessGroupId = requireProcessGroupId(processGroupId);
	if (!hasLiveProcessGroup(ownedProcessGroupId)) {
		assertExitedProcessGroupOwnership(ownedProcessGroupId, processStartTime, leaderAlreadyExited);
		return;
	}
	assertTerminationOwnership(ownedProcessGroupId, processStartTime, leaderAlreadyExited);
	signalProcessGroup(ownedProcessGroupId);
	await waitForProcessGroupTermination(ownedProcessGroupId);
}

function requireProcessGroupId(processGroupId: number | undefined): number {
	if (processGroupId === undefined) throw new Error("Cannot prove Pi process ownership without a process group.");
	return processGroupId;
}

function assertExitedProcessGroupOwnership(
	processGroupId: number,
	processStartTime: string | undefined,
	leaderAlreadyExited: boolean,
): void {
	if (processStartTime === undefined) throw new Error("Cannot prove Pi process ownership after the process exited.");
	if (readProcessStartTime(processGroupId) !== undefined)
		assertTerminationOwnership(processGroupId, processStartTime, leaderAlreadyExited);
}

function isKillableProcessGroup(
	processGroupId: number | undefined,
	processStartTime: string | undefined,
): processGroupId is number {
	if (processGroupId === undefined) return false;
	if (process.platform === "win32") return true;
	return processStartTime !== undefined && readProcessStartTime(processGroupId) === processStartTime;
}

function assertTerminationOwnership(
	processGroupId: number,
	processStartTime: string | undefined,
	leaderAlreadyExited: boolean,
): void {
	if (leaderAlreadyExited) {
		assertExitedLeaderOwnership(processGroupId, processStartTime);
		return;
	}
	assertLiveLeaderOwnership(processGroupId, processStartTime);
}

function assertExitedLeaderOwnership(processGroupId: number, processStartTime: string | undefined): void {
	if (processStartTime === undefined) throw new Error("Cannot prove Pi process ownership after the leader exited.");
	const liveLeaderStartTime = readProcessStartTime(processGroupId);
	if (liveLeaderStartTime !== undefined && liveLeaderStartTime !== processStartTime)
		throw new Error("A different process now owns the Pi process identity.");
}

function assertLiveLeaderOwnership(processGroupId: number, processStartTime: string | undefined): void {
	if (!isKillableProcessGroup(processGroupId, processStartTime))
		throw new Error("Cannot prove Pi process ownership before termination.");
}

function signalProcessGroup(processGroupId: number): void {
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch (error) {
		if (isProcessGroupGone(processGroupId)) return;
		throwProcessSignalError(error instanceof Error ? error : new Error(String(error)));
	}
}

function throwProcessSignalError(error: Error): void {
	const failure = error instanceof Error ? error : new Error(String(error));
	if (isUnexpectedProcessSignalError(failure)) throw failure;
}

function isProcessGroupGone(processGroupId: number): boolean {
	return process.platform !== "linux" && !posixProcessGroupExists(processGroupId);
}

function assertSupportedProcessPlatform(): void {
	if (process.platform === "win32") throw new Error("Pi process-tree cleanup is unsupported on Windows.");
}

function hasLiveProcessGroup(processGroupId: number | undefined): processGroupId is number {
	return processGroupId !== undefined && processGroupExists(processGroupId);
}

function isUnexpectedProcessSignalError(error: Error): boolean {
	return !("code" in error && error.code === "ESRCH");
}

async function waitForProcessGroupTermination(processGroupId: number): Promise<void> {
	const deadline = Date.now() + PROCESS_TERMINATION_TIMEOUT_MS;
	while (processGroupExists(processGroupId)) {
		if (Date.now() >= deadline) throw new Error("Pi process tree termination could not be confirmed.");
		await new Promise((resolve) => setTimeout(resolve, PROCESS_TERMINATION_POLL_MS));
	}
}

export function processGroupExists(processGroupId: number | undefined): boolean {
	if (processGroupId === undefined || processGroupId <= 0) return false;
	return process.platform === "linux"
		? linuxProcessGroupExists(processGroupId)
		: posixProcessGroupExists(processGroupId);
}

function linuxProcessGroupExists(processGroupId: number): boolean {
	try {
		return readdirSync("/proc").some((entry) => linuxEntryInProcessGroup(entry, processGroupId));
	} catch {
		return true;
	}
}

function linuxEntryInProcessGroup(entry: string, processGroupId: number): boolean {
	if (!isLinuxProcessEntry(entry)) return false;
	return readLinuxProcessEntry(entry, processGroupId);
}

function readLinuxProcessEntry(entry: string, processGroupId: number): boolean {
	try {
		return processStatBelongsToGroup(readFileSync(`/proc/${entry}/stat`, "utf8"), processGroupId);
	} catch (error) {
		if (error instanceof Error && isMissingProcessEntry(error)) return false;
		throw error;
	}
}

function isLinuxProcessEntry(entry: string): boolean {
	return /^\d+$/.test(entry);
}

function processStatBelongsToGroup(stat: string, processGroupId: number): boolean {
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	return Number(fields[2]) === processGroupId && fields[0] !== "Z";
}

function isMissingProcessEntry(error: Error): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}

function posixProcessGroupExists(processGroupId: number): boolean {
	return process.platform === "darwin"
		? darwinProcessGroupExists(processGroupId)
		: probePosixProcessGroup(processGroupId);
}

function probePosixProcessGroup(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return processSignalDidNotFindGroup(error instanceof Error ? error : new Error(String(error)));
	}
}

function processSignalDidNotFindGroup(error: Error): boolean {
	return !(error instanceof Error && "code" in error && error.code === "ESRCH");
}

function darwinProcessGroupExists(processGroupId: number): boolean {
	try {
		const output = execFileSync("ps", ["-axo", "pid=,pgid="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.split("\n").some((line) => {
			const fields = line.trim().split(/\s+/);
			return fields.length >= 2 && Number(fields[0]) > 0 && Number(fields[1]) === processGroupId;
		});
	} catch {
		return true;
	}
}

export function isTransientStartupFailure(message: string): boolean {
	return message.includes("Pi child exited") || message.includes("Pi RPC get_state timed out");
}

export function sameBindingIdentity(left: RuntimeBinding, right: RuntimeBinding): boolean {
	return [
		left.sessionId === right.sessionId,
		left.sessionPath === right.sessionPath,
		left.processGroupId === right.processGroupId,
		left.processStartTime === right.processStartTime,
		left.capabilityNonce === right.capabilityNonce,
		left.processMarker === right.processMarker,
	].every(Boolean);
}
