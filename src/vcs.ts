import type { Sandbox, SandboxRequest } from "./executor.js";

// biome-ignore lint/style/useNamingConvention: VCSProvider is the user-facing domain term.
abstract class VCSProvider {
	abstract createSandbox(request: SandboxRequest): Promise<Sandbox>;
	abstract removeSandbox(sandbox: Sandbox): Promise<void>;
	protected abstract generateSandboxName(name: string): string;
}

export { VCSProvider };
