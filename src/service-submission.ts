import { type ArchivePort, CommandReuseConflict } from "./archive.js";
import type { CommandMeta, SubmitWorkInput, WorkTerms, WorkView } from "./model.js";
import { ArchiveCore } from "./service-archive-core.js";
import type { ServiceOptions } from "./service-contracts.js";
import { normalizeTerms } from "./service-dispatch-policy.js";
import { submissionWorkId } from "./service-foundation-policy.js";
import { rawMissionSpecificity } from "./service-lifecycle-policy.js";
import { actionFingerprint, submissionDispatchLimits } from "./service-runtime-policy.js";

export class ServiceSubmission {
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly getOptions: () => ServiceOptions;

	constructor(archive: ArchivePort, core: ArchiveCore, getOptions: () => ServiceOptions) {
		this.archive = archive;
		this.core = core;
		this.getOptions = getOptions;
	}

	submit(input: SubmitWorkInput, meta: CommandMeta): WorkView {
		this.core.requireActor(meta, "user");
		const fingerprint = actionFingerprint("submit-work", input);
		const prior = this.readPrior(meta, fingerprint);
		if (prior !== undefined) return this.validatePrior(prior, meta);
		const workId = submissionWorkId(input);
		this.assertNew(workId, meta);
		const terms = this.terms(input);
		const projection: WorkView = {
			workId,
			revision: 1,
			state: "submitted",
			terms,
			budget: { maxTokens: terms.maxTokens, reservedTokens: 0, consumedTokens: 0 },
			missionSpecificity: rawMissionSpecificity(input),
			nextAction: "Conclave admission is pending.",
			queuedSequence: 0,
			dispatchLimits: submissionDispatchLimits(this.getOptions()),
		};
		return this.core.append({
			meta: { ...meta, commandFingerprint: fingerprint },
			kind: "submission",
			workId,
			payload: terms,
			projection,
			summary: `Work submitted: ${terms.title}`,
			effects: [
				{ effectId: `conclave-wake:${workId}`, kind: "conclave-wake", payload: { workId, reason: "admission" } },
			],
		}).projection;
	}

	private readPrior(meta: CommandMeta, fingerprint: string): ReturnType<ArchivePort["findCommand"]> {
		try {
			return this.archive.findCommand(meta.commandId, fingerprint);
		} catch (error) {
			if (error instanceof CommandReuseConflict)
				throw this.core.error(
					"invalid-input",
					error.message,
					false,
					"Use a new command ID for a different Work submission.",
				);
			throw error;
		}
	}

	private validatePrior(prior: NonNullable<ReturnType<ArchivePort["findCommand"]>>, meta: CommandMeta): WorkView {
		if (prior.record.actor !== "user")
			throw this.core.error(
				"forbidden",
				`Command ${meta.commandId} belongs to a different actor.`,
				false,
				"Use a new command ID for this User submission.",
			);
		return prior.projection;
	}

	private assertNew(workId: string, meta: CommandMeta): void {
		if (this.archive.project(workId) !== undefined)
			throw this.core.error("invalid-input", `Work ID ${workId} is already in use.`, false, "Choose a new Work ID.");
		if (meta.expectedWorkRevision !== 0)
			throw this.core.error(
				"revision-conflict",
				"A new Work must use revision zero.",
				false,
				"Retry with expected_work_revision 0.",
			);
	}

	private terms(input: SubmitWorkInput): WorkTerms {
		try {
			return normalizeTerms(input, this.getOptions().defaultWorkTokens);
		} catch (error) {
			throw this.core.error(
				"invalid-input",
				error instanceof Error ? error.message : "Work terms are invalid.",
				false,
				"Provide nonblank Work terms and a positive token budget.",
			);
		}
	}
}
