import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "workon-forge-heartbeat.sh");
const fixturesRoot = path.join(repoRoot, "tests", "scripts", "fixtures", "workon-forge-heartbeat");
const branch = "work/103-heartbeat";

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function writeFakeGh(binDir: string, scenario: string): Promise<void> {
  const fixtureDir = path.join(fixturesRoot, scenario);
  await writeExecutable(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
fixture_dir=${JSON.stringify(fixtureDir)}
if [[ "$*" == *"user"* && "$*" == *".login"* ]]; then
  printf 'pesap\n'
  exit 0
fi
if [[ "$*" == "pr list --repo pesap/agents --state open --head ${branch} --json number,title,url --jq .[0] // empty" ]]; then
  printf '{"number":103,"title":"heartbeat","url":"https://github.com/pesap/agents/pull/103"}\n'
  exit 0
fi
if [[ "$*" == *"repos/pesap/agents/issues/103/comments --paginate"* ]]; then
  cat "$fixture_dir/issue-comments.json"
  exit 0
fi
if [[ "$*" == *"repos/pesap/agents/pulls/103/comments --paginate"* ]]; then
  cat "$fixture_dir/review-comments.json"
  exit 0
fi
if [[ "$*" == *"repos/pesap/agents/pulls/103/reviews --paginate"* ]]; then
  cat "$fixture_dir/reviews.json"
  exit 0
fi
if [[ "\${1:-}" == "api" && "$*" == *"graphql"* ]]; then
  cat "$fixture_dir/review-threads.json"
  exit 0
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
  );
}

async function writeFakeZellij(binDir: string, zellijLog: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "zellij"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(zellijLog)}
exit 0
`,
  );
}

async function writeFakeTmux(binDir: string, tmuxLog: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "tmux"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(tmuxLog)}
exit 0
`,
  );
}

async function setupScenario(scenario: string): Promise<{
  tempDir: string;
  env: NodeJS.ProcessEnv;
  stateFile: string;
  zellijLog: string;
  tmuxLog: string;
}> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-forge-heartbeat-test-"));
  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir);
  const stateFile = path.join(tempDir, "state", "heartbeat.json");
  const zellijLog = path.join(tempDir, "zellij.log");
  const tmuxLog = path.join(tempDir, "tmux.log");
  await writeFakeGh(binDir, scenario);
  await writeFakeZellij(binDir, zellijLog);
  await writeFakeTmux(binDir, tmuxLog);

  return {
    tempDir,
    stateFile,
    zellijLog,
    tmuxLog,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  };
}

async function runHeartbeat(env: NodeJS.ProcessEnv, stateFile: string, multiplexer = "zellij"): Promise<string> {
  const { stdout } = await execFileAsync(
    "bash",
    [
      scriptPath,
      "--repo",
      "pesap/agents",
      "--branch",
      branch,
      "--interval",
      "1.0",
      "--multiplexer",
      multiplexer,
      "--author",
      "@me",
      "--notify-pane",
      "terminal_99",
      "--state-file",
      stateFile,
      "--once",
    ],
    {
      cwd: repoRoot,
      env,
    },
  );
  return stdout;
}

