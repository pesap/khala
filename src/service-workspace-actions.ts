import { nanoid } from "nanoid";
import type { ArchivePort } from "./archive.js";
import type { ActionInput, CommandMeta, Execution, Mission, Signal, WorkView } from "./model.js";
import type { CodeHostPort, OperationContext, ServicePorts, WorkspacePort } from "./ports.js";
import { ArchiveCore } from "./service-archive-core.js";
import type { ServiceOptions } from "./service-contracts.js";
import { readTextList, readyReviewEvidence } from "./service-dispatch-policy.js";
import { publishedReviewMatches, signalExecution, validationResultsPassed } from "./service-foundation-policy.js";
import { isCurrentReadySignal, readSignalKind } from "./service-lifecycle-policy.js";
import { providerEvidenceAllowsReady } from "./service-provider-readiness.js";
import {
	readyReviewRequestMatches,
	reviewRequestIsCurrent,
	signalEffects,
	throwIfOperationAborted,
} from "./service-runtime-policy.js";
import { isAllowedPath, requiredNonBlank, requiredText } from "./service-state-policy.js";

type SourceVerification = Readonly<{ sourceVerified: boolean; sourceFailure?: string | undefined }>;

function validationNextAction(verified: boolean, passed: boolean, attemptFailure?: string): string {
	if (attemptFailure !== undefined) return `${attemptFailure} Inspect the workspace and retry validation.`;
	if (!verified)
		return "Validation source verification failed; restore and commit the intended source before retrying.";
	return passed
		? "Validation passed; create or reconcile the draft review request."
		: "Validation failed; inspect the results and revise the sandbox.";
}

function validationSummary(verified: boolean, passed: boolean, attemptFailure?: string): string {
	if (attemptFailure !== undefined) return attemptFailure;
	if (!verified) return "Validation source correspondence could not be verified.";
	return passed ? "All declared validation commands passed." : "One or more declared validation commands failed.";
}

export class ServiceWorkspaceActions {
	private readonly core: ArchiveCore;
	private readonly archive: ArchivePort;
	private readonly workspace: WorkspacePort;
	private readonly codeHost: CodeHostPort;
	private readonly getOptions: () => ServiceOptions;

	constructor(
		core: ArchiveCore,
		archive: ArchivePort,
		workspace: WorkspacePort,
		codeHost: CodeHostPort,
		getOptions: () => ServiceOptions,
	) {
		this.core = core;
		this.archive = archive;
		this.workspace = workspace;
		this.codeHost = codeHost;
		this.getOptions = getOptions;
	}

	async recordSignal(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireActor(meta, "executor");
		const execution = this.core.requireExecution(work, "running");
		this.requireNoPendingReadySignal(work);
		const kind = readSignalKind(input);
		const summary = requiredNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		if (kind === "ready") await this.validateReadySignal(work, execution, evidence, operation);
		const signal: Signal = {
			signalId: nanoid(),
			executionId: execution.executionId,
			kind,
			summary,
			evidence,
			observedAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: signalExecution(execution, kind),
			lastSignal: signal,
			nextAction: "Conclave assessment is pending.",
		};
		return this.core.append({
			meta,
			kind: "signal",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: signal,
			projection: next,
			summary: `${kind} Signal from Executor.`,
			evidenceRefs: evidence,
			effects: signalEffects(work.workId, next.revision, kind),
		}).projection;
	}

