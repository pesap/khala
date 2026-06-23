import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MALFORMED_PROFILE_MESSAGE, normalizeCustomProfileEntry, parseProfileEntry } from "../../bin/khala-setup-lib.js";

const execFileAsync = promisify(execFile);

async function writeFakePi(binDir: string, body: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "pi"), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
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

test("khala CLI exposes help", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--help"]);

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--global/);
  assert.match(stdout, /--project/);
  assert.match(stdout, /--yes/);
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

test("khala CLI discovers Pi availability and LiteLLM aliases without printing secrets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-discovery-"));
  const binDir = path.join(tempDir, "bin");
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await writeFakePi(
      binDir,
      `if [[ "$*" == "--list-models gpt-5.5" ]]; then
  printf 'provider model\n'
  printf 'github-copilot gpt-5.5\n'
  exit 0
fi
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model\n'
  printf 'openai-codex gpt-5.4-mini\n'
  exit 0
fi
if [[ "$*" == "--list-models claude-opus-4.7" ]]; then
  printf 'provider model\n'
  printf 'github-copilot claude-opus-4.7\n'
  exit 0
fi
printf 'provider model\n'
exit 0
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
            "litellm-team-b": {
              baseUrl: "https://lite.example/v1",
              api: "openai-responses",
              apiKey: "team-b-secret",
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
    assert.match(stdout, /development\s+openai-codex\/gpt-5\.4-mini:medium/);
    assert.match(stdout, /peer-review\s+github-copilot\/claude-opus-4\.7:high/);
    assert.match(stdout, /providers/);
    assert.match(stdout, /◦ litellm-team-a/);
    assert.match(stdout, /openai-completions/);
    assert.match(stdout, /◦ litellm-team-b/);
    assert.match(stdout, /openai-responses/);
    assert.match(stdout, /✓ development\s+openai-codex\/gpt-5\.4-mini/);
    assert.match(stdout, /openai-codex.*litellm-team-a|litellm-team-a.*openai-codex/);
    assert.doesNotMatch(stdout, /team-a-secret|team-b-secret|anthropic-secret/);
    assert.equal(stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala CLI reports provider discovery skipped when pi is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-skip-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.resolve("bin/khala.js"), "--project", "--dry-run"],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: tempDir,
          PI_CODING_AGENT_DIR: piAgentDir,
        },
      },
    );

    assert.match(stdout, /availability/);
    assert.match(stdout, /\? planning\s+github-copilot\/gpt-5\.5/);
    assert.match(stdout, /\? development\s+openai-codex\/gpt-5\.4-mini/);
    assert.match(stdout, /\? peer-review\s+github-copilot\/claude-opus-4\.7/);
    assert.match(stdout, /discovery skipped/);
    assert.equal(stderr, "");
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
