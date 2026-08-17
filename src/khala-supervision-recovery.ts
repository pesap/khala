// biome-ignore-all lint/style/noExcessiveLinesPerFile: Polling, outage persistence, and runtime-loss evidence share one recovery boundary.
// biome-ignore-all lint/style/noExcessiveClassesPerFile: The poller and outage coordinator are independently injected recovery services.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Recovery paths fail closed and retain explicit evidence fences.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Recovery transactions stay auditable in one bounded function.
// biome-ignore-all lint/complexity/useMaxParams: Recovery APIs retain explicit identity and injection boundaries.
// biome-ignore-all lint/performance/noAwaitInLoops: Dependency and outage ordering is durable and intentionally sequential.
// biome-ignore-all lint/style/noContinue: Untrusted Archive and dependency records use explicit skip guards.
// biome-ignore-all lint/style/noMagicNumbers: The bounded protocol and evidence limits are local recovery constants.
// biome-ignore-all lint/style/useDestructuring: Defensive parsing keeps untrusted values visibly qualified.
// biome-ignore-all lint/suspicious/noBitwiseOperators: Stable outage IDs use a bounded deterministic digest.
// biome-ignore-all lint/style/noProcessEnv: The git subprocess must explicitly disable terminal prompting.
// biome-ignore-all lint/style/useNamingConvention: GIT_TERMINAL_PROMPT is an external git environment contract.
// biome-ignore-all lint/style/useErrorCause: Recovery errors are intentionally bounded for persisted evidence.
// biome-ignore-all lint/style/noTernary: Explicit fail-closed branches keep recovery conditions readable.
// biome-ignore-all lint/suspicious/useAwait: Async recovery APIs preserve a uniform injected service contract.
// Supervision recovery owns the non-model fail-safe edges: exact upstream ref
// observation, persisted Conclave outages, and runtime-loss evidence.  The
// Conclave model may advise, but it never decides whether these safety fences
// are active.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { RpcSessionBinding } from "./executor-rpc.js";
import { appendArchiveRecord, listArchiveRecords } from "./khala-archive.js";
import { projectActiveUpstreamBases } from "./khala-archive-projections.js";
import {
	buildCoordinationDependencyGraph,
	directRevisionDependents,
	recordUpstreamRevision,
	resolveTerminalUpstreamCoordinations,
} from "./khala-coordination.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import {
	type CoordinationDependent,
	ExecutorStatus,
	type InterventionIssuanceRecord,
	type UpstreamExecutionBase,
} from "./khala-model.js";
import { sameFilesystemPath } from "./khala-path.js";

const UPSTREAM_POLL_INTERVAL_MS = 30_000;
const GIT_REF_TIMEOUT_MS = 10_000;
const OUTAGE_RETRY_DELAYS_MS = [30_000, 60_000, 90_000] as const;
const OUTAGE_ENTRY_TYPE = "khala-supervision-outage";
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type Clock = () => number;
type TimeoutHandle = unknown;
type TimerApi = Readonly<{
	setTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
	clearTimeout: (handle: TimeoutHandle) => void;
	setInterval: (callback: () => void, delayMs: number) => TimeoutHandle;
	clearInterval: (handle: TimeoutHandle) => void;
}>;

