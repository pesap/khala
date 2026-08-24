import type { Execution, Mission, ProviderObservation, ReviewRequest, TokenUsage, WorkTerms } from "./model.js";

export type WorkspacePreflight = Readonly<{
	projectPath: string;
	origin: string;
	targetBranch: string;
	headCommit: string;
}>;

export interface WorkspacePort {
	preflight: (projectPath: string, targetBranch: string) => Promise<WorkspacePreflight>;
	ensureSandbox: (
		input: Readonly<{
			workId: string;
			executionId: string;
			mission: Mission;
			projectPath: string;
			baseCommit: string;
		}>,
	) => Promise<Execution["sandbox"]>;
	inspectHead: (path: string) => Promise<string>;
	publishSandbox: (sandbox: Execution["sandbox"]) => Promise<string>;
	removeSandbox: (sandbox: Execution["sandbox"]) => Promise<void>;
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
	capabilities: () => Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>>;
	identity: () => Promise<Readonly<{ principalId: string; verified: boolean }>>;
	ensureReviewRequest: (input: ReviewRequestInput) => Promise<ReviewRequest>;
	poll: (reviewRequest: ReviewRequest) => Promise<readonly ProviderObservation[]>;
	inspectOutcome: (reviewRequest: ReviewRequest) => Promise<ProviderObservation | undefined>;
}

export type RuntimeState = "working" | "pending" | "idle" | "unreachable" | "unknown";
export type RuntimeTurn = Readonly<{ output: string; usage?: TokenUsage | undefined }>;

export type RuntimeBinding = Readonly<{
	sessionId: string;
	sessionPath: string;
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
			tools: readonly string[];
			bindingScope?: Readonly<{
				workId?: string | undefined;
				executionId?: string | undefined;
				nonce?: string | undefined;
			}>;
			sessionPath?: string | undefined;
		}>,
	) => Promise<RuntimeBinding>;
	send: (binding: RuntimeBinding, message: string) => Promise<RuntimeTurn>;
	getState: (binding: RuntimeBinding) => Promise<RuntimeState>;
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
	review: (packet: OraclePacket, model: string, thinking: string) => Promise<OracleResult>;
}

export type ServicePorts = Readonly<{
	workspace: WorkspacePort;
	codeHost: CodeHostPort;
	runtime: AgentRuntimePort;
	models: ModelCatalogPort;
	oracle: OraclePort;
}>;