test("forge heartbeat uses host-aware gh calls for GitHub Enterprise repos", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workon-forge-heartbeat-enterprise-test-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    const stateFile = path.join(tempDir, "state", "heartbeat.json");
    const ghLog = path.join(tempDir, "gh.log");
    const fixtureDir = path.join(fixturesRoot, "answered-review-thread");
    const enterpriseBranch = "feat/91-implement-sienna-z2n-mapping";

    await writeExecutable(
      path.join(binDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(ghLog)}
fixture_dir=${JSON.stringify(fixtureDir)}
if [[ "$*" == "api --hostname github.enterprise.example user --jq .login" ]]; then
  printf 'pesap\n'
  exit 0
fi
if [[ "$*" == "pr list --repo github.enterprise.example/PCM/nodal-allocation --state open --head ${enterpriseBranch} --json number,title,url --jq .[0] // empty" ]]; then
  printf '{"number":91,"title":"enterprise heartbeat","url":"https://github.enterprise.example/PCM/nodal-allocation/pull/91"}\n'
  exit 0
fi
if [[ "$*" == "api --hostname github.enterprise.example repos/PCM/nodal-allocation/issues/91/comments --paginate" ]]; then
  cat "$fixture_dir/issue-comments.json"
  exit 0
fi
if [[ "$*" == "api --hostname github.enterprise.example repos/PCM/nodal-allocation/pulls/91/comments --paginate" ]]; then
  cat "$fixture_dir/review-comments.json"
  exit 0
fi
if [[ "$*" == "api --hostname github.enterprise.example repos/PCM/nodal-allocation/pulls/91/reviews --paginate" ]]; then
  cat "$fixture_dir/reviews.json"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-} \${4:-}" == "api graphql --hostname github.enterprise.example" ]]; then
  cat "$fixture_dir/review-threads.json"
  exit 0
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
    );

    const { stdout } = await execFileAsync(
      "bash",
      [
        scriptPath,
        "--repo",
        "github.enterprise.example/PCM/nodal-allocation",
        "--branch",
        enterpriseBranch,
        "--interval",
        "1.0",
        "--author",
        "@me",
        "--state-file",
        stateFile,
        "--once",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.match(stdout, /https:\/\/github\.enterprise\.example\/PCM\/nodal-allocation\/pull\/91/);
    const ghCalls = await readFile(ghLog, "utf8");
    assert.match(ghCalls, /api --hostname github\.enterprise\.example user --jq \.login/);
    assert.match(ghCalls, /pr list --repo github\.enterprise\.example\/PCM\/nodal-allocation/);
    assert.match(ghCalls, /api --hostname github\.enterprise\.example repos\/PCM\/nodal-allocation\/issues\/91\/comments --paginate/);
    assert.match(ghCalls, /api --hostname github\.enterprise\.example repos\/PCM\/nodal-allocation\/pulls\/91\/comments --paginate/);
    assert.match(ghCalls, /api --hostname github\.enterprise\.example repos\/PCM\/nodal-allocation\/pulls\/91\/reviews --paginate/);
    assert.match(ghCalls, /api graphql --hostname github\.enterprise\.example/);
    assert.match(ghCalls, /-f owner=PCM/);
    assert.match(ghCalls, /-f name=nodal-allocation/);
    assert.doesNotMatch(ghCalls, /pr list --repo PCM\/nodal-allocation/);
    assert.doesNotMatch(ghCalls, /repos\/github\.enterprise\.example\/PCM/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test("forge heartbeat sends unresolved root review threads as structured actionable feedback", async () => {
  const { tempDir, env, stateFile, zellijLog } = await setupScenario("unresolved-review-thread");
  try {
    const stdout = await runHeartbeat(env, stateFile);
    const jsonLines = parseJsonLines(stdout);
    const thread = jsonLines.find((line) => line.type === "review-thread");

    assert.ok(thread);
    assert.equal(thread.actionable, true);
    assert.equal(thread.threadId, "PRRT_unresolved");
    assert.equal(thread.rootCommentId, 1001);
    assert.equal(thread.path, "scripts/workon-forge-heartbeat.sh");
    assert.equal(thread.url, "https://github.com/pesap/agents/pull/103#discussion_r1001");
    assert.equal(Array.isArray(thread.suggestions), true);
    const expectedSuggestion = `remember_notified_feedback "${"$"}{new_actionable_feedback}"`;
    assert.deepEqual(thread.suggestions, [
      {
        kind: "suggestion",
        replacement: expectedSuggestion,
      },
    ]);

    assert.match(stdout, /"status":"notified-pi"/);
    const zellijActions = await readFile(zellijLog, "utf8");
    assert.match(zellijActions, /BEGIN UNTRUSTED FORGE FEEDBACK JSON/);
    assert.match(zellijActions, /"type":"review-thread"/);
    assert.match(zellijActions, /"actionable":true/);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(state.notifiedKeys, [thread.dedupeKey]);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("forge heartbeat notifies tmux targets when requested", async () => {
  const { tempDir, env, stateFile, tmuxLog } = await setupScenario("unresolved-review-thread");
  try {
    const stdout = await runHeartbeat(env, stateFile, "tmux");
    assert.match(stdout, /"status":"notified-pi"/);

    const tmuxActions = await readFile(tmuxLog, "utf8");
    assert.match(tmuxActions, /send-keys -t terminal_99 -l/);
    assert.match(tmuxActions, /BEGIN UNTRUSTED FORGE FEEDBACK JSON/);
    assert.match(tmuxActions, /send-keys -t terminal_99 Enter/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("forge heartbeat skips resolved review threads instead of notifying Pi", async () => {
  const { tempDir, env, stateFile, zellijLog } = await setupScenario("resolved-review-thread");
  try {
    const stdout = await runHeartbeat(env, stateFile);
    const jsonLines = parseJsonLines(stdout);
    const thread = jsonLines.find((line) => line.type === "review-thread");

    assert.ok(thread);
    assert.equal(thread.actionable, false);
    assert.equal(thread.skipReason, "resolved-review-thread");
    assert.match(stdout, /"status":"no-new-actionable-feedback"/);
    await assert.rejects(readFile(zellijLog, "utf8"), /ENOENT/);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(state.notifiedKeys, []);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("forge heartbeat recognizes actor replies as already answered review threads", async () => {
  const { tempDir, env, stateFile, zellijLog } = await setupScenario("answered-review-thread");
  try {
    const stdout = await runHeartbeat(env, stateFile);
    const jsonLines = parseJsonLines(stdout);
    const thread = jsonLines.find((line) => line.type === "review-thread");

    assert.ok(thread);
    assert.equal(thread.actionable, false);
    assert.equal(thread.skipReason, "actor-reply-present");
    assert.deepEqual(thread.actorReplyCommentIds, [3002]);
    assert.match(stdout, /"status":"no-new-actionable-feedback"/);
    await assert.rejects(readFile(zellijLog, "utf8"), /ENOENT/);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(state.notifiedKeys, []);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("forge heartbeat durable state prevents restart duplicate notifications", async () => {
  const { tempDir, env, stateFile, zellijLog } = await setupScenario("unresolved-review-thread");
  try {
    const firstStdout = await runHeartbeat(env, stateFile);
    assert.match(firstStdout, /"status":"notified-pi"/);
    await rm(zellijLog, { force: true });

    const secondStdout = await runHeartbeat(env, stateFile);
    assert.match(secondStdout, /"status":"no-new-actionable-feedback"/);
    await assert.rejects(readFile(zellijLog, "utf8"), /ENOENT/);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.notifiedKeys.length, 1);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
