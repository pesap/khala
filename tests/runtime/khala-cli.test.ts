import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  DEFAULT_THINKING_LEVEL_MAP,
  LITELLM_PROVIDER_API,
  MALFORMED_PROFILE_MESSAGE,
  buildProfileChoices,
  filterValidLiteLLMModelNames,
  buildEnrichedModelEntries,
  liteLLMProviderExists,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectSettings,
  modelSupportsThinking,
  normalizeCustomProfileEntry,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  parseLiteLLMModelInfoResponse,
  parseProfileEntry,
  stringifyModelsJson,
  validateLiteLLMKeyEnv,
  validateLiteLLMProviderId,
} from "../../bin/khala-setup-lib.js";

const execFileAsync = promisify(execFile);

async function writeFakePi(binDir: string, body: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "pi"), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

async function runKhala(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  try {
    const result = await execFileAsync("node", [path.resolve("bin/khala.js"), ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : Number(error?.code) || 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : String(error?.stdout ?? ""),
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.stderr ?? ""),
    };
  }
}

test("khala CLI prints setup guidance without running pi in dry-run mode", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--project", "--dry-run"]);

  assert.match(stdout, /Khala configuration \[dry-run\]:/);
  assert.match(stdout, /scope\s+.*\.pi\/settings\.json/);
  assert.match(stdout, /config\s+.*\.pi\/khala\/workflow-model\.yaml/);
  assert.doesNotMatch(stdout, /^\s*command\b/m);
  assert.match(stdout, /planning\s+github-copilot\/gpt-5\.5:xhigh/);
  assert.match(stdout, /development\s+openai-codex\/gpt-5\.4-mini:medium/);
  assert.match(stdout, /peer-review\s+github-copilot\/claude-opus-4\.7:high/);
});

test("khala CLI exposes help with commands, flags, examples, and environment sections", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--help"]);

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Commands:/);
  assert.match(stdout, /Flags:/);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /Environment:/);
  assert.match(stdout, /--global/);
  assert.match(stdout, /--project/);
  assert.match(stdout, /--yes/);
  assert.match(stdout, /--no-input/);
  assert.match(stdout, /PI_CODING_AGENT_DIR/);
  assert.match(stdout, /NO_COLOR/);
  assert.match(stdout, /khala litellm --help/);
});

test("khala CLI accepts --no-input as an alias for --yes", async () => {
  const { stdout } = await execFileAsync("node", [
    "bin/khala.js",
    "--project",
    "--no-input",
    "--dry-run",
  ]);

  assert.match(stdout, /planning\s+github-copilot\/gpt-5\.5:xhigh/);
  assert.match(stdout, /config\s+.*\.pi\/khala\/workflow-model\.yaml/);
  assert.doesNotMatch(stdout, /^\s*command\b/m);
});

test("khala CLI defaults to global scope in non-interactive dry-run mode", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--dry-run"]);

  assert.match(stdout, /scope\s+.*\.pi\/agent\/settings\.json/);
  assert.match(stdout, /config\s+.*workflow-model\.yaml/);
  assert.doesNotMatch(stdout, /^\s*command\b/m);
});

test("khala CLI writes project workflow config after successful install", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-install-"));
  const binDir = path.join(tempDir, "bin");
  const piLog = path.join(tempDir, "pi.log");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "pi"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(piLog)}\n`,
      { mode: 0o755 },
    );

    const { stdout } = await execFileAsync(
      "node",
      [path.resolve("bin/khala.js"), "--project", "--yes"],
      {
        cwd: tempDir,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );

    const config = await readFile(path.join(tempDir, ".pi", "khala", "workflow-model.yaml"), "utf8");
    assert.equal(await readFile(piLog, "utf8"), "install -l npm:khala\n");
    assert.match(stdout, /Installed\.\s+Config written to.*\.pi\/khala\/workflow-model\.yaml/);
    assert.match(config, /planning: "github-copilot\/gpt-5\.5:xhigh"/);
    assert.match(config, /development: "openai-codex\/gpt-5\.4-mini:medium"/);
    assert.match(config, /peer-review: "github-copilot\/claude-opus-4\.7:high"/);
    assert.match(config, /peer-review: "peer-review"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala CLI summary omits provider/availability noise and never prints model.json secrets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-summary-"));
  const binDir = path.join(tempDir, "bin");
  const piAgentDir = path.join(tempDir, "pi-agent");
  const piLog = path.join(tempDir, "pi.log");

  try {
    await writeFakePi(
      binDir,
      `printf '%s\n' "$*" >> ${JSON.stringify(piLog)}