type GitLsRemoteRequest = Readonly<{ projectPath: string; remote: string; branch: string }>;
type GitLsRemoteExecutor = (request: GitLsRemoteRequest) => Promise<string>;
type RefObservation = Readonly<{ remote: string; branch: string; headCommit: string | null; observedAt: string }>;
type PollScope = Readonly<{
	base: UpstreamExecutionBase;
	remote: string;
	branch: string;
}>;
type MandatoryStopRuntime = Readonly<{
	setStopPending: () => void;
	sendAbort: () => Promise<void>;
	waitForSettled: (timeoutMs?: number) => Promise<void>;
	sendStopHandoff: (message: string) => Promise<void>;
	getEntries: () => Promise<Readonly<{ entries: readonly { id: string; message?: unknown }[] }>>;
}>;
type MandatoryStopOptions = Readonly<{
	marker: string;
	message: string;
	timeoutMs?: number;
	getBaselineSignalIds?: () => readonly string[];
	validatePostSettlement: (baselineSignalIds: readonly string[]) => Promise<boolean>;
}>;
type PollFailure = Readonly<{
	base: UpstreamExecutionBase;
	error: string;
	dependents: readonly CoordinationDependent[];
	scope: PollScope;
}>;
type UpstreamPollerOptions = Readonly<{
	projectPath: string;
	projectTrusted?: boolean;
	clock?: Clock;
	timers?: TimerApi;
	exec?: GitLsRemoteExecutor;
	getBases?: (projectPath: string, projectTrusted: boolean) => readonly UpstreamExecutionBase[];
	recordRevision?: (input: {
		projectPath: string;
		projectTrusted: boolean;
		supersededBase: UpstreamExecutionBase;
		replacementHead: string | null;
		evidence: RefObservation;
		directDependents: readonly CoordinationDependent[];
		closeRuntime?: (executionId: string) => Promise<void>;
	}) => unknown;
	stopDependent?: (dependent: CoordinationDependent) => Promise<void> | void;
	closeRuntime?: (executionId: string) => Promise<void>;
	isVerifiedMerged?: (base: UpstreamExecutionBase) => boolean;
	onFailure?: (failure: PollFailure) => Promise<void> | void;
	onSuccess?: (base: UpstreamExecutionBase, observation?: RefObservation) => Promise<void> | void;
	isSupervisionAvailable?: (base?: UpstreamExecutionBase) => boolean;
}>;

type PollOutcome = Readonly<{
	base: UpstreamExecutionBase;
	status: "unchanged" | "changed" | "missing" | "merged" | "failed";
	observation?: RefObservation;
	error?: string;
}>;

function defaultTimers(): TimerApi {
	return {
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		setInterval: (callback, delayMs) => setInterval(callback, delayMs),
		clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	};
}

function defaultGitLsRemote(request: GitLsRemoteRequest): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(
			"git",
			["ls-remote", request.remote, `refs/heads/${request.branch}`],
			{
				cwd: request.projectPath,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				shell: false,
				timeout: GIT_REF_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
			},
			(error, stdout) => {
				if (error !== null) {
					reject(error);
					return;
				}
				resolveOutput(stdout);
			},
		);
	});
}

function parseLsRemoteOutput(output: string, branch: string): string | null {
	if (output === "" || output === "\n") {
		return null;
	}
	const lines = output.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	if (lines.length !== 1) {
		throw new Error("git ls-remote returned an ambiguous ref result.");
	}
	const [line] = lines;
	if (line === undefined || line === "") {
		return null;
	}
	const expectedRef = `refs/heads/${branch}`;
	const separator = line.indexOf("\t");
	if (separator < 0 || line.indexOf("\t", separator + 1) >= 0) {
		throw new Error("git ls-remote returned a malformed ref result.");
	}
	const headCommit = line.slice(0, separator);
	const ref = line.slice(separator + 1);
	if (!FULL_COMMIT_PATTERN.test(headCommit) || ref !== expectedRef) {
		throw new Error("git ls-remote returned an invalid or unexpected ref result.");
	}
	return headCommit.toLowerCase();
}

function baseIdentity(base: UpstreamExecutionBase): string {
	return `${base.workId}\u0000${base.missionId}\u0000${base.executionId}\u0000${base.remote}\u0000${base.branch}\u0000${base.headCommit}`;
}

function remoteRefIdentity(projectPath: string, remote: string, branch: string): string {
	return `${resolve(projectPath)}\u0000${remote.trim()}\u0000${branch}`;
}

const sharedRefQueries = new Map<string, Promise<string>>();

class UpstreamRefPoller {
	private readonly options: Required<
		Pick<
			UpstreamPollerOptions,
			| "projectPath"
			| "projectTrusted"
			| "clock"
			| "timers"
			| "exec"
			| "getBases"
			| "recordRevision"
			| "isVerifiedMerged"
		>
	> &
		UpstreamPollerOptions;
	private readonly observed = new Map<string, string | null>();
	private readonly pendingObservations = new Map<string, RefObservation>();
	private interval: TimeoutHandle | undefined;
	private disposed = false;
	private readonly polling = new Map<string, Promise<readonly PollOutcome[]>>();
	private readonly basePolls = new Map<string, Promise<PollOutcome>>();

