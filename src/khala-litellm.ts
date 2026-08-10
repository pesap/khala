/* biome-ignore-all lint/suspicious/noConsole: This file is the standalone CLI output surface. */
/* biome-ignore-all lint/style/noExcessiveLinesPerFile: The LiteLLM provider wizard is shipped as one CLI module. */
/* biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: The interactive wizard keeps its transaction together. */
/* biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Each setup mode branches on explicit, named flags. */
/* biome-ignore-all lint/style/noProcessEnv: Process env is read to resolve LiteLLM keys and detect a TTY. */
/* biome-ignore-all lint/complexity/useLiteralKeys: Untrusted dynamic JSON records use explicit index keys. */
/* biome-ignore-all lint/style/noTernary: Setup projections keep default labels concise. */
/* biome-ignore-all lint/style/noContinue: The command parser and discovery scans use early iteration exits. */
/* biome-ignore-all lint/suspicious/useAwait: Several planning functions return another prompt's promise directly to keep one async signature across the wizard. */
/* biome-ignore-all lint/complexity/noUselessReturn: TypeScript's noImplicitReturns requires an explicit return on every code path, including bare early exits. */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { confirm, isCancel, multiselect, password, select, text } from "@clack/prompts";
import { dim, row, titleLine, yellow } from "./khala-cli-ui.js";
import { ConfigScope, getKhalaConfigPath } from "./khala-config.js";
import {
	deriveEnvVarFromKeyName,
	extractLitellmProvidersFromModelsJson,
	fetchLitellmCatalog,
	isStoredLitellmAuthEntry,
	isSuspiciousLitellmModelId,
	type JsonRecord,
	LITELLM_AUTH_MODES,
	type LitellmProvider,
	litellmKeyAuthId,
	litellmKeyAuthParts,
	litellmProviderExists,
	lookupKeyValueByName,
	mergeAuthJsonApiKey,
	mergeLitellmKeyRegistry,
	mergeLitellmModelsJson,
	mergeLitellmProjectKeyConfig,
	mergeLitellmProjectSettings,
	modelSummary,
	normalizeLitellmBaseUrl,
	normalizeLitellmModelPattern,
	readJsonObjectFile,
	registryLitellmKeyCandidates,
	resolveKeyForFetch,
	validateAuthCommand,
	validateAuthLiteral,
	validateLitellmKeyEnv,
	validateLitellmProviderId,
	warnIfInsecureBaseUrl,
	writeJsonFile,
	writeSecureJsonFile,
} from "./khala-litellm-lib.js";

type AuthMode = "skip" | "literal" | "command";

interface LitellmOptions {
	provider: string;
	baseUrl: string;
	keyEnv: string;
	model: string;
	authMode: string;
	authKey: string;
	authCommand: string;
	projectSettings: boolean | null;
	yes: boolean;
	dryRun: boolean;
	help: boolean;
}

interface ReusableKeyCandidate {
	provider: string;
	baseUrl: string;
	keyEnv: string;
	modelIds: string[];
	hasStoredAuth: boolean;
	needsKeyLabel: boolean;
}

const SETUP_CANCELLED_MESSAGE = "Setup cancelled.";
const CANCEL_EXIT_CODE = 130;
const NEW_PROVIDER_LABEL = "New provider and key";
const ADD_KEY_LABEL = "New key for existing provider";
const REUSE_KEY_LABEL = "Reuse an existing key";

function isInteractive(options: Pick<LitellmOptions, "yes">): boolean {
	return !options.yes && input.isTTY === true && output.isTTY === true;
}

function unwrapPrompt<T>(result: T | symbol): T {
	if (isCancel(result)) {
		throw new Error(SETUP_CANCELLED_MESSAGE);
	}
	return result;
}

function printUsage(): void {
	console.log(`khala litellm - configure a LiteLLM-compatible Pi provider

Usage:
  khala litellm
  khala litellm --provider <id> --base-url <url> --key-env <name> --model <ids> [flags]
  khala litellm print-key --provider <id>
  khala litellm --help

Commands:
  print-key                 Print the selected LiteLLM API key for Pi's provider resolver

Flags:
      --provider <id>       LiteLLM provider id  (e.g. team-litellm)
      --base-url <url>      LiteLLM base URL     (e.g. https://lite.example/v1)
      --key-env <name>      LiteLLM key name (matches your portal label, e.g. reeds-maint).
                             Shell env var is derived: 'reeds-maint' -> $REEDS_MAINT.
      --model <ids>         One model id or comma-separated list to register
      --auth-mode <mode>    How to store the key: skip | literal | command
      --auth-key <value>    Literal key value for --auth-mode=literal
      --auth-command <!cmd> Shell command for --auth-mode=command (must start with '!')
      --project-settings    Also set .pi/settings.json defaults; leave models enabled
      --no-project-settings Do not update .pi/settings.json
  -y, --yes                 Use defaults and skip prompts (requires all flags above)
      --no-input             Alias for --yes
      --dry-run              Print the planned config changes without writing files
  -h, --help                 Show help

Examples:
  # Interactive: add a provider/key, add a key to an existing provider, or reuse a key.
  khala litellm

  # Fully specified new-key setup:
  khala litellm --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env reeds-maint --model gpt-5.4-mini --auth-mode=literal --auth-key="$KEY" --yes

Key resolution at runtime:
  models.json calls '!npx --yes --silent github:pesap/khala litellm print-key --provider <id>'.
  print-key reads this project's selected key label, then checks env vars and key-specific auth entries
  (<provider>:<key-label>).

Environment:
  PI_CODING_AGENT_DIR              Override the Pi agent directory (default: ~/.pi/agent)
`);
}

