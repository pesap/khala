import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createKhalaHubCommandHandlers,
  getDefaultHubPath,
  getHubConfigPath,
  getHubScaffoldPaths,
} from "../../extensions/commands/khala-hub.ts";
import { registerCommands } from "../../extensions/commands/register.ts";

let previousLibrarianCacheRoot: string | undefined;

before(() => {
  previousLibrarianCacheRoot = process.env.LIBRARIAN_CACHE_ROOT;
});

after(async () => {
  if (previousLibrarianCacheRoot === undefined) delete process.env.LIBRARIAN_CACHE_ROOT;
  else process.env.LIBRARIAN_CACHE_ROOT = previousLibrarianCacheRoot;
});

async function makeTempHome(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "khala-hub-home-"));
}

async function makeTempCwd(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "khala-hub-cwd-"));
}

async function writeCheckoutScript(params: {
  packageSkillsPath: string;
  logPath: string;
  createEscape?: boolean;
}): Promise<string> {
  const librarianDir = path.join(params.packageSkillsPath, "librarian");
  await mkdir(librarianDir, { recursive: true });
  const scriptPath = path.join(librarianDir, "checkout.sh");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cache_root="\${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}"`,
    'checkout_root="$cache_root/checkout"',
    'outside_root="$cache_root/outside"',
    'mkdir -p "$checkout_root/wiki" "$outside_root"',
    `printf "%s|%s|%s\n" "\${LIBRARIAN_CACHE_ROOT:-}" "$1" "$2" > ${JSON.stringify(params.logPath)}`,
    ...(params.createEscape ? ['ln -sfn "$outside_root" "$checkout_root/escape"'] : []),
    'printf "%s\n" "$checkout_root"',
    "",
  ].join("\n");
  await writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

function makeHandler(params: {
  homeDir: string;
  cwd: string;
  packageSkillsPath: string;
  stdout: string[];
  errors: string[];
}) {
  const pi = {
    sendUserMessage: (message: string) => {
      params.stdout.push(message);
    },
  } as never;

  return {
    handler: createKhalaHubCommandHandlers({
      pi,
      homeDir: params.homeDir,
      packageSkillsPath: params.packageSkillsPath,
      notify: (_ctx, message, _type) => {
        params.errors.push(message);
      },
    }).khalaHub,
    ctx: {
      cwd: params.cwd,
      isIdle: () => true,
    } as never,
  };
}

function makeRegisterHarness() {
  const registrations: Array<{ name: string; description: string; handler: unknown }> = [];
  const pi = {
    registerCommand: (name: string, config: { description: string; handler: unknown }) => {
      registrations.push({ name, description: config.description, handler: config.handler });
    },
  } as never;
  return { registrations, pi };
}

async function runHubCommand(params: {
  args?: string;
  homeDir: string;
  cwd: string;
  packageSkillsPath: string;
}) {
  const stdout: string[] = [];
  const errors: string[] = [];
  const { handler, ctx } = makeHandler({
    homeDir: params.homeDir,
    cwd: params.cwd,
    packageSkillsPath: params.packageSkillsPath,
    stdout,
    errors,
  });
  await handler(params.args, ctx);
  return { stdout, errors };
}

async function writeGitRepoWithDirtyAndUntrackedFiles(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const initialFile = path.join(root, "tracked.txt");
  await writeFile(initialFile, "tracked\n");
  const init = spawnSync("git", ["-C", root, "init"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync("git", ["-C", root, "add", "tracked.txt"], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  await writeFile(initialFile, "tracked dirty\n");
  await writeFile(path.join(root, "untracked.txt"), "new\n");
}

test("registerCommands exposes /khala-hub", () => {
  const { pi, registrations } = makeRegisterHarness();
  registerCommands({
    pi,
    handlers: {
      khalaHub: async () => undefined,
    } as never,
  });

  const khalaHub = registrations.find((entry) => entry.name === "khala-hub");
  assert.ok(khalaHub);
  assert.equal(khalaHub?.description, "Report or set the Khala hub storage path for the LLM wiki");
  assert.equal(typeof khalaHub?.handler, "function");
});

test("default /khala-hub scaffolds the managed hub and reports the default path", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));

  const result = await runHubCommand({
    homeDir,
    cwd,
    packageSkillsPath,
  });

  const defaultHubPath = getDefaultHubPath(homeDir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.stdout, [`hub: ${defaultHubPath}`]);
  assert.equal(await readFile(getHubConfigPath(homeDir), "utf8").catch(() => ""), "");

  const scaffold = getHubScaffoldPaths(defaultHubPath);
  assert.equal(await readFile(scaffold.agents, "utf8"), [
    "# Khala Hub",
    "",
    "- raw sources are read-only",
    "- wiki markdown is agent-maintained",
    "- read `wiki/index.md` first",
    "- append `wiki/log.md` for ingest/query/lint/save-context actions",
    "- cite/update wiki pages when saving context",
    "",
  ].join("\n"));
  assert.equal(await readFile(scaffold.index, "utf8"), "# Hub Index\n\n- Start here.\n");
  assert.equal(await readFile(scaffold.log, "utf8"), "# Hub Log\n\n- Append hub activity here.\n");
  assert.equal(await readFile(scaffold.rawGitkeep, "utf8"), "");

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
});

test("default /khala-hub is idempotent and preserves existing scaffold edits", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const defaultHubPath = getDefaultHubPath(homeDir);
  const scaffold = getHubScaffoldPaths(defaultHubPath);

  await runHubCommand({ homeDir, cwd, packageSkillsPath });
  await writeFile(scaffold.agents, "custom agents\n");
  await writeFile(scaffold.index, "custom index\n");

  const result = await runHubCommand({ homeDir, cwd, packageSkillsPath });
  assert.deepEqual(result.stdout, [`hub: ${defaultHubPath}`]);
  assert.equal(await readFile(scaffold.agents, "utf8"), "custom agents\n");
  assert.equal(await readFile(scaffold.index, "utf8"), "custom index\n");
  assert.equal(await readFile(scaffold.log, "utf8"), "# Hub Log\n\n- Append hub activity here.\n");

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
});

test("/khala-hub --path persists a local directory across sessions without scaffolding it", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const localHub = await mkdtemp(path.join(tmpdir(), "khala-hub-local-"));

  const first = await runHubCommand({
    args: `--path ${localHub}`,
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.match(first.stdout.join("\n"), new RegExp(`hub: ${localHub}$`));
  assert.match(first.stdout.join("\n"), /state: non-git directory/);
  assert.equal(await readFile(getHubConfigPath(homeDir), "utf8"), `${JSON.stringify({ path: localHub }, null, 2)}\n`);
  assert.equal(await readFile(path.join(localHub, "AGENTS.md"), "utf8").catch(() => ""), "");

  const second = await runHubCommand({
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.match(second.stdout.join("\n"), new RegExp(`hub: ${localHub}$`));
  assert.match(second.stdout.join("\n"), /note: missing scaffold:/);
  assert.equal(await readFile(path.join(localHub, "wiki", "index.md"), "utf8").catch(() => ""), "");

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
  await rm(localHub, { recursive: true, force: true });
});

test("/khala-hub reports local git and non-git directory state", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const gitHub = await mkdtemp(path.join(tmpdir(), "khala-hub-git-"));
  await writeGitRepoWithDirtyAndUntrackedFiles(gitHub);

  const gitResult = await runHubCommand({
    args: `--path ${gitHub}`,
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.match(gitResult.stdout.join("\n"), /state: git repo \(dirty, untracked\)/);
  assert.match(gitResult.stdout.join("\n"), new RegExp(`hub: ${gitHub}$`));

  const plainDir = await mkdtemp(path.join(tmpdir(), "khala-hub-plain-"));
  const plainResult = await runHubCommand({
    args: `--path ${plainDir}`,
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.match(plainResult.stdout.join("\n"), /state: non-git directory/);
  assert.match(plainResult.stdout.join("\n"), new RegExp(`hub: ${plainDir}$`));

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
  await rm(gitHub, { recursive: true, force: true });
  await rm(plainDir, { recursive: true, force: true });
});

test("/khala-hub rejects missing path-like values and existing non-directories separately", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const filePath = path.join(cwd, "hub-file.txt");
  await writeFile(filePath, "not a directory\n");

  const missingResult = await runHubCommand({
    args: "--path ./missing",
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.deepEqual(missingResult.stdout, []);
  assert.deepEqual(missingResult.errors, ["path does not exist"]);

  const fileResult = await runHubCommand({
    args: "--path ./hub-file.txt",
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.deepEqual(fileResult.stdout, []);
  assert.deepEqual(fileResult.errors, ["path is not a directory"]);

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
});

test("existing local directories win over owner/repo-shaped inputs", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const localHub = path.join(cwd, "owner", "repo");
  await mkdir(localHub, { recursive: true });
  const scriptLog = path.join(packageSkillsPath, "checkout.log");
  await writeCheckoutScript({ packageSkillsPath, logPath: scriptLog });

  const result = await runHubCommand({
    args: "--path owner/repo",
    homeDir,
    cwd,
    packageSkillsPath,
  });
  assert.match(result.stdout.join("\n"), new RegExp(`hub: ${localHub}$`));
  assert.match(result.stdout.join("\n"), /state: non-git directory/);
  assert.equal(await readFile(scriptLog, "utf8").catch(() => ""), "");

  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await rm(packageSkillsPath, { recursive: true, force: true });
});

test("/khala-hub uses the packaged checkout script, honors LIBRARIAN_CACHE_ROOT, and persists remote selections", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "khala-hub-cache-"));
  const logPath = path.join(packageSkillsPath, "checkout.log");
  await writeCheckoutScript({
    packageSkillsPath,
    logPath,
    createEscape: true,
  });
  const previousCacheRoot = process.env.LIBRARIAN_CACHE_ROOT;
  process.env.LIBRARIAN_CACHE_ROOT = cacheRoot;

  try {
    const first = await runHubCommand({
      args: "--path owner/repo --subdir wiki",
      homeDir,
      cwd,
      packageSkillsPath,
    });
    const expectedCheckout = path.join(cacheRoot, "checkout", "wiki");
    assert.match(first.stdout.join("\n"), new RegExp(`hub: ${expectedCheckout}$`));
    assert.match(first.stdout.join("\n"), /note: missing scaffold:/);
    assert.equal(await readFile(logPath, "utf8"), `${cacheRoot}|owner/repo|--path-only\n`);
    assert.equal(await readFile(getHubConfigPath(homeDir), "utf8"), `${JSON.stringify({ path: expectedCheckout }, null, 2)}\n`);
    assert.equal(await readFile(path.join(cacheRoot, "checkout", "AGENTS.md"), "utf8").catch(() => ""), "");

    const second = await runHubCommand({
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.match(second.stdout.join("\n"), new RegExp(`hub: ${expectedCheckout}$`));
    assert.equal(await readFile(logPath, "utf8"), `${cacheRoot}|owner/repo|--path-only\n`);
  } finally {
    if (previousCacheRoot === undefined) delete process.env.LIBRARIAN_CACHE_ROOT;
    else process.env.LIBRARIAN_CACHE_ROOT = previousCacheRoot;
    await rm(homeDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(packageSkillsPath, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("/khala-hub rejects unsupported subdir combinations and escape attempts", async () => {
  const homeDir = await makeTempHome();
  const cwd = await makeTempCwd();
  const packageSkillsPath = await mkdtemp(path.join(tmpdir(), "khala-hub-skills-"));
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "khala-hub-cache-"));
  const logPath = path.join(packageSkillsPath, "checkout.log");
  await writeCheckoutScript({
    packageSkillsPath,
    logPath,
    createEscape: true,
  });
  const previousCacheRoot = process.env.LIBRARIAN_CACHE_ROOT;
  process.env.LIBRARIAN_CACHE_ROOT = cacheRoot;

  try {
    const noPath = await runHubCommand({
      args: "--subdir wiki",
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.deepEqual(noPath.errors, ["Usage: /khala-hub [--path <path|git-ref> [--subdir <relative-path>]]"]);

    const localPath = await mkdtemp(path.join(tmpdir(), "khala-hub-local-"));
    const localSubdir = await runHubCommand({
      args: `--path ${localPath} --subdir wiki`,
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.deepEqual(localSubdir.errors, ["subdir requires a remote git ref"]);

    const absoluteSubdir = await runHubCommand({
      args: "--path owner/repo --subdir /wiki",
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.deepEqual(absoluteSubdir.errors, ["subdir must be a safe relative path"]);

    const traversalSubdir = await runHubCommand({
      args: "--path owner/repo --subdir ../wiki",
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.deepEqual(traversalSubdir.errors, ["subdir must be a safe relative path"]);

    const escapeSubdir = await runHubCommand({
      args: "--path owner/repo --subdir escape",
      homeDir,
      cwd,
      packageSkillsPath,
    });
    assert.deepEqual(escapeSubdir.errors, ["subdir escapes checkout root"]);

    await rm(localPath, { recursive: true, force: true });
  } finally {
    if (previousCacheRoot === undefined) delete process.env.LIBRARIAN_CACHE_ROOT;
    else process.env.LIBRARIAN_CACHE_ROOT = previousCacheRoot;
    await rm(homeDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(packageSkillsPath, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("checkout script rejects repository path traversal before creating cache escapes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-hub-checkout-traversal-"));
  const cacheRoot = path.join(tempDir, "cache");
  const escapedRoot = path.join(tempDir, "escape");
  const scriptPath = path.join(process.cwd(), "skills", "librarian", "checkout.sh");

  try {
    for (const repoRef of [
      "evil.example/org/../../../escape/repo",
      "../escape/org/repo",
    ]) {
      const result = spawnSync("bash", [scriptPath, repoRef, "--path-only"], {
        encoding: "utf8",
        env: {
          ...process.env,
          LIBRARIAN_CACHE_ROOT: cacheRoot,
        },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe segment/);
      assert.equal(await stat(escapedRoot).then(() => true, () => false), false);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
