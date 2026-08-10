import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceJiti = createJiti(import.meta.url);
const lib = await sourceJiti.import("../src/khala-litellm-lib.ts");
const projectBin = join(projectRoot, "bin", "khala.js");

function runKhalaLitellm(args, { cwd, env = {} } = {}) {
	const root = cwd ?? mkdtempSync(join(tmpdir(), "khala-litellm-"));
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const result = spawnSync(process.execPath, [projectBin, "litellm", ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
	});
	return { root, agentDir, ...result };
}

// ── Pure lib behavior ───────────────────────────────────────────────────────

test("validateLitellmProviderId accepts identifier-shaped ids and rejects the rest", () => {
	assert.equal(lib.validateLitellmProviderId("team-litellm"), "team-litellm");
	assert.throws(() => lib.validateLitellmProviderId(""));
	assert.throws(() => lib.validateLitellmProviderId("has spaces"));
	assert.throws(() => lib.validateLitellmProviderId("has/slash"));
});

test("deriveEnvVarFromKeyName derives a shell-canonical name and is idempotent", () => {
	assert.equal(lib.deriveEnvVarFromKeyName("reeds-maint"), "REEDS_MAINT");
	assert.equal(lib.deriveEnvVarFromKeyName("team.litellm.prod"), "TEAM_LITELLM_PROD");
	assert.equal(lib.deriveEnvVarFromKeyName("LITELLM_API_KEY"), "LITELLM_API_KEY");
	assert.equal(lib.deriveEnvVarFromKeyName("123abc"), "ABC");
});

test("normalizeLitellmBaseUrl strips trailing slashes and rejects query strings", () => {
	assert.equal(lib.normalizeLitellmBaseUrl("https://lite.example/v1/"), "https://lite.example/v1");
	assert.throws(() => lib.normalizeLitellmBaseUrl("not-a-url"));
	assert.throws(() => lib.normalizeLitellmBaseUrl("https://lite.example/v1?x=1"));
	assert.throws(() => lib.normalizeLitellmBaseUrl("ftp://lite.example"));
});

test("buildLitellmApiKeyCommand and isLitellmApiKeyCommand round-trip", () => {
	const command = lib.buildLitellmApiKeyCommand("team-litellm");
	assert.equal(command, "!npx --yes --silent github:pesap/khala litellm print-key --provider team-litellm");
	assert.equal(lib.isLitellmApiKeyCommand("team-litellm", command), true);
	assert.equal(lib.isLitellmApiKeyCommand("other", command), false);
});

test("mergeLitellmModelsJson writes a provider entry with REPLACE model semantics", () => {
	const first = lib.mergeLitellmModelsJson(null, {
		providerId: "team-litellm",
		baseUrl: "https://lite.example/v1",
		modelIds: ["gpt-a", "gpt-b"],
	});
	assert.equal(first.isUpdate, false);
	assert.deepEqual(
		first.value.providers["team-litellm"].models.map((entry) => entry.id),
		["gpt-a", "gpt-b"],
	);

	const second = lib.mergeLitellmModelsJson(first.value, {
		providerId: "team-litellm",
		baseUrl: "https://lite.example/v1",
		modelIds: ["gpt-b"],
	});
	assert.equal(second.isUpdate, true);
	assert.deepEqual(
		second.value.providers["team-litellm"].models.map((entry) => entry.id),
		["gpt-b"],
	);
});

test("mergeLitellmModelsJson preserves an existing supported API", () => {
	const merged = lib.mergeLitellmModelsJson(
		{
			providers: {
				"team-litellm": {
					api: "openai-responses",
					baseUrl: "https://lite.example/v1",
					apiKey: "!npx --yes --silent github:pesap/khala litellm print-key --provider team-litellm",
					models: [{ id: "gpt-old" }],
				},
			},
		},
		{
			providerId: "team-litellm",
			baseUrl: "https://lite.example/v1",
			modelIds: ["gpt-new"],
		},
	);
	assert.equal(merged.value.providers["team-litellm"].api, "openai-responses");
});

