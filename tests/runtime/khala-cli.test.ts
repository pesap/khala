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
  buildLiteLLMApiKeyCommand,
  buildProfileChoices,
  buildPiCommandInvocation,
  filterValidLiteLLMModelNames,
  buildEnrichedModelEntries,
  isLiteLLMApiKeyCommand,
  liteLLMProviderExists,
  mergeAuthJsonApiKey,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectKeyConfig,
  mergeLiteLLMProjectSettings,
  modelSupportsThinking,
  normalizeCustomProfileEntry,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  parseLiteLLMModelInfoResponse,
  parseProfileEntry,
  resolveLiteLLMApiKeyResolverCommand,
  shellQuoteCommandArg,
  stringifyModelsJson,
  validateAuthCommand,
  validateAuthLiteral,
  validateLiteLLMKeyEnv,
  deriveEnvVarFromKeyName,
  validateLiteLLMProviderId,
} from "../../bin/khala-setup-lib.js";

const execFileAsync = promisify(execFile);

function expectedNodeResolverApiKeyCommand(provider: string): string {
  return buildLiteLLMApiKeyCommand(provider, `${process.execPath} ${path.resolve("bin/khala.js")}`);
}

async function writeFakePi(binDir: string, body: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "pi"), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

async function runKhala(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  try {
    const result = await execFileAsync(process.execPath, [path.resolve("bin/khala.js"), ...args], {
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

async function runKhalaLiteLLMPtyTranscript(cwd: string, piAgentDir: string): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 8
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "LiteLLM key setup" in out and "New provider and key" in out:
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 1
    elif state == 1 and "Provider id:" in out:
        os.write(master, b"bad id\n")
        state = 2
    elif state == 2 and out.count("Provider id:") >= 2:
        os.write(master, b"nlr\n")
        state = 3
    elif state == 3 and "Base URL:" in out:
        os.write(master, b"\x03")
        state = 4

    if state >= 4 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        os.write(master, b"\x03")
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()

sys.stdout.write(out)
sys.exit(0 if state >= 4 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_AGENT_DIR: piAgentDir,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

async function runKhalaLiteLLMModelCatalogPtyTranscript(cwd: string, piAgentDir: string, baseUrl: string): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "LiteLLM key setup" in out and "New provider and key" in out:
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 1
    elif state == 1 and "Provider id:" in out:
        os.write(master, b"nlr\n")
        state = 2
    elif state == 2 and "Base URL:" in out:
        os.write(master, os.environ["KH_BASE_URL"].encode() + b"\n")
        state = 3
    elif state == 3 and "Project key label:" in out:
        os.write(master, b"reeds-maint\n")
        state = 4
    elif state == 4 and "API key:" in out:
        os.write(master, b"sk-catalog-test\n")
        state = 5
    elif state == 5 and "LiteLLM models" in out and "gpt-4.1-mini" in out and "Space toggle" in out:
        os.write(master, b" ")
        state = 6
    elif state == 6 and "1/2 selected" in out:
        os.write(master, b"\r")
        state = 7
    elif state == 7 and "Set this project's Pi defaults" in out:
        os.write(master, b"\x03")
        state = 8
        break

    if state >= 8 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        os.write(master, b"\x03")
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()

sys.stdout.write(out)
sys.exit(0 if state >= 8 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_AGENT_DIR: piAgentDir,
      KH_BASE_URL: baseUrl,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

async function runKhalaLiteLLMRememberedBaseUrlPtyTranscript(cwd: string, piAgentDir: string): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [
        os.environ["KH_NODE"],
        os.environ["KH_BIN"],
        "litellm",
        "--model", "gpt-4o",
        "--auth-mode", "skip",
        "--yes",
    ],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 8
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "Provider id:" in out:
        os.write(master, b"nlr\n")
        state = 1
    elif state == 1 and "Base URL [https://litellm.nlr.gov/v1]:" in out:
        os.write(master, b"\r")
        state = 2
    elif state == 2 and "Project key label:" in out:
        os.write(master, b"reeds-maint\n")
        state = 3
    elif state == 3 and "Done." in out:
        state = 4
        break

    if state >= 4 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()

sys.stdout.write(out)
sys.exit(0 if state >= 4 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_AGENT_DIR: piAgentDir,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

async function runKhalaLiteLLMReuseKeyPtyTranscript(cwd: string, piAgentDir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "LiteLLM key setup" in out and "Reuse existing key" in out:
        time.sleep(0.2)
        os.write(master, b"\x1b[B\x1b[B\r")
        state = 1
    elif state == 1 and "LiteLLM provider" in out and "nlr" in out:
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 2
    elif state == 2 and "Key name" in out and "Key label:" in out:
        time.sleep(0.2)
        os.write(master, os.environ.get("KH_REUSE_KEY_LABEL", "reeds-maint").encode() + b"\n")
        state = 3
    elif state == 2 and "Key name" in out and ("nlr (" in out or os.environ.get("KH_REUSE_KEY_LABEL", "reeds-maint") in out):
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 3
    elif state == 3 and "Configure this project to use" in out:
        os.write(master, b"y" if os.environ.get("KH_CONFIGURE_PROJECT") == "1" else b"n")
        state = 4
    elif state == 4 and os.environ.get("KH_CONFIGURE_PROJECT") != "1" and "Skipped." in out:
        state = 6
    elif state == 4 and "Set this project's Pi defaults" in out:
        os.write(master, b"y" if os.environ.get("KH_PROJECT_DEFAULTS") == "1" else b"n")
        state = 5
    elif state == 5 and "Write changes?" in out:
        os.write(master, b"y")
        state = 6
    elif state == 6 and "Done." in out:
        state = 6

    if state >= 6 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        os.write(master, b"\x03")
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

sys.stdout.write(out)
sys.exit(0 if state >= 6 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_AGENT_DIR: piAgentDir,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
      KH_CONFIGURE_PROJECT: extraEnv.KH_CONFIGURE_PROJECT ?? "1",
      KH_PROJECT_DEFAULTS: extraEnv.KH_PROJECT_DEFAULTS ?? "1",
      KH_REUSE_KEY_LABEL: extraEnv.KH_REUSE_KEY_LABEL ?? "reeds-maint",
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

async function runKhalaLiteLLMAddExistingProviderKeyPtyTranscript(
  cwd: string,
  piAgentDir: string,
  configureProject = false,
  overwriteExistingKey = true,
): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "LiteLLM key setup" in out and "New key for existing provider" in out:
        time.sleep(0.2)
        os.write(master, b"\x1b[B\r")
        state = 1
    elif state == 1 and "Existing provider" in out and "nlr" in out:
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 2
    elif state == 2 and "Project key label:" in out:
        os.write(master, b"reeds-research\n")
        state = 3
    elif state == 3 and "Overwrite the stored key" in out:
        os.write(master, b"y" if os.environ.get("KH_OVERWRITE_EXISTING_KEY") == "1" else b"n")
        state = 4
    elif state == 3 and "API key:" in out:
        os.write(master, b"sk-new-existing-provider-key\n")
        state = 5
    elif state == 4 and "API key:" in out:
        os.write(master, b"sk-new-existing-provider-key\n")
        state = 5
    elif state == 4 and "Configure this project to use" in out:
        os.write(master, b"y" if os.environ.get("KH_CONFIGURE_PROJECT") == "1" else b"n")
        state = 5
    elif state == 5 and "Configure this project to use" in out:
        os.write(master, b"y" if os.environ.get("KH_CONFIGURE_PROJECT") == "1" else b"n")
        state = 6
    elif state == 5 and "Write changes?" in out:
        os.write(master, b"y")
        state = 6
    elif state == 6 and "Write changes?" in out:
        os.write(master, b"y")
        state = 7
    elif state == 6 and "Done." in out:
        state = 7
    elif state == 7 and "Done." in out:
        state = 8

    if state >= 7 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        os.write(master, b"\x03")
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

sys.stdout.write(out)
sys.exit(0 if state >= 7 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_CONFIGURE_PROJECT: configureProject ? "1" : "0",
      KH_OVERWRITE_EXISTING_KEY: overwriteExistingKey ? "1" : "0",
      KH_AGENT_DIR: piAgentDir,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

async function runKhalaLiteLLMAbortExistingProviderKeyPtyTranscript(
  cwd: string,
  piAgentDir: string,
): Promise<string> {
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
state = 0
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")

    if state == 0 and "LiteLLM key setup" in out and "New key for existing provider" in out:
        time.sleep(0.2)
        os.write(master, b"\x1b[B\r")
        state = 1
    elif state == 1 and "Existing provider" in out and "nlr" in out:
        time.sleep(0.2)
        os.write(master, b"\r")
        state = 2
    elif state == 2 and "Project key label:" in out:
        os.write(master, b"reeds-research\n")
        state = 3
    elif state == 3 and "API key:" in out:
        os.write(master, b"\x03")
        state = 4

    if state >= 4 and proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

sys.stdout.write(out)
sys.exit(0 if state >= 4 and proc.returncode == 130 else 1)
`;
  const result = await execFileAsync("python3", ["-c", script], {
    env: {
      ...process.env,
      KH_AGENT_DIR: piAgentDir,
      KH_BIN: path.resolve("bin/khala.js"),
      KH_CWD: cwd,
      KH_NODE: process.execPath,
    },
    encoding: "utf8",
    timeout: 12_000,
  });
  return result.stdout;
}

test("khala CLI prints setup guidance without running pi in dry-run mode", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--project", "--dry-run"]);

  assert.match(stdout, /Khala configuration \[dry-run\]:/);
  assert.match(stdout, /install khala package in project Pi settings .*\.pi\/settings\.json/);
  assert.match(stdout, /write workflow model config .*\.pi\/khala\/workflow-model\.yaml/);
  assert.doesNotMatch(stdout, /^\s*command\b/m);
  assert.match(stdout, /planning\s+github-copilot\/gpt-5\.5:xhigh/);
  assert.match(stdout, /development\s+openai-codex\/gpt-5\.4-mini:medium/);
  assert.match(stdout, /peer-review\s+github-copilot\/claude-opus-4\.7:high/);
  assert.match(stdout, /Run without --dry-run when you are ready to install/);
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

test("khala CLI reports unknown top-level commands as commands", async () => {
  const result = await runKhala(["bogus"]);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stderr, /khala --help/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});

test("khala CLI accepts --no-input as an alias for --yes", async () => {
  const { stdout } = await execFileAsync("node", [
    "bin/khala.js",
    "--project",
    "--no-input",
    "--dry-run",
  ]);

  assert.match(stdout, /planning\s+github-copilot\/gpt-5\.5:xhigh/);
  assert.match(stdout, /write workflow model config .*\.pi\/khala\/workflow-model\.yaml/);
  assert.doesNotMatch(stdout, /^\s*command\b/m);
});

test("khala CLI defaults to global scope in non-interactive dry-run mode", async () => {
  const { stdout } = await execFileAsync("node", ["bin/khala.js", "--dry-run"]);

  assert.match(stdout, /install khala package in global Pi settings .*\.pi\/agent\/settings\.json/);
  assert.match(stdout, /write workflow model config .*workflow-model\.yaml/);
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
      process.execPath,
      [path.resolve("bin/khala.js"), "--project", "--yes"],
      {
        cwd: tempDir,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );

    const config = await readFile(path.join(tempDir, ".pi", "khala", "workflow-model.yaml"), "utf8");
    assert.equal(await readFile(piLog, "utf8"), "install -l https://github.com/pesap/khala\n");
    assert.match(stdout, /Done\. Khala is installed\./);
    assert.match(stdout, /Wrote workflow model config .*\.pi\/khala\/workflow-model\.yaml/);
    assert.match(stdout, /Start Pi and run \/khala then \/khala-health to verify/);
    assert.match(config, /planning: "github-copilot\/gpt-5\.5:xhigh"/);
    assert.match(config, /development: "openai-codex\/gpt-5\.4-mini:medium"/);
    assert.match(config, /peer-review: "github-copilot\/claude-opus-4\.7:high"/);
    assert.match(config, /peer-review: "peer-review"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala CLI reports a clear error when pi is not on PATH", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-missing-pi-"));

  try {
    const result = await runKhala(["--project", "--yes"], { PATH: "/usr/bin:/bin" }, tempDir);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Pi CLI is required for Khala setup\./);
    assert.match(result.stderr, /Verify that Pi is installed and on your PATH, then retry\./);
    assert.doesNotMatch(result.stderr, /spawnSync pi ENOENT/);
    await assert.rejects(
      readFile(path.join(tempDir, ".pi", "khala", "workflow-model.yaml"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala CLI propagates nonzero pi install exits without writing config", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-cli-pi-failure-"));
  const binDir = path.join(tempDir, "bin");
  const piLog = path.join(tempDir, "pi.log");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "pi"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(piLog)}\nexit 17\n`,
      { mode: 0o755 },
    );

    const result = await runKhala(["--project", "--yes"], {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, tempDir);

    assert.equal(result.code, 17);
    assert.equal(await readFile(piLog, "utf8"), "install -l https://github.com/pesap/khala\n");
    assert.doesNotMatch(result.stderr, /Pi CLI is required/);
    await assert.rejects(
      readFile(path.join(tempDir, ".pi", "khala", "workflow-model.yaml"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala setup helper preserves pi install arguments on Windows shims", () => {
  const invocation = buildPiCommandInvocation(["install", "-l", "https://github.com/pesap/khala"], {
    platform: "win32",
    command: "pi.cmd",
    spawnOptions: { stdio: "inherit" },
  });

  assert.deepEqual(invocation, {
    command: "pi.cmd",
    args: ["install", "-l", "https://github.com/pesap/khala"],
    spawnOptions: {
      shell: true,
      stdio: "inherit",
    },
  });
});

test("khala CLI full setup prompt uses section hints and confirmation lines", async () => {
  const source = await readFile(path.resolve("bin/khala.js"), "utf8");
  const start = source.indexOf("async function askScope(options)");
  assert.notEqual(start, -1);
  const flow = source.slice(start, source.indexOf("// ── Main", start));
  const markers = [
    'stepHeading("Install scope")',
    "Choose where Pi should load the khala package",
    'askChoice("Scope"',
    'bold("Install scope")',
    'stepHeading("Workflow models")',
    "Defaults are recommended",
    'stepHeading(label)',
    "Pick the model Pi should use for this workflow role",
    "model`, choices",
    "thinking`, THINKING_CHOICES",
    "bold(label)",
  ];
  for (const marker of markers) {
    assert.notEqual(flow.indexOf(marker), -1, `missing full setup prompt marker: ${marker}`);
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
  assert.throws(() => normalizeLiteLLMBaseUrl("https://lite.example/v1?x=1"), /query string/);
  assert.throws(() => normalizeLiteLLMBaseUrl("ftp://lite.example/v1"), /must start with http:\/\//);
  assert.throws(() => normalizeLiteLLMModelPattern("team-litellm/*"), /'\/' or ':'/);
  assert.throws(() => normalizeLiteLLMModelPattern("vendor:thinking"), /'\/' or ':'/);
  // Real LiteLLM hubs publish model ids with internal whitespace; only / and :
  // are structurally reserved, so spaces must round-trip unchanged.
  assert.equal(normalizeLiteLLMModelPattern(" HALO Gemma 4 "), "HALO Gemma 4");
});

test("khala setup helper validateLiteLLMKeyEnv accepts LiteLLM portal labels, not just shell idents", () => {
  // Whole point of the renamed concept: a user typing the same name they
  // assigned the key on the LiteLLM admin portal should round-trip without
  // a regex error. Dashes and dots are the common offenders.
  assert.equal(validateLiteLLMKeyEnv(" reeds-maint "), "reeds-maint");
  assert.equal(validateLiteLLMKeyEnv("team.litellm.prod"), "team.litellm.prod");
  assert.equal(validateLiteLLMKeyEnv("alice_dev"), "alice_dev");
  assert.equal(validateLiteLLMKeyEnv("k1"), "k1");
  // Still reject shapes we can't safely round-trip through the filesystem,
  // shell pipelines, or stable schema validation — whitespace, slashes,
  // leading dash/dot.
  assert.throws(() => validateLiteLLMKeyEnv("reeds maint"), /must start with a letter, digit, or '_'/);
  assert.throws(() => validateLiteLLMKeyEnv("team/litellm"), /must start with a letter, digit, or '_'/);
  assert.throws(() => validateLiteLLMKeyEnv("-leading-dash"), /must start with a letter, digit, or '_'/);
  assert.throws(() => validateLiteLLMKeyEnv(""), /got empty input/);
});

test("khala setup helper deriveEnvVarFromKeyName turns portal labels into shell-canonical names", () => {
  // Headline case from #235: the user types the LiteLLM portal label, and we
  // mechanically produce the env var they'd type into `export`.
  assert.equal(deriveEnvVarFromKeyName("reeds-maint"), "REEDS_MAINT");
  assert.equal(deriveEnvVarFromKeyName("team.litellm.prod"), "TEAM_LITELLM_PROD");
  // Idempotent: typing a valid identifier should round-trip case-preserved.
  // (We don't aggressively uppercase a name that's already a legal shell
  // var, because doing so would change semantics for users who deliberately
  // chose a lowercase name.)
  assert.equal(deriveEnvVarFromKeyName("LITELLM_API_KEY"), "LITELLM_API_KEY");
  assert.equal(deriveEnvVarFromKeyName("my_lowercase_var"), "my_lowercase_var");
  // Defensive normalizations: leading digits dropped (identifiers can't
  // start with one), runs of separators collapsed, leading/trailing _
  // stripped, edge case of all-punctuation returns null.
  assert.equal(deriveEnvVarFromKeyName("3-team-prod"), "TEAM_PROD");
  assert.equal(deriveEnvVarFromKeyName("team..prod--key"), "TEAM_PROD_KEY");
  assert.equal(deriveEnvVarFromKeyName(" --__-- "), null);
  assert.equal(deriveEnvVarFromKeyName(""), null);
  assert.equal(deriveEnvVarFromKeyName("!!!"), null);
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

test("khala setup helper resolves maintainable LiteLLM key resolver commands", () => {
  const installed = resolveLiteLLMApiKeyResolverCommand();
  const nodeInvoked = resolveLiteLLMApiKeyResolverCommand({
    execPath: process.execPath,
    resolvedInvokedPath: path.resolve("bin/khala.js"),
  });
  const npxInvoked = resolveLiteLLMApiKeyResolverCommand({
    npmCommand: "exec",
    npmPackage: "github:pesap/khala",
  });
  const override = resolveLiteLLMApiKeyResolverCommand({
    overrideCommand: "custom-khala",
    npmCommand: "exec",
    npmPackage: "github:pesap/khala",
  });

  assert.equal(installed, "khala");
  assert.equal(nodeInvoked, `${process.execPath} ${path.resolve("bin/khala.js")}`);
  assert.equal(npxInvoked, "npx --yes github:pesap/khala");
  assert.equal(override, "custom-khala");
  assert.equal(shellQuoteCommandArg("github:pesap/khala"), "github:pesap/khala");
  assert.equal(shellQuoteCommandArg("one two"), "'one two'");

  assert.equal(isLiteLLMApiKeyCommand("team-litellm", buildLiteLLMApiKeyCommand("team-litellm", installed)), true);
  assert.equal(isLiteLLMApiKeyCommand("team-litellm", buildLiteLLMApiKeyCommand("team-litellm", nodeInvoked)), true);
  assert.equal(isLiteLLMApiKeyCommand("team-litellm", buildLiteLLMApiKeyCommand("team-litellm", npxInvoked)), true);
  assert.equal(isLiteLLMApiKeyCommand("other-provider", buildLiteLLMApiKeyCommand("team-litellm", npxInvoked)), false);
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
  // apiKey is stable per provider; project-local key config selects the env var.
  assert.equal(result.value.providers["team-litellm"].apiKey, buildLiteLLMApiKeyCommand("team-litellm"));
});

test("khala setup helper merges project LiteLLM key references per provider", () => {
  const result = mergeLiteLLMProjectKeyConfig(
    { providers: { other: { keyEnv: "OTHER_KEY" }, "team-litellm": { note: "keep" } } },
    { providerId: "team-litellm", keyEnv: "PROJECT_A_KEY" },
  );

  assert.deepEqual(result, {
    providers: {
      other: { keyEnv: "OTHER_KEY" },
      "team-litellm": { note: "keep", keyEnv: "PROJECT_A_KEY" },
    },
  });
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

test("khala setup helper validateAuthLiteral accepts single-line keys and rejects blank/multiline", () => {
  assert.equal(validateAuthLiteral("sk-abc123"), "sk-abc123");
  assert.equal(validateAuthLiteral(" sk-leading-space"), " sk-leading-space");  // trim is the user's job
  assert.throws(() => validateAuthLiteral(""), /non-empty/);
  assert.throws(() => validateAuthLiteral("   "), /non-empty/);
  assert.throws(() => validateAuthLiteral("line1\nline2"), /single line/);
  assert.throws(() => validateAuthLiteral("line1\r\nline2"), /single line/);
  assert.throws(() => validateAuthLiteral(undefined as unknown as string), /non-empty/);
});

test("khala setup helper validateAuthCommand requires a leading '!' followed by a command", () => {
  assert.equal(
    validateAuthCommand("!op read 'op://Personal/team/credential'"),
    "!op read 'op://Personal/team/credential'",
  );
  assert.equal(validateAuthCommand("  !security find-generic-password -ws nlr  "), "!security find-generic-password -ws nlr");
  assert.throws(() => validateAuthCommand(""), /must start with '!'/);
  assert.throws(() => validateAuthCommand("!"), /must start with '!'/);
  assert.throws(() => validateAuthCommand("security find ..."), /must start with '!'/);
  assert.throws(() => validateAuthCommand("$ENV_VAR"), /must start with '!'/);
});

test("khala setup helper mergeAuthJsonApiKey preserves unrelated providers and reports conflicts", () => {
  const existing = {
    "openai": { type: "api_key", key: "sk-other-keep-me" },
    "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: 9_999_999_999_000 },
    "cloudflare-ai-gateway": { type: "api_key", key: "$CF_KEY", env: { CLOUDFLARE_ACCOUNT_ID: "abc" } },
  };

  // Brand-new provider: isUpdate=false, no conflict.
  const fresh = mergeAuthJsonApiKey(existing, "team-litellm", "sk-team-new");
  assert.equal(fresh.isUpdate, false);
  assert.equal(fresh.conflict, false);
  assert.deepEqual(fresh.value["team-litellm"], { type: "api_key", key: "sk-team-new" });
  // Every other entry survives bit-for-bit.
  assert.deepEqual(fresh.value.openai, existing.openai);
  assert.deepEqual(fresh.value["github-copilot"], existing["github-copilot"]);
  assert.deepEqual(fresh.value["cloudflare-ai-gateway"], existing["cloudflare-ai-gateway"]);

  // Same provider, SAME key: update, no conflict.
  const sameAgain = mergeAuthJsonApiKey(fresh.value, "team-litellm", "sk-team-new");
  assert.equal(sameAgain.isUpdate, true);
  assert.equal(sameAgain.conflict, false);

  // Same provider, DIFFERENT key: update with conflict.
  const replaced = mergeAuthJsonApiKey(fresh.value, "team-litellm", "sk-team-rotated");
  assert.equal(replaced.isUpdate, true);
  assert.equal(replaced.conflict, true);
  assert.equal(replaced.value["team-litellm"].key, "sk-team-rotated");

  // Overwriting an OAuth entry with api_key: conflict=true (the caller must
  // require explicit confirmation before nuking refresh tokens).
  const overrideOAuth = mergeAuthJsonApiKey(existing, "github-copilot", "sk-not-oauth");
  assert.equal(overrideOAuth.conflict, true);
  assert.equal(overrideOAuth.value["github-copilot"].type, "api_key");
  assert.equal(overrideOAuth.value["github-copilot"].key, "sk-not-oauth");

  // Existing provider-scoped env block is preserved on a key-only update.
  const preserveEnv = mergeAuthJsonApiKey(existing, "cloudflare-ai-gateway", "$NEW_CF_KEY");
  assert.deepEqual(preserveEnv.value["cloudflare-ai-gateway"].env, { CLOUDFLARE_ACCOUNT_ID: "abc" });
  assert.equal(preserveEnv.value["cloudflare-ai-gateway"].key, "$NEW_CF_KEY");

  // Defensive: bad inputs throw with actionable messages.
  assert.throws(() => mergeAuthJsonApiKey(existing, "", "sk"), /providerId is required/);
  assert.throws(() => mergeAuthJsonApiKey(existing, "team", ""), /key value is required/);
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
  assert.equal(mergedModels.value.providers["team-litellm"].apiKey, buildLiteLLMApiKeyCommand("team-litellm"));
  assert.deepEqual(mergedModels.value.providers["team-litellm"].models.map((model) => model.id), ["gpt-5.4-mini"]);
  assert.equal(mergedModels.value.providers["other-provider"].api, "anthropic-messages");

  const mergedSettings = mergeLiteLLMProjectSettings(
    { theme: "dark", enabledModels: ["claude-*"], warnings: { foo: true } },
    { providerId: "team-litellm", modelIds: ["gpt-5.4-mini"] },
  );

  assert.equal(mergedSettings.defaultProvider, "team-litellm");
  assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
  assert.deepEqual(mergedSettings.enabledModels, ["team-litellm/gpt-5.4-mini"]);
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
  assert.deepEqual(mergedSettings.enabledModels, ["team-litellm/gpt-5.4-mini", "team-litellm/claude-opus-4.7"]);
});

test("khala setup helper replaces stale project enabledModels with selected provider models", () => {
  const mergedSettings = mergeLiteLLMProjectSettings(
    {
      defaultProvider: "NLR",
      defaultModel: "gpt-5.4",
      enabledModels: [
        "gpt-5.4",
        "claude-sonnet-4-6",
        "gemini-3-pro-image-preview",
        "gpt-5.3-codex",
        "text-embedding-3-large",
        "HALO Llama 4 Scout",
      ],
      theme: "dark",
    },
    { providerId: "NLR", modelIds: ["gpt-5.4-mini", "gpt-5-mini"] },
  );

  assert.equal(mergedSettings.defaultProvider, "NLR");
  assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
  assert.deepEqual(mergedSettings.enabledModels, ["NLR/gpt-5.4-mini", "NLR/gpt-5-mini"]);
  assert.equal(mergedSettings.theme, "dark");
});

test("khala litellm --help documents the LiteLLM setup mode and key-storage options", async () => {
  const { stdout } = await runKhala(["litellm", "--help"]);

  assert.equal(stdout.includes("khala litellm - configure a LiteLLM-compatible Pi provider"), true);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Commands:/);
  assert.match(stdout, /Flags:/);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /Environment:/);
  assert.match(stdout, /Project model scope:/);
  assert.match(stdout, /print-key\s+Print the selected LiteLLM API key/);
  assert.match(stdout, /--provider/);
  assert.match(stdout, /--base-url/);
  assert.match(stdout, /--key-env/);
  assert.match(stdout, /--project/);
  assert.match(stdout, /--yes/);
  assert.match(stdout, /--no-input/);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /PI_CODING_AGENT_DIR/);
  // The three new auth flags must all be documented.
  assert.match(stdout, /--auth-mode <mode>\s+How to store the key: skip \| literal \| command/);
  assert.match(stdout, /--auth-key <value>/);
  assert.match(stdout, /--auth-command <!cmd>/);
  assert.match(stdout, /--project-settings/);
  assert.match(stdout, /--no-project-settings/);
  // The runtime-resolution section explains pi's chain so users understand
  // why auth.json is the canonical place to put the key.
  assert.match(stdout, /Key resolution at runtime:/);
  assert.match(stdout, /key-specific auth entries/);
  assert.match(stdout, /multiple labels for the same LiteLLM provider/);
  assert.match(stdout, /provider-qualified entries like team-litellm\/gpt-5\.4-mini/);
  assert.match(stdout, /--list-models\s+command still lists the global registry/);
});

test("khala litellm reports unknown subcommands as commands", async () => {
  const result = await runKhala(["litellm", "bogus"]);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stderr, /khala litellm --help/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});

test("khala litellm print-key help documents flags and output streams", async () => {
  const result = await runKhala(["litellm", "print-key", "--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /khala litellm print-key - print the selected LiteLLM API key/);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Flags:/);
  assert.match(result.stdout, /--provider <id>/);
  assert.match(result.stdout, /writes only the resolved key value to stdout/i);
  assert.match(result.stdout, /errors are written to stderr/i);
});

test("khala litellm --no-input fails fast instead of prompting in a TTY", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-no-input-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["PI_CODING_AGENT_DIR"] = os.environ["KH_AGENT_DIR"]
proc = subprocess.Popen(
    [os.environ["KH_NODE"], os.environ["KH_BIN"], "litellm", "--no-input"],
    cwd=os.environ["KH_CWD"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

out = ""
deadline = time.time() + 3
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        out += data.decode(errors="replace")
    if proc.poll() is not None:
        break

if proc.poll() is None:
    try:
        code = proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = -999
else:
    code = proc.returncode

sys.stdout.write(out)
sys.stdout.write(f"\n__CODE__={code}\n")
sys.exit(0)
`;

  try {
    await mkdir(piAgentDir, { recursive: true });
    const result = await execFileAsync("python3", ["-c", script], {
      env: {
        ...process.env,
        KH_AGENT_DIR: piAgentDir,
        KH_BIN: path.resolve("bin/khala.js"),
        KH_CWD: tempDir,
        KH_NODE: process.execPath,
      },
      encoding: "utf8",
      timeout: 6_000,
    });

    assert.match(result.stdout, /__CODE__=2/);
    assert.match(result.stdout, /Missing required LiteLLM options: --provider, --base-url, --key-env, --model/);
    assert.doesNotMatch(result.stdout, /Provider id:/);
    assert.doesNotMatch(result.stdout, /LiteLLM key setup/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm setup prompt order collects key and models before project defaults", async () => {
  const source = await readFile(path.resolve("bin/khala.js"), "utf8");
  const start = source.indexOf("async function mainLiteLLM(argv)");
  assert.notEqual(start, -1);
  const flow = source.slice(start);
  const markers = [
    "LiteLLM provider setup",
    'stepHeading("Key setup")',
    'stepHeading("Provider")',
    "short id for Pi config",
    "Provider id: ",
    'stepHeading("Base URL")',
    "OpenAI-compatible LiteLLM endpoint",
    'stepHeading("Project key")',
    "Project key label: ",
    "API key: ",
    "Fetching model catalog...",
    "promptLiteLLMModelIds(",
    "Set this project's Pi defaults to these models?",
    "Ready to write",
    "Write changes?",
  ];
  const positions = markers.map((marker) => {
    const index = flow.indexOf(marker);
    assert.notEqual(index, -1, `missing prompt marker: ${marker}`);
    return index;
  });

  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(
    flow,
    /askConfirmation\(`.*Set this project's Pi defaults to these models\?`, \{ defaultYes: false \}\)/,
  );
  assert.match(source, /New provider and key/);
  assert.match(source, /New key for existing provider/);
  assert.match(source, /Reuse existing key/);
  assert.match(source, /bold\("Models"\)/);
  assert.match(source, /askMultiChoice\("LiteLLM models"/);
  assert.match(source, /Use the model ids from your LiteLLM admin catalog/);
  assert.match(source, /promptLine\(`.*Model ids: `\)/);
});

test("khala litellm interactive retry transcript avoids bare labels and regex internals", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-pty-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    const transcript = await runKhalaLiteLLMPtyTranscript(tempDir, piAgentDir);

    assert.match(transcript, /LiteLLM provider setup/);
    assert.match(transcript, /LiteLLM key setup/);
    assert.match(transcript, /New provider and key/);
    assert.match(transcript, /Reuse existing key/);
    assert.match(transcript, /◉ {2}New provider and key/);
    assert.match(transcript, /◯ {2}Reuse existing key/);
    assert.match(transcript, /Up\/Down select {2}Enter accept {2}Ctrl\+C cancel/);
    assert.doesNotMatch(transcript, /type to filter/);
    assert.doesNotMatch(transcript, /Esc clear/);
    assert.match(transcript, /Provider id:/);
    assert.match(transcript, /Use a short id with letters, numbers, dots, underscores, or hyphens/);
    assert.match(transcript, /Base URL:/);
    assert.doesNotMatch(transcript, /^\s*id\s*$/m);
    assert.doesNotMatch(transcript, /Provider id must match \^/);
    assert.doesNotMatch(transcript, /A-Za-z0-9/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm suggests a remembered base URL and accepts Enter to reuse it", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-remember-url-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const modelsPath = path.join(piAgentDir, "models.json");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "https://litellm.nlr.gov/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2)}\n`,
    );

    const transcript = await runKhalaLiteLLMRememberedBaseUrlPtyTranscript(tempDir, piAgentDir);

    assert.match(transcript, /Press Enter to reuse the remembered URL/);
    assert.match(transcript, /Base URL \[https:\/\/litellm\.nlr\.gov\/v1\]:/);
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(models.providers.nlr.baseUrl, "https://litellm.nlr.gov/v1");
    assert.deepEqual(models.providers.nlr.models.map((model: { id: string }) => model.id), ["gpt-4o"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm interactive setup can reuse an existing shared key", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-reuse-key-pty-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }, { id: "gpt-4o" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({ nlr: { type: "api_key", key: "sk-stored-once" } }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMReuseKeyPtyTranscript(targetProject, piAgentDir);

    assert.match(transcript, /LiteLLM key setup/);
    assert.match(transcript, /Reuse existing key/);
    assert.match(transcript, /Reuse provider/);
    assert.match(transcript, /LiteLLM provider/);
    assert.match(transcript, /Key name/);
    assert.match(transcript, /Key label:/);
    assert.match(transcript, /Project config/);
    assert.match(transcript, /Configure this project to use reeds-maint\?/);
    assert.doesNotMatch(transcript, /nlr \(stored key; 2 models/);
    assert.match(transcript, /reuse LiteLLM provider nlr with key label reeds-maint/);
    assert.match(transcript, /leave global model registry provider nlr unchanged/);
    assert.match(transcript, /save project key label reeds-maint in project LiteLLM config/);
    assert.match(transcript, /keep existing API key in global auth store/);
    assert.doesNotMatch(transcript, /Could not fetch model metadata/);
    assert.doesNotMatch(transcript, /API key:/);
    assert.doesNotMatch(transcript, /sk-stored-once/);

    const targetKeys = JSON.parse(await readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
    assert.equal(targetKeys.providers.nlr.keyEnv, "reeds-maint");

    const targetSettings = JSON.parse(await readFile(path.join(targetProject, ".pi", "settings.json"), "utf8"));
    assert.equal(targetSettings.defaultProvider, "nlr");
    assert.equal(targetSettings.defaultModel, "gpt-5-mini");
    assert.deepEqual(targetSettings.enabledModels, ["nlr/gpt-5-mini", "nlr/gpt-4o"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm reuse key can skip configuring the current project", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-reuse-key-skip-project-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");
  const registryPath = path.join(piAgentDir, "khala", "litellm-keys.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }, { id: "gpt-4o" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({ "nlr:reeds-maint": { type: "api_key", key: "sk-stored-once" } }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMReuseKeyPtyTranscript(targetProject, piAgentDir, {
      KH_CONFIGURE_PROJECT: "0",
    });

    assert.match(transcript, /Reuse existing key/);
    assert.match(transcript, /Configure this project to use reeds-maint\?/);
    assert.match(transcript, new RegExp(`${targetProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.pi.*khala.*litellm\\.json`));
    assert.match(transcript, /Skipped\.\s+No files were written\./);
    assert.doesNotMatch(transcript, /Set this project's Pi defaults/);
    assert.doesNotMatch(transcript, /Could not fetch model metadata/);
    assert.doesNotMatch(transcript, /Ready to write/);
    assert.doesNotMatch(transcript, /Write changes\?/);
    assert.doesNotMatch(transcript, /sk-stored-once/);

    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.deepEqual(models.providers.nlr.models.map((model: { id: string }) => model.id), ["gpt-5-mini", "gpt-4o"]);
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(auth, { "nlr:reeds-maint": { type: "api_key", key: "sk-stored-once" } });
    await assert.rejects(readFile(registryPath, "utf8"));
    await assert.rejects(readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
    await assert.rejects(readFile(path.join(targetProject, ".pi", "settings.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm interactive setup can add a new key to an existing provider", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-existing-provider-key-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const reuseProject = path.join(tempDir, "reuse-target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");
  const registryPath = path.join(piAgentDir, "khala", "litellm-keys.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(reuseProject, { recursive: true });
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }, { id: "gpt-4o" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({ nlr: { type: "api_key", key: "sk-existing-provider-key" } }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMAddExistingProviderKeyPtyTranscript(targetProject, piAgentDir);

    assert.match(transcript, /New key for existing provider/);
    assert.match(transcript, /Existing provider/);
    assert.match(transcript, /Project key label:/);
    assert.match(transcript, /API key:/);
    assert.match(transcript, /Project config/);
    assert.match(transcript, /Configure this project to use reeds-research\?/);
    assert.match(transcript, new RegExp(`${targetProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.pi.*khala.*litellm\\.json`));
    assert.match(transcript, /add key label reeds-research to existing LiteLLM provider nlr/);
    assert.match(transcript, /leave global model registry provider nlr unchanged/);
    assert.match(transcript, /leave project LiteLLM config unchanged/);
    assert.match(transcript, /store API key for label reeds-research in global auth store and keep existing provider key/);
    assert.match(transcript, /Done\. LiteLLM key is registered\./);
    assert.doesNotMatch(transcript, /Base URL:/);
    assert.doesNotMatch(transcript, /Model ids:/);
    assert.doesNotMatch(transcript, /Set this project's Pi defaults/);
    assert.doesNotMatch(transcript, /Could not fetch model metadata/);
    assert.doesNotMatch(transcript, /sk-new-existing-provider-key/);
    assert.doesNotMatch(transcript, /sk-existing-provider-key/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(auth.nlr, { type: "api_key", key: "sk-existing-provider-key" });
    assert.deepEqual(auth["nlr:reeds-research"], { type: "api_key", key: "sk-new-existing-provider-key" });

    const unchangedModels = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.deepEqual(unchangedModels.providers.nlr.models.map((model: { id: string }) => model.id), ["gpt-5-mini", "gpt-4o"]);
    await assert.rejects(readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
    await assert.rejects(readFile(path.join(targetProject, ".pi", "settings.json"), "utf8"));

    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    assert.deepEqual(registry.keys, [{
      provider: "nlr",
      keyEnv: "reeds-research",
      baseUrl: "http://127.0.0.1:1/v1",
      modelIds: ["gpt-5-mini", "gpt-4o"],
    }]);

    const reuseTranscript = await runKhalaLiteLLMReuseKeyPtyTranscript(reuseProject, piAgentDir, {
      KH_REUSE_KEY_LABEL: "reeds-research",
    });
    assert.match(reuseTranscript, /reeds-research/);
    assert.match(reuseTranscript, /reuse LiteLLM provider nlr with key label reeds-research/);

    const reuseKeys = JSON.parse(await readFile(path.join(reuseProject, ".pi", "khala", "litellm.json"), "utf8"));
    assert.equal(reuseKeys.providers.nlr.keyEnv, "reeds-research");

    const printed = await runKhala(
      ["litellm", "print-key", "--provider", "nlr"],
      { PI_CODING_AGENT_DIR: piAgentDir },
      reuseProject,
    );
    assert.equal(printed.code, 0);
    assert.equal(printed.stdout, "sk-new-existing-provider-key");
    assert.equal(printed.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm existing-provider new key can also configure the current project", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-existing-provider-key-local-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({ nlr: { type: "api_key", key: "sk-existing-provider-key" } }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMAddExistingProviderKeyPtyTranscript(targetProject, piAgentDir, true);

    assert.match(transcript, /Configure this project to use reeds-research\?/);
    assert.match(transcript, /save project key label reeds-research in project LiteLLM config/);
    assert.match(transcript, /Wrote project LiteLLM config/);
    assert.doesNotMatch(transcript, /Set this project's Pi defaults/);
    assert.doesNotMatch(transcript, /Could not fetch model metadata/);

    const targetKeys = JSON.parse(await readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
    assert.equal(targetKeys.providers.nlr.keyEnv, "reeds-research");
    await assert.rejects(readFile(path.join(targetProject, ".pi", "settings.json"), "utf8"));

    const printed = await runKhala(
      ["litellm", "print-key", "--provider", "nlr"],
      { PI_CODING_AGENT_DIR: piAgentDir },
      targetProject,
    );
    assert.equal(printed.code, 0);
    assert.equal(printed.stdout, "sk-new-existing-provider-key");
    assert.equal(printed.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm existing-provider API key prompt cancels on Ctrl-C", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-existing-provider-key-abort-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");
  const registryPath = path.join(piAgentDir, "khala", "litellm-keys.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({ nlr: { type: "api_key", key: "sk-existing-provider-key" } }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMAbortExistingProviderKeyPtyTranscript(targetProject, piAgentDir);

    assert.match(transcript, /A provider-level API key already exists for nlr/);
    assert.match(transcript, /API key:/);
    assert.match(transcript, /Cancelled\./);
    assert.doesNotMatch(transcript, /aborted/);
    assert.doesNotMatch(transcript, /Write changes\?/);
    assert.equal((transcript.match(/API key:/g) ?? []).length, 1);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(auth, { nlr: { type: "api_key", key: "sk-existing-provider-key" } });
    await assert.rejects(readFile(registryPath, "utf8"));
    await assert.rejects(readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm existing-provider duplicate key label can be kept", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-existing-provider-key-keep-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({
        nlr: { type: "api_key", key: "sk-existing-provider-key" },
        "nlr:reeds-research": { type: "api_key", key: "sk-existing-label-key" },
      }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMAddExistingProviderKeyPtyTranscript(targetProject, piAgentDir, false, false);

    assert.match(transcript, /A stored API key already exists for provider nlr with key label reeds-research/);
    assert.match(transcript, /Overwrite the stored key for reeds-research\?/);
    assert.match(transcript, /keep existing API key for label reeds-research in global auth store/);
    assert.doesNotMatch(transcript, /API key:/);
    assert.doesNotMatch(transcript, /sk-new-existing-provider-key/);
    assert.doesNotMatch(transcript, /sk-existing-label-key/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(auth.nlr, { type: "api_key", key: "sk-existing-provider-key" });
    assert.deepEqual(auth["nlr:reeds-research"], { type: "api_key", key: "sk-existing-label-key" });
    await assert.rejects(readFile(path.join(targetProject, ".pi", "khala", "litellm.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm existing-provider duplicate key label can be overwritten", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-existing-provider-key-overwrite-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");
  const modelsPath = path.join(piAgentDir, "models.json");
  const authPath = path.join(piAgentDir, "auth.json");

  try {
    await mkdir(targetProject, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      JSON.stringify({
        nlr: { type: "api_key", key: "sk-existing-provider-key" },
        "nlr:reeds-research": { type: "api_key", key: "sk-existing-label-key" },
      }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMAddExistingProviderKeyPtyTranscript(targetProject, piAgentDir, false, true);

    assert.match(transcript, /Overwrite the stored key for reeds-research\?/);
    assert.match(transcript, /API key:/);
    assert.match(transcript, /store API key for label reeds-research in global auth store and keep existing provider key/);
    assert.doesNotMatch(transcript, /sk-new-existing-provider-key/);
    assert.doesNotMatch(transcript, /sk-existing-label-key/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(auth.nlr, { type: "api_key", key: "sk-existing-provider-key" });
    assert.deepEqual(auth["nlr:reeds-research"], { type: "api_key", key: "sk-new-existing-provider-key" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm interactive setup uses /v1/models as the multi-select catalog", async () => {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "gpt-4.1" },
          { id: "gpt-4.1-mini" },
        ],
      }));
      return;
    }
    if (req.url === "/model/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-catalog-pty-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    const transcript = await runKhalaLiteLLMModelCatalogPtyTranscript(tempDir, piAgentDir, baseUrl);

    assert.match(transcript, /API key:/);
    assert.match(transcript, /Fetching model catalog/);
    assert.match(transcript, /LiteLLM models/);
    assert.match(transcript, /Space toggle/);
    assert.match(transcript, /gpt-4\.1/);
    assert.match(transcript, /gpt-4\.1-mini/);
    assert.doesNotMatch(transcript, /showing \d+-\d+ of \d+/);
    assert.doesNotMatch(transcript, /[↑↓] \d+ more/);
    assert.doesNotMatch(transcript, /Model ids:/);
    assert.match(transcript, /Set this project's Pi defaults/);
    assert.equal(requests[0]?.url, "/v1/models");
    assert.equal(requests[0]?.auth, "Bearer sk-catalog-test");
    assert.doesNotMatch(transcript, /sk-catalog-test/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm keeps /v1/models catalog when /model/info rejects the key", async () => {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/model/info") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model info requires admin" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "gpt-4.1" },
          { id: "gpt-4.1-mini" },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-models-fallback-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    await mkdir(piAgentDir, { recursive: true });
    const transcript = await runKhalaLiteLLMModelCatalogPtyTranscript(tempDir, piAgentDir, baseUrl);

    assert.deepEqual(requests.map((request) => request.url), ["/v1/models", "/model/info"]);
    assert.equal(requests[0]?.auth, "Bearer sk-catalog-test");
    assert.equal(requests[1]?.auth, "Bearer sk-catalog-test");
    assert.match(transcript, /Fetched model list\. Detailed metadata unavailable: HTTP 401\./);
    assert.match(transcript, /LiteLLM models/);
    assert.match(transcript, /gpt-4\.1-mini/);
    assert.match(transcript, /Set this project's Pi defaults/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm dry-run previews human labels without writing files or calling pi", async () => {
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
    assert.match(result.stdout, /Ready to write \[dry-run\]:/);
    assert.match(result.stdout, /add global model registry provider team-litellm with 1 model/);
    assert.match(result.stdout, /save project key label LITELLM_API_KEY in project LiteLLM config/);
    assert.match(result.stdout, /leave global auth store unchanged/);
    assert.match(result.stdout, /leave project Pi defaults unchanged/);
    assert.match(result.stdout, /Run without --dry-run when you are ready to write/);
    assert.doesNotMatch(result.stdout, /models\.json|litellm\.json|auth\.json|\.pi\/settings\.json/);
    assert.doesNotMatch(result.stdout, /!khala litellm print-key/);
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
    await assert.rejects(readFile(path.join(tempDir, ".pi", "khala", "litellm.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm --verbose shows paths and implementation details", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-verbose-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider", "team-litellm",
        "--base-url", "https://lite.example/v1",
        "--key-env", "LITELLM_API_KEY",
        "--model", "gpt-5.4-mini",
        "--dry-run",
        "--verbose",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /global model registry \([^)]*models\.json\)/);
    assert.match(result.stdout, /project LiteLLM config \([^)]*\.pi\/khala\/litellm\.json\)/);
    assert.match(result.stdout, /global auth store \([^)]*auth\.json\)/);
    assert.match(result.stdout, /project Pi defaults \([^)]*\.pi\/settings\.json\)/);
    assert.match(result.stdout, new RegExp(`provider apiKey command ${expectedNodeResolverApiKeyCommand("team-litellm").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm uses an npx resolver when setup is invoked through npx", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-npx-resolver-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const expectedResolver = buildLiteLLMApiKeyCommand("team-litellm", "npx --yes github:pesap/khala");

  try {
    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider", "team-litellm",
        "--base-url", "https://lite.example/v1",
        "--key-env", "LITELLM_API_KEY",
        "--model", "gpt-5.4-mini",
        "--yes",
      ],
      {
        PI_CODING_AGENT_DIR: piAgentDir,
        npm_command: "exec",
        npm_config_package: "github:pesap/khala",
      },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const models = JSON.parse(await readFile(path.join(piAgentDir, "models.json"), "utf8"));
    assert.equal(models.providers["team-litellm"].apiKey, expectedResolver);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm rejects suspiciously short model ids in non-interactive mode", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-short-model-"));
  const piAgentDir = path.join(tempDir, "pi-agent");

  try {
    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider", "team-litellm",
        "--base-url", "https://lite.example/v1",
        "--key-env", "LITELLM_API_KEY",
        "--model", "l",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr, /model id 'l' is very short/);
    await assert.rejects(readFile(path.join(piAgentDir, "models.json"), "utf8"));
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
  const keyConfigPath = path.join(tempDir, ".pi", "khala", "litellm.json");
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
        "--project-settings",
        "--yes",
      ],
      env,
      tempDir,
    );

    assert.equal(first.code, 0);
    assert.match(first.stdout, /Ready to write:/);
    assert.match(first.stdout, /existing provider config differs/);
    assert.doesNotMatch(first.stdout, /other-secret|OLD_KEY/);
    await assert.rejects(readFile(piLog, "utf8"));

    const mergedModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const provider = mergedModels.providers["team-litellm"];
    assert.equal(provider.baseUrl, "https://lite.example/v1");
    assert.equal(provider.api, LITELLM_PROVIDER_API);
    assert.equal(provider.apiKey, expectedNodeResolverApiKeyCommand("team-litellm"));
    assert.deepEqual(provider.models.map((model) => model.id), ["gpt-5.4-mini"]);
    assert.equal(mergedModels.providers["other-provider"].api, "anthropic-messages");

    const mergedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(mergedSettings.defaultProvider, "team-litellm");
    assert.equal(mergedSettings.defaultModel, "gpt-5.4-mini");
    assert.deepEqual(mergedSettings.enabledModels, ["team-litellm/gpt-5.4-mini"]);
    assert.equal(mergedSettings.theme, "dark");
    assert.equal(mergedSettings.warnings.foo, true);
    assert.doesNotMatch(JSON.stringify(mergedSettings), /team-litellm\/\*/);

    const keyConfig = JSON.parse(await readFile(keyConfigPath, "utf8"));
    assert.equal(keyConfig.providers["team-litellm"].keyEnv, "LITELLM_API_KEY");

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
        "PROJECT_B_LITELLM_API_KEY",
        "--model",
        "gpt-5.4-mini",
        "--project-settings",
        "--yes",
      ],
      env,
      tempDir,
    );

    assert.equal(second.code, 0);
    const rerunModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const rerunSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    const rerunKeyConfig = JSON.parse(await readFile(keyConfigPath, "utf8"));
    assert.equal(rerunModels.providers["team-litellm"].apiKey, expectedNodeResolverApiKeyCommand("team-litellm"));
    assert.deepEqual(rerunModels.providers["team-litellm"].models.map((model) => model.id), ["gpt-5.4-mini"]);
    assert.deepEqual(rerunSettings.enabledModels, ["team-litellm/gpt-5.4-mini"]);
    assert.equal(rerunKeyConfig.providers["team-litellm"].keyEnv, "PROJECT_B_LITELLM_API_KEY");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm leaves project Pi settings untouched unless explicitly requested", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-settings-skip-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const settingsPath = path.join(tempDir, ".pi", "settings.json");
  const originalSettings = JSON.stringify({
    defaultProvider: "github-copilot",
    defaultModel: "gpt-5.5",
    enabledModels: ["gpt-5.5"],
    theme: "dark",
  }, null, 2);

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, originalSettings, "utf8");

    const result = await runKhala(
      [
        "litellm",
        "--project",
        "--provider", "team-litellm",
        "--base-url", "https://lite.example/v1",
        "--key-env", "LITELLM_API_KEY",
        "--model", "gpt-5.4-mini",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Left project Pi defaults unchanged\./);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    const models = JSON.parse(await readFile(path.join(piAgentDir, "models.json"), "utf8"));
    assert.equal(models.providers["team-litellm"].api, LITELLM_PROVIDER_API);
    const keyConfig = JSON.parse(await readFile(path.join(tempDir, ".pi", "khala", "litellm.json"), "utf8"));
    assert.equal(keyConfig.providers["team-litellm"].keyEnv, "LITELLM_API_KEY");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm print-key resolves the nearest project key env without using models.json", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-print-key-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const nestedDir = path.join(tempDir, "src", "nested");
  const keyConfigPath = path.join(tempDir, ".pi", "khala", "litellm.json");
  const authPath = path.join(piAgentDir, "auth.json");

  try {
    await mkdir(path.dirname(keyConfigPath), { recursive: true });
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      keyConfigPath,
      JSON.stringify({ providers: { "team-litellm": { keyEnv: "PROJECT_LITELLM_KEY" } } }, null, 2),
      "utf8",
    );

    const result = await runKhala(
      ["litellm", "print-key", "--provider", "team-litellm"],
      { PROJECT_LITELLM_KEY: "sk-project-secret" },
      nestedDir,
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "sk-project-secret");
    assert.equal(result.stderr, "");

    const missing = await runKhala(
      ["litellm", "print-key", "--provider", "team-litellm"],
      { PI_CODING_AGENT_DIR: piAgentDir },
      nestedDir,
    );
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /key 'PROJECT_LITELLM_KEY' has no exported value \(expected \$PROJECT_LITELLM_KEY\)/);
    assert.doesNotMatch(missing.stderr, /sk-project-secret/);

    await writeFile(
      authPath,
      JSON.stringify({ "team-litellm": { type: "api_key", key: "sk-stored-global-auth" } }, null, 2),
      "utf8",
    );
    const stored = await runKhala(
      ["litellm", "print-key", "--provider", "team-litellm"],
      { PI_CODING_AGENT_DIR: piAgentDir },
      nestedDir,
    );
    assert.equal(stored.code, 0);
    assert.equal(stored.stdout, "sk-stored-global-auth");
    assert.equal(stored.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm reuse picker lists multiple key labels for the same provider", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-key-labels-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(targetProject, { recursive: true });
    await writeFile(
      path.join(piAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(piAgentDir, "auth.json"),
      JSON.stringify({
        "nlr:reeds-maint": { type: "api_key", key: "sk-stored-maint" },
        "nlr:reeds-research": { type: "api_key", key: "sk-stored-research" },
      }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMReuseKeyPtyTranscript(targetProject, piAgentDir);

    assert.match(transcript, /LiteLLM provider/);
    assert.match(transcript, /Key name/);
    assert.match(transcript, /reeds-maint/);
    assert.match(transcript, /reeds-research/);
    assert.doesNotMatch(transcript, /nlr - reeds-maint/);
    assert.doesNotMatch(transcript, /nlr - reeds-research/);
    assert.doesNotMatch(transcript, /Key label:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm reuse picker ignores non-Khala OpenAI-compatible providers", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-ignore-local-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const targetProject = path.join(tempDir, "target");

  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(targetProject, { recursive: true });
    await writeFile(
      path.join(piAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: "$LOCAL_API_KEY",
            models: [{ id: "llama-local" }],
          },
          nlr: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: LITELLM_PROVIDER_API,
            apiKey: buildLiteLLMApiKeyCommand("nlr"),
            models: [{ id: "gpt-5-mini" }],
          },
        },
      }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(piAgentDir, "auth.json"),
      JSON.stringify({
        "local:local-key": { type: "api_key", key: "sk-local" },
        "nlr:reeds-maint": { type: "api_key", key: "sk-stored-maint" },
      }, null, 2),
      "utf8",
    );

    const transcript = await runKhalaLiteLLMReuseKeyPtyTranscript(targetProject, piAgentDir);

    assert.match(transcript, /LiteLLM provider/);
    assert.match(transcript, /nlr/);
    assert.match(transcript, /reeds-maint/);
    assert.doesNotMatch(transcript, /[◉◯] {2}local/);
    assert.doesNotMatch(transcript, /local-key/);
    assert.doesNotMatch(transcript, /llama-local/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm keeps one provider entry while different projects choose different key envs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-project-keys-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  const projectA = path.join(tempDir, "project-a");
  const projectB = path.join(tempDir, "project-b");
  const modelsPath = path.join(piAgentDir, "models.json");

  try {
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    for (const [projectDir, keyEnv] of [[projectA, "PROJECT_A_KEY"], [projectB, "PROJECT_B_KEY"]] as const) {
      const result = await runKhala(
        [
          "litellm", "--project",
          "--provider", "team-litellm",
          "--base-url", "https://lite.example/v1",
          "--key-env", keyEnv,
          "--model", "gpt-5.4-mini",
          "--yes",
        ],
        { PI_CODING_AGENT_DIR: piAgentDir },
        projectDir,
      );
      assert.equal(result.code, 0, result.stderr || result.stdout);
    }

    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.deepEqual(Object.keys(models.providers), ["team-litellm"]);
    assert.equal(models.providers["team-litellm"].apiKey, expectedNodeResolverApiKeyCommand("team-litellm"));

    const projectAKeys = JSON.parse(await readFile(path.join(projectA, ".pi", "khala", "litellm.json"), "utf8"));
    const projectBKeys = JSON.parse(await readFile(path.join(projectB, ".pi", "khala", "litellm.json"), "utf8"));
    assert.equal(projectAKeys.providers["team-litellm"].keyEnv, "PROJECT_A_KEY");
    assert.equal(projectBKeys.providers["team-litellm"].keyEnv, "PROJECT_B_KEY");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm accepts a LiteLLM portal label and resolves $DERIVED env var for enrichment", async () => {
  // The whole point of the #235 follow-up: typing the same name as your
  // LiteLLM portal key (e.g. `reeds-maint`) must work end-to-end. We type
  // the portal label, export the *derived* shell name (REEDS_MAINT) the
  // way we actually told the user to in the auth row, and assert that
  // /model/info enrichment fires using that value.
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/model/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          model_name: "gpt-4o",
          model_info: { max_input_tokens: 128000, input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
        }],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-portal-label-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", baseUrl,
        // Portal label with a dash — used to be a fatal validation error.
        "--key-env", "reeds-maint",
        "--model", "gpt-4o",
        "--yes",
      ],
      // The shell-canonical derived name is what we tell users to export.
      // The lookup helper must find the value under REEDS_MAINT even though
      // models.json/.pi config store the literal `reeds-maint`.
      { PI_CODING_AGENT_DIR: piAgentDir, REEDS_MAINT: "sk-from-shell" },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    // (a) Summary key row anchors on the portal label and discloses the
    //     derived shell name in a parenthetical.
    assert.match(result.stdout, /save project key label reeds-maint in project LiteLLM config/);
    // (b) Auth preview references the derived form (the one you'd actually
    //     `export`), not the portal label.
    assert.match(result.stdout, /use API key from \$REEDS_MAINT; do not write global auth store/);
    // (c) Enrichment fired with the shell-resolved value.
    assert.equal(requests[0]?.auth, "Bearer sk-from-shell");
    assert.match(result.stdout, /^1\/1 enriched from \/model\/info/m);
    // (d) Project config persists the portal label verbatim — the user's
    //     mental anchor is preserved across reruns, and print-key resolves
    //     via lookupKeyValueByName().
    const cfg = JSON.parse(await readFile(path.join(tempDir, ".pi/khala/litellm.json"), "utf8"));
    assert.equal(cfg.providers.nlr.keyEnv, "reeds-maint");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        "--project-settings",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0);
    // Summary collapses the model list to one labeled row with a +N more
    // suffix, matching the one-row-per-concept aesthetic of the main khala
    // configuration block. The full list is verifiable in models.json.
    assert.match(result.stdout, /provider team-litellm with 3 models/);
    assert.match(result.stdout, /set project Pi defaults to 3 models \(gpt-5\.4-mini, gpt-4o, claude-opus-4\.7\)/);
    assert.match(result.stdout, /pi --list-models is global; project model defaults live in \.pi\/settings\.json\./);

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
    assert.equal(merged.providers["team-litellm"].apiKey, expectedNodeResolverApiKeyCommand("team-litellm"));

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "team-litellm");
    assert.equal(settings.defaultModel, "gpt-5.4-mini");
    assert.deepEqual(settings.enabledModels, [
      "team-litellm/gpt-5.4-mini",
      "team-litellm/gpt-4o",
      "team-litellm/claude-opus-4.7",
    ]);
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
    assert.match(result.stdout, /add global model registry provider nlr with 1 model/);
    assert.match(result.stdout, /^1\/1 enriched from \/model\/info/m);
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

test("khala litellm previews an unchanged auth store when no key source is available", async () => {
  // The setup should stay calm: explain that metadata could not be fetched,
  // preview that auth stays unchanged, and still write bare model entries.
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-noexport-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    // Note: NO `DEFINITELY_UNSET_KEY` in the spawn env and no --auth-mode
    // flag — we want to exercise the "silent fallback to skip" path.
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
    assert.match(result.stdout, /leave global auth store unchanged/);
    assert.match(result.stdout, /Could not fetch model metadata: no API key was available/);
    // The fallback write still proceeds with bare { id } entries.
    const raw = await readFile(path.join(piAgentDir, "models.json"), "utf8");
    assert.match(raw, /\{ "id": "gpt-4o" \}/);
    // And no auth.json is created when the user picked skip (the default).
    await assert.rejects(readFile(path.join(piAgentDir, "auth.json"), "utf8"));
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
    assert.match(result.stdout, /Could not fetch model metadata: request failed\. Models will still work if the ids are correct\./);

    // Bare entries get the compact one-line treatment.
    const raw = await readFile(path.join(piAgentDir, "models.json"), "utf8");
    assert.match(raw, /\{ "id": "gpt-4o" \}/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm uses calm metadata failure wording on a 403 from /model/info", async () => {
  // Reproduces the real-world failure observed against an internal LiteLLM
  // proxy: the key is valid for inference but doesn't have admin permission.
  // Normal output should keep only the status and the consequence.
  const server: Server = createServer((req, res) => {
    if (req.url === "/model/info") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "Authentication Error, Only proxy admin can view /model/info" },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-403-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", baseUrl,
        "--key-env", "NLR_KEY",
        "--model", "gpt-4o",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir, NLR_KEY: "sk-user-scope" },
      tempDir,
    );

    // Setup itself succeeds; metadata enrichment is the only thing skipped.
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Could not fetch model metadata: HTTP 403\. Models will still work if the ids are correct\./);
    assert.doesNotMatch(result.stdout, /Only proxy admin can view \/model\/info/);
    assert.doesNotMatch(result.stdout, /admin access/);
    // And the bare write happens — the user's setup isn't blocked.
    const raw = await readFile(path.join(piAgentDir, "models.json"), "utf8");
    assert.match(raw, /\{ "id": "gpt-4o" \}/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm hides non-JSON proxy error bodies in normal output", async () => {
  // Some proxies/load-balancers return text/html on errors. Normal output
  // should not dump that body; --verbose is the path for implementation detail.
  const server: Server = createServer((req, res) => {
    if (req.url === "/model/info") {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body><h1>502 Bad Gateway</h1>upstream connection refused</body></html>");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-502-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", baseUrl,
        "--key-env", "NLR_KEY",
        "--model", "gpt-4o",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir, NLR_KEY: "sk-anything" },
      tempDir,
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Could not fetch model metadata: HTTP 502\. Models will still work if the ids are correct\./);
    assert.doesNotMatch(result.stdout, /502 Bad Gateway/);
    assert.doesNotMatch(result.stdout, /admin access/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm --auth-mode=literal writes auth.json with 0600 perms and uses the key for /model/info", async () => {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/model/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [{
          model_name: "gpt-5.4-mini",
          model_info: { max_input_tokens: 200_000, max_output_tokens: 8192, input_cost_per_token: 0.00000015, output_cost_per_token: 0.0000006 },
        }],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-auth-literal-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    // Pre-seed auth.json with an unrelated entry that MUST survive the merge.
    await writeFile(path.join(piAgentDir, "auth.json"), JSON.stringify({
      "openai": { type: "api_key", key: "sk-keep-me" },
    }, null, 2), "utf8");

    const secretValue = "sk-fake-literal-token-paste";
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "team-litellm",
        "--base-url", baseUrl,
        "--key-env", "LITELLM_API_KEY",
        "--model", "gpt-5.4-mini",
        "--auth-mode=literal", `--auth-key=${secretValue}`,
        "--yes",
      ],
      // NO LITELLM_API_KEY in env: prove the literal alone enables enrichment.
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    // (a) The auth row in the summary points at auth.json with 0600.
    assert.match(result.stdout, /store API key in global auth store/);
    assert.match(result.stdout, /\(0600\)/);
    assert.match(result.stdout, /Wrote global auth store/);
    // (b) Enrichment kicked in because the literal was used for the fetch.
    assert.match(result.stdout, /^1\/1 enriched from \/model\/info/m);
    // (c) Server saw a Bearer header carrying the literal value.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, `Bearer ${secretValue}`);
    // (d) The literal NEVER appears in stdout/stderr — only the path to the
    //     file. This is the core safety guarantee of the masked prompt.
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secretValue));
    // (e) auth.json on disk has the literal, the unrelated provider survived,
    //     and the file is 0600 (read+write for user only).
    const authPath = path.join(piAgentDir, "auth.json");
    const authRaw = await readFile(authPath, "utf8");
    const authParsed = JSON.parse(authRaw);
    assert.deepEqual(authParsed["team-litellm"], { type: "api_key", key: secretValue });
    assert.deepEqual(authParsed.openai, { type: "api_key", key: "sk-keep-me" });
    const { mode } = await import("node:fs/promises").then((m) => m.stat(authPath));
    // Lower 9 bits == permission bits; 0o600 == 0o400 (user-read) | 0o200 (user-write).
    assert.equal(mode & 0o777, 0o600, `auth.json must be 0600, was 0${(mode & 0o777).toString(8)}`);
    assert.match(result.stdout, /Khala stored your API key in global auth store/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm --auth-mode=command stores a !command and exec's it for /model/info", async () => {
  const requests: Array<{ auth: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ auth: req.headers.authorization });
    if (req.url === "/model/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ model_name: "gpt-4o", model_info: { max_input_tokens: 128000 } }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-auth-command-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    // The command prints a fake key on stdout. khala must exec it once for
    // the immediate /model/info fetch, AND store the command (NOT its output)
    // in auth.json so pi re-execs at runtime.
    const command = "!printf 'sk-from-shell-command'";
    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "cmd-provider",
        "--base-url", baseUrl,
        "--key-env", "CMD_PROVIDER_KEY",
        "--model", "gpt-4o",
        "--auth-mode=command", `--auth-command=${command}`,
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /store API key command in global auth store/);
    // Enrichment worked because the command's stdout was used as the bearer.
    assert.match(result.stdout, /^1\/1 enriched from \/model\/info/m);
    assert.equal(requests[0].auth, "Bearer sk-from-shell-command");
    // auth.json stores the !command verbatim, not the resolved value.
    const auth = JSON.parse(await readFile(path.join(piAgentDir, "auth.json"), "utf8"));
    assert.deepEqual(auth["cmd-provider"], { type: "api_key", key: command });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm --auth-mode=skip leaves auth.json untouched", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-auth-skip-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });

    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", "https://example.com/v1",
        "--key-env", "NLR_KEY",
        "--model", "gpt-4o",
        "--auth-mode=skip",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir, NLR_KEY: "sk-from-shell" },
      tempDir,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /use API key from \$NLR_KEY; do not write global auth store/);
    // No ✓ Wrote line for auth.json, and no auth.json file on disk.
    assert.doesNotMatch(result.stdout, /Wrote global auth store/);
    await assert.rejects(readFile(path.join(piAgentDir, "auth.json"), "utf8"));
    // Boundary tagline stays in "reference, not value" mode.
    assert.doesNotMatch(result.stdout, /Khala stored a key reference, not a secret value/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("khala litellm fails closed on malformed auth.json", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-litellm-bad-auth-"));
  const piAgentDir = path.join(tempDir, "pi-agent");
  try {
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await writeFile(path.join(piAgentDir, "auth.json"), "{ not-json", "utf8");

    const result = await runKhala(
      [
        "litellm", "--project",
        "--provider", "nlr",
        "--base-url", "https://example.com/v1",
        "--key-env", "NLR_KEY",
        "--model", "gpt-4o",
        "--auth-mode=literal", "--auth-key=sk-fake",
        "--yes",
      ],
      { PI_CODING_AGENT_DIR: piAgentDir },
      tempDir,
    );

    // Same fail-closed contract as models.json / settings.json: exit 2 with
    // a clear message naming the bad file. Better than silently clobbering
    // a file that might be salvageable by hand.
    assert.equal(result.code, 2);
    assert.match(result.stderr, /auth\.json/);
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
        "--project-settings",
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
        "--project-settings",
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
