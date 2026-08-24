import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeHostForOrigin, GitWorkspace } from "./adapters.js";
import { SQLiteArchive } from "./archive.js";
import { archivePath, type KhalaConfig, loadConfig } from "./config.js";
import type { GovernedRole, JsonObject, JsonValue, RoleSetting } from "./model.js";
import { PiOracle } from "./oracle.js";
import type { CodeHostPort, ModelCatalogPort, ServicePorts } from "./ports.js";
import { PiRpcRuntime, promptIdentity } from "./runtime.js";
import { ApplicationService, type ServiceOptions } from "./service.js";

export type ApplicationRuntime = Readonly<{
	service: ApplicationService;
	config: KhalaConfig;
	updateRoleSetting: (role: GovernedRole, setting: RoleSetting, value: string) => void;
}>;

export function createApplication(
	projectPath: string,
	trusted: boolean,
	packageRoot: string,
	options?: Readonly<{ requireModels?: boolean }>,
): ApplicationRuntime {
	const childContext = process.env["KHALA_BOUND_WORK_ID"] !== undefined;
	const effectiveProjectPath = childContext ? (process.env["KHALA_PROJECT_PATH"] ?? projectPath) : projectPath;
	const trustedValue = childContext ? process.env["KHALA_PROJECT_TRUSTED"] : undefined;
	const effectiveTrusted = trustedValue === undefined ? trusted : trustedValue === "1";
	const configuredPublicKey = process.env["KHALA_ROLE_PUBLIC_KEY"];
	const authority = configuredPublicKey === undefined ? generateKeyPairSync("ed25519") : undefined;
	const rolePublicKey =
		configuredPublicKey ?? authority?.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
	if (rolePublicKey === undefined) throw new Error("Khala could not establish its role authority.");
	const config = loadConfig(effectiveProjectPath, effectiveTrusted, options?.requireModels ?? true);
	const archive = new SQLiteArchive(archivePath(config, effectiveProjectPath));
	const runtime = new PiRpcRuntime({
		command: config.piCommand,
		extensionPath: join(packageRoot, "src", "index.ts"),
		authorityPrivateKey: authority?.privateKey,
		baseEnvironment: {
			KHALA_PROJECT_PATH: effectiveProjectPath,
			KHALA_PROJECT_TRUSTED: effectiveTrusted ? "1" : "0",
			KHALA_ROLE_PUBLIC_KEY: rolePublicKey,
		},
	});
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
	const models = new ConfiguredModels(config);
	const ports: ServicePorts = {
		workspace: new GitWorkspace(config.worktreeRoot, config.worktreeBranchPrefix, effectiveProjectPath),
		codeHost: new LazyCodeHost(effectiveProjectPath, config.targetBranch),
		runtime,
		models,
		oracle: new PiOracle(runtime, effectiveProjectPath, version, oraclePrompt),
	};
	const serviceOptions: ServiceOptions = {
		projectPath: effectiveProjectPath,
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
		rolePublicKey,
	};
	const service = new ApplicationService(archive, ports, serviceOptions);
	return {
		service,
		config,
		updateRoleSetting: (role, setting, value) => {
			if (setting === "model") models.updateRoleModel(role, value);
			service.updateRoleSetting(role, setting, value);
		},
	};
}

type ModelResolution = Readonly<{ model: string; supportedThinking: readonly string[] }>;

class ConfiguredModels implements ModelCatalogPort {
	private scopedModels: Readonly<Record<GovernedRole, string>>;

	constructor(config: KhalaConfig) {
		this.scopedModels = {
			conclave: config.conclaveModel,
			executor: config.executorModel,
			observer: config.observerModel,
			oracle: config.oracleModel,
		};
	}

	listScoped(role: GovernedRole): readonly string[] {
		const model = this.scopedModels[role];
		return model.length === 0 ? [] : [model];
	}

	updateRoleModel(role: GovernedRole, model: string): void {
		this.scopedModels = { ...this.scopedModels, [role]: model };
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
			execFile(
				"git",
				["remote", "get-url", "origin"],
				{ cwd: this.projectPath, timeout: 120_000, killSignal: "SIGKILL" },
				(error, stdout) => {
					if (error !== null) {
						reject(error);
						return;
					}
					resolve(stdout.trim());
				},
			);
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