test("mergeLitellmModelsJson flags a conflicting base URL for an existing provider", () => {
	const first = lib.mergeLitellmModelsJson(null, {
		providerId: "team-litellm",
		baseUrl: "https://lite.example/v1",
		modelIds: ["gpt-a"],
	});
	const second = lib.mergeLitellmModelsJson(first.value, {
		providerId: "team-litellm",
		baseUrl: "https://other.example/v1",
		modelIds: ["gpt-a"],
	});
	assert.equal(second.conflict, true);
});

test("mergeAuthJsonApiKey preserves unrelated providers and reports conflicts", () => {
	const current = { other: { type: "api_key", key: "unrelated" } };
	const merged = lib.mergeAuthJsonApiKey(current, "team-litellm", "sk-test");
	assert.equal(merged.isUpdate, false);
	assert.equal(merged.conflict, false);
	assert.deepEqual(merged.value.other, { type: "api_key", key: "unrelated" });
	assert.deepEqual(merged.value["team-litellm"], { type: "api_key", key: "sk-test" });

	const replaced = lib.mergeAuthJsonApiKey(merged.value, "team-litellm", "sk-different");
	assert.equal(replaced.isUpdate, true);
	assert.equal(replaced.conflict, true);
});

test("project defaults preserve an existing model scope", () => {
	const merged = lib.mergeLitellmProjectSettings(
		{
			enabledModels: ["anthropic/claude-sonnet"],
			theme: "dark",
		},
		{ providerId: "team-litellm", modelIds: ["gpt-5.4-mini"] },
	);
	assert.equal(merged.defaultProvider, "team-litellm");
	assert.equal(merged.defaultModel, "gpt-5.4-mini");
	assert.deepEqual(merged.enabledModels, ["anthropic/claude-sonnet"]);
	assert.equal(merged.theme, "dark");
});

test("secure auth writes repair permissions when the JSON already matches", () => {
	const directory = mkdtempSync(join(tmpdir(), "khala-litellm-auth-"));
	const authPath = join(directory, "auth.json");
	const auth = { "team-litellm:reeds-maint": { type: "api_key", key: "sk-test" } };
	writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o644 });
	chmodSync(authPath, 0o644);

	lib.writeSecureJsonFile(authPath, auth);

	assert.equal(statSync(authPath).mode & 0o777, 0o600);
});

test("parseLitellmModelInfoResponse enriches reasoning, cost, and modality fields", () => {
	const infoMap = lib.parseLitellmModelInfoResponse({
		data: [
			{
				model_name: "gpt-x",
				model_info: {
					supports_reasoning: true,
					supports_vision: true,
					supports_audio_input: true,
					input_cost_per_token: 0.0000025,
					output_cost_per_token: 0.00001,
					max_input_tokens: 128000,
					max_output_tokens: 32000,
				},
			},
			{ model_name: "", model_info: {} },
		],
	});
	assert.equal(infoMap.size, 1);
	const entry = infoMap.get("gpt-x");
	assert.equal(entry.reasoning, true);
	assert.deepEqual(entry.input, ["text", "image"]);
	assert.equal(entry.contextWindow, 128000);
	assert.equal(entry.maxTokens, 32000);
	assert.equal(entry.cost.input, 2.5);
	assert.equal(entry.cost.output, 10);
});

// ── CLI behavior ─────────────────────────────────────────────────────────────