function printPrintKeyUsage(): void {
	console.log(`khala litellm print-key - print the selected LiteLLM API key for Pi

Usage:
  khala litellm print-key --provider <id>
  khala litellm print-key --help

Output:
  On success, writes only the resolved key value to stdout. Diagnostics and
  errors are written to stderr.
`);
}

function parseArgs(args: string[]): LitellmOptions {
	const options: LitellmOptions = {
		provider: "",
		baseUrl: "",
		keyEnv: "",
		model: "",
		authMode: "",
		authKey: "",
		authCommand: "",
		projectSettings: null,
		yes: false,
		dryRun: false,
		help: false,
	};
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		index += 1;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--yes" || arg === "-y") {
			options.yes = true;
		} else if (arg === "--no-input") {
			options.yes = true;
		} else if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--project-settings" || arg === "--configure-project-settings") {
			options.projectSettings = true;
		} else if (arg === "--no-project-settings") {
			options.projectSettings = false;
		} else if (arg?.startsWith("--provider=")) {
			options.provider = arg.slice("--provider=".length);
		} else if (arg === "--provider") {
			options.provider = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--base-url=")) {
			options.baseUrl = arg.slice("--base-url=".length);
		} else if (arg === "--base-url") {
			options.baseUrl = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--key-env=")) {
			options.keyEnv = arg.slice("--key-env=".length);
		} else if (arg === "--key-env") {
			options.keyEnv = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--model=")) {
			options.model = arg.slice("--model=".length);
		} else if (arg === "--model") {
			options.model = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--auth-mode=")) {
			options.authMode = arg.slice("--auth-mode=".length);
		} else if (arg === "--auth-mode") {
			options.authMode = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--auth-key=")) {
			options.authKey = arg.slice("--auth-key=".length);
		} else if (arg === "--auth-key") {
			options.authKey = args[index] ?? "";
			index += 1;
		} else if (arg?.startsWith("--auth-command=")) {
			options.authCommand = arg.slice("--auth-command=".length);
		} else if (arg === "--auth-command") {
			options.authCommand = args[index] ?? "";
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function parsePrintKeyArgs(args: string[]): { provider: string; help: boolean } {
	const result = { provider: "", help: false };
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		index += 1;
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg?.startsWith("--provider=")) {
			result.provider = arg.slice("--provider=".length);
		} else if (arg === "--provider") {
			result.provider = args[index] ?? "";
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return result;
}

// ── Path helpers ─────────────────────────────────────────────────────────
function agentDir(): string {
	return dirname(getKhalaConfigPath(ConfigScope.global));
}

function modelsJsonPath(): string {
	return join(agentDir(), "models.json");
}

function authJsonPath(): string {
	return join(agentDir(), "auth.json");
}

function keyRegistryPath(): string {
	return join(agentDir(), "khala", "litellm-keys.json");
}

function projectConfigDir(projectPath: string): string {
	return dirname(getKhalaConfigPath(ConfigScope.project, projectPath));
}

function projectSettingsPath(projectPath: string): string {
	return join(projectConfigDir(projectPath), "settings.json");
}

function projectLitellmConfigPath(projectPath: string): string {
	return join(projectConfigDir(projectPath), "khala", "litellm.json");
}

function findProjectLitellmConfigPath(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = projectLitellmConfigPath(dir);
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return;
		}
		dir = parent;
	}
}

// ── Discovery ────────────────────────────────────────────────────────────
function litellmProvidersFromModelsJson(): LitellmProvider[] {
	const modelsJson = readJsonObjectFile(modelsJsonPath());
	return extractLitellmProvidersFromModelsJson(modelsJson);
}

function rememberedBaseUrl(providerId: string, providers: readonly LitellmProvider[]): string {
	const exact = providers.find((provider) => provider.name === providerId);
	if (exact !== undefined) {
		return exact.baseUrl;
	}
	const uniqueBaseUrls = [...new Set(providers.map((provider) => provider.baseUrl))];
	return uniqueBaseUrls.length === 1 ? (uniqueBaseUrls[0] ?? "") : "";
}

