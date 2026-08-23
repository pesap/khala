import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeHostForOrigin, GitWorkspace } from "./adapters.js";
import { SQLiteArchive } from "./archive.js";
import { archivePath, type KhalaConfig, loadConfig } from "./config.js";
import type { JsonObject, JsonValue } from "./model.js";
import { PiOracle } from "./oracle.js";
import type { CodeHostPort, ModelCatalogPort, ServicePorts } from "./ports.js";
import { PiRpcRuntime, promptIdentity } from "./runtime.js";
import { ApplicationService, type ServiceOptions } from "./service.js";

export type ApplicationRuntime = Readonly<{
	service: ApplicationService;
	config: KhalaConfig;
}>;

export function createApplication(
	projectPath: string,
	trusted: boolean,
	packageRoot: string,
	options?: Readonly<{ requireModels?: boolean }>,
): ApplicationRuntime {
	const config = loadConfig(projectPath, trusted, options?.requireModels ?? true);
	const archive = new SQLiteArchive(archivePath(config, projectPath));
	const runtime = new PiRpcRuntime({ command: config.piCommand, extensionPath: join(packageRoot, "src", "index.ts") });
	const version = packageVersion(packageRoot);
	const conclavePromptIdentity = promptIdentity(
		readFileSync(join(packageRoot, "system-prompts", "conclave.md"), "utf8"),
		version,
	);
	const executorPromptIdentity = promptIdentity(
		readFileSync(join(packageRoot, "system-prompts", "executor.md"), "utf8"),
		version,
	);
	const observerPromptIdentity = promptIdentity(
		readFileSync(join(packageRoot, "system-prompts", "observer.md"), "utf8"),
		version,
	);
	const oraclePrompt = readFileSync(join(packageRoot, "system-prompts", "oracle.md"), "utf8");
	const ports: ServicePorts = {
		workspace: new GitWorkspace(config.worktreeRoot, config.worktreeBranchPrefix),
		codeHost: new LazyCodeHost(projectPath, config.targetBranch),
		runtime,
		models: new ConfiguredModels(config),
		oracle: new PiOracle(runtime, projectPath, version, oraclePrompt),
	};
	const serviceOptions: ServiceOptions = {
		projectPath,
		targetBranch: config.targetBranch,
		maxConcurrentExecutions: config.maxConcurrentExecutions,
		defaultWorkTokens: config.defaultWorkTokens,
		conclaveModel: config.conclaveModel,
		conclaveThinking: config.conclaveThinking,
		executorModel: config.executorModel,
		executorThinking: config.executorThinking,
		oracleModel: config.oracleModel,
		oracleThinking: config.oracleThinking,
		observerModel: config.observerModel,
		observerThinking: config.observerThinking,
		conclavePromptIdentity,
		executorPromptIdentity,
		observerPromptIdentity,
	};
	return { service: new ApplicationService(archive, ports, serviceOptions), config };
}

type ModelResolution = Readonly<{ model: string; supportedThinking: readonly string[] }>;

class ConfiguredModels implements ModelCatalogPort {
	private readonly config: KhalaConfig;

	constructor(config: KhalaConfig) {
		this.config = config;
	}

	listScoped(role: "conclave" | "observer" | "executor" | "oracle"): readonly string[] {
		let model = this.config.observerModel;
		if (role === "conclave") {
			model = this.config.conclaveModel;
		} else if (role === "executor") {
			model = this.config.executorModel;
		} else if (role === "oracle") {
			model = this.config.oracleModel;
		}
		if (model.length === 0) {
			return [];
		}
		return [model];
	}

	resolve(model: string): ModelResolution {
		if (model.trim().length === 0) {
			throw new Error("A model is required.");
		}
		return { model, supportedThinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] };
	}
}

class LazyCodeHost implements CodeHostPort {
	private adapter: CodeHostPort | undefined;
	private readonly projectPath: string;
	private readonly targetBranch: string;

	constructor(projectPath: string, targetBranch: string) {
		this.projectPath = projectPath;
		this.targetBranch = targetBranch;
	}

	async capabilities(): Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>> {
		return (await this.get()).capabilities();
	}

	async identity(): Promise<Readonly<{ principalId: string; verified: boolean }>> {
		return (await this.get()).identity();
	}

	async ensureReviewRequest(input: Parameters<CodeHostPort["ensureReviewRequest"]>[0]) {
		return (await this.get()).ensureReviewRequest({ ...input, targetBranch: this.targetBranch });
	}

	async poll(reviewRequest: Parameters<CodeHostPort["poll"]>[0]) {
		return (await this.get()).poll(reviewRequest);
	}

	async inspectOutcome(reviewRequest: Parameters<CodeHostPort["inspectOutcome"]>[0]) {
		return (await this.get()).inspectOutcome(reviewRequest);
	}

	private async get(): Promise<CodeHostPort> {
		if (this.adapter !== undefined) {
			return this.adapter;
		}
		const origin = await new Promise<string>((resolve, reject) => {
			execFile("git", ["remote", "get-url", "origin"], { cwd: this.projectPath }, (error, stdout) => {
				if (error !== null) {
					reject(error);
					return;
				}
				resolve(stdout.trim());
			});
		});
		this.adapter = codeHostForOrigin(origin, this.projectPath);
		return this.adapter;
	}
}

function packageVersion(packageRoot: string): string {
	const packageJson: JsonValue = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (!isJsonObject(packageJson)) {
		throw new Error("Package metadata is invalid.");
	}
	const version = packageJson["version"];
	if (version === undefined || version !== String(version)) {
		throw new Error("Package version is missing.");
	}
	return String(version);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}