test("khala litellm --help exits zero without writing files", () => {
	const result = runKhalaLitellm(["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /khala litellm - configure a LiteLLM-compatible Pi provider/);
	assert.match(result.stdout, /--model <ids>/);
	assert.match(result.stdout, /npx --yes --silent github:pesap\/khala litellm print-key/);
	assert.doesNotMatch(result.stdout, /<resolver>/);
	assert.doesNotMatch(result.stdout, /legacy provider auth/);
	assert.equal(existsSync(join(result.agentDir, "models.json")), false);
});

test("non-interactive setup reports every missing required flag", () => {
	const result = runKhalaLitellm(["--yes"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--provider/);
	assert.match(result.stderr, /--base-url/);
	assert.match(result.stderr, /--key-env/);
	assert.match(result.stderr, /--model/);
});

test("non-interactive setup registers a provider, project key config, and key registry", () => {
	const result = runKhalaLitellm(
		[
			"--provider",
			"team-litellm",
			"--base-url",
			"https://lite.example/v1",
			"--key-env",
			"reeds-maint",
			"--model",
			"gpt-5.4-mini",
			"--auth-mode=skip",
			"--project-settings",
			"--yes",
		],
	);
	assert.equal(result.status, 0, result.stderr);

	const models = JSON.parse(readFileSync(join(result.agentDir, "models.json"), "utf8"));
	assert.equal(models.providers["team-litellm"].baseUrl, "https://lite.example/v1");
	assert.equal(models.providers["team-litellm"].api, "openai-completions");
	assert.equal(
		models.providers["team-litellm"].apiKey,
		"!npx --yes --silent github:pesap/khala litellm print-key --provider team-litellm",
	);
	assert.deepEqual(
		models.providers["team-litellm"].models.map((entry) => entry.id),
		["gpt-5.4-mini"],
	);

	const projectKeyConfig = JSON.parse(readFileSync(join(result.root, ".pi", "khala", "litellm.json"), "utf8"));
	assert.equal(projectKeyConfig.providers["team-litellm"].keyEnv, "reeds-maint");

	const settings = JSON.parse(readFileSync(join(result.root, ".pi", "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "team-litellm");
	assert.equal(settings.defaultModel, "gpt-5.4-mini");
	assert.equal(settings.enabledModels, undefined);

	const registry = JSON.parse(readFileSync(join(result.agentDir, "khala", "litellm-keys.json"), "utf8"));
	assert.deepEqual(registry.keys, [
		{ provider: "team-litellm", keyEnv: "reeds-maint", baseUrl: "https://lite.example/v1", modelIds: ["gpt-5.4-mini"] },
	]);

	assert.equal(existsSync(join(result.agentDir, "auth.json")), false);
});

test("setup preserves an existing provider that Khala does not manage", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-litellm-provider-collision-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const existingModels = {
		providers: {
			"shared-proxy": {
				baseUrl: "https://shared.example/v1",
				api: "openai-completions",
				apiKey: "$SHARED_PROXY_KEY",
				models: [{ id: "shared-model" }],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(existingModels, null, 2)}\n`);

	const result = runKhalaLitellm(
		[
			"--provider",
			"shared-proxy",
			"--base-url",
			"https://lite.example/v1",
			"--key-env",
			"reeds-maint",
			"--model",
			"gpt-5.4-mini",
			"--auth-mode=skip",
			"--yes",
		],
		{ cwd: root, env: { PI_CODING_AGENT_DIR: agentDir } },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /is not managed by Khala/);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")), existingModels);
});

test("non-interactive setup preserves Pi model ids containing slashes and colons", () => {
	const result = runKhalaLitellm([
		"--provider",
		"team-litellm",
		"--base-url",
		"https://lite.example/v1",
		"--key-env",
		"reeds-maint",
		"--model",
		"openai/gpt-4o:extended",
		"--auth-mode=skip",
		"--project-settings",
		"--yes",
	]);
	assert.equal(result.status, 0, result.stderr);

	const models = JSON.parse(readFileSync(join(result.agentDir, "models.json"), "utf8"));
	assert.deepEqual(models.providers["team-litellm"].models, [{ id: "openai/gpt-4o:extended" }]);

	const settings = JSON.parse(readFileSync(join(result.root, ".pi", "settings.json"), "utf8"));
	assert.equal(settings.defaultModel, "openai/gpt-4o:extended");
	assert.equal(settings.enabledModels, undefined);
});

test("--auth-mode=literal writes auth.json with 0600 permissions and never echoes the key", () => {
	const result = runKhalaLitellm([
		"--provider",
		"acme",
		"--base-url",
		"https://acme.example/v1",
		"--key-env",
		"acme-key",
		"--model",
		"gpt-x",
		"--auth-mode=literal",
		"--auth-key=sk-super-secret",
		"--yes",
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /sk-super-secret/);
	assert.doesNotMatch(result.stderr, /sk-super-secret/);

	const authPath = join(result.agentDir, "auth.json");
	const auth = JSON.parse(readFileSync(authPath, "utf8"));
	assert.equal(auth.acme, undefined);
	assert.deepEqual(auth["acme:acme-key"], { type: "api_key", key: "sk-super-secret" });
	const mode = statSync(authPath).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("setup refuses a provider-level credential that would bypass project key selection", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-litellm-provider-auth-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ "team-litellm": { type: "api_key", key: "provider-key" } }, null, 2)}\n`,
	);

	const result = runKhalaLitellm(
		[
			"--provider",
			"team-litellm",
			"--base-url",
			"https://lite.example/v1",
			"--key-env",
			"reeds-maint",
			"--model",
			"gpt-5.4-mini",
			"--auth-mode=skip",
			"--yes",
		],
		{ cwd: root, env: { PI_CODING_AGENT_DIR: agentDir } },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /provider-level auth\.json entry/);
	assert.equal(existsSync(join(agentDir, "models.json")), false);
});

test("--dry-run shows a Khala-style LiteLLM configuration without writing files", () => {
	const result = runKhalaLitellm([
		"--provider",
		"team-litellm",
		"--base-url",
		"https://lite.example/v1",
		"--key-env",
		"reeds-maint",
		"--model",
		"gpt-5.4-mini",
		"--project-settings",
		"--dry-run",
		"--yes",
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /LiteLLM configuration/);
	assert.match(result.stdout, /\+ Pi models\s+.*models\.json/);
	assert.match(result.stdout, /\+ project key\s+.*\.pi\/khala\/litellm\.json/);
	assert.match(result.stdout, /= authentication\s+environment \$REEDS_MAINT/);
	assert.match(result.stdout, /\+ project defaults\s+.*settings\.json \(all models enabled\)/);
	assert.match(result.stdout, /Dry run\.\s+Run without --dry-run to write the LiteLLM configuration\./);
	assert.equal(existsSync(join(result.agentDir, "models.json")), false);
});

test("print-key resolves the derived environment variable", () => {
	const setup = runKhalaLitellm([
		"--provider",
		"team-litellm",
		"--base-url",
		"https://lite.example/v1",
		"--key-env",
		"reeds-maint",
		"--model",
		"gpt-5.4-mini",
		"--auth-mode=skip",
		"--yes",
	]);
	assert.equal(setup.status, 0, setup.stderr);

	const printed = runKhalaLitellm(["print-key", "--provider", "team-litellm"], {
		cwd: setup.root,
		env: { PI_CODING_AGENT_DIR: setup.agentDir, REEDS_MAINT: "resolved-from-env" },
	});
	assert.equal(printed.status, 0, printed.stderr);
	assert.equal(printed.stdout, "resolved-from-env");
});

test("print-key fails with an actionable diagnostic when no key is available", () => {
	const setup = runKhalaLitellm([
		"--provider",
		"team-litellm",
		"--base-url",
		"https://lite.example/v1",
		"--key-env",
		"reeds-maint",
		"--model",
		"gpt-5.4-mini",
		"--auth-mode=skip",
		"--yes",
	]);
	assert.equal(setup.status, 0, setup.stderr);

	const printed = runKhalaLitellm(["print-key", "--provider", "team-litellm"], {
		cwd: setup.root,
		env: { PI_CODING_AGENT_DIR: setup.agentDir },
	});
	assert.equal(printed.status, 2);
	assert.equal(printed.stdout, "");
	assert.match(printed.stderr, /REEDS_MAINT/);
});

test("print-key ignores provider-level auth so each project selects its recorded key label", () => {
	const setup = runKhalaLitellm([
		"--provider",
		"team-litellm",
		"--base-url",
		"https://lite.example/v1",
		"--key-env",
		"reeds-maint",
		"--model",
		"gpt-5.4-mini",
		"--auth-mode=skip",
		"--yes",
	]);
	assert.equal(setup.status, 0, setup.stderr);
	writeFileSync(
		join(setup.agentDir, "auth.json"),
		`${JSON.stringify({ "team-litellm": { type: "api_key", key: "provider-fallback" } }, null, 2)}\n`,
	);

	const printed = runKhalaLitellm(["print-key", "--provider", "team-litellm"], {
		cwd: setup.root,
		env: { PI_CODING_AGENT_DIR: setup.agentDir },
	});
	assert.equal(printed.status, 2);
	assert.equal(printed.stdout, "");
	assert.match(printed.stderr, /REEDS_MAINT/);
});

test("print-key fails clearly when no project config exists", () => {
	const result = runKhalaLitellm(["print-key", "--provider", "team-litellm"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Run khala litellm first/);
});