	constructor(options: UpstreamPollerOptions) {
		const projectTrusted = options.projectTrusted ?? false;
		this.options = {
			...options,
			projectPath: options.projectPath,
			projectTrusted,
			clock: options.clock ?? Date.now,
			timers: options.timers ?? defaultTimers(),
			exec: options.exec ?? defaultGitLsRemote,
			getBases: options.getBases ?? projectActiveUpstreamBases,
			recordRevision: options.recordRevision ?? ((input) => recordUpstreamRevision(input)),
			isVerifiedMerged:
				options.isVerifiedMerged ?? ((base) => defaultVerifiedMerge(options.projectPath, projectTrusted, base)),
		};
	}

	async start(): Promise<readonly PollOutcome[]> {
		const outcomes = await this.pollNow();
		if (!this.disposed && this.interval === undefined) {
			this.interval = this.options.timers.setInterval(() => {
				this.pollNow().catch(() => undefined);
			}, UPSTREAM_POLL_INTERVAL_MS);
		}
		return outcomes;
	}

	async beforeDependentLaunch(): Promise<readonly PollOutcome[]> {
		return this.pollNow();
	}

	async pollNow(scope?: PollScope): Promise<readonly PollOutcome[]> {
		if (this.disposed) {
			return [];
		}
		const pollingKey = scope === undefined ? "global" : `scope:${baseIdentity(scope.base)}`;
		const existing = this.polling.get(pollingKey);
		if (existing !== undefined) {
			return existing;
		}
		const run = this.pollActiveBases(scope);
		this.polling.set(pollingKey, run);
		try {
			return await run;
		} finally {
			if (this.polling.get(pollingKey) === run) {
				this.polling.delete(pollingKey);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.interval !== undefined) {
			this.options.timers.clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private async pollActiveBases(scope?: PollScope): Promise<readonly PollOutcome[]> {
		const allBases = [...this.options.getBases(this.options.projectPath, this.options.projectTrusted)];
		const bases =
			scope === undefined
				? allBases
				: allBases.filter((candidate) => baseIdentity(candidate) === baseIdentity(scope.base));
		if (scope !== undefined && bases.length === 0 && this.options.isVerifiedMerged?.(scope.base) === true) {
			await this.options.onSuccess?.(scope.base);
			return [{ base: scope.base, status: "merged" }];
		}
		const activeKeys = new Set(allBases.map(baseIdentity));
		for (const key of this.observed.keys()) {
			if (!activeKeys.has(key)) {
				this.observed.delete(key);
			}
		}
		return Promise.all(bases.map((base) => this.pollBase(base)));
	}

	// One base transaction per poll window: a concurrent global and a scoped poll for the same base
	// share the same in-flight transaction (ref query, revision recording, and success callbacks) and
	// both receive its outcome, instead of running the side effects twice.
	private pollBase(base: UpstreamExecutionBase): Promise<PollOutcome> {
		const identity = baseIdentity(base);
		const existing = this.basePolls.get(identity);
		if (existing !== undefined) {
			return existing;
		}
		const run = this.runPollBase(base);
		this.basePolls.set(identity, run);
		run
			.finally(() => {
				if (this.basePolls.get(identity) === run) {
					this.basePolls.delete(identity);
				}
			})
			.catch(() => undefined);
		return run;
	}

	private async runPollBase(base: UpstreamExecutionBase): Promise<PollOutcome> {
		const identity = baseIdentity(base);
		const pendingObservation = this.pendingObservations.get(identity);
		const observedAt = pendingObservation?.observedAt ?? new Date(this.options.clock()).toISOString();
		let headCommit: string | null;
		try {
			const key = remoteRefIdentity(this.options.projectPath, base.remote, base.branch);
			let query = sharedRefQueries.get(key);
			if (query === undefined) {
				query = this.options.exec({ projectPath: this.options.projectPath, remote: base.remote, branch: base.branch });
				sharedRefQueries.set(key, query);
				query
					.finally(() => {
						if (sharedRefQueries.get(key) === query) {
							sharedRefQueries.delete(key);
						}
					})
					.catch(() => undefined);
			}
			const output = await query;
			headCommit = parseLsRemoteOutput(output, base.branch);
		} catch (error) {
			const dependents = revisionDependents(this.options.projectPath, this.options.projectTrusted, base);
			const failure: PollFailure = {
				base,
				error: errorMessage(error),
				dependents,
				scope: { base, remote: base.remote, branch: base.branch },
			};
			await this.options.onFailure?.(failure);
			return { base, status: "failed", error: failure.error };
		}
		if (pendingObservation !== undefined) {
			headCommit = pendingObservation.headCommit;
		}
		const observation: RefObservation = { remote: base.remote, branch: base.branch, headCommit, observedAt };
		const previous = this.observed.get(identity);
		if (headCommit === null && this.options.isVerifiedMerged(base)) {
			this.observed.set(identity, headCommit);
			this.pendingObservations.delete(identity);
			await this.options.onSuccess?.(base, observation);
			return { base, status: "missing", observation };
		}
		if (headCommit === base.headCommit || previous === headCommit) {
			this.observed.set(identity, headCommit);
			this.pendingObservations.delete(identity);
			await this.options.onSuccess?.(base, observation);
			return { base, status: "unchanged", observation };
		}
		if (this.options.isSupervisionAvailable?.(base) === false) {
			return { base, status: "failed", observation, error: "Supervision is unavailable; replacement is blocked." };
		}
		const dependents = revisionDependents(this.options.projectPath, this.options.projectTrusted, base);
		for (const dependent of dependents) {
			await this.options.stopDependent?.(dependent);
		}
		const directDependents = directRevisionDependents(this.options.projectPath, base, this.options.projectTrusted);
		try {
			await this.options.recordRevision({
				projectPath: this.options.projectPath,
				projectTrusted: this.options.projectTrusted,
				supersededBase: base,
				replacementHead: headCommit,
				evidence: observation,
				directDependents,
				...(this.options.closeRuntime === undefined ? {} : { closeRuntime: this.options.closeRuntime }),
			});
		} catch (error) {
			this.pendingObservations.set(identity, observation);
			const failure: PollFailure = {
				base,
				error: errorMessage(error),
				dependents,
				scope: { base, remote: base.remote, branch: base.branch },
			};
			await this.options.onFailure?.(failure);
			return { base, status: "failed", observation, error: failure.error };
		}
		this.observed.set(identity, headCommit);
		this.pendingObservations.delete(identity);
		await this.options.onSuccess?.(base, observation);
		return { base, status: headCommit === null ? "missing" : "changed", observation };
	}
}

function revisionDependents(
	projectPath: string,
	projectTrusted: boolean,
	base: UpstreamExecutionBase,
): CoordinationDependent[] {
	const graph = buildCoordinationDependencyGraph(projectPath, projectTrusted);
	const result: CoordinationDependent[] = [];
	const seenDependents = new Set<string>();
	const seenSources = new Set<string>();
	let frontier: UpstreamExecutionBase[] = [base];
	while (frontier.length > 0) {
		const next: UpstreamExecutionBase[] = [];
		for (const source of frontier) {
			const sourceKey = baseIdentity(source);
			if (seenSources.has(sourceKey)) {
				continue;
			}
			seenSources.add(sourceKey);
			for (const dependent of graph.directDependents(source)) {
				const key = `${dependent.workId}\u0000${dependent.missionId}\u0000${dependent.executionId ?? ""}`;
				if (seenDependents.has(key)) {
					continue;
				}
				seenDependents.add(key);
				result.push(dependent);
			}
			for (const dependent of result.filter((candidate) => candidate.supersededHead === source.headCommit)) {
				next.push(...graph.publishedBases(dependent.workId, dependent.missionId, dependent.executionId));
			}
		}
		frontier = next;
	}
	return result;
}

function defaultVerifiedMerge(projectPath: string, projectTrusted: boolean, base: UpstreamExecutionBase): boolean {
	const records = listArchiveRecords(projectPath, projectTrusted);
	return records.some((record) => {
		if (record.type === "pull-request" && typeof record.payload === "object" && record.payload !== null) {
			const payload = record.payload as {
				workId?: unknown;
				missionId?: unknown;
				executionId?: unknown;
				status?: unknown;
				headCommit?: unknown;
				mergeCommit?: unknown;
			};
			return (
				payload.workId === base.workId &&
				payload.missionId === base.missionId &&
				payload.executionId === base.executionId &&
				payload.status === "merged" &&
				payload.headCommit === base.headCommit &&
				typeof payload.mergeCommit === "string" &&
				FULL_COMMIT_PATTERN.test(payload.mergeCommit)
			);
		}
		if (record.type === "work-outcome" && typeof record.payload === "object" && record.payload !== null) {
			const payload = record.payload as {
				workId?: unknown;
				missionId?: unknown;
				executionId?: unknown;
				finalHeadCommit?: unknown;
				mergeCommit?: unknown;
			};
			return (
				payload.workId === base.workId &&
				payload.missionId === base.missionId &&
				payload.executionId === base.executionId &&
				payload.finalHeadCommit === base.headCommit &&
				typeof payload.mergeCommit === "string" &&
				payload.mergeCommit.length > 0
			);
		}
		return false;
	});
}

type OutageKind = "poll" | "conclave-model";
type OutageCheck = Readonly<{ attempt: number; at: string; result: "failed" | "succeeded"; error?: string }>;
type OutageRecord = Readonly<{
	outageId: string;
	kind: OutageKind;
	state: "open" | "closed" | "failed";
	startedAt: string;
	deadlineAt: string;
	failedCheckCount: number;
	checks: readonly OutageCheck[];
	workIds: readonly string[];
	missionIds: readonly string[];
	executionIds: readonly string[];
	initialError?: string;
	pollScope?: PollScope;
	closedAt?: string;
	failSafeAt?: string;
}>;
type OutageSession = Readonly<{
	getEntries: () => readonly { type: string; customType?: string; data?: unknown }[];
	appendCustomEntry: (customType: string, data: unknown) => string;
}>;
type OutageOptions = Readonly<{
	projectPath: string;
	session: OutageSession;
	clock?: Clock;
	timers?: TimerApi;
	onRetry: (outage: OutageRecord) => Promise<boolean>;
	onFailSafe: (outage: OutageRecord) => Promise<void> | void;
}>;

class SupervisionOutageCoordinator {
	private readonly options: Required<Pick<OutageOptions, "clock" | "timers">> & OutageOptions;
	private readonly open = new Map<string, OutageRecord>();
	private readonly retryTimers = new Map<string, TimeoutHandle>();
	private readonly failed = new Map<string, OutageRecord>();
	private disposed = false;

	constructor(options: OutageOptions) {
		this.options = { ...options, clock: options.clock ?? Date.now, timers: options.timers ?? defaultTimers() };
		this.restore();
	}

	async fail(
		input: Readonly<{
			kind: OutageKind;
			workIds: readonly string[];
			missionIds: readonly string[];
			executionIds: readonly string[];
			error: string;
			startedAt?: string;
			deadlineAt?: string;
			scope?: PollScope;
		}>,
	): Promise<OutageRecord> {
		const scope = input.scope;
		const outageId = stableOutageId(
			this.options.projectPath,
			input.kind,
			input.workIds,
			input.missionIds,
			input.executionIds,
			scope,
		);
		const terminal = this.failed.get(outageId);
		if (terminal !== undefined) {
			return terminal;
		}
		const existing = this.open.get(outageId);
		if (existing !== undefined) {
			return existing;
		}
		const startedAt = input.startedAt ?? new Date(this.options.clock()).toISOString();
		const outage: OutageRecord = {
			outageId,
			kind: input.kind,
			state: "open",
			startedAt,
			deadlineAt:
				input.deadlineAt ?? new Date(Date.parse(startedAt) + (OUTAGE_RETRY_DELAYS_MS.at(-1) ?? 90_000)).toISOString(),
			failedCheckCount: 0,
			checks: [],
			workIds: [...new Set(input.workIds)].sort(),
			missionIds: [...new Set(input.missionIds)].sort(),
			executionIds: [...new Set(input.executionIds)].sort(),
			initialError: input.error.slice(0, 500),
			...(scope === undefined ? {} : { pollScope: scope }),
		};
		this.open.set(outageId, outage);
		this.persist(outage);
		this.scheduleNext(outage);
		return outage;
	}

	async close(outageId: string): Promise<void> {
		const outage = this.open.get(outageId);
		if (outage === undefined) {
			return;
		}
		const timer = this.retryTimers.get(outageId);
		if (timer !== undefined) {
			this.options.timers.clearTimeout(timer);
			this.retryTimers.delete(outageId);
		}
		const closed: OutageRecord = {
			...outage,
			state: "closed",
			closedAt: new Date(this.options.clock()).toISOString(),
			checks: [
				...outage.checks,
				{ attempt: outage.failedCheckCount + 1, at: new Date(this.options.clock()).toISOString(), result: "succeeded" },
			],
		};
		this.open.delete(outageId);
		this.persist(closed);
	}

	getOpen(): readonly OutageRecord[] {
		return [...this.open.values()];
	}

	async recover(): Promise<void> {
		for (const outage of this.open.values()) {
			this.scheduleNext(outage);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.retryTimers.values()) {
			this.options.timers.clearTimeout(timer);
		}
		this.retryTimers.clear();
	}

	private restore(): void {
		const latest = new Map<string, OutageRecord>();
		for (const entry of this.options.session.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== OUTAGE_ENTRY_TYPE || !isOutageRecord(entry.data)) {
				continue;
			}
			latest.set(entry.data.outageId, entry.data);
		}
		for (const outage of latest.values()) {
			if (outage.state === "open") {
				this.open.set(outage.outageId, outage);
			} else if (outage.state === "failed") {
				this.failed.set(outage.outageId, outage);
			}
		}
	}

	private scheduleNext(outage: OutageRecord): void {
		if (this.disposed || this.retryTimers.has(outage.outageId)) {
			return;
		}
		const checkpoint = OUTAGE_RETRY_DELAYS_MS.at(outage.failedCheckCount);
		if (checkpoint === undefined) {
			this.failSafe(outage).catch(() => undefined);
			return;
		}
		const target = Date.parse(outage.startedAt) + checkpoint;
		const timer = this.options.timers.setTimeout(
			() => {
				this.retryTimers.delete(outage.outageId);
				this.runRetry(outage).catch(() => undefined);
			},
			Math.max(0, target - this.options.clock()),
		);
		this.retryTimers.set(outage.outageId, timer);
	}

	private async runRetry(outage: OutageRecord): Promise<void> {
		if (this.disposed || !this.open.has(outage.outageId)) {
			return;
		}
		const current = this.open.get(outage.outageId) as OutageRecord;
		try {
			if (await this.options.onRetry(current)) {
				await this.close(outage.outageId);
				return;
			}
			await this.recordRecoveryFailure(current, "Retry check failed.");
		} catch (error) {
			await this.recordRecoveryFailure(current, errorMessage(error));
		}
	}

	private async recordRecoveryFailure(current: OutageRecord, error: string): Promise<void> {
		const next: OutageRecord = {
			...current,
			failedCheckCount: current.failedCheckCount + 1,
			checks: [
				...current.checks,
				{
					attempt: current.failedCheckCount + 1,
					at: new Date(this.options.clock()).toISOString(),
					result: "failed",
					error: error.slice(0, 500),
				},
			],
		};
		this.open.set(next.outageId, next);
		this.persist(next);
		if (next.failedCheckCount >= OUTAGE_RETRY_DELAYS_MS.length) {
			await this.failSafe(next);
		} else {
			this.scheduleNext(next);
		}
	}

	private async failSafe(outage: OutageRecord): Promise<void> {
		if (outage.state !== "open" || outage.failSafeAt !== undefined) {
			return;
		}
		const failed: OutageRecord = {
			...outage,
			state: "failed",
			failSafeAt: new Date(this.options.clock()).toISOString(),
		};
		this.retryTimers.delete(outage.outageId);
		this.open.delete(outage.outageId);
		this.failed.set(outage.outageId, failed);
		this.persist(failed);
		await this.options.onFailSafe(failed);
	}

	private persist(outage: OutageRecord): void {
		this.options.session.appendCustomEntry(OUTAGE_ENTRY_TYPE, { ...outage, hidden: true });
	}
}

function stableOutageId(
	projectPath: string,
	kind: OutageKind,
	workIds: readonly string[],
	missionIds: readonly string[],
	executionIds: readonly string[],
	scope?: PollScope,
): string {
	const scopeKey =
		scope === undefined
			? ""
			: `${scope.base.workId}\u0000${scope.base.missionId}\u0000${scope.base.executionId}\u0000${scope.remote}\u0000${scope.branch}\u0000${scope.base.headCommit}`;
	const value = `${resolve(projectPath)}\u0000${kind}\u0000${[...workIds].sort().join(",")}\u0000${[...missionIds].sort().join(",")}\u0000${[...executionIds].sort().join(",")}\u0000${scopeKey}`;
	return `outage-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function isOutageRecord(value: unknown): value is OutageRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as {
		outageId?: unknown;
		kind?: unknown;
		state?: unknown;
		startedAt?: unknown;
		deadlineAt?: unknown;
		failedCheckCount?: unknown;
		checks?: unknown;
		workIds?: unknown;
		missionIds?: unknown;
		executionIds?: unknown;
		pollScope?: unknown;
	};
	return (
		typeof candidate.outageId === "string" &&
		(candidate.kind === "poll" || candidate.kind === "conclave-model") &&
		(candidate.state === "open" || candidate.state === "closed" || candidate.state === "failed") &&
		typeof candidate.startedAt === "string" &&
		typeof candidate.deadlineAt === "string" &&
		typeof candidate.failedCheckCount === "number" &&
		Array.isArray(candidate.checks) &&
		Array.isArray(candidate.workIds) &&
		Array.isArray(candidate.missionIds) &&
		Array.isArray(candidate.executionIds)
	);
}

async function failExecutionAndCloseInterventions(
	projectPath: string,
	executionId: string,
	projectTrusted = false,
	closeRuntime?: () => Promise<void>,
): Promise<string | undefined> {
	await closeRuntime?.().catch(() => undefined);
	const currentExecution = readExecutorRecord(projectPath, executionId, projectTrusted);
	if (currentExecution?.status !== ExecutorStatus.failed) {
		updateExecutorRecord(projectPath, executionId, { status: ExecutorStatus.failed }, projectTrusted);
	}
	const failedExecutionRecordId = [...listArchiveRecords(projectPath, projectTrusted)]
		.reverse()
		.find((record) => record.type === "execution" && record.executionId === executionId)?.recordId;
	if (failedExecutionRecordId === undefined) {
		return;
	}
	const records = listArchiveRecords(projectPath, projectTrusted);
	const closedInterventionIds = new Set(
		records.flatMap((record) => {
			if (
				record.type === "intervention" &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { phase?: unknown }).phase === "outcome" &&
				typeof (record.payload as { interventionId?: unknown }).interventionId === "string"
			) {
				return [(record.payload as { interventionId: string }).interventionId];
			}
			return [];
		}),
	);
	const outstanding = records.filter(
		(record): record is typeof record & { payload: InterventionIssuanceRecord } =>
			record.type === "intervention" &&
			typeof record.payload === "object" &&
			record.payload !== null &&
			(record.payload as { phase?: unknown }).phase === "issuance" &&
			(record.payload as { executionId?: unknown }).executionId === executionId &&
			!closedInterventionIds.has((record.payload as { interventionId: string }).interventionId),
	);
	resolveTerminalUpstreamCoordinations(projectPath, executionId, failedExecutionRecordId, projectTrusted);
	for (const issuanceRecord of outstanding) {
		const issuance = issuanceRecord.payload;
		appendArchiveRecord(
			projectPath,
			{
				schemaVersion: 2,
				type: "intervention",
				workId: issuance.workId,
				executionId: issuance.executionId,
				payload: {
					...issuance,
					phase: "outcome",
					actionId: `runtime-loss-outcome-${issuance.interventionId}`,
					outcome: "escalated",
					observedEntryIds: [],
					reason: "The Executor runtime was unrestartable; the exact failed Execution record is authoritative.",
					failedExecutionRecordId,
				},
			},
			projectTrusted,
		);
	}
	return failedExecutionRecordId;
}

function validatePersistedExecutorSession(binding: RpcSessionBinding, expectedPath?: string): void {
	if (binding.sessionId.trim().length === 0 || binding.sessionPath.trim().length === 0) {
		throw new Error("Persisted Executor Pi session binding is empty.");
	}
	if (expectedPath !== undefined && !sameFilesystemPath(expectedPath, binding.sessionPath)) {
		throw new Error("Persisted Executor session path does not match its Pi binding.");
	}
	if (!(existsSync(binding.sessionPath) && statSync(binding.sessionPath).isFile())) {
		throw new Error(`Persisted Executor Pi session path is invalid: ${binding.sessionPath}`);
	}
	const lines = readFileSync(binding.sessionPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		throw new Error("Persisted Executor Pi session is empty.");
	}
	for (const line of lines) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			throw new Error(`Persisted Executor Pi session is corrupt: ${errorMessage(error)}`);
		}
		if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
			throw new Error("Persisted Executor Pi session contains an invalid entry.");
		}
	}
	const header = JSON.parse(lines[0] as string) as { type?: unknown; id?: unknown };
	if (
		header.type !== "session" ||
		header.id !== binding.sessionId ||
		typeof header.id !== "string" ||
		header.id.trim().length === 0
	) {
		throw new Error("Persisted Executor Pi session identity is not verifiable.");
	}
}

async function mandatoryStopExecution(
	runtime: MandatoryStopRuntime,
	options: MandatoryStopOptions,
): Promise<readonly string[]> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	runtime.setStopPending();
	await runtime.sendAbort();
	await runtime.waitForSettled(timeoutMs);
	const baselineSignalIds = options.getBaselineSignalIds?.() ?? [];
	await runtime.sendStopHandoff(`${options.marker}${options.message}`);
	const deadline = Date.now() + timeoutMs;
	let marked: readonly string[] = [];
	while (Date.now() < deadline) {
		const result = await runtime.getEntries();
		marked = result.entries.flatMap((entry) => {
			if (typeof entry.message !== "object" || entry.message === null) {
				return [];
			}
			const message = entry.message as { role?: unknown; content?: unknown };
			let content = "";
			if (typeof message.content === "string") {
				content = message.content;
			} else if (Array.isArray(message.content)) {
				content = message.content
					.flatMap((part) =>
						typeof part === "object" &&
						part !== null &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string"
							? [(part as { text: string }).text]
							: [],
					)
					.join("");
			}
			return message.role === "user" && content.includes(options.marker) ? [entry.id] : [];
		});
		if (marked.length > 0) {
			break;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	if (marked.length === 0) {
		throw new Error("Mandatory stop handoff was not persisted in the Executor Pi session.");
	}
	await runtime.waitForSettled(timeoutMs);
	if (!(await options.validatePostSettlement(baselineSignalIds))) {
		throw new Error("Mandatory stop handoff did not produce exactly one current blocked Signal.");
	}
	return marked;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type {
	Clock,
	GitLsRemoteExecutor,
	GitLsRemoteRequest,
	MandatoryStopOptions,
	MandatoryStopRuntime,
	OutageCheck,
	OutageKind,
	OutageOptions,
	OutageRecord,
	PollFailure,
	PollOutcome,
	PollScope,
	RefObservation,
	TimerApi,
	UpstreamPollerOptions,
};
export {
	defaultGitLsRemote,
	failExecutionAndCloseInterventions,
	mandatoryStopExecution,
	OUTAGE_RETRY_DELAYS_MS,
	parseLsRemoteOutput,
	revisionDependents,
	SupervisionOutageCoordinator,
	stableOutageId,
	UPSTREAM_POLL_INTERVAL_MS,
	UpstreamRefPoller,
	validatePersistedExecutorSession,
};
