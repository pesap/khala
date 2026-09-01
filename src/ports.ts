import type {
	Execution,
	Mission,
	ProviderObservation,
	ProviderOutcomeObservation,
	ReviewRequest,
	TokenUsage,
	ValidationResult,
	WorkTerms,
} from "./model.js";

export type OperationContext = Readonly<{
	signal?: AbortSignal | undefined;
	onUpdate?: ((message: string) => void) | undefined;
}>;

export type WorkspacePreflight = Readonly<{
	projectPath: string;
	origin: string;
	targetBranch: string;
	headCommit: string;
}>;

export interface WorkspacePort {
	preflight: (projectPath: string, targetBranch: string, operation?: OperationContext) => Promise<WorkspacePreflight>;
	ensureSandbox: (
		input: Readonly<{
			workId: string;
			executionId: string;
			mission: Mission;
			projectPath: string;
			baseCommit: string;
		}>,
		operation?: OperationContext,
	) => Promise<Execution["sandbox"]>;
	inspectHead: (path: string, operation?: OperationContext) => Promise<string>;
	inspectChanges?: (
		input: Readonly<{ path: string; baseCommit: string }>,
		operation?: OperationContext,
	) => Promise<readonly string[]>;
	inspectAddedLines: (
		input: Readonly<{ path: string; baseCommit: string }>,
		operation?: OperationContext,
	) => Promise<number>;
	commitSandbox?: (
		input: Readonly<{ sandbox: Execution["sandbox"]; allowedPaths: readonly string[]; message: string }>,
		operation?: OperationContext,
	) => Promise<string>;
	runValidation?: (
		input: Readonly<{ path: string; commands: readonly string[] }>,
		operation?: OperationContext,
	) => Promise<readonly ValidationResult[]>;
	publishSandbox: (sandbox: Execution["sandbox"], operation?: OperationContext) => Promise<string>;
	removeSandbox: (sandbox: Execution["sandbox"], operation?: OperationContext) => Promise<void>;
}

export type ReviewRequestInput = Readonly<{
	workId: string;
	mission: Mission;
	execution: Execution;
	terms: WorkTerms;
	sandbox: Execution["sandbox"];
	headCommit: string;
	targetBranch: string;
	draftMarker: string;
}>;

export interface CodeHostPort {
	capabilities: (
		operation?: OperationContext,
	) => Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>>;
	identity: (operation?: OperationContext) => Promise<Readonly<{ principalId: string; verified: boolean }>>;
	ensureReviewRequest: (input: ReviewRequestInput, operation?: OperationContext) => Promise<ReviewRequest>;
	poll: (reviewRequest: ReviewRequest, operation?: OperationContext) => Promise<readonly ProviderObservation[]>;
	inspectOutcome: (
		reviewRequest: ReviewRequest,
		operation?: OperationContext,
	) => Promise<ProviderOutcomeObservation | undefined>;
}

export type RuntimeState = "working" | "pending" | "idle" | "unreachable" | "unknown";
export type RuntimeTurn = Readonly<{ output: string; usage?: TokenUsage | undefined }>;

export type RuntimeBinding = Readonly<{
	sessionId: string;
	sessionPath: string;
	promptIdentity?: Readonly<{ packageVersion: string; promptSha256: string }> | undefined;
	processGroupId?: number | undefined;
	processStartTime?: string | undefined;
	capabilityNonce?: string | undefined;
	processMarker?: string | undefined;
}>;

export interface AgentRuntimePort {
	ensureSession: (
		input: Readonly<{
			cwd: string;
			model: string;
			thinking: string;
			role: "conclave" | "observer" | "executor" | "oracle";
			promptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
			agentTimeoutMs?: number | undefined;
			tools: readonly string[];
			allowedPaths?: readonly string[] | undefined;
			sandboxRoot?: string | undefined;
			bindingScope?: Readonly<{
				workId?: string | undefined;
				executionId?: string | undefined;
				nonce?: string | undefined;
			}>;
			sessionPath?: string | undefined;
		}>,
		operation?: OperationContext,
	) => Promise<RuntimeBinding>;
	send: (binding: RuntimeBinding, message: string, operation?: OperationContext) => Promise<RuntimeTurn>;
	getState: (binding: RuntimeBinding, operation?: OperationContext) => Promise<RuntimeState>;
	requestStop: (binding: RuntimeBinding) => Promise<void>;
	close: () => Promise<void>;
}

export interface ModelCatalogPort {
	listScoped: (role: "conclave" | "observer" | "executor" | "oracle") => readonly string[];
	resolve: (model: string) => Readonly<{ model: string; supportedThinking: readonly string[] }>;
}

export type OraclePacket = Readonly<{
	subject: string;
	mission: Mission;
	diff: string;
	validation: readonly string[];
	providerEvidence: readonly string[];
}>;

export type OracleFinding = Readonly<{
	severity: "blocker" | "major" | "minor";
	summary: string;
	evidence: readonly string[];
}>;

export type OracleResult = Readonly<{
	verdict: "pass" | "needs-revision" | "blocked" | "incomplete";
	findings: readonly OracleFinding[];
	validationGaps: readonly string[];
	durationMs: number;
	output: string;
}>;

export interface OraclePort {
	review: (
		packet: OraclePacket,
		model: string,
		thinking: string,
		operation?: OperationContext,
	) => Promise<OracleResult>;
}

export type ServicePorts = Readonly<{
	workspace: WorkspacePort;
	codeHost: CodeHostPort;
	runtime: AgentRuntimePort;
	models: ModelCatalogPort;
	oracle: OraclePort;
}>;
