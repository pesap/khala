import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function writeFakeJq(binDir: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "jq"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-Rn" && args[1] === "--arg" && args[2] === "value") {
  console.log(JSON.stringify(args[3] ?? ""));
  process.exit(0);
}
const input = fs.readFileSync(0, "utf8");
if (args.includes(".path // empty")) {
  try {
    const parsed = JSON.parse(input);
    if (parsed.path) process.stdout.write(String(parsed.path));
  } catch {}
  process.exit(0);
}
process.stdout.write(input);
`,
  );
}

test("workon tmux handoff launches Pi and heartbeat with structured multiplexer JSON", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-tmux-handoff-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "tmux.log");
    const worktreePath = path.join(tempDir, "worktree");
    await mkdir(binDir);
    await mkdir(worktreePath);
    await writeFakeJq(binDir);
    await writeExecutable(path.join(binDir, "tr"), "#!/bin/sh\nexec /usr/bin/tr \"$@\"\n");
    await writeExecutable(path.join(binDir, "sed"), "#!/bin/sh\nexec /usr/bin/sed \"$@\"\n");
    await writeExecutable(
      path.join(binDir, "wt"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "switch --create feat/211-tmux-provider --format json" ]]; then
  printf '{"action":"created","branch":"feat/211-tmux-provider","path":"%s"}\\n' "\${WORKTREE_PATH}"
  exit 0
fi
printf 'unexpected wt args: %s\\n' "$*" >&2
exit 1
`,
    );
    await writeExecutable(
      path.join(binDir, "pi"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\\n'
  printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\\n'
  exit 0
fi
printf 'unexpected pi args: %s\\n' "$*" >&2
exit 1
`,
    );
    await writeExecutable(
      path.join(binDir, "tmux"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${TMUX_LOG}"
case "$1" in
  has-session)
    exit 1
    ;;
  new-session)
    printf '$khala-session\\n'
    ;;
  list-windows)
    exit 0
    ;;
  display-message)
    printf '$khala-session\\n'
    ;;
  new-window)
    if [[ "$*" == *" -n pi "* ]]; then
      printf '%%1\\n'
    else
      printf '%%2\\n'
    fi
    ;;
  *)
    exit 0
    ;;
esac
`,
    );

    const capsulePath = path.join(tempDir, "capsule.md");
    await writeFile(capsulePath, "# capsule\n", "utf8");
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const scriptPath = path.join(repoRoot, "scripts", "workon-multiplexer-handoff.sh");
    const { stdout } = await execFileAsync("bash", [
      scriptPath,
      "--multiplexer",
      "tmux",
      "--repo",
      "pesap/agents",
      "--branch",
      "feat/211-tmux-provider",
      "--capsule",
      capsulePath,
      "--prompt",
      "handoff prompt",
      "--heartbeat",
      "0.25",
      "--model",
      "github-copilot/gpt-5.4-mini",
      "--thinking",
      "medium",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        WORKTREE_PATH: worktreePath,
        TMUX_LOG: logPath,
        PI_CODING_AGENT_DIR: path.join(tempDir, "pi-agent"),
      },
    });

    const result = JSON.parse(stdout.trim());
    assert.equal(result.status, "launched");
    assert.equal(result.multiplexer, "tmux");
    assert.equal(result.path, worktreePath);
    assert.equal(result.scopeName, "khala-agents-feat-211-tmux-provider");
    assert.equal(result.sessionName, "khala-agents-feat-211-tmux-provider");
    assert.equal(result.tabName, "khala-agents-feat-211-tmux-provider");
    assert.equal(result.piPaneId, "%1");
    assert.equal(result.heartbeatPaneId, "%2");
    assert.match(result.piHandoffCommand, /tmux new-window .* -n pi /);
    assert.match(result.heartbeatCommand, /--multiplexer tmux/);
    assert.match(result.heartbeatCommand, /--trusted-author @me/);
    assert.match(result.heartbeatCommand, /--trusted-author copilot-pull-request-reviewer\[bot\]/);
    assert.match(result.heartbeatCommand, /--notify-pane %1/);

    if (process.platform !== "win32") {
      const handoffDir = path.join(tempDir, "handoff");
      const promptPath = path.join(handoffDir, "feat-211-tmux-provider-prompt.txt");
      const piScriptPath = path.join(handoffDir, "feat-211-tmux-provider-pi.sh");
      assert.equal((await stat(handoffDir)).mode & 0o777, 0o700);
      assert.equal((await stat(promptPath)).mode & 0o777, 0o600);
      assert.equal((await stat(piScriptPath)).mode & 0o777, 0o700);
      const prompt = await readFile(promptPath, "utf8");
      assert.match(prompt, /First-turn required actions:/);
      assert.match(prompt, /Read the session capsule path with the read tool:/);
      assert.match(prompt, /Run the acknowledgement command with the bash tool exactly after reading the capsule:/);
      assert.match(prompt, /Confirm this session is in the Worktrunk worktree recorded in the capsule/);
      assert.match(prompt, /create\/reuse the draft PR immediately with an empty bootstrap commit/);
      assert.match(prompt, /Final answer must include: capsule-acknowledged; readiness status; draft PR status or exact blocker; first implementation action or escalation\./);
      assert.doesNotMatch(prompt, /waiting for a separate explicit operator instruction/);
    }

    const tmuxLog = await readFile(logPath, "utf8");
    assert.match(tmuxLog, /new-session .* -s khala-agents-feat-211-tmux-provider .* -n khala /);
    assert.match(tmuxLog, /new-window .* -n pi /);
    assert.match(tmuxLog, /new-window .* -n forge-heartbeat /);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("workon tmux handoff passes host-qualified repo to heartbeat window", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-tmux-enterprise-heartbeat-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "tmux.log");
    const worktreePath = path.join(tempDir, "worktree");
    await mkdir(binDir);
    await mkdir(worktreePath);
    await writeFakeJq(binDir);
    await writeExecutable(path.join(binDir, "tr"), "#!/bin/sh\nexec /usr/bin/tr \"$@\"\n");
    await writeExecutable(path.join(binDir, "sed"), "#!/bin/sh\nexec /usr/bin/sed \"$@\"\n");
    await writeExecutable(
      path.join(binDir, "wt"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"action":"created","path":"%s"}\n' "\${WORKTREE_PATH}"
`,
    );
    await writeExecutable(path.join(binDir, "pi"), "#!/usr/bin/env bash\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "tmux"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"\${TMUX_LOG}"
case "$1" in
  has-session)
    exit 1
    ;;
  new-session)
    printf '$khala-session\n'
    ;;
  list-windows)
    exit 0
    ;;
  display-message)
    printf '$khala-session\n'
    ;;
  new-window)
    if [[ "$*" == *" -n pi "* ]]; then
      printf '%%1\n'
    else
      printf '%%2\n'
    fi
    ;;
  *)
    exit 0
    ;;
esac
`,
    );

    const capsulePath = path.join(tempDir, "capsule.md");
    await writeFile(capsulePath, "# capsule\n", "utf8");
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const scriptPath = path.join(repoRoot, "scripts", "workon-multiplexer-handoff.sh");
    const { stdout } = await execFileAsync("bash", [
      scriptPath,
      "--multiplexer",
      "tmux",
      "--repo",
      "github.enterprise.example/PCM/nodal-allocation",
      "--branch",
      "feat/91-implement-sienna-z2n-mapping",
      "--capsule",
      capsulePath,
      "--prompt",
      "handoff prompt",
      "--heartbeat",
      "1.0",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        WORKTREE_PATH: worktreePath,
        TMUX_LOG: logPath,
      },
    });

    const result = JSON.parse(stdout.trim());
    assert.equal(result.status, "launched");
    assert.match(result.heartbeatCommand, /--repo github\.enterprise\.example\/PCM\/nodal-allocation/);
    assert.match(result.heartbeatCommand, /--trusted-author @me/);
    assert.match(result.heartbeatCommand, /--trusted-author copilot-pull-request-reviewer\[bot\]/);

    const tmuxLog = await readFile(logPath, "utf8");
    assert.match(tmuxLog, /new-window .* -n forge-heartbeat /);
    assert.match(tmuxLog, /--repo github\.enterprise\.example\/PCM\/nodal-allocation/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("workon multiplexer dispatcher rejects unsupported providers with structured JSON", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "workon-multiplexer-handoff.sh");
  await assert.rejects(
    execFileAsync("bash", [scriptPath, "--multiplexer", "screen"], { cwd: repoRoot }),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      const result = JSON.parse(stderr.trim());
      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "unsupported-multiplexer");
      assert.equal(result.multiplexer, "screen");
      return true;
    },
  );
});
