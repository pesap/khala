import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  LITELLM_PROVIDER_API,
  MALFORMED_PROFILE_MESSAGE,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectSettings,
  normalizeCustomProfileEntry,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  parseProfileEntry,
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

  assert.match(stdout, /Khala configuration\s+v\d/);
  assert.match(stdout, /\.pi\/settings\.json/);
  assert.match(stdout, /command\s+pi install -l npm:khala/);
  assert.match(stdout, /config\s+.*\.pi\/khala\/workflow-model\.yaml/);
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
  assert.match(stdout, /command\s+pi install -l npm:khala/);
});

test("khala CLI defaults to global scope in non-interactive dry-run mode", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--dry-run"]);

  assert.match(stdout, /~\/\.pi\/agent\/settings\.json/);
  assert.match(stdout, /command\s+pi install npm:khala/);
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

    assert.match(stdout, /Khala configuration\s+v\d/);
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
  assert.throws(() => normalizeLiteLLMModelPattern("team-litellm/*"), /slashes/);
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
      modelId: "gpt-5.4-mini",
    },
  );

  assert.equal(mergedModels.conflict, false);
  assert.equal(mergedModels.value.providers["team-litellm"].baseUrl, "https://lite.example/v1");
  assert.equal(mergedModels.value.providers["team-litellm"].api, LITELLM_PROVIDER_API);
  assert.equal(mergedModels.value.providers["team-litellm"].apiKey, "$LITELLM_API_KEY");
  assert.deepEqual(mergedModels.value.providers["team-litellm"].models.map((model) => model.id), ["gpt-4o", "gpt-5.4-mini"]);
  assert.equal(mergedModels.value.providers["other-provider"].api, "anthropic-messages");

  const mergedSettings = mergeLiteLLMProjectSettings(
    { theme: "dark", enabledModels: ["claude-*"], warnings: { foo: true } },
    { providerId: "team-litellm", modelId: "gpt-5.4-mini" },
  );

  assert.equal(mergedSettings.defaultProvider, "team-litellm");
  assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
  assert.deepEqual(mergedSettings.enabledModels, ["claude-*", "gpt-5.4-mini"]);
  assert.equal(mergedSettings.theme, "dark");
  assert.equal(mergedSettings.warnings.foo, true);
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
    assert.match(result.stdout, /LiteLLM setup/);
    assert.match(result.stdout, /models\.json/);
    assert.match(result.stdout, /\.pi\/settings\.json/);
    assert.match(result.stdout, /apiKey\s+\$LITELLM_API_KEY/);
    assert.doesNotMatch(result.stdout, /team-litellm\/\*/);
    assert.doesNotMatch(result.stdout, /LITELLM_API_KEY=/);
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
    assert.match(first.stdout, /LiteLLM setup/);
    assert.match(first.stdout, /existing provider config differs/);
    assert.doesNotMatch(first.stdout, /other-secret|OLD_KEY/);
    await assert.rejects(readFile(piLog, "utf8"));

    const mergedModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const provider = mergedModels.providers["team-litellm"];
    assert.equal(provider.baseUrl, "https://lite.example/v1");
    assert.equal(provider.api, LITELLM_PROVIDER_API);
    assert.equal(provider.apiKey, "$LITELLM_API_KEY");
    assert.deepEqual(provider.models.map((model) => model.id), ["gpt-4o", "gpt-5.4-mini"]);
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
    assert.deepEqual(rerunModels.providers["team-litellm"].models.map((model) => model.id), ["gpt-4o", "gpt-5.4-mini"]);
    assert.deepEqual(rerunSettings.enabledModels, ["claude-*", "gpt-5.4-mini"]);
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