printf 'unexpected pi invocation: %s\n' "$*" >&2
exit 99
`,
    );
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      path.join(piAgentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "litellm-team-a": {
              baseUrl: "https://lite.example/v1",
              api: "openai-completions",
              apiKey: "team-a-secret",
              models: [{ id: "gpt-5.4-mini" }],
            },
            "anthropic-cloud": {
              baseUrl: "https://anthropic.example/v1",
              api: "anthropic-messages",
              apiKey: "anthropic-secret",
              models: [{ id: "claude-opus-4.7" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.resolve("bin/khala.js"), "--project", "--yes", "--dry-run"],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PI_CODING_AGENT_DIR: piAgentDir,
        },
      },
    );

    assert.match(stdout, /Khala configuration/);
    assert.match(stdout, /planning\s+github-copilot\/gpt-5\.5:xhigh/);
    assert.match(stdout, /development\s+openai-codex\/gpt-5\.4-mini:medium/);
    assert.match(stdout, /peer-review\s+github-copilot\/claude-opus-4\.7:high/);
    assert.doesNotMatch(stdout, /^\s*providers\b/m);
    assert.doesNotMatch(stdout, /availability/);
    assert.doesNotMatch(stdout, /openai-completions|anthropic-messages|openai-responses/);
    assert.doesNotMatch(stdout, /team-a-secret|anthropic-secret/);
    assert.equal(stderr, "");

    const piInvocations = await readFile(piLog, "utf8").catch(() => "");
    assert.equal(piInvocations, "", "pi should not be invoked in non-interactive --dry-run");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala setup helper normalizes malformed custom model strings with a clear message", () => {
  assert.equal(parseProfileEntry("not-a-model"), null);
  assert.equal(parseProfileEntry("github-copilot/gpt-5.4-mini:made-up"), null);

  const normalized = normalizeCustomProfileEntry("not-a-model", "github-copilot/gpt-5.4-mini:medium");
  assert.equal(normalized.value, "github-copilot/gpt-5.4-mini:medium");
  assert.equal(normalized.errorMessage, MALFORMED_PROFILE_MESSAGE);
  assert.match(MALFORMED_PROFILE_MESSAGE, /provider\/model:thinking/);
});

test("khala setup helper validates LiteLLM provider, base URL, env, and model inputs", () => {
  assert.equal(validateLiteLLMProviderId(" team-litellm "), "team-litellm");
  assert.equal(validateLiteLLMKeyEnv(" LITELLM_API_KEY "), "LITELLM_API_KEY");
  assert.equal(normalizeLiteLLMBaseUrl(" https://lite.example/v1/ "), "https://lite.example/v1");
  assert.equal(normalizeLiteLLMModelPattern(" gpt-5.4-mini "), "gpt-5.4-mini");

  assert.throws(() => validateLiteLLMProviderId("team litellm"), /Provider id must match/);
  assert.throws(() => validateLiteLLMKeyEnv("1BAD"), /Key environment variable must match/);
  assert.throws(() => normalizeLiteLLMBaseUrl("https://lite.example/v1?x=1"), /query string/);
  assert.throws(() => normalizeLiteLLMBaseUrl("ftp://lite.example/v1"), /must start with http:\/\//);
  assert.throws(() => normalizeLiteLLMModelPattern("team-litellm/*"), /'\/' or ':'/);
  assert.throws(() => normalizeLiteLLMModelPattern("vendor:thinking"), /'\/' or ':'/);
  // Real LiteLLM hubs publish model ids with internal whitespace; only / and :
  // are structurally reserved, so spaces must round-trip unchanged.
  assert.equal(normalizeLiteLLMModelPattern(" HALO Gemma 4 "), "HALO Gemma 4");
});

test("khala setup helper builds profile picker choices from all discovery rows and LiteLLM models", () => {
  const providers = [
    {
      name: "nlr",
      baseUrl: "https://nlr.example/v1",
      api: "openai-completions",
      models: ["gpt-5.5", "gpt-5.4-mini", "text-embedding-3-large"],
    },
    {
      name: "mlx-community",
      baseUrl: "https://mlx.example/v1",
      api: "openai-completions",
      models: ["claude-opus-4.7"],
    },
  ];
  const rows = [
    { provider: "github-copilot", model: "gpt-5.5", thinking: true },
    { provider: "azure-openai-responses", model: "gpt-5.5-pro", thinking: true },
    { provider: "openai-codex", model: "text-embedding-3-large", thinking: false },
  ];

  const choices = buildProfileChoices(providers, rows, [
    "github-copilot/gpt-5.5:xhigh",
  ]);

  // Every discovery row is offered.
  assert.equal(choices.includes("github-copilot/gpt-5.5"), true);
  assert.equal(choices.includes("azure-openai-responses/gpt-5.5-pro"), true);
  assert.equal(choices.includes("openai-codex/text-embedding-3-large"), true);

  // Every explicitly-listed LiteLLM provider model is offered.
  assert.equal(choices.includes("nlr/gpt-5.5"), true);
  assert.equal(choices.includes("nlr/gpt-5.4-mini"), true);
  assert.equal(choices.includes("nlr/text-embedding-3-large"), true);
  assert.equal(choices.includes("mlx-community/claude-opus-4.7"), true);

  // No duplicates even when discovery and fallback overlap.
  assert.equal(new Set(choices).size, choices.length);
});

test("khala setup helper falls back to preset model ids without thinking suffix when discovery and providers are empty", () => {
  const choices = buildProfileChoices([], [], [
    "openai-codex/gpt-5.4-mini:medium",
    "github-copilot/gpt-5.4-mini:medium",
  ]);

  assert.deepEqual(choices, [
    "openai-codex/gpt-5.4-mini",
    "github-copilot/gpt-5.4-mini",
  ]);
});

test("khala setup helper skips LiteLLM providers with no explicit model list", () => {
  const providers = [
    { name: "sparse", baseUrl: "https://sparse.example/v1", api: "openai-completions", models: [] },
    { name: "nlr", baseUrl: "https://nlr.example/v1", api: "openai-completions", models: ["gpt-5.5"] },
  ];

  const choices = buildProfileChoices(providers, [], ["github-copilot/gpt-5.5:xhigh"]);

  assert.equal(choices.some((c) => c.startsWith("sparse/")), false);
  assert.equal(choices.includes("nlr/gpt-5.5"), true);
  assert.equal(choices.includes("github-copilot/gpt-5.5"), true);
});

test("khala setup helper filters LiteLLM model picker choices to bare names that pass validation", () => {
  const filtered = filterValidLiteLLMModelNames([
    "gpt-4o-mini",
    "claude-opus-4.7",
    "gpt-4o-mini",                    // duplicate: dropped
    "text-embed:v1",                  // colon: dropped
    "vendor/model",                   // slash: dropped
    "HALO Gemma 4",                    // internal whitespace is allowed
    "",                                // empty: dropped
    "   ",                             // whitespace-only: dropped after trim
    null,                              // non-string: dropped
    undefined,                         // non-string: dropped
    "  gpt-5.5  ",                    // edge whitespace trimmed and accepted
    "gpt-5.5",                        // duplicate of trimmed: dropped
  ]);

  assert.deepEqual(filtered, ["gpt-4o-mini", "claude-opus-4.7", "HALO Gemma 4", "gpt-5.5"]);
});

test("khala setup helper stringifyModelsJson collapses { id } entries to one line", () => {
  const out = stringifyModelsJson({
    providers: {
      nlr: {
        baseUrl: "https://litellm.nlr.gov",
        api: "openai-responses",
        apiKey: "$NLR_KEY",
        models: [
          { id: "claude-sonnet-4-6" },
          { id: "HALO Gemma 4" },
          { id: "text-embedding-3-large", displayName: "big-embed" }, // extra fields preserved on multiple lines
        ],
      },
    },
  });

  // JSON.parse round-trip must be lossless.
  const parsed = JSON.parse(out);
  assert.equal(parsed.providers.nlr.models.length, 3);
  assert.equal(parsed.providers.nlr.models[0].id, "claude-sonnet-4-6");
  assert.equal(parsed.providers.nlr.models[1].id, "HALO Gemma 4");
  assert.equal(parsed.providers.nlr.models[2].displayName, "big-embed");

  // Single-`id` entries are collapsed.
  assert.match(out, /\{ "id": "claude-sonnet-4-6" \}/);
  assert.match(out, /\{ "id": "HALO Gemma 4" \}/);
  // Multi-field entries keep the default pretty-printed shape.
  assert.match(out, /\{\n\s+"id": "text-embedding-3-large",\n\s+"displayName": "big-embed"\n\s+\}/);
  // Top-level structure stays pretty-printed.
  assert.match(out, /"providers": \{\n\s+"nlr": \{/);
});

test("khala setup helper parseLiteLLMModelInfoResponse maps LiteLLM fields to pi shape", () => {
  const map = parseLiteLLMModelInfoResponse({
    data: [
      {
        model_name: "gpt-5.3-codex",
        model_info: {
          max_input_tokens: 1_050_000,
          max_output_tokens: 128_000,
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 0,
          cache_creation_input_token_cost: 0,
          supports_reasoning: true,
          supports_vision: true,
        },
      },
      {
        model_name: "text-embedding-3-small",
        model_info: {
          max_input_tokens: 8192,
          input_cost_per_token: 0.00000002,
          // No supports_vision / supports_reasoning at all.
        },
      },
      { model_name: "   " },                                  // blank: dropped
      { not_a_model: true },                                   // shape mismatch: dropped
    ],
  });

  assert.equal(map.size, 2);

  const codex = map.get("gpt-5.3-codex");
  assert.deepEqual(codex, {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    reasoning: true,
    thinkingLevelMap: { ...DEFAULT_THINKING_LEVEL_MAP },
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 0 },
  });

  const embed = map.get("text-embedding-3-small");
  // No reasoning => no thinkingLevelMap. No vision => input is text-only.
  // No max_output_tokens / cache costs => those fields are absent.
  assert.deepEqual(embed, {
    id: "text-embedding-3-small",
    name: "text-embedding-3-small",
    input: ["text"],
    contextWindow: 8192,
    cost: { input: 0.02 },
  });

  // Malformed responses must never throw — just return an empty map.
  assert.equal(parseLiteLLMModelInfoResponse(null).size, 0);
  assert.equal(parseLiteLLMModelInfoResponse({}).size, 0);
  assert.equal(parseLiteLLMModelInfoResponse({ data: "nope" }).size, 0);
});

test("khala setup helper buildEnrichedModelEntries prefers fetched, then existing, then bare", () => {
  const fetched = new Map([
    ["gpt-5.4-mini", { id: "gpt-5.4-mini", name: "gpt-5.4-mini", contextWindow: 200_000 }],
  ]);
  const existing = [
    { id: "gpt-5.4-mini", contextWindow: 999_999, custom: "keep-me" },  // overridden by fresh
    { id: "claude-opus-4-7", reasoning: true, customField: "preserved" }, // no fetched data
    { id: "stale-model", contextWindow: 0 },                              // not in modelIds: dropped
  ];

  const entries = buildEnrichedModelEntries(
    ["gpt-5.4-mini", "claude-opus-4-7", "brand-new-model"],
    fetched,
    existing,
  );

  assert.deepEqual(entries, [
    // Fetched data wins on overlap, existing fields not in fetched are preserved.
    { id: "gpt-5.4-mini", name: "gpt-5.4-mini", contextWindow: 200_000, custom: "keep-me" },
    // No fetched data: existing entry kept verbatim.
    { id: "claude-opus-4-7", reasoning: true, customField: "preserved" },
    // No fetched data, no existing: bare { id } only (no name=id duplication).
    { id: "brand-new-model" },
  ]);
});

test("khala setup helper liteLLMProviderExists detects existing provider entries", () => {
  const models = { providers: { foo: { baseUrl: "https://example.com" } } };
  assert.equal(liteLLMProviderExists(models, "foo"), true);
  assert.equal(liteLLMProviderExists(models, "missing"), false);
  assert.equal(liteLLMProviderExists(null, "foo"), false);
  assert.equal(liteLLMProviderExists({}, "foo"), false);
  assert.equal(liteLLMProviderExists({ providers: null }, "foo"), false);
  assert.equal(liteLLMProviderExists({ providers: { foo: null } }, "foo"), false);
});

test("khala setup helper merge uses REPLACE semantics and reports isUpdate/previousModelCount", () => {
  const existing = {
    providers: {
      "team-litellm": {
        baseUrl: "https://lite.example/v1",
        api: LITELLM_PROVIDER_API,
        apiKey: "$OLD_KEY",
        models: [
          { id: "gpt-4o", contextWindow: 128000, customField: "preserved" },
          { id: "gpt-5.4-mini" },
          { id: "deselected-model" },
        ],
      },
      "unrelated-anthropic": {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-opus-4.7" }],
      },
    },
  };

  const fresh = new Map([
    ["gpt-4o", { id: "gpt-4o", name: "gpt-4o", contextWindow: 256000, cost: { input: 2.5 } }],
  ]);

  const result = mergeLiteLLMModelsJson(existing, {
    providerId: "team-litellm",
    baseUrl: "https://lite.example/v1",
    keyEnv: "LITELLM_API_KEY",
    modelIds: ["gpt-4o", "gpt-5.4-mini"],   // user deselected `deselected-model`
    infoMap: fresh,
  });

  assert.equal(result.isUpdate, true, "detects existing provider");
  assert.equal(result.previousModelCount, 3, "reports previous count for the summary block");

  const newModels = result.value.providers["team-litellm"].models;
  // REPLACE: deselected-model dropped, order is modelIds order (not old order).
  assert.deepEqual(newModels.map((m: { id: string }) => m.id), ["gpt-4o", "gpt-5.4-mini"]);
  // Fresh data wins on overlap (contextWindow), existing-only fields kept (customField).
  assert.deepEqual(newModels[0], {
    id: "gpt-4o",
    name: "gpt-4o",
    contextWindow: 256000,
    cost: { input: 2.5 },
    customField: "preserved",
  });
  // gpt-5.4-mini was in existing without fetched data: kept as-is (bare).
  assert.deepEqual(newModels[1], { id: "gpt-5.4-mini" });
  // Unrelated provider untouched.
  assert.equal(result.value.providers["unrelated-anthropic"].api, "anthropic-messages");
  // apiKey reference is refreshed from keyEnv.
  assert.equal(result.value.providers["team-litellm"].apiKey, "$LITELLM_API_KEY");
});

test("khala setup helper merge reports isUpdate=false for a brand-new provider", () => {
  const result = mergeLiteLLMModelsJson(
    { providers: { other: { baseUrl: "https://x", api: "anthropic-messages", models: [] } } },
    { providerId: "brand-new", baseUrl: "https://new.example/v1", keyEnv: "K", modelIds: ["m1"] },
  );
  assert.equal(result.isUpdate, false);
  assert.equal(result.previousModelCount, 0);
  assert.deepEqual(
    result.value.providers["brand-new"].models.map((m: { id: string }) => m.id),
    ["m1"],
  );
});

test("khala setup helper reads thinking support from discovery rows and assumes yes when unknown", () => {
  const rows = [
    { provider: "github-copilot", model: "gpt-5.5", thinking: true },
    { provider: "azure-openai-responses", model: "gpt-4", thinking: false },
    { provider: "two-col-only", model: "some-model", thinking: undefined },
  ];

  assert.equal(modelSupportsThinking(rows, "github-copilot", "gpt-5.5"), true);
  assert.equal(modelSupportsThinking(rows, "azure-openai-responses", "gpt-4"), false);
  assert.equal(modelSupportsThinking(rows, "two-col-only", "some-model"), true);
  assert.equal(modelSupportsThinking(rows, "unknown-provider", "unknown-model"), true);
});

test("khala setup helper merges LiteLLM provider and project settings without clobbering unrelated entries", () => {
  const mergedModels = mergeLiteLLMModelsJson(
    {
      providers: {
        "other-provider": {
          baseUrl: "https://other.example/v1",
          api: "anthropic-messages",
          apiKey: "other-secret",
          models: [{ id: "claude-opus-4.7" }],
        },
        "team-litellm": {
          baseUrl: "https://lite.example/v1/",
          api: "openai-responses",
          apiKey: "$OLD_KEY",
          models: [{ id: "gpt-4o" }],
        },
      },
    },
    {
      providerId: "team-litellm",
      baseUrl: "https://lite.example/v1",
      keyEnv: "LITELLM_API_KEY",
      modelIds: ["gpt-5.4-mini"],
    },
  );

  assert.equal(mergedModels.conflict, false);
  assert.equal(mergedModels.value.providers["team-litellm"].baseUrl, "https://lite.example/v1");
  assert.equal(mergedModels.value.providers["team-litellm"].api, LITELLM_PROVIDER_API);
  assert.equal(mergedModels.value.providers["team-litellm"].apiKey, "$LITELLM_API_KEY");
  assert.deepEqual(mergedModels.value.providers["team-litellm"].models.map((model) => model.id), ["gpt-5.4-mini"]);
  assert.equal(mergedModels.value.providers["other-provider"].api, "anthropic-messages");

  const mergedSettings = mergeLiteLLMProjectSettings(
    { theme: "dark", enabledModels: ["claude-*"], warnings: { foo: true } },
    { providerId: "team-litellm", modelIds: ["gpt-5.4-mini"] },
  );

  assert.equal(mergedSettings.defaultProvider, "team-litellm");
  assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
  assert.deepEqual(mergedSettings.enabledModels, ["claude-*", "gpt-5.4-mini"]);
  assert.equal(mergedSettings.theme, "dark");
  assert.equal(mergedSettings.warnings.foo, true);
});

test("khala setup helper merges multiple LiteLLM models in a single pass with the first as the default", () => {
  const mergedModels = mergeLiteLLMModelsJson(
    { providers: { "team-litellm": { baseUrl: "https://lite.example/v1", api: LITELLM_PROVIDER_API, apiKey: "$LITELLM_API_KEY", models: [{ id: "gpt-4o" }] } } },
    {
      providerId: "team-litellm",
      baseUrl: "https://lite.example/v1",
      keyEnv: "LITELLM_API_KEY",
      modelIds: ["gpt-5.4-mini", "claude-opus-4.7", "gpt-5.4-mini"], // duplicates dropped
    },
  );

  assert.equal(mergedModels.conflict, false);
  assert.deepEqual(
    mergedModels.value.providers["team-litellm"].models.map((m) => m.id),
    ["gpt-5.4-mini", "claude-opus-4.7"],
  );

  const mergedSettings = mergeLiteLLMProjectSettings(
    { enabledModels: ["claude-*"] },
    { providerId: "team-litellm", modelIds: ["gpt-5.4-mini", "claude-opus-4.7"] },
  );

  assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini", "defaultModel is the first id supplied");
  assert.deepEqual(mergedSettings.enabledModels, ["claude-*", "gpt-5.4-mini", "claude-opus-4.7"]);
});

test("khala litellm --help documents the LiteLLM setup mode and secret boundary", async () => {
  const { stdout } = await runKhala(["litellm", "--help"]);

  assert.equal(stdout.includes("khala litellm - configure a LiteLLM-compatible Pi provider"), true);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Flags:/);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /Environment:/);
  assert.match(stdout, /--provider/);
  assert.match(stdout, /--base-url/);
  assert.match(stdout, /--key-env/);
  assert.match(stdout, /--project/);
  assert.match(stdout, /--yes/);
  assert.match(stdout, /--no-input/);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /PI_CODING_AGENT_DIR/);
  assert.match(stdout, /raw API keys are never requested or stored/);
});

test("khala litellm dry-run prints config paths without writing files or calling pi", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-dry-run-"));
  const binDir = path.join(tempDir, "bin");
  const piAgentDir = path.join(tempDir, "pi-agent");
  const piLog = path.join(tempDir, "pi.log");

  try {
    await writeFakePi(binDir, `printf 'called\n' > ${JSON.stringify(piLog)}`);

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        "https://lite.example/v1",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--dry-run",
      ],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: piAgentDir,
      },
      tempDir,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Khala LiteLLM \[dry-run\]:/);
    assert.match(result.stdout, /models\s+.*models\.json/);
    assert.match(result.stdout, /settings\s+.*\.pi\/settings\.json/);
    assert.match(result.stdout, /provider\s+team-litellm/);
    assert.match(result.stdout, /api\s+openai-completions/);
    assert.match(result.stdout, /apiKey\s+\$LITELLM_API_KEY/);
    assert.match(result.stdout, /model\s+gpt-5\.4-mini/);
    assert.doesNotMatch(result.stdout, /team-litellm\/\*/);
    // Forbid actual secret-shaped leaks (KEY=<real-value>). The pre-flight
    // banner legitimately includes the placeholder `export KEY=<your-key>`
    // as a how-to-fix hint when the env var isn't exported — that's
    // documentation, not a leak.
    assert.doesNotMatch(result.stdout, /LITELLM_API_KEY=(?!<)\S/);
    assert.doesNotMatch(result.stdout, /raw API keys are never requested or stored/);
    await assert.rejects(readFile(piLog, "utf8"));
    await assert.rejects(readFile(path.join(piAgentDir, "models.json"), "utf8"));
    await assert.rejects(readFile(path.join(tempDir, ".pi", "settings.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm exits 2 when required inputs are missing in non-TTY mode", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-missing-"));

  try {
    const result = await runKhala(["litellm", "--dry-run"], {}, tempDir);

    assert.equal(result.code, 2);
    assert.match(result.stderr || result.stdout, /Missing required LiteLLM options:/);
    assert.match(result.stderr || result.stdout, /--provider/);
    assert.match(result.stderr || result.stdout, /--base-url/);
    assert.match(result.stderr || result.stdout, /--key-env/);
    assert.match(result.stderr || result.stdout, /--model/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm updates a LiteLLM provider and project settings idempotently", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-merge-"));
  const binDir = path.join(tempDir, "bin");
  const piAgentDir = path.join(tempDir, "pi-agent");
  const piLog = path.join(tempDir, "pi.log");
  const modelsPath = path.join(piAgentDir, "models.json");
  const settingsPath = path.join(tempDir, ".pi", "settings.json");
  const authPath = path.join(piAgentDir, "auth.json");
  const projectAuthPath = path.join(tempDir, ".pi", "auth.json");

  try {
    await writeFakePi(binDir, `printf 'called\n' > ${JSON.stringify(piLog)}`);
    await mkdir(path.dirname(modelsPath), { recursive: true });
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      modelsPath,
      JSON.stringify(
        {
          providers: {
            "other-provider": {
              baseUrl: "https://other.example/v1",
              api: "anthropic-messages",
              apiKey: "other-secret",
              models: [{ id: "claude-opus-4.7" }],
            },
            "team-litellm": {
              baseUrl: "https://old.example/v1/",
              api: "anthropic-messages",
              apiKey: "$OLD_KEY",
              models: [{ id: "gpt-4o" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", enabledModels: ["claude-*"], warnings: { foo: true } }, null, 2),
      "utf8",
    );

    const env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: piAgentDir,
    };

    const first = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        " https://lite.example/v1/ ",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--yes",
      ],
      env,
      tempDir,
    );

    assert.equal(first.code, 0);
    assert.match(first.stdout, /Khala LiteLLM:/);
    assert.match(first.stdout, /existing provider config differs/);
    assert.doesNotMatch(first.stdout, /other-secret|OLD_KEY/);
    await assert.rejects(readFile(piLog, "utf8"));

    const mergedModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const provider = mergedModels.providers["team-litellm"];
    assert.equal(provider.baseUrl, "https://lite.example/v1");
    assert.equal(provider.api, LITELLM_PROVIDER_API);
    assert.equal(provider.apiKey, "$LITELLM_API_KEY");
    assert.deepEqual(provider.models.map((model) => model.id), ["gpt-5.4-mini"]);
    assert.equal(mergedModels.providers["other-provider"].api, "anthropic-messages");

    const mergedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(mergedSettings.defaultProvider, "team-litellm");
    assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
    assert.deepEqual(mergedSettings.enabledModels, ["claude-*", "gpt-5.4-mini"]);
    assert.equal(mergedSettings.theme, "dark");
    assert.equal(mergedSettings.warnings.foo, true);
    assert.doesNotMatch(JSON.stringify(mergedSettings), /team-litellm\/\*/);

    await assert.rejects(readFile(authPath, "utf8"));
    await assert.rejects(readFile(projectAuthPath, "utf8"));

    const second = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        "https://lite.example/v1",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--yes",
      ],
      env,
      tempDir,
    );

    assert.equal(second.code, 0);
    const rerunModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const rerunSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(rerunModels.providers["team-litellm"].models.map((model) => model.id), ["gpt-5.4-mini"]);
    assert.deepEqual(rerunSettings.enabledModels, ["claude-*", "gpt-5.4-mini"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm registers multiple models in one pass via --model a,b,c", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-multi-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const modelsPath = path.join(piAgentDir, "models.json");
  const settingsPath = path.join(tempDir, ".pi", "settings.json");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.dirname(settingsPath), { recursive: true });

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider", "team-litellm",
        "--base-url", "https://lite.example/v1",
        "--key-env", "LITELLM_API_KEY",
        "--model", "gpt-5.4-mini, gpt-4o ,claude-opus-4.7",  // whitespace + duplicates resilience
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0);
    // Summary collapses the model list to one labeled row with a +N more
    // suffix, matching the one-row-per-concept aesthetic of the main khala
    // configuration block. The full list is verifiable in models.json.
    assert.match(result.stdout, /model\s+gpt-5\.4-mini\s+\+2 more/);
    assert.doesNotMatch(result.stdout, /\n\s{8,}gpt-4o\b/, "no model continuation rows");
    assert.doesNotMatch(result.stdout, /\n\s{8,}claude-opus-4\.7\b/, "no model continuation rows");

    const rawModels = await readFile(modelsPath, "utf8");
    // Compact format: each `{ "id": "..." }` entry is rendered on one line.
    assert.match(rawModels, /\{ "id": "gpt-5\.4-mini" \}/);
    assert.match(rawModels, /\{ "id": "gpt-4o" \}/);
    assert.doesNotMatch(rawModels, /\{\n\s+"id": "gpt-4o"\n\s+\}/, "models entries must not sprawl");

    const merged = JSON.parse(rawModels);
    assert.deepEqual(
      merged.providers["team-litellm"].models.map((m: { id: string }) => m.id),
      ["gpt-5.4-mini", "gpt-4o", "claude-opus-4.7"],
    );
    assert.equal(merged.providers["team-litellm"].apiKey, "$LITELLM_API_KEY");

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "team-litellm");
    assert.equal(settings.defaultModel, "gpt-5.4-mini");
    assert.deepEqual(settings.enabledModels, ["gpt-5.4-mini", "gpt-4o", "claude-opus-4.7"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm enriches model entries from a LiteLLM /model/info endpoint", async () => {
  // Stand up a fake LiteLLM proxy that serves /model/info. The fixture is
  // intentionally minimal: enough surface to verify that field mapping,
  // /v1-stripping, and the replace-semantics merge all work end-to-end.
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/model/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            model_name: "gpt-5.3-codex",
            model_info: {
              max_input_tokens: 1_050_000,
              max_output_tokens: 128_000,
              input_cost_per_token: 0.0000025,
              output_cost_per_token: 0.000015,
              cache_read_input_token_cost: 0,
              cache_creation_input_token_cost: 0,
              supports_reasoning: true,
              supports_vision: true,
            },
          },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-enrich-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const modelsPath = path.join(piAgentDir, "models.json");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", baseUrl,
        "--key-env", "FAKE_LITELLM_KEY",
        "--model", "gpt-5.3-codex",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir, FAKE_LITELLM_KEY: "sk-fake-not-real" },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    // Summary surfaces the metadata fetch result and the "new provider" tag.
    assert.match(result.stdout, /provider\s+nlr\s+\(new\)/);
    assert.match(result.stdout, /metadata\s+1\/1 enriched from \/model\/info/);
    // Secret never echoed back into stdout/stderr.
    assert.doesNotMatch(result.stdout + result.stderr, /sk-fake-not-real/);

    // Server received the request at the root /model/info (not /v1/model/info)
    // and got a Bearer auth header carrying the env-var value.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/model/info");
    assert.equal(requests[0].auth, "Bearer sk-fake-not-real");

    // models.json carries the full enriched entry, not just { id }.
    const merged = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.deepEqual(merged.providers.nlr.models, [
      {
        id: "gpt-5.3-codex",
        name: "gpt-5.3-codex",
        reasoning: true,
        thinkingLevelMap: { ...DEFAULT_THINKING_LEVEL_MAP },
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm prints a loud pre-flight warning when the key env var is not exported", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-noexport-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    // Note: NO `DEFINITELY_UNSET_KEY` in the spawn env. We're testing the
    // pre-flight detection path: enrichment must not silently degrade.
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", "https://example.com/v1",
        "--key-env", "DEFINITELY_UNSET_KEY",
        "--model", "gpt-4o",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0);
    // (1) Pre-flight banner above the summary — unmissable, multi-line,
    //     and tells the user exactly how to fix it.
    assert.match(result.stdout, /! \$DEFINITELY_UNSET_KEY is not exported in this shell\./);
    assert.match(result.stdout, /Models will be written as bare/);
    assert.match(result.stdout, /export DEFINITELY_UNSET_KEY=<your-key>/);
    // (2) Summary's metadata row says NOT FETCHED loudly, not a meek "skipped".
    assert.match(result.stdout, /metadata\s+.*NOT FETCHED — \$DEFINITELY_UNSET_KEY is not exported/);
    // (3) The fallback write still proceeds with bare { id } entries.
    const raw = await readFile(path.join(piAgentDir, "models.json"), "utf8");
    assert.match(raw, /\{ "id": "gpt-4o" \}/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm degrades to bare entries when /model/info is unreachable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-noenrich-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    // Port 1 is reserved/unbound; the connection refuses fast on every OS.
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "unreachable",
        "--base-url", "http://127.0.0.1:1/v1",
        "--key-env", "FAKE_KEY",
        "--model", "gpt-4o",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir, FAKE_KEY: "sk-fake" },
      tempDir,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /metadata\s+fetch failed/);
    assert.match(result.stdout, /writing bare entries/);

    // Bare entries get the compact one-line treatment.
    const raw = await readFile(path.join(piAgentDir, "models.json"), "utf8");
    assert.match(raw, /\{ "id": "gpt-4o" \}/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm fails closed on malformed models.json", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-malformed-models-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await writeFile(path.join(piAgentDir, "models.json"), "{ not-json", "utf8");
    await writeFile(path.join(tempDir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }, null, 2), "utf8");

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        "https://lite.example/v1",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--dry-run",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr || result.stdout, /models\.json/);
    assert.match(result.stderr || result.stdout, /Failed to parse/);
    assert.equal(await readFile(path.join(piAgentDir, "models.json"), "utf8"), "{ not-json");
    assert.equal(await readFile(path.join(tempDir, ".pi", "settings.json"), "utf8"), JSON.stringify({ theme: "dark" }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm fails closed on malformed .pi/settings.json", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-malformed-settings-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await writeFile(path.join(piAgentDir, "models.json"), JSON.stringify({ providers: {} }, null, 2), "utf8");
    await writeFile(path.join(tempDir, ".pi", "settings.json"), "{ not-json", "utf8");

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        "https://lite.example/v1",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--dry-run",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr || result.stdout, /\.pi\/settings\.json/);
    assert.match(result.stderr || result.stdout, /Failed to parse/);
    assert.equal(await readFile(path.join(piAgentDir, "models.json"), "utf8"), JSON.stringify({ providers: {} }, null, 2));
    assert.equal(await readFile(path.join(tempDir, ".pi", "settings.json"), "utf8"), "{ not-json");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm requires --yes before overwriting a conflicting provider in non-TTY mode", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-conflict-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await writeFile(
      path.join(piAgentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "team-litellm": {
              baseUrl: "https://old.example/v1",
              api: "anthropic-messages",
              apiKey: "$OLD_KEY",
              models: [{ id: "gpt-4o" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(tempDir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }, null, 2), "utf8");

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider",
        "team-litellm",
        "--base-url",
        "https://lite.example/v1",
        "--key-env",
        "LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 2);
    assert.match(result.stdout, /existing provider config differs/);
    assert.match(result.stderr, /LiteLLM setup writes require --yes in non-interactive mode\./);
    const models = JSON.parse(await readFile(path.join(piAgentDir, "models.json"), "utf8"));
    assert.equal(models.providers["team-litellm"].baseUrl, "https://old.example/v1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
