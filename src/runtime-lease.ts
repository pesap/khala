import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { nanoid } from "nanoid";
import type { JsonObject, JsonValue } from "./model.js";
import type { RuntimeBinding } from "./ports.js";
import { processGroupExists, readProcessStartTime, terminateProcessGroup } from "./runtime-process.js";

type LaunchLease = Readonly<{
	processGroupId?: number | undefined;
	processStartTime?: string | undefined;
	capabilityFile?: string | undefined;
	processMarker?: string | undefined;
	ownerProcessId?: number | undefined;
	createdAt?: number | undefined;
}>;

const LAUNCH_INTENT_STALE_MS = 60_000;

import type { RuntimeStorage } from "./runtime-storage.js";

export async function writeCapabilityFile(path: string, token: string, storage: RuntimeStorage): Promise<void> {
	await storage.prepareSessionFile(path, false);
	await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
export async function reserveLaunch(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
	storage: RuntimeStorage,
): Promise<void> {
	await withLaunchLock(sessionPath, storage, async () => {
		const path = storage.launchLeasePath(sessionPath);
		await storage.prepareSessionFile(path, false);
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text !== undefined) await replaceExistingLaunch(path, sessionPath, text, storage);
		await writeLaunchIntentSafely(sessionPath, capabilityFile, processMarker, storage);
	});
}

async function writeLaunchIntentSafely(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
	storage: RuntimeStorage,
): Promise<void> {
	try {
		await writeLaunchIntent(sessionPath, capabilityFile, processMarker, storage);
	} catch (error) {
		if (error instanceof Error && isExistsError(error))
			throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
		throw error;
	}
}

async function replaceExistingLaunch(
	path: string,
	sessionPath: string,
	text: string,
	storage: RuntimeStorage,
): Promise<void> {
	const lease = parseLaunchLease(text);
	validateLeaseCapability(lease, storage);
	await assertLaunchAvailable(path, sessionPath, lease);
	const displacedPath = `${path}.stale-${nanoid()}`;
	await renameStaleLaunch(path, displacedPath, sessionPath);
	if (lease?.capabilityFile !== undefined) await unlink(lease.capabilityFile).catch(() => undefined);
	await unlink(displacedPath).catch(() => undefined);
}

function validateLeaseCapability(lease: LaunchLease | undefined, storage: RuntimeStorage): void {
	if (lease?.capabilityFile !== undefined) storage.ownedPath(lease.capabilityFile);
}

async function assertLaunchAvailable(path: string, sessionPath: string, lease: LaunchLease | undefined): Promise<void> {
	if (isProcessLease(lease)) {
		assertLiveProcessLease(sessionPath, lease);
		return;
	}
	await assertLaunchIntentAvailable(path, sessionPath, lease);
}

function isProcessLease(lease: LaunchLease | undefined): lease is ProcessLease {
	return lease?.processGroupId !== undefined;
}

type ProcessLease = LaunchLease & Readonly<{ processGroupId: number }>;

function assertLiveProcessLease(sessionPath: string, lease: ProcessLease): void {
	if (processGroupExists(lease.processGroupId))
		throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
}

async function assertLaunchIntentAvailable(
	path: string,
	sessionPath: string,
	lease: LaunchLease | undefined,
): Promise<void> {
	if (liveLaunchIntent(lease)) throw new Error(`Runtime session ${sessionPath} is already launching.`);
	const createdAt = await launchIntentCreatedAt(path, lease);
	if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
		throw new Error(`Runtime session ${sessionPath} is already launching.`);
}

function liveLaunchIntent(lease: LaunchLease | undefined): boolean {
	return lease?.ownerProcessId !== undefined && processExists(lease.ownerProcessId);
}

async function launchIntentCreatedAt(path: string, lease: LaunchLease | undefined): Promise<number> {
	return lease?.createdAt ?? (await stat(path)).mtimeMs;
}

async function renameStaleLaunch(path: string, displacedPath: string, sessionPath: string): Promise<void> {
	try {
		await rename(path, displacedPath);
	} catch (error) {
		if (error instanceof Error && isMissingFileError(error))
			throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
		throw error;
	}
}

async function withLaunchLock<T>(
	sessionPath: string,
	storage: RuntimeStorage,
	operation: () => Promise<T>,
): Promise<T> {
	const lockPath = storage.launchLockPath(sessionPath);
	await acquireLaunchLock(lockPath, sessionPath, storage);
	try {
		return await operation();
	} finally {
		await rmdir(lockPath).catch(() => undefined);
	}
}

