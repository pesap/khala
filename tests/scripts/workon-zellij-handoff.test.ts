import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

test("workon zellij handoff waits long enough for delayed Worktrunk tab", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-zellij-handoff-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);

    const stateFile = path.join(tempDir, "list-tabs-count");
    const paneLog = path.join(tempDir, "panes.log");
    const worktreePath = path.join(tempDir, "worktree");
    const capsulePath = path.join(tempDir, "capsule.md");
    const branch = "work/93-work-when-our-handoff-pi-session-finish-it-does-not-receive-the-feedback";
    const tabName = "agents/work-93-work-when-our-handoff-pi-session-finish-it-does-not-receive-the-feedback";

    await mkdir(worktreePath);
    await writeFile(capsulePath, "# capsule\n", "utf8");
    await writeFile(stateFile, "0\n", "utf8");

    await writeExecutable(
      path.join(binDir, "wt"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "switch" ]]; then
  printf '{"action":"created","path":"${worktreePath}"}\\n'
else
  printf 'unexpected wt args: %s\\n' "$*" >&2
  exit 2
fi
`,
    );

    await writeExecutable(
      path.join(binDir, "zellij"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "action list-tabs --json" ]]; then
  count=$(cat "${stateFile}")
  count=$((count + 1))
  printf '%s\\n' "$count" > "${stateFile}"
  if (( count < 12 )); then
    printf '[]\\n'
  else
    printf '[{"name":"${tabName}","tab_id":12}]\\n'
  fi
  exit 0
fi
if [[ "$*" == "action go-to-tab-name ${tabName}" ]]; then
  exit 0
fi
if [[ "$1 $2" == "action new-pane" ]]; then
  printf '%s\\n' "$*" >> "${paneLog}"
  printf 'terminal_99\\n'
  exit 0
fi
printf 'unexpected zellij args: %s\\n' "$*" >&2
exit 2
`,
    );

    await writeExecutable(path.join(binDir, "pi"), "#!/usr/bin/env bash\nexit 0\n");

    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const scriptPath = path.join(repoRoot, "scripts", "workon-zellij-handoff.sh");
    const { stdout } = await execFileAsync(
      "bash",
      [
        scriptPath,
        "--repo",
        "pesap/agents",
        "--branch",
        branch,
        "--capsule",
        capsulePath,
        "--prompt",
        "handoff prompt",
        "--heartbeat",
        "0",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          ZELLIJ_TAB_WAIT_SECONDS: "0.01",
        },
      },
    );

    const resultLine = stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("{"));
    assert.ok(resultLine);
    const result = JSON.parse(resultLine);
    assert.equal(result.status, "launched");
    assert.equal(result.path, worktreePath);
    assert.equal(result.tabName, tabName);

    const panes = await readFile(paneLog, "utf8");
    assert.match(panes, /--name pi/);
    assert.doesNotMatch(panes, /forge-heartbeat/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
