import { execFile } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { codeHostForOrigin, GitWorkspace } from "./adapters.js";
import { SQLiteArchive } from "./archive.js";
import { archivePath, type KhalaConfig, loadConfig } from "./config.js";
import type { GovernedRole, JsonObject, JsonValue, RoleSetting } from "./model.js";
import { PiOracle } from "./oracle.js";
import type { CodeHostPort, ModelCatalogPort, ServicePorts } from "./ports.js";
import { PiRpcRuntime, promptIdentity } from "./runtime.js";
import { ApplicationService, type ServiceOptions } from "./service.js";

export type ApplicationModelRegistry = Readonly<{
	find: (provider: string, modelId: string) => Model<Api> | undefined;
}>;

export type ApplicationRuntime = Readonly<{
	service: ApplicationService;
	config: KhalaConfig;
	updateRoleSetting: (role: GovernedRole, setting: RoleSetting, value: string) => void;
}>;

export function createApplication(
	projectPath: string,
	trusted: boolean,
	packageRoot: string,
	options?: Readonly<{
		requireModels?: boolean;
		modelRegistry?: ApplicationModelRegistry;
	}>,
): ApplicationRuntime {
	const context = applicationContext(projectPath, trusted);
	const config = loadConfig(context.projectPath, context.trusted, options?.requireModels ?? true);
	const archive = new SQLiteArchive(archivePath(config, context.projectPath));
	const runtime = createRuntime(config, packageRoot, context, context.authorityPrivateKey);
	const version = packageVersion(packageRoot);
	const prompts = readPromptIdentities(packageRoot, version);
	const models = new ConfiguredModels(config, options?.modelRegistry);
	const ports = createPorts(config, context.projectPath, runtime, models, prompts.oracle);
	const service = new ApplicationService(archive, ports, createServiceOptions(config, context, prompts));
	return createApplicationRuntime(service, config, models);
}

type ApplicationContext = Readonly<{
	projectPath: string;
	trusted: boolean;
	child: boolean;
	rolePublicKey: string;
	authorityPrivateKey: KeyObject | undefined;
}>;
function applicationContext(projectPath: string, trusted: boolean): ApplicationContext {
	return process.env["KHALA_BOUND_WORK_ID"] === undefined
		? parentApplicationContext(projectPath, trusted)
		: childApplicationContext(projectPath, trusted);
}

function parentApplicationContext(projectPath: string, trusted: boolean): ApplicationContext {
	const authority = generateKeyPairSync("ed25519");
	return {
		projectPath,
		trusted,
		child: false,
		rolePublicKey: exportPublicKey(authority),
		authorityPrivateKey: authority.privateKey,
	};
}

function childApplicationContext(projectPath: string, trusted: boolean): ApplicationContext {
	const configuredPublicKey = process.env["KHALA_ROLE_PUBLIC_KEY"];
	const authority = childAuthority(configuredPublicKey);
	return {
		projectPath: process.env["KHALA_PROJECT_PATH"] ?? projectPath,
		trusted: childTrust(trusted),
		child: true,
		rolePublicKey: configuredPublicKey ?? exportPublicKey(authority),
		authorityPrivateKey: authority?.privateKey,
	};
}

function childAuthority(
	configuredPublicKey: string | undefined,
): { privateKey: KeyObject; publicKey: KeyObject } | undefined {
	return configuredPublicKey === undefined ? generateKeyPairSync("ed25519") : undefined;
}

function childTrust(fallback: boolean): boolean {
	const trustedValue = process.env["KHALA_PROJECT_TRUSTED"];
	return trustedValue === undefined ? fallback : trustedValue === "1";
}

function exportPublicKey(authority: Readonly<{ publicKey: KeyObject }> | undefined): string {
	const publicKey = authority?.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
	if (publicKey === undefined) throw new Error("Khala could not establish its role authority.");
	return publicKey;
}

function createRuntime(
	config: KhalaConfig,
	packageRoot: string,
	context: ApplicationContext,
	authorityPrivateKey: KeyObject | undefined,
): PiRpcRuntime {
	return new PiRpcRuntime({
		command: config.piCommand,
		extensionPath: join(packageRoot, "src", "index.ts"),
		authorityPrivateKey,
		baseEnvironment: {
			KHALA_PROJECT_PATH: context.projectPath,
			KHALA_PROJECT_TRUSTED: context.trusted ? "1" : "0",
			KHALA_ROLE_PUBLIC_KEY: context.rolePublicKey,
		},
	});
}

type PromptIdentities = Readonly<{
	conclave: ReturnType<typeof promptIdentity>;
	executor: ReturnType<typeof promptIdentity>;
	observer: ReturnType<typeof promptIdentity>;
	oracle: ReturnType<typeof promptIdentity>;
}>;