function reusableKeyLabel(candidate: ReusableKeyCandidate): string {
	const keySource = candidate.hasStoredAuth
		? "stored key"
		: `env $${deriveEnvVarFromKeyName(candidate.keyEnv) ?? candidate.keyEnv}`;
	return `${candidate.keyEnv} (${keySource}; ${modelSummary(candidate.modelIds)})`;
}

function reusableKeyCandidates(): ReusableKeyCandidate[] {
	const providers = litellmProvidersFromModelsJson();
	const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
	const auth = readJsonObjectFile(authJsonPath());
	const projectConfigPath = findProjectLitellmConfigPath(process.cwd());
	const projectConfig = projectConfigPath === undefined ? null : readJsonObjectFile(projectConfigPath);
	const projectProviders =
		projectConfig !== null && typeof projectConfig["providers"] === "object" && projectConfig["providers"] !== null
			? (projectConfig["providers"] as JsonRecord)
			: {};

	const seeded: { provider: string; baseUrl: string; keyEnv: string; modelIds: string[] }[] = [];
	for (const entry of registryLitellmKeyCandidates(readJsonObjectFile(keyRegistryPath()))) {
		seeded.push(entry);
	}
	if (auth !== null) {
		for (const [authId, authEntry] of Object.entries(auth)) {
			if (!isStoredLitellmAuthEntry(authEntry)) {
				continue;
			}
			const parts = litellmKeyAuthParts(authId);
			const provider = parts === undefined ? undefined : providerByName.get(parts.provider);
			if (parts === undefined || provider === undefined) {
				continue;
			}
			seeded.push({
				provider: parts.provider,
				baseUrl: provider.baseUrl,
				keyEnv: parts.keyEnv,
				modelIds: [...provider.models],
			});
		}
	}
	for (const provider of providers) {
		const projectEntryRaw = projectProviders[provider.name];
		const projectEntry =
			typeof projectEntryRaw === "object" && projectEntryRaw !== null ? (projectEntryRaw as JsonRecord) : null;
		const projectKeyEnvRaw = projectEntry?.["keyEnv"];
		const projectKeyEnv =
			typeof projectKeyEnvRaw === "string" && projectKeyEnvRaw.trim().length > 0
				? validateLitellmKeyEnv(projectKeyEnvRaw)
				: "";
		seeded.push({
			provider: provider.name,
			baseUrl: provider.baseUrl,
			keyEnv: projectKeyEnv.length > 0 ? projectKeyEnv : provider.name,
			modelIds: [...provider.models],
		});
	}

	const seen = new Set<string>();
	const candidates: ReusableKeyCandidate[] = [];
	for (const entry of seeded) {
		const provider = providerByName.get(entry.provider);
		const baseUrl = entry.baseUrl.length > 0 ? entry.baseUrl : (provider?.baseUrl ?? "");
		const modelIds = entry.modelIds.length > 0 ? entry.modelIds : [...(provider?.models ?? [])];
		if (baseUrl.length === 0 || modelIds.length === 0) {
			continue;
		}
		const key = `${entry.provider}\0${entry.keyEnv}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const keySpecificAuth = auth === null ? undefined : auth[litellmKeyAuthId(entry.provider, entry.keyEnv)];
		candidates.push({
			provider: entry.provider,
			baseUrl,
			keyEnv: entry.keyEnv,
			modelIds,
			hasStoredAuth: isStoredLitellmAuthEntry(keySpecificAuth),
			needsKeyLabel: false,
		});
	}
	return candidates.sort((a, b) => `${a.provider}\0${a.keyEnv}`.localeCompare(`${b.provider}\0${b.keyEnv}`));
}

// ── Prompts ──────────────────────────────────────────────────────────────
function acceptAnyValue(): string | undefined {
	// No validation rule; every value is accepted.
	return;
}

async function askText(
	message: string,
	placeholder = "",
	validate: (value: string) => string | undefined = acceptAnyValue,
): Promise<string> {
	const result = await text({ message, placeholder, validate: (value) => validate(value ?? "") });
	return unwrapPrompt(result).trim();
}

async function askSecret(message: string): Promise<string> {
	const result = await password({ message, mask: "*" });
	return unwrapPrompt(result);
}

async function askSelect(message: string, choices: readonly string[], initialValue: string): Promise<string> {
	const result = await select({
		message,
		options: choices.map((choice) => ({ value: choice, label: choice })),
		initialValue,
	});
	return unwrapPrompt(result);
}

async function askYesNo(message: string, initialValue = false): Promise<boolean> {
	const result = await confirm({ message, initialValue });
	return unwrapPrompt(result);
}

function validatedOrUndefined<T>(fn: () => T): string | undefined {
	try {
		fn();
		return;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function askProvider(defaultValue: string): Promise<string> {
	const value = await askText("LiteLLM provider id (e.g. team-litellm)", defaultValue, (candidate) =>
		validatedOrUndefined(() => validateLitellmProviderId(candidate || defaultValue)),
	);
	return validateLitellmProviderId(value.length > 0 ? value : defaultValue);
}

async function askBaseUrl(defaultValue: string): Promise<string> {
	const value = await askText("LiteLLM base URL (e.g. https://lite.example/v1)", defaultValue, (candidate) =>
		validatedOrUndefined(() => normalizeLitellmBaseUrl(candidate || defaultValue)),
	);
	return normalizeLitellmBaseUrl(value.length > 0 ? value : defaultValue);
}

async function askKeyEnv(): Promise<string> {
	const value = await askText("Project key label (e.g. reeds-maint)", "", (candidate) =>
		validatedOrUndefined(() => validateLitellmKeyEnv(candidate)),
	);
	return validateLitellmKeyEnv(value);
}

async function askModelIds(catalogModelNames: readonly string[]): Promise<string[]> {
	if (catalogModelNames.length > 0) {
		const picked = await multiselect({
			message: "LiteLLM models to register and enable",
			options: catalogModelNames.map((name) => ({ value: name, label: name })),
			required: true,
		});
		return unwrapPrompt(picked).map((id) => normalizeLitellmModelPattern(id));
	}
	const raw = await askText("Model ids (comma-separated, e.g. gpt-4.1, gpt-4.1-mini)");
	const modelIds = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => normalizeLitellmModelPattern(entry));
	if (modelIds.length === 0) {
		throw new Error("At least one model id is required.");
	}
	return modelIds;
}

interface AuthChoice {
	mode: AuthMode;
	key?: string;
	command?: string;
}

async function askAuthMode(provider: string, keyEnv: string, hasExistingAuth: boolean): Promise<AuthChoice> {
	if (hasExistingAuth) {
		const replace = await askYesNo(`A stored key already exists for ${provider}:${keyEnv}. Replace it?`, false);
		if (!replace) {
			return { mode: "skip" };
		}
	}
	const choice = await askSelect(
		"How should Pi resolve this provider's API key?",
		["Paste the key now", "Run a shell command each time", "Skip (already exported as an environment variable)"],
		"Paste the key now",
	);
	if (choice.startsWith("Paste")) {
		const key = await askSecret("API key (input is masked; stored in auth.json with 0600 permissions)");
		return { mode: "literal", key: validateAuthLiteral(key) };
	}
	if (choice.startsWith("Run")) {
		const command = await askText(
			"Shell command (must start with '!', e.g. !op read 'op://Personal/team/credential')",
			"",
			(candidate) => validatedOrUndefined(() => validateAuthCommand(candidate)),
		);
		return { mode: "command", command: validateAuthCommand(command) };
	}
	return { mode: "skip" };
}

// ── Main flow ────────────────────────────────────────────────────────────

interface ResolvedSetup {
	provider: string;
	baseUrl: string;
	keyEnv: string;
	modelIds: string[];
	auth: AuthChoice;
	writeModelsJson: boolean;
	writeProjectKeyConfig: boolean;
	writeProjectSettings: boolean;
}

async function planInteractiveNewProvider(
	options: LitellmOptions,
	providers: readonly LitellmProvider[],
): Promise<ResolvedSetup> {
	const provider = options.provider.length > 0 ? validateLitellmProviderId(options.provider) : await askProvider("");
	const defaultBaseUrl = options.baseUrl.length > 0 ? options.baseUrl : rememberedBaseUrl(provider, providers);
	const baseUrl =
		options.baseUrl.length > 0 ? normalizeLitellmBaseUrl(options.baseUrl) : await askBaseUrl(defaultBaseUrl);
	const warning = warnIfInsecureBaseUrl(baseUrl);
	if (warning !== undefined) {
		console.log(`Warning: ${warning}`);
	}
	const keyEnv = options.keyEnv.length > 0 ? validateLitellmKeyEnv(options.keyEnv) : await askKeyEnv();

	const currentAuth = readJsonObjectFile(authJsonPath());
	const keyAuthId = litellmKeyAuthId(provider, keyEnv);
	const hasExistingAuth = currentAuth !== null && isStoredLitellmAuthEntry(currentAuth[keyAuthId]);
	const auth = await resolveAuthChoice(options, provider, keyEnv, hasExistingAuth);

	const resolvedKey = resolveAuthKeyForFetch(auth, provider, keyEnv, currentAuth);
	const catalogModelNames = resolvedKey === undefined ? [] : await fetchCatalogNames(baseUrl, resolvedKey);
	const modelIds = options.model.length > 0 ? parseModelList(options.model) : await askModelIds(catalogModelNames);

	const writeProjectSettings = await resolveProjectSettingsChoice(options, true);
	return {
		provider,
		baseUrl,
		keyEnv,
		modelIds,
		auth,
		writeModelsJson: true,
		writeProjectKeyConfig: true,
		writeProjectSettings,
	};
}

async function resolveAuthChoice(
	options: LitellmOptions,
	provider: string,
	keyEnv: string,
	hasExistingAuth: boolean,
): Promise<AuthChoice> {
	const explicitMode = options.authMode.trim().toLowerCase();
	if (explicitMode.length > 0) {
		if (!LITELLM_AUTH_MODES.has(explicitMode)) {
			throw new Error(`Unknown --auth-mode '${explicitMode}'. Expected one of: ${[...LITELLM_AUTH_MODES].join(", ")}.`);
		}
		if (explicitMode === "literal") {
			if (options.authKey.length === 0) {
				throw new Error("--auth-mode=literal needs --auth-key=<value>.");
			}
			return { mode: "literal", key: validateAuthLiteral(options.authKey) };
		}
		if (explicitMode === "command") {
			if (options.authCommand.length === 0) {
				throw new Error("--auth-mode=command needs --auth-command=<!cmd>.");
			}
			return { mode: "command", command: validateAuthCommand(options.authCommand) };
		}
		return { mode: "skip" };
	}
	if (options.authKey.length > 0) {
		return { mode: "literal", key: validateAuthLiteral(options.authKey) };
	}
	if (options.authCommand.length > 0) {
		return { mode: "command", command: validateAuthCommand(options.authCommand) };
	}
	if (!isInteractive(options)) {
		return { mode: "skip" };
	}
	return askAuthMode(provider, keyEnv, hasExistingAuth);
}

function resolveAuthKeyForFetch(
	auth: AuthChoice,
	provider: string,
	keyEnv: string,
	currentAuth: JsonRecord | null,
): string | undefined {
	if (auth.mode === "literal" && auth.key !== undefined) {
		return auth.key;
	}
	if (auth.mode === "command" && auth.command !== undefined) {
		return resolveKeyForFetch(auth.command);
	}
	const fromEnv = lookupKeyValueByName(keyEnv);
	if (fromEnv !== undefined) {
		return fromEnv;
	}
	if (currentAuth === null) {
		return;
	}
	const keyAuthEntry = currentAuth[litellmKeyAuthId(provider, keyEnv)];
	if (isStoredLitellmAuthEntry(keyAuthEntry)) {
		return resolveKeyForFetch(keyAuthEntry.key);
	}
	return;
}

async function fetchCatalogNames(baseUrl: string, apiKey: string): Promise<string[]> {
	console.log("Fetching model catalog...");
	try {
		const catalog = await fetchLitellmCatalog(baseUrl, apiKey);
		if (catalog.modelListError !== undefined && catalog.modelNames.length === 0) {
			console.log(`Could not fetch model list: ${catalog.modelListError.message}. Enter model ids manually.`);
		}
		return catalog.modelNames;
	} catch (error) {
		console.log(
			`Could not fetch model catalog: ${error instanceof Error ? error.message : String(error)}. Enter model ids manually.`,
		);
		return [];
	}
}

function parseModelList(raw: string): string[] {
	const modelIds = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => normalizeLitellmModelPattern(entry));
	if (modelIds.length === 0) {
		throw new Error("Missing required LiteLLM option: --model.");
	}
	const suspicious = modelIds.find((id) => isSuspiciousLitellmModelId(id));
	if (suspicious !== undefined) {
		throw new Error(
			`LiteLLM model id '${suspicious}' is very short. Re-run in a TTY to confirm it, or pass a longer model id.`,
		);
	}
	return modelIds;
}

async function resolveProjectSettingsChoice(options: LitellmOptions, defaultToAsk: boolean): Promise<boolean> {
	if (options.projectSettings !== null) {
		return options.projectSettings;
	}
	if (!(isInteractive(options) && defaultToAsk)) {
		return false;
	}
	return askYesNo("Set this project's Pi defaults (.pi/settings.json) to these models?", false);
}

async function planAddKeyToExistingProvider(
	options: LitellmOptions,
	providers: readonly LitellmProvider[],
): Promise<ResolvedSetup> {
	if (providers.length === 0) {
		throw new Error("No existing Khala LiteLLM providers found. Add a provider first.");
	}
	const providerNames = providers.map((candidate) => candidate.name);
	const providerName =
		options.provider.length > 0
			? validateLitellmProviderId(options.provider)
			: await askSelect("Existing LiteLLM provider", providerNames, providerNames[0] ?? "");
	const provider = providers.find((candidate) => candidate.name === providerName);
	if (provider === undefined) {
		throw new Error(`Unknown LiteLLM provider '${providerName}'.`);
	}
	const keyEnv = options.keyEnv.length > 0 ? validateLitellmKeyEnv(options.keyEnv) : await askKeyEnv();
	const currentAuth = readJsonObjectFile(authJsonPath());
	const keyAuthId = litellmKeyAuthId(provider.name, keyEnv);
	const hasExistingAuth = currentAuth !== null && isStoredLitellmAuthEntry(currentAuth[keyAuthId]);
	const auth = await resolveAuthChoice(options, provider.name, keyEnv, hasExistingAuth);
	const writeProjectKeyConfig = isInteractive(options)
		? await askYesNo(`Configure this project to use key label '${keyEnv}'?`, false)
		: true;
	const writeProjectSettings = writeProjectKeyConfig ? await resolveProjectSettingsChoice(options, true) : false;
	return {
		provider: provider.name,
		baseUrl: provider.baseUrl,
		keyEnv,
		modelIds: [...provider.models],
		auth,
		writeModelsJson: false,
		writeProjectKeyConfig,
		writeProjectSettings,
	};
}

async function planReuseExistingKey(options: LitellmOptions): Promise<ResolvedSetup> {
	const candidates = reusableKeyCandidates();
	if (candidates.length === 0) {
		throw new Error(
			"No reusable LiteLLM keys found. Add a new key first, then rerun khala litellm in another project to reuse it.",
		);
	}
	const providerNames = [...new Set(candidates.map((candidate) => candidate.provider))];
	const providerName =
		options.provider.length > 0
			? validateLitellmProviderId(options.provider)
			: await askSelect("LiteLLM provider to reuse", providerNames, providerNames[0] ?? "");
	const providerCandidates = candidates.filter((candidate) => candidate.provider === providerName);
	if (providerCandidates.length === 0) {
		throw new Error(`No reusable key found for provider '${providerName}'.`);
	}
	const keyChoices = providerCandidates.map((candidate) => reusableKeyLabel(candidate));
	const selectedLabel =
		options.keyEnv.length > 0 ? "" : await askSelect("Key label to reuse", keyChoices, keyChoices[0] ?? "");
	const selected =
		options.keyEnv.length > 0
			? providerCandidates.find((candidate) => candidate.keyEnv === options.keyEnv)
			: providerCandidates[keyChoices.indexOf(selectedLabel)];
	if (selected === undefined) {
		throw new Error(`No reusable key labeled '${options.keyEnv}' found for provider '${providerName}'.`);
	}
	const writeProjectKeyConfig = isInteractive(options)
		? await askYesNo(`Configure this project to use ${providerName}:${selected.keyEnv}?`, true)
		: true;
	const writeProjectSettings = writeProjectKeyConfig ? await resolveProjectSettingsChoice(options, true) : false;
	return {
		provider: providerName,
		baseUrl: selected.baseUrl,
		keyEnv: selected.keyEnv,
		modelIds: selected.modelIds,
		auth: { mode: "skip" },
		writeModelsJson: false,
		writeProjectKeyConfig,
		writeProjectSettings,
	};
}

function hasExplicitSetupInput(options: LitellmOptions): boolean {
	return (
		options.provider.length > 0 ||
		options.baseUrl.length > 0 ||
		options.keyEnv.length > 0 ||
		options.model.length > 0 ||
		options.authMode.length > 0 ||
		options.authKey.length > 0 ||
		options.authCommand.length > 0
	);
}

async function planNonInteractive(options: LitellmOptions): Promise<ResolvedSetup> {
	const missing: string[] = [];
	if (options.provider.length === 0) {
		missing.push("--provider");
	}
	if (options.baseUrl.length === 0) {
		missing.push("--base-url");
	}
	if (options.keyEnv.length === 0) {
		missing.push("--key-env");
	}
	if (options.model.length === 0) {
		missing.push("--model");
	}
	if (missing.length > 0) {
		throw new Error(
			`Missing required LiteLLM options: ${missing.join(", ")}. Run in a TTY to answer prompts, or pass all required flags explicitly.`,
		);
	}
	const provider = validateLitellmProviderId(options.provider);
	const baseUrl = normalizeLitellmBaseUrl(options.baseUrl);
	const keyEnv = validateLitellmKeyEnv(options.keyEnv);
	const modelIds = parseModelList(options.model);
	const auth = await resolveAuthChoice(options, provider, keyEnv, false);
	const writeProjectSettings = await resolveProjectSettingsChoice(options, false);
	return {
		provider,
		baseUrl,
		keyEnv,
		modelIds,
		auth,
		writeModelsJson: true,
		writeProjectKeyConfig: true,
		writeProjectSettings,
	};
}

async function planSetup(options: LitellmOptions): Promise<ResolvedSetup> {
	const providers = litellmProvidersFromModelsJson();
	if (!isInteractive(options) || hasExplicitSetupInput(options)) {
		if (!isInteractive(options)) {
			return planNonInteractive(options);
		}
		return planInteractiveNewProvider(options, providers);
	}
	const modes =
		providers.length > 0 ? [NEW_PROVIDER_LABEL, ADD_KEY_LABEL, REUSE_KEY_LABEL] : [NEW_PROVIDER_LABEL, REUSE_KEY_LABEL];
	console.log("Connect Pi to a LiteLLM-compatible proxy. Press Ctrl-C any time to cancel.");
	const mode = await askSelect("LiteLLM key setup", modes, NEW_PROVIDER_LABEL);
	if (mode === ADD_KEY_LABEL) {
		return planAddKeyToExistingProvider(options, providers);
	}
	if (mode === REUSE_KEY_LABEL) {
		return planReuseExistingKey(options);
	}
	return planInteractiveNewProvider(options, providers);
}

function printPlanSummary(plan: ResolvedSetup): void {
	let authentication = `environment $${deriveEnvVarFromKeyName(plan.keyEnv) ?? plan.keyEnv}`;
	let authenticationMarker = "=";
	if (plan.auth.mode === "literal") {
		authentication = "stored literal value (0600)";
		authenticationMarker = "+";
	} else if (plan.auth.mode === "command") {
		authentication = "stored command (0600)";
		authenticationMarker = "+";
	}
	const writesKeyRegistry = plan.auth.mode !== "skip" || plan.writeModelsJson || plan.writeProjectKeyConfig;
	let projectDefaults = "(unchanged)";
	if (plan.writeProjectSettings) {
		const globalSettings = readJsonObjectFile(join(agentDir(), "settings.json"));
		const currentProjectSettings = readJsonObjectFile(projectSettingsPath(process.cwd()));
		const modelScope = currentProjectSettings?.["enabledModels"] ?? globalSettings?.["enabledModels"];
		const scopeDescription = modelScope === undefined ? "all models enabled" : "existing model scope preserved";
		projectDefaults = `${projectSettingsPath(process.cwd())} (${scopeDescription})`;
	}

	console.log("");
	console.log(titleLine("LiteLLM configuration"));
	console.log(row("=", "provider", plan.provider));
	console.log(row("=", "base URL", plan.baseUrl));
	console.log(row("=", "models", modelSummary(plan.modelIds)));
	console.log(row("=", "key label", plan.keyEnv));
	console.log(row(authenticationMarker, "authentication", authentication));
	console.log(
		row(plan.writeModelsJson ? "+" : "=", "Pi models", plan.writeModelsJson ? modelsJsonPath() : "(unchanged)"),
	);
	console.log(
		row(
			plan.writeProjectKeyConfig ? "+" : "=",
			"project key",
			plan.writeProjectKeyConfig ? projectLitellmConfigPath(process.cwd()) : "(unchanged)",
		),
	);
	console.log(
		row(writesKeyRegistry ? "+" : "=", "key registry", writesKeyRegistry ? keyRegistryPath() : "(unchanged)"),
	);
	console.log(row(plan.writeProjectSettings ? "+" : "=", "project defaults", projectDefaults));
}

async function writePlan(plan: ResolvedSetup): Promise<void> {
	if (plan.writeModelsJson) {
		const currentModels = readJsonObjectFile(modelsJsonPath());
		const managedProvider = extractLitellmProvidersFromModelsJson(currentModels).some(
			(provider) => provider.name === plan.provider,
		);
		if (litellmProviderExists(currentModels, plan.provider) && !managedProvider) {
			throw new Error(
				`Provider '${plan.provider}' already exists in models.json and is not managed by Khala. Choose a new provider id rather than replacing its configuration.`,
			);
		}
		const catalog = await catalogForWrite(plan);
		const merged = mergeLitellmModelsJson(currentModels, {
			providerId: plan.provider,
			baseUrl: plan.baseUrl,
			modelIds: plan.modelIds,
			infoMap: catalog,
		});
		writeJsonFile(modelsJsonPath(), merged.value, { compactModelEntries: true });
	}
	if (plan.writeProjectKeyConfig) {
		const path = projectLitellmConfigPath(process.cwd());
		const merged = mergeLitellmProjectKeyConfig(readJsonObjectFile(path), {
			providerId: plan.provider,
			keyEnv: plan.keyEnv,
		});
		writeJsonFile(path, merged);
	}
	// Environment-backed keys still need a non-secret registry entry so the
	// reuse picker can offer their labels from another project.
	const writeKeyRegistry = plan.auth.mode !== "skip" || plan.writeModelsJson || plan.writeProjectKeyConfig;
	if (writeKeyRegistry) {
		const merged = mergeLitellmKeyRegistry(readJsonObjectFile(keyRegistryPath()), {
			provider: plan.provider,
			keyEnv: plan.keyEnv,
			baseUrl: plan.baseUrl,
			modelIds: plan.modelIds,
		});
		writeJsonFile(keyRegistryPath(), merged);
	}
	if (plan.writeProjectSettings) {
		const path = projectSettingsPath(process.cwd());
		const merged = mergeLitellmProjectSettings(readJsonObjectFile(path), {
			providerId: plan.provider,
			modelIds: plan.modelIds,
		});
		writeJsonFile(path, merged);
	}
	if (plan.auth.mode === "literal" && plan.auth.key !== undefined) {
		writeAuthEntry(plan.provider, plan.keyEnv, plan.auth.key);
	} else if (plan.auth.mode === "command" && plan.auth.command !== undefined) {
		writeAuthEntry(plan.provider, plan.keyEnv, plan.auth.command);
	}
}

async function catalogForWrite(plan: ResolvedSetup): Promise<Map<string, JsonRecord> | null> {
	const resolvedKey = resolveAuthKeyForFetch(plan.auth, plan.provider, plan.keyEnv, readJsonObjectFile(authJsonPath()));
	if (resolvedKey === undefined) {
		return null;
	}
	try {
		const catalog = await fetchLitellmCatalog(plan.baseUrl, resolvedKey);
		return catalog.infoMap;
	} catch {
		return null;
	}
}

function writeAuthEntry(provider: string, keyEnv: string, keyValue: string): void {
	const current = readJsonObjectFile(authJsonPath());
	// Pi resolves a provider-level auth.json credential before models.json's
	// apiKey command. Keep this credential key-specific so the command can
	// select the key label recorded by each project.
	const merged = mergeAuthJsonApiKey(current, litellmKeyAuthId(provider, keyEnv), keyValue);
	writeSecureJsonFile(authJsonPath(), merged.value);
}

async function configure(options: LitellmOptions): Promise<void> {
	const plan = await planSetup(options);
	const currentAuth = readJsonObjectFile(authJsonPath());
	if (currentAuth !== null && currentAuth[plan.provider] !== undefined) {
		throw new Error(
			`Provider '${plan.provider}' has a provider-level auth.json entry. Remove it before configuring project-specific LiteLLM keys; Pi would use it before the selected-key resolver.`,
		);
	}
	printPlanSummary(plan);
	if (options.dryRun) {
		console.log(`\n${yellow("Dry run.")} ${dim("Run without --dry-run to write the LiteLLM configuration.")}`);
		return;
	}
	if (isInteractive(options)) {
		const confirmed = await askYesNo("Write these changes?", true);
		if (!confirmed) {
			console.log("Skipped. No files were written.");
			return;
		}
	}
	await writePlan(plan);
	console.log("\nDone. LiteLLM provider is configured.");
}

// ── print-key ────────────────────────────────────────────────────────────
async function runPrintKey(args: string[]): Promise<void> {
	let options: { provider: string; help: boolean };
	try {
		options = parsePrintKeyArgs(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error("Run `khala litellm --help` for usage.");
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		printPrintKeyUsage();
		return;
	}
	try {
		if (options.provider.length === 0) {
			throw new Error("Missing required LiteLLM option: --provider.");
		}
		const provider = validateLitellmProviderId(options.provider);
		const configPath = findProjectLitellmConfigPath(process.cwd());
		if (configPath === undefined) {
			throw new Error(`No project LiteLLM key config found for provider '${provider}'. Run khala litellm first.`);
		}
		const config = readJsonObjectFile(configPath);
		const providers =
			config !== null && typeof config["providers"] === "object" && config["providers"] !== null
				? (config["providers"] as JsonRecord)
				: {};
		const providerConfigRaw = providers[provider];
		const providerConfig =
			typeof providerConfigRaw === "object" && providerConfigRaw !== null ? (providerConfigRaw as JsonRecord) : null;
		if (providerConfig === null || typeof providerConfig["keyEnv"] !== "string") {
			throw new Error(
				`No project LiteLLM key env is configured for provider '${provider}'. Run khala litellm --provider ${provider} --key-env <label>.`,
			);
		}
		const keyEnv = validateLitellmKeyEnv(providerConfig["keyEnv"]);
		const value = lookupKeyValueByName(keyEnv);
		if (value !== undefined) {
			process.stdout.write(value);
			return;
		}
		const auth = readJsonObjectFile(authJsonPath());
		const keyAuthEntry = auth === null ? undefined : auth[litellmKeyAuthId(provider, keyEnv)];
		if (isStoredLitellmAuthEntry(keyAuthEntry)) {
			const resolved = resolveKeyForFetch(keyAuthEntry.key);
			if (resolved !== undefined) {
				process.stdout.write(resolved);
				return;
			}
		}
		const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;
		throw new Error(`Project LiteLLM key '${keyEnv}' has no exported value (expected $${envVar}).`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

async function main(args: string[]): Promise<void> {
	if (args[0] === "print-key") {
		await runPrintKey(args.slice(1));
		return;
	}
	let options: LitellmOptions;
	try {
		options = parseArgs(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error("Run `khala litellm --help` for usage.");
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		printUsage();
		return;
	}
	try {
		await configure(options);
	} catch (error) {
		if (error instanceof Error && error.message === SETUP_CANCELLED_MESSAGE) {
			process.exitCode = CANCEL_EXIT_CODE;
			return;
		}
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1]?.endsWith("khala-litellm.js") || process.argv[1]?.endsWith("khala-litellm.ts")) {
	await main(process.argv.slice(2));
}

export { main as runKhalaLitellm };
