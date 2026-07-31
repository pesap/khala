import type { Sandbox, SandboxRequest } from "./executor.js";

type ReviewWorkflowRequest = Readonly<{
	sandbox: Sandbox;
	name: string;
	workId: string;
	executionId: string;
	mission: string;
	publish: boolean;
	targetBranch?: string;
	supersedesPullRequestUrl?: string;
	commitConvention?: string;
}>;

type ReviewPreparation = Readonly<{
	sourceBranch: string;
	targetBranch: string;
	planningCommit: string;
	url?: string;
	number?: number;
}>;

type ReviewFinalization = Readonly<{
	headCommit: string;
	url?: string;
	number?: number;
}>;

// biome-ignore lint/style/useNamingConvention: VCSProvider is the user-facing domain term.
abstract class VCSProvider {
	abstract createSandbox(request: SandboxRequest): Promise<Sandbox>;
	abstract removeSandbox(sandbox: Sandbox): Promise<void>;
	abstract prepareReview(request: ReviewWorkflowRequest): Promise<ReviewPreparation | undefined>;
	abstract finalizeReview(request: ReviewWorkflowRequest, url?: string): Promise<ReviewFinalization | undefined>;
	abstract supersedePullRequest(previousUrl: string, successorUrl: string): Promise<void>;
	protected abstract generateSandboxName(name: string): string;
}

export type { ReviewFinalization, ReviewPreparation, ReviewWorkflowRequest };
export { VCSProvider };