function readPromptIdentities(packageRoot: string, version: string): PromptIdentities {
	const readPrompt = (role: "conclave" | "executor" | "observer") =>
		promptIdentity(readFileSync(join(packageRoot, "system-prompts", `${role}.md`), "utf8"), version);
	return {
		conclave: readPrompt("conclave"),
		executor: readPrompt("executor"),
		observer: readPrompt("observer"),
		oracle: promptIdentity(readFileSync(join(packageRoot, "system-prompts", "oracle.md"), "utf8"), version),
	};
}

function createPorts(
	config: KhalaConfig,
	projectPath: string,
	runtime: PiRpcRuntime,
	models: ConfiguredModels,
	oraclePrompt: Readonly<{ packageVersion: string; promptSha256: string }>,
): ServicePorts {
	return {
		workspace: new GitWorkspace(config.worktreeRoot, config.worktreeBranchPrefix, projectPath),
		codeHost: new LazyCodeHost(projectPath, config.targetBranch),
		runtime,
		models,
		oracle: new PiOracle(runtime, projectPath, oraclePrompt),
	};
}

function createServiceOptions(
	config: KhalaConfig,
	context: ApplicationContext,
	prompts: PromptIdentities,
): ServiceOptions {
	return {
		projectPath: context.projectPath,
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
		conclavePromptIdentity: prompts.conclave,
		executorPromptIdentity: prompts.executor,
		observerPromptIdentity: prompts.observer,
		oraclePromptIdentity: prompts.oracle,
		rolePublicKey: context.rolePublicKey,
		autonomousMonitor: !context.child,
	};
}

function createApplicationRuntime(
	service: ApplicationService,
	config: KhalaConfig,
	models: ConfiguredModels,
): ApplicationRuntime {
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
type ModelReference = Readonly<{ provider: string; modelId: string }>;

function parseModelReference(model: string): ModelReference | undefined {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) return undefined;
	return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

function resolveModelMetadata(
	registry: ApplicationModelRegistry | undefined,
	reference: ModelReference,
	model: string,
): Model<Api> {
	if (registry === undefined) throw new Error("Pi model metadata is unavailable.");
	const metadata = registry.find(reference.provider, reference.modelId);
	if (metadata === undefined) throw new Error(`Model ${model} is not available in Pi.`);
	return metadata;
}

class ConfiguredModels implements ModelCatalogPort {
	private scopedModels: Readonly<Record<GovernedRole, string>>;
	private readonly modelRegistry: ApplicationModelRegistry | undefined;

	constructor(config: KhalaConfig, modelRegistry?: ApplicationModelRegistry) {
		this.modelRegistry = modelRegistry;
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
		if (model.trim().length === 0) throw new Error("A model is required.");
		const reference = parseModelReference(model);
		if (reference === undefined) throw new Error(`Model ${model} is not a valid provider/model reference.`);
		const metadata = resolveModelMetadata(this.modelRegistry, reference, model);
		return { model, supportedThinking: getSupportedThinkingLevels(metadata) };
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

	async capabilities(
		operation?: Parameters<CodeHostPort["capabilities"]>[0],
	): Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>> {
		return (await this.get(operation)).capabilities(operation);
	}

	async identity(
		operation?: Parameters<CodeHostPort["identity"]>[0],
	): Promise<Readonly<{ principalId: string; verified: boolean }>> {
		return (await this.get(operation)).identity(operation);
	}

	async ensureReviewRequest(
		input: Parameters<CodeHostPort["ensureReviewRequest"]>[0],
		operation?: Parameters<CodeHostPort["ensureReviewRequest"]>[1],
	) {
		return (await this.get(operation)).ensureReviewRequest({ ...input, targetBranch: this.targetBranch }, operation);
	}

	async poll(reviewRequest: Parameters<CodeHostPort["poll"]>[0], operation?: Parameters<CodeHostPort["poll"]>[1]) {
		return (await this.get(operation)).poll(reviewRequest, operation);
	}

	async inspectOutcome(
		reviewRequest: Parameters<CodeHostPort["inspectOutcome"]>[0],
		operation?: Parameters<CodeHostPort["inspectOutcome"]>[1],
	) {
		return (await this.get(operation)).inspectOutcome(reviewRequest, operation);
	}

	private async get(operation?: Parameters<CodeHostPort["capabilities"]>[0]): Promise<CodeHostPort> {
		if (this.adapter !== undefined) {
			return this.adapter;
		}
		const origin = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["remote", "get-url", "origin"],
				{ cwd: this.projectPath, timeout: 120_000, killSignal: "SIGKILL", signal: operation?.signal },
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
