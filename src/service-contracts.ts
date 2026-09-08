import { type ErrorEnvelope, type ServiceResult, type TokenUsage } from "./model.js";

export type ServiceOptions = Readonly<{
	projectPath: string;
	targetBranch: string;
	maxConcurrentExecutions: number;
	maxConcurrentRuns?: number | undefined;
	maxCorrections?: number | undefined;
	defaultWorkTokens: number;
	conclaveModel: string;
	conclaveThinking: string;
	executorModel: string;
	executorThinking: string;
	oracleModel: string;
	oracleThinking: string;
	observerModel: string;
	observerThinking: string;
	conclavePromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	executorPromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	observerPromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	oraclePromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	rolePublicKey: string;
	supervision: "candidate" | "client";
	autonomousMonitor?: boolean | undefined;
	shutdownGraceMs?: number | undefined;
}>;

export class ActionInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionInputError";
	}
}

export class RunGateUnavailable extends Error {
	constructor() {
		super("The shared model-run gate is full.");
		this.name = "RunGateUnavailable";
	}
}

export class ConclaveTokenExhaustedError extends Error {
	constructor(usage: TokenUsage, allowance: number) {
		super(
			`The Conclave token allowance was exhausted at ${usage.inputTokens + usage.outputTokens}/${allowance} tokens before a durable decision was recorded.`,
		);
		this.name = "ConclaveTokenExhaustedError";
	}
}

export class ApplicationError extends Error {
	readonly envelope: ErrorEnvelope;

	constructor(envelope: ErrorEnvelope) {
		super(envelope.summary);
		this.name = "ApplicationError";
		this.envelope = envelope;
	}
}

export function resultText<T>(result: ServiceResult<T>): string {
	return "error" in result ? `${result.error.code}: ${result.error.summary}` : "The command was applied.";
}
