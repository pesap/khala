import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "workon-send-to-worker.sh");

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function writeFakeZellij(binDir: string, logPath: string, paneId: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "zellij"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  "action list-panes --json")
    printf '[{"id":${JSON.stringify(paneId)}}]\n'
    ;;
  "action paste --pane-id ${paneId} "*)
    ;;
  "action send-keys --pane-id ${paneId} Enter")
    ;;
  *)
    printf 'unexpected zellij args: %s\n' "$*" >&2
    exit 2
    ;;
esac
`,
  );
}

async function writeFakeTmux(binDir: string, logPath: string, paneId: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "tmux"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  "list-panes -a -F #{pane_id}")
    printf '%s\n' ${JSON.stringify(paneId)}
    ;;
  "send-keys -t ${paneId} -l "*)
    ;;
  "send-keys -t ${paneId} Enter")
    ;;
  *)
    printf 'unexpected tmux args: %s\n' "$*" >&2
    exit 2
    ;;
esac
`,
  );
}

async function writeLedger(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ledgerPath = path.join(dir, "handoff-ledger.json");
  await writeFile(
    ledgerPath,
    JSON.stringify(
      {
        version: 1,
        capsulePath: path.join(dir, "capsule.md"),
        ledgerPath,
        primaryIssue: {
          number: 270,
          url: "https://github.com/pesap/khala/issues/270",
        },
        multiplexer: { resolved: "zellij" },
        pi: { status: "capsule-acknowledged", paneId: "terminal_91" },
        attempts: [],
        ...overrides,
      },
      null,
      2,
    ),
    "utf8",
  );
  return ledgerPath;
}

async function runSend(env: NodeJS.ProcessEnv, ledgerPath: string, message: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(
    "bash",
    [scriptPath, "--ledger", ledgerPath, "--message", message],
    { cwd: repoRoot, env },
  );
  return { stdout, stderr };
}

test("sends a framed operator follow-up to a live zellij pane and appends ledger records", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-zellij-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "zellij.log");
    await mkdir(binDir);
    await writeFakeZellij(binDir, logPath, "terminal_91");
    const ledgerPath = await writeLedger(tempDir, {
      multiplexer: { resolved: "zellij" },
      pi: { status: "capsule-acknowledged", paneId: "terminal_91" },
    });

    const { stdout } = await runSend(
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      ledgerPath,
      "Please verify scope and rerun validation.",
    );

    assert.match(stdout, /"status":"sent"/);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.pi.operatorFollowUps.at(-1).status, "sent");
    assert.equal(ledger.pi.operatorFollowUps.at(-1).paneId, "terminal_91");
    assert.match(String(ledger.pi.operatorFollowUps.at(-1).framedMessage), /\/workon operator follow-up/);
    assert.match(String(ledger.pi.operatorFollowUps.at(-1).framedMessage), /This is not forge feedback\./);
    assert.match(String(ledger.pi.operatorFollowUps.at(-1).framedMessage), /Please verify scope and rerun validation\./);
    assert.equal(ledger.attempts.at(-1).phase, "operator-follow-up");
    assert.equal(ledger.attempts.at(-1).status, "sent");
    assert.match(await readFile(logPath, "utf8"), /action list-panes --json/);
    assert.match(await readFile(logPath, "utf8"), /action paste --pane-id terminal_91/);
    assert.match(await readFile(logPath, "utf8"), /action send-keys --pane-id terminal_91 Enter/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("sends a framed operator follow-up to a live tmux pane and appends ledger records", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-tmux-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "tmux.log");
    await mkdir(binDir);
    await writeFakeTmux(binDir, logPath, "%1");
    const ledgerPath = await writeLedger(tempDir, {
      multiplexer: { resolved: "tmux" },
      pi: { status: "pi-process-started", paneId: "%1" },
    });

    const { stdout } = await runSend(
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      ledgerPath,
      "Please rerun the focused tests.",
    );

    assert.match(stdout, /"multiplexer":"tmux"/);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.pi.operatorFollowUps.at(-1).status, "sent");
    assert.equal(ledger.attempts.at(-1).status, "sent");
    assert.match(await readFile(logPath, "utf8"), /list-panes -a -F #\{pane_id\}/);
    assert.match(await readFile(logPath, "utf8"), /send-keys -t %1 -l/);
    assert.match(await readFile(logPath, "utf8"), /send-keys -t %1 Enter/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("rejects invalid send requests with actionable stderr", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-failure-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    await writeFakeZellij(binDir, path.join(tempDir, "zellij.log"), "terminal_91");
    const ledgerPath = await writeLedger(tempDir, {
      multiplexer: { resolved: "zellij" },
      pi: { status: "not-launched", paneId: "terminal_91" },
    });

    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", ledgerPath, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /not sendable in status not-launched/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("rejects missing pane ids, live-pane failures, and missing jq", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-matrix-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(
      path.join(binDir, "jq"),
      "#!/usr/bin/env bash\nexec /usr/bin/jq \"$@\"\n",
    );
    const ledgerPath = await writeLedger(tempDir, {
      multiplexer: { resolved: "zellij" },
      pi: { status: "capsule-acknowledged", paneId: "terminal_91" },
    });

    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", ledgerPath, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: binDir } },
      ),
      () => true,
    );

    await writeFakeZellij(binDir, path.join(tempDir, "zellij.log"), "terminal_99");
    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", ledgerPath, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:/bin:/usr/sbin:/sbin` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /recorded Zellij pane id is not live: terminal_91/);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", ledgerPath, "--message", ""],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:/bin:/usr/sbin:/sbin` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /--message requires TEXT|Usage:/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("rejects missing ledger, empty ledger, unsupported multiplexer, and missing pane id", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-invalid-ledger-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(
      path.join(binDir, "jq"),
      "#!/usr/bin/env bash\nexec /usr/bin/jq \"$@\"\n",
    );
    const emptyLedger = path.join(tempDir, "empty.json");
    await writeFile(emptyLedger, "", "utf8");
    const missingLedger = path.join(tempDir, "missing.json");
    const unsupportedLedger = await writeLedger(path.join(tempDir, "unsupported"), {
      multiplexer: { resolved: "none" },
      pi: { status: "capsule-acknowledged", paneId: "terminal_91" },
    });
    const missingPaneLedger = await writeLedger(path.join(tempDir, "missing-pane"), {
      multiplexer: { resolved: "zellij" },
      pi: { status: "capsule-acknowledged", paneId: "" },
    });

    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", missingLedger, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /handoff ledger is missing or empty/);
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", emptyLedger, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /handoff ledger is missing or empty/);
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", unsupportedLedger, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /unsupported multiplexer/);
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", missingPaneLedger, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      ),
      (error: unknown) => {
        const nodeError = error as { stderr?: string };
        assert.match(nodeError.stderr ?? "", /does not record a Pi pane id/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("rejects missing jq before reading the ledger", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-send-worker-missing-jq-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(
      path.join(binDir, "zellij"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    const ledgerPath = await writeLedger(tempDir, {
      multiplexer: { resolved: "zellij" },
      pi: { status: "capsule-acknowledged", paneId: "terminal_91" },
    });

    await assert.rejects(
      execFileAsync(
        "bash",
        [scriptPath, "--ledger", ledgerPath, "--message", "follow up"],
        { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:/bin:/usr/sbin:/sbin` } },
      ),
      () => true,
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