async function acquireLaunchLock(lockPath: string, sessionPath: string, storage: RuntimeStorage): Promise<void> {
	storage.ownedPath(lockPath);
	try {
		await mkdir(lockPath, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		await replaceStaleLaunchLock(lockPath, sessionPath, error, storage);
	}
}

async function replaceStaleLaunchLock(
	lockPath: string,
	sessionPath: string,
	error: Error,
	storage: RuntimeStorage,
): Promise<void> {
	if (!isExistsError(error)) throw error;
	await chmod(lockPath, 0o700);
	const createdAt = await stat(lockPath)
		.then((entry) => entry.mtimeMs)
		.catch(() => Date.now());
	if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
		throw new Error(`Runtime session ${sessionPath} is already launching.`);
	await chmod(lockPath, 0o700);
	await rmdir(lockPath).catch(() => undefined);
	storage.ownedPath(lockPath);
	await mkdir(lockPath, { mode: 0o700 });
}

function isMissingFileError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

function isExistsError(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

function processExists(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

async function writeLaunchIntent(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
	storage: RuntimeStorage,
): Promise<void> {
	await writeFile(
		storage.launchLeasePath(sessionPath),
		JSON.stringify({ capabilityFile, processMarker, ownerProcessId: process.pid, createdAt: Date.now() }),
		{
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		},
	);
}
export async function writeLaunchLease(
	sessionPath: string,
	binding: RuntimeBinding,
	capabilityFile: string | undefined,
	storage: RuntimeStorage,
): Promise<void> {
	if (binding.processGroupId === undefined) return;
	const existing = parseLaunchLease(readFileSync(storage.launchLeasePath(sessionPath), "utf8"));
	if (existing?.processMarker !== binding.processMarker) throw new Error("Runtime launch ownership was lost.");
	const leasePath = storage.launchLeasePath(sessionPath);
	const temporaryPath = storage.launchTemporaryPath(sessionPath);
	try {
		await writeFile(temporaryPath, launchLeaseJson(binding, capabilityFile, existing), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporaryPath, leasePath);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function launchOwner(existing: LaunchLease | undefined): number {
	return existing?.ownerProcessId ?? process.pid;
}

function launchCreatedAt(existing: LaunchLease | undefined): number {
	return existing?.createdAt ?? Date.now();
}

function launchLeaseJson(
	binding: RuntimeBinding,
	capabilityFile: string | undefined,
	existing: LaunchLease | undefined,
): string {
	return JSON.stringify({
		processGroupId: binding.processGroupId,
		processStartTime: binding.processStartTime,
		capabilityFile,
		processMarker: binding.processMarker,
		ownerProcessId: launchOwner(existing),
		createdAt: launchCreatedAt(existing),
	});
}

export function removeLaunchLeaseSync(
	sessionPath: string,
	processMarker: string | undefined,
	storage: RuntimeStorage,
): void {
	if (sessionPath.length === 0) return;
	try {
		const leasePath = storage.launchLeasePath(sessionPath);
		const existing = parseLaunchLease(readFileSync(leasePath, "utf8"));
		if (leaseBelongsToAnotherProcess(existing, processMarker)) return;
		unlinkSync(leasePath);
	} catch {
		// The lease may already have been removed by normal completion.
	}
}

export async function stopPersistedInvocation(
	binding: RuntimeBinding,
	writerProcessId: number,
	storage: RuntimeStorage,
	onStopped: () => void,
): Promise<void> {
	await withLaunchLock(binding.sessionPath, storage, async () => {
		const leasePath = storage.launchLeasePath(binding.sessionPath);
		const lease = readFileSync(leasePath, "utf8");
		const parsed = parseLaunchLease(lease);
		if (!persistedBindingOwnsLease(binding, writerProcessId, parsed))
			throw new Error("Runtime invocation launch lease is missing, malformed, or owned by another writer.");
		const leaderExited = readProcessStartTime(binding.processGroupId) === undefined;
		await terminateProcessGroup(binding.processGroupId, binding.processStartTime, leaderExited);
		onStopped();
		const current = parseLaunchLease(readFileSync(leasePath, "utf8"));
		if (!persistedBindingOwnsLease(binding, writerProcessId, current))
			throw new Error("Runtime invocation launch lease changed ownership during reconciliation.");
		unlinkSync(leasePath);
	});
}

function persistedBindingOwnsLease(
	binding: RuntimeBinding,
	writerProcessId: number,
	lease: LaunchLease | undefined,
): boolean {
	if (lease === undefined) return false;
	return [
		lease.processGroupId === binding.processGroupId,
		lease.processStartTime === binding.processStartTime,
		lease.processMarker === binding.processMarker,
		lease.ownerProcessId === writerProcessId,
	].every(Boolean);
}

function leaseBelongsToAnotherProcess(lease: LaunchLease | undefined, processMarker: string | undefined): boolean {
	return processMarker !== undefined && lease?.processMarker !== undefined && lease.processMarker !== processMarker;
}
function parseLaunchLease(text: string): LaunchLease | undefined {
	const parsed = readLaunchLeaseJson(text);
	if (parsed === undefined || !isJsonObject(parsed)) return undefined;
	return launchLeaseFromObject(parsed);
}

function readLaunchLeaseJson(text: string): JsonValue | undefined {
	try {
		// SAFETY: launch lease JSON is parsed and validated as a JsonValue before its fields are read.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

type LaunchLeaseFields = Readonly<{
	capabilityFile: string | undefined;
	processMarker: string | undefined;
	ownerProcessId: number | undefined;
	createdAt: number | undefined;
}>;

function launchLeaseFromObject(parsed: JsonObject): LaunchLease | undefined {
	const fields = readLaunchLeaseFields(parsed);
	if (fields === undefined) return undefined;
	if (isLaunchIntent(parsed)) return launchIntentLease(fields);
	const processGroupId = parsed["processGroupId"];
	const processStartTime = parsed["processStartTime"];
	const process = readLeaseProcess(processGroupId, processStartTime);
	if (process === undefined) return undefined;
	return { ...fields, ...process };
}

function isLaunchIntent(parsed: JsonObject): boolean {
	return parsed["processGroupId"] === undefined && parsed["processStartTime"] === undefined;
}

function readLeaseProcess(
	processGroupId: JsonValue | undefined,
	processStartTime: JsonValue | undefined,
): { processGroupId: number; processStartTime: string | undefined } | undefined {
	if (!validProcessGroup(processGroupId) || !validProcessStartTime(processStartTime)) return undefined;
	return { processGroupId, processStartTime };
}

function readLaunchLeaseFields(parsed: JsonObject): LaunchLeaseFields | undefined {
	const valid = validLaunchLeaseFields(parsed);
	if (!valid) return undefined;
	return {
		capabilityFile: optionalLeaseText(parsed["capabilityFile"]),
		processMarker: optionalLeaseText(parsed["processMarker"]),
		ownerProcessId: optionalLeaseInteger(parsed["ownerProcessId"]),
		createdAt: optionalLeaseInteger(parsed["createdAt"]),
	};
}

function validLaunchLeaseFields(parsed: JsonObject): boolean {
	return [
		validOptionalPositiveInteger(parsed["ownerProcessId"]),
		validOptionalPositiveInteger(parsed["createdAt"]),
		parsed["capabilityFile"] === undefined || isText(parsed["capabilityFile"]),
		parsed["processMarker"] === undefined || isText(parsed["processMarker"]),
	].every(Boolean);
}

function validOptionalPositiveInteger(value: JsonValue | undefined): boolean {
	return value === undefined || (isInteger(value) && value > 0);
}

function optionalLeaseText(value: JsonValue | undefined): string | undefined {
	if (value === undefined) return undefined;
	return isText(value) ? value : undefined;
}

function optionalLeaseInteger(value: JsonValue | undefined): number | undefined {
	if (value === undefined) return undefined;
	return isInteger(value) ? value : undefined;
}

function launchIntentLease(fields: LaunchLeaseFields): LaunchLease {
	return hasLeaseFields(fields) ? fields : {};
}

function hasLeaseFields(fields: LaunchLeaseFields): boolean {
	return [
		fields.capabilityFile !== undefined,
		fields.processMarker !== undefined,
		fields.ownerProcessId !== undefined,
		fields.createdAt !== undefined,
	].some(Boolean);
}

function validProcessGroup(value: JsonValue | undefined): value is number {
	return isInteger(value) && value > 0;
}

function validProcessStartTime(value: JsonValue | undefined): value is string | undefined {
	return value === undefined || (isText(value) && value.length > 0);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

export function isInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}