	async commitSandbox(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "executor");
		const execution = this.core.requireExecution(work, "running");
		const commitSandbox = this.workspace.commitSandbox?.bind(this.workspace);
		if (commitSandbox === undefined)
			throw this.core.error(
				"external-failure",
				"The configured workspace cannot commit sandbox changes.",
				false,
				"Use a workspace adapter that supports governed sandbox commits.",
			);
		await this.ensureAllowedPaths(work, execution, operation);
		const headCommit = await commitSandbox(
			{
				sandbox: execution.sandbox,
				allowedPaths: work.terms.allowedPaths,
				message: `Khala: ${work.terms.title}`,
			},
			operation,
		);
		throwIfOperationAborted(operation);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastValidation: undefined,
			nextAction: `Sandbox committed at ${headCommit}; run validation before handoff.`,
		};
		return this.core.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: execution,
			projection: next,
			summary: `Sandbox changes committed at ${headCommit}.`,
		}).projection;
	}

	async runValidation(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "executor");
		const execution = this.core.requireExecution(work, "running");
		const runValidation = this.requireValidationRunner();
		await this.ensureAllowedPaths(work, execution, operation);
		const headCommit = await this.workspace.inspectHead(execution.sandbox.path, operation);
		const before = await this.verifySourceForValidation(execution, headCommit, operation);
		if (!before.sourceVerified) return this.recordValidation(work, meta, execution, headCommit, [], before);
		let results: NonNullable<WorkView["lastValidation"]>["results"];
		try {
			results = await runValidation({ path: execution.sandbox.path, commands: work.terms.validation }, operation);
		} catch (error) {
			throwIfOperationAborted(operation);
			const afterFailure = await this.verifySourceForValidation(execution, headCommit, operation);
			const message = `Validation runner failed: ${error instanceof Error ? error.message : String(error)}`.slice(
				0,
				2_000,
			);
			return this.recordValidation(work, meta, execution, headCommit, [], afterFailure, message);
		}
		throwIfOperationAborted(operation);
		const after = await this.verifySourceForValidation(execution, headCommit, operation);
		return this.recordValidation(work, meta, execution, headCommit, results, after);
	}

	private recordValidation(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		headCommit: string,
		results: NonNullable<WorkView["lastValidation"]>["results"],
		verification: SourceVerification,
		attemptFailure?: string,
	): WorkView {
		const validation = { executionId: execution.executionId, headCommit, results, ...verification };
		const passed =
			attemptFailure === undefined &&
			verification.sourceVerified &&
			validationResultsPassed(results, work.terms.validation);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastValidation: validation,
			nextAction: validationNextAction(verification.sourceVerified, passed, attemptFailure),
		};
		return this.core.append({
			meta,
			kind: "validation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: validation,
			projection: next,
			evidenceRefs: results.map((result) => result.command),
			summary: validationSummary(verification.sourceVerified, passed, attemptFailure),
		}).projection;
	}

	async createReviewRequest(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "executor");
		const execution = this.core.requireExecution(work, "running");
		await this.ensureAllowedPaths(work, execution, operation);
		const mission = this.requireReviewMission(work);
		await this.requireDraftReviewSupport(operation);
		const headCommit = await this.reviewHead(execution, operation);
		throwIfOperationAborted(operation);
		if (reviewRequestIsCurrent(work.reviewRequest, execution, headCommit, this.getOptions().targetBranch)) return work;
		this.requireReviewCommit(headCommit, execution);
		const request = await this.publishReview(work, mission, execution, headCommit, operation);
		throwIfOperationAborted(operation);
		return this.recordPublishedReview(work, meta, execution, request, headCommit);
	}

	private async validateReadySignal(
		work: WorkView,
		execution: Execution,
		evidence: readonly string[],
		operation?: OperationContext,
	): Promise<void> {
		this.requireReadySignalEvidence(evidence);
		await this.ensureAllowedPaths(work, execution, operation);
		const request = this.requireReadyReviewRequest(work, execution);
		const head = await this.workspace.inspectHead(execution.sandbox.path, operation);
		throwIfOperationAborted(operation);
		this.requireVerifiedSource(await this.verifySource(execution, head, operation));
		if (
			!readyReviewEvidence(
				work,
				execution,
				request,
				head,
				providerEvidenceAllowsReady(this.archive, work, request),
				this.workspace.runValidation,
			)
		)
			throw this.core.error(
				"invalid-state",
				"The review request does not contain current head, diff, and validation evidence.",
				false,
				"Reconcile the review request and rerun validation.",
			);
	}

	async validateHandoffSource(work: WorkView, execution: Execution, operation?: OperationContext): Promise<void> {
		this.requireValidationRunner();
		const request = this.requireReadyReviewRequest(work, execution);
		const head = await this.workspace.inspectHead(execution.sandbox.path, operation);
		throwIfOperationAborted(operation);
		if (head !== request.headCommit)
			throw this.sourceVerificationError("The sandbox HEAD changed after the ready Signal was recorded.");
		this.requireVerifiedSource(await this.verifySource(execution, head, operation));
	}

	private async verifySource(
		execution: Execution,
		headCommit: string,
		operation?: OperationContext,
	): Promise<SourceVerification> {
		const inspectChanges = this.requireChangeInspector();
		const changes = await inspectChanges({ path: execution.sandbox.path, baseCommit: headCommit }, operation);
		throwIfOperationAborted(operation);
		const currentHead = await this.workspace.inspectHead(execution.sandbox.path, operation);
		throwIfOperationAborted(operation);
		if (currentHead !== headCommit)
			return { sourceVerified: false, sourceFailure: "Sandbox HEAD differs from the validated commit." };
		if (changes.length === 0) return { sourceVerified: true };
		return {
			sourceVerified: false,
			sourceFailure: `Sandbox source differs from the validated commit: ${changes.slice(0, 5).join(", ")}.`.slice(
				0,
				2_000,
			),
		};
	}

	private async verifySourceForValidation(
		execution: Execution,
		headCommit: string,
		operation?: OperationContext,
	): Promise<SourceVerification> {
		try {
			return await this.verifySource(execution, headCommit, operation);
		} catch (error) {
			throwIfOperationAborted(operation);
			return {
				sourceVerified: false,
				sourceFailure: `Source verification failed: ${error instanceof Error ? error.message : String(error)}`.slice(
					0,
					2_000,
				),
			};
		}
	}

	private requireVerifiedSource(verification: SourceVerification): void {
		if (verification.sourceVerified) return;
		throw this.sourceVerificationError(verification.sourceFailure ?? "The sandbox source is not clean.");
	}

	private sourceVerificationError(summary: string) {
		return this.core.error(
			"invalid-state",
			summary,
			false,
			"Restore and commit the intended source, then rerun validation before handoff.",
		);
	}

	private requireNoPendingReadySignal(work: WorkView): void {
		if (!isCurrentReadySignal(work)) return;
		throw this.core.error(
			"invalid-state",
			"A ready Signal is awaiting a Conclave Verdict.",
			false,
			"Wait for the Conclave to record a Verdict before sending another Signal.",
		);
	}

	private requireReadySignalEvidence(evidence: readonly string[]): void {
		if (evidence.length > 0) return;
		throw this.core.error(
			"invalid-input",
			"A ready Signal must include validation evidence.",
			false,
			"Include the validation commands and results in the Signal evidence.",
		);
	}

	private requireReadyReviewRequest(work: WorkView, execution: Execution): NonNullable<WorkView["reviewRequest"]> {
		const request = work.reviewRequest;
		if (request !== undefined && readyReviewRequestMatches(request, execution, this.getOptions().targetBranch))
			return request;
		throw this.core.error(
			"invalid-state",
			"A ready Signal requires a review request for the current sandbox branch.",
			false,
			"Publish the current sandbox and create its draft review request.",
		);
	}

	private async ensureAllowedPaths(work: WorkView, execution: Execution, operation?: OperationContext): Promise<void> {
		const inspectChanges = this.requireChangeInspector();
		const changedPaths = await inspectChanges(
			{ path: execution.sandbox.path, baseCommit: execution.sandbox.baseCommit },
			operation,
		);
		const unauthorized = changedPaths.filter((path) => !isAllowedPath(path, work.terms.allowedPaths));
		if (unauthorized.length > 0)
			throw this.core.error(
				"invalid-state",
				`The sandbox contains changes outside the permitted paths: ${unauthorized.slice(0, 5).join(", ")}.`,
				false,
				"Revert changes outside the Mission paths before publishing or sending ready evidence.",
			);
	}

	private requireValidationRunner(): NonNullable<ServicePorts["workspace"]["runValidation"]> {
		if (this.workspace.runValidation !== undefined) return this.workspace.runValidation.bind(this.workspace);
		throw this.core.error(
			"external-failure",
			"The configured workspace cannot run validation commands.",
			false,
			"Use a workspace adapter that supports governed validation.",
		);
	}

	private requireChangeInspector(): NonNullable<ServicePorts["workspace"]["inspectChanges"]> {
		if (this.workspace.inspectChanges !== undefined) return this.workspace.inspectChanges.bind(this.workspace);
		throw this.core.error(
			"external-failure",
			"The configured workspace cannot verify source correspondence.",
			false,
			"Use a workspace adapter that can inspect tracked and untracked changes.",
		);
	}

	private requireReviewMission(work: WorkView): Mission {
		if (work.mission !== undefined) return work.mission;
		throw this.core.error(
			"invalid-state",
			"A Mission is required before review publication.",
			false,
			"Ask the Conclave to admit Work.",
		);
	}

	private async requireDraftReviewSupport(operation?: OperationContext): Promise<void> {
		const capabilities = await this.codeHost.capabilities(operation);
		if (capabilities.supportsDraft) return;
		throw this.core.error(
			"external-failure",
			"The configured provider does not support draft review requests.",
			false,
			"Use a GitHub or GitLab provider with draft review support.",
		);
	}

	private async reviewHead(execution: Execution, operation?: OperationContext): Promise<string> {
		const options = this.getOptions();
		const preflight = await this.workspace.preflight(options.projectPath, options.targetBranch, operation);
		if (preflight.headCommit !== execution.sandbox.baseCommit)
			throw this.core.error(
				"invalid-state",
				"The target branch changed since this Execution started.",
				false,
				"Rebase or replace the Execution before publishing its review request.",
			);
		return this.workspace.inspectHead(execution.sandbox.path, operation);
	}

	private requireReviewCommit(headCommit: string, execution: Execution): void {
		if (headCommit !== execution.sandbox.baseCommit) return;
		throw this.core.error(
			"invalid-state",
			"The sandbox has no commit beyond its base.",
			false,
			"Implement and commit the Mission changes before publishing.",
		);
	}

	private async publishReview(
		work: WorkView,
		mission: Mission,
		execution: Execution,
		headCommit: string,
		operation?: OperationContext,
	): Promise<NonNullable<WorkView["reviewRequest"]>> {
		const publishedHead = await this.workspace.publishSandbox(execution.sandbox, operation);
		if (publishedHead !== headCommit)
			throw this.core.error(
				"external-failure",
				"The published sandbox head changed unexpectedly.",
				true,
				"Reconcile the sandbox and review provider.",
			);
		return this.codeHost.ensureReviewRequest(
			{
				workId: work.workId,
				mission,
				execution,
				terms: work.terms,
				sandbox: execution.sandbox,
				headCommit,
				targetBranch: this.getOptions().targetBranch,
				draftMarker: `Khala-Work: ${work.workId}`,
			},
			operation,
		);
	}

	private recordPublishedReview(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		request: NonNullable<WorkView["reviewRequest"]>,
		headCommit: string,
	): WorkView {
		if (!publishedReviewMatches(request, execution, this.getOptions().targetBranch, headCommit))
			throw this.core.error(
				"integrity-failure",
				"The provider review request does not match the published sandbox.",
				false,
				"Reconcile the provider request before sending a ready Signal.",
			);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			reviewRequest: request,
			nextAction: "Executor may send a ready Signal.",
		};
		return this.core.append({
			meta,
			kind: "review-request",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: request,
			projection: next,
			summary: `Draft ${request.provider} review request ${request.providerId} is ready.`,
		}).projection;
	}
}
