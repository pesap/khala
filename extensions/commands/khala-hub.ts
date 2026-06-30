import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { ensureFile, formatErrorMessage, isMissingPathError } from "../lib/io.ts";
import { parseKhalaHubArgs } from "./parsers.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export const DEFAULT_HUB_DIRNAME = "hub";
export const HUB_CONFIG_FILENAME = "hub.json";
export const DEFAULT_HUB_PATH = path.join(homedir(), ".pi", "khala", DEFAULT_HUB_DIRNAME);
export const DEFAULT_HUB_AGENTS_PATH = path.join(DEFAULT_HUB_PATH, "AGENTS.md");
export const DEFAULT_HUB_RAW_GITKEEP_PATH = path.join(DEFAULT_HUB_PATH, "raw", ".gitkeep");
export const DEFAULT_HUB_INDEX_PATH = path.join(DEFAULT_HUB_PATH, "wiki", "index.md");
export const DEFAULT_HUB_LOG_PATH = path.join(DEFAULT_HUB_PATH, "wiki", "log.md");

const DEFAULT_AGENTS_CONTENT = [
  "# Khala Hub",
  "",
  "- raw sources are read-only",
  "- wiki markdown is agent-maintained",
  "- read `wiki/index.md` first",
  "- append `wiki/log.md` for ingest/query/lint/save-context actions",
  "- cite/update wiki pages when saving context",
  "",
].join("\n");

const DEFAULT_INDEX_CONTENT = ["# Hub Index", "", "- Start here.", ""].join("\n");
const DEFAULT_LOG_CONTENT = ["# Hub Log", "", "- Append hub activity here.", ""].join("\n");

export interface HubConfig {
  path: string;
}

export interface HubResolution {
  path: string;
  notes: string[];
}

export interface HubPathState {
  kind: "default" | "local" | "remote";
  path: string;
  notes: string[];
}

export function getHubConfigPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "khala", HUB_CONFIG_FILENAME);
}

export function getDefaultHubPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "khala", DEFAULT_HUB_DIRNAME);
}

export function getLibrarianCheckoutScriptPath(packageSkillsPath: string): string {
  return path.join(packageSkillsPath, "librarian", "checkout.sh");
}

export function getHubScaffoldPaths(root: string): {
  agents: string;
  rawGitkeep: string;
  index: string;
  log: string;
} {
  return {
    agents: path.join(root, "AGENTS.md"),
    rawGitkeep: path.join(root, "raw", ".gitkeep"),
    index: path.join(root, "wiki", "index.md"),
    log: path.join(root, "wiki", "log.md"),
  };
}

export function formatHubOutput(pathname: string, notes: string[] = []): string {
  return [...notes, `hub: ${pathname}`].join("\n");
}

export function isRecognizedHubGitRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(trimmed)) return true;
  return /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(trimmed);
}

export function isPathLikeHubValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("..\\") ||
    trimmed.startsWith("~/") ||
    trimmed === "~" ||
    trimmed.startsWith("~\\")
  );
}

export function expandHubHome(value: string, homeDir: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return path.join(homeDir, trimmed.slice(2));
  if (trimmed.startsWith("~\\")) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

export function normalizeHubSubdir(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join(path.sep);
}

export function parseHubConfig(raw: string): HubConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HubConfig>;
    return typeof parsed.path === "string" && parsed.path.trim()
      ? { path: parsed.path.trim() }
      : null;
  } catch {
    return null;
  }
}

export async function readHubConfig(homeDir: string): Promise<HubConfig | null> {
  const configPath = getHubConfigPath(homeDir);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return parseHubConfig(raw);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new Error(`Failed to read hub config at ${configPath}: ${formatErrorMessage(error)}`);
  }
}

export async function writeHubConfig(homeDir: string, hubPath: string): Promise<void> {
  const configPath = getHubConfigPath(homeDir);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({ path: hubPath }, null, 2)}\n`, "utf8");
}

export async function removeHubConfig(homeDir: string): Promise<void> {
  const configPath = getHubConfigPath(homeDir);
  try {
    await fs.unlink(configPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw new Error(`Failed to remove hub config at ${configPath}: ${formatErrorMessage(error)}`);
  }
}

export async function ensureDefaultHubScaffold(homeDir: string): Promise<void> {
  const root = getDefaultHubPath(homeDir);
  const paths = getHubScaffoldPaths(root);
  await Promise.all([
    fs.mkdir(path.dirname(paths.agents), { recursive: true }),
    fs.mkdir(path.dirname(paths.rawGitkeep), { recursive: true }),
    fs.mkdir(path.dirname(paths.index), { recursive: true }),
    fs.mkdir(path.dirname(paths.log), { recursive: true }),
  ]);
  await Promise.all([
    ensureFile(paths.agents, DEFAULT_AGENTS_CONTENT),
    ensureFile(paths.rawGitkeep, ""),
    ensureFile(paths.index, DEFAULT_INDEX_CONTENT),
    ensureFile(paths.log, DEFAULT_LOG_CONTENT),
  ]);
}

export async function detectMissingHubScaffoldFiles(root: string): Promise<string[]> {
  const paths = getHubScaffoldPaths(root);
  const entries = [
    ["AGENTS.md", paths.agents],
    ["raw/.gitkeep", paths.rawGitkeep],
    ["wiki/index.md", paths.index],
    ["wiki/log.md", paths.log],
  ] as const;
  const missing: string[] = [];
  for (const [label, filePath] of entries) {
    try {
      await fs.access(filePath);
    } catch (error) {
      if (isMissingPathError(error)) missing.push(label);
      else throw new Error(`Failed to inspect ${filePath}: ${formatErrorMessage(error)}`);
    }
  }
  return missing;
}

export async function describeLocalHubState(root: string): Promise<string> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return "state: path is not a directory";
  } catch (error) {
    if (isMissingPathError(error)) return "state: path does not exist";
    throw new Error(`Failed to inspect ${root}: ${formatErrorMessage(error)}`);
  }

  try {
    const gitStatus = spawnSync(
      "git",
      ["-C", root, "status", "--porcelain", "--untracked-files=all"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (gitStatus.status !== 0) return "state: non-git directory";
    const output = (gitStatus.stdout ?? "").trim();
    if (!output) return "state: git repo (clean)";
    const lines = output.split(/\r?\n/);
    const hasUntracked = lines.some((line) => line.startsWith("??"));
    const hasTrackedChanges = lines.some((line) => !line.startsWith("??"));
    const states: string[] = [];
    if (hasTrackedChanges) states.push("dirty");
    if (hasUntracked) states.push("untracked");
    return `state: git repo (${states.join(", ")})`;
  } catch (error) {
    throw new Error(`Failed to inspect git state for ${root}: ${formatErrorMessage(error)}`);
  }
}

export async function checkoutHubRemote(params: {
  checkoutScriptPath: string;
  repoRef: string;
}): Promise<string> {
  const result = spawnSync(
    "bash",
    [params.checkoutScriptPath, params.repoRef, "--path-only"],
    {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      details
        ? `librarian checkout failed for ${params.repoRef}: ${details}`
        : `librarian checkout failed for ${params.repoRef}`,
    );
  }

  const checkoutPath = (result.stdout ?? "").trim();
  if (!checkoutPath) {
    throw new Error(`librarian checkout returned no path for ${params.repoRef}`);
  }
  return checkoutPath;
}

export async function resolveHubPath(params: {
  args: string | undefined;
  cwd: string;
  homeDir: string;
  packageSkillsPath: string;
}): Promise<HubResolution> {
  const parsed = parseKhalaHubArgs(params.args ?? "");
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const config = await readHubConfig(params.homeDir);
  if (!parsed.path) {
    const hubPath = config?.path ? path.resolve(config.path) : getDefaultHubPath(params.homeDir);
    const notes: string[] = [];
    if (hubPath === getDefaultHubPath(params.homeDir)) {
      await ensureDefaultHubScaffold(params.homeDir);
    } else {
      const missing = await detectMissingHubScaffoldFiles(hubPath).catch((error) => {
        if (isMissingPathError(error)) return [];
        throw error;
      });
      if (missing.length > 0) notes.push(`note: missing scaffold: ${missing.join(", ")}`);
    }
    return { path: hubPath, notes };
  }

  const expanded = expandHubHome(parsed.path, params.homeDir);
  const resolvedLocal = path.resolve(params.cwd, expanded);

  if (parsed.subdir) {
    const localExists = await fs.stat(resolvedLocal).catch((error) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (localExists?.isDirectory()) {
      throw new Error("subdir requires a remote git ref");
    }
  }

  try {
    const stat = await fs.stat(resolvedLocal);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }

    const notes = [await describeLocalHubState(resolvedLocal)];
    const missing = await detectMissingHubScaffoldFiles(resolvedLocal);
    if (missing.length > 0) notes.push(`note: missing scaffold: ${missing.join(", ")}`);
    const defaultHub = getDefaultHubPath(params.homeDir);
    if (path.resolve(resolvedLocal) === path.resolve(defaultHub)) {
      await ensureDefaultHubScaffold(params.homeDir);
      await removeHubConfig(params.homeDir);
    } else if (parsed.path) {
      await writeHubConfig(params.homeDir, resolvedLocal);
    }
    return { path: resolvedLocal, notes };
  } catch (error) {
    if (!isMissingPathError(error)) {
      if (error instanceof Error && error.message === "path is not a directory") {
        throw error;
      }
      throw new Error(`Failed to inspect ${resolvedLocal}: ${formatErrorMessage(error)}`);
    }
  }

  if (isPathLikeHubValue(parsed.path)) {
    throw new Error("path does not exist");
  }

  if (!isRecognizedHubGitRef(parsed.path)) {
    throw new Error("Usage: /khala-hub [--path <path|git-ref> [--subdir <relative-path>]]");
  }

  const checkoutScriptPath = getLibrarianCheckoutScriptPath(params.packageSkillsPath);
  const checkoutPath = await checkoutHubRemote({
    checkoutScriptPath,
    repoRef: parsed.path,
  });
  const normalizedCheckoutPath = path.resolve(checkoutPath);
  let resolvedPath = normalizedCheckoutPath;
  const notes: string[] = [];

  if (parsed.subdir) {
    const normalizedSubdir = normalizeHubSubdir(parsed.subdir);
    if (!normalizedSubdir) {
      throw new Error("subdir must be a safe relative path");
    }
    const candidate = path.resolve(normalizedCheckoutPath, normalizedSubdir);
    let candidateStat: Stats;
    try {
      candidateStat = await fs.stat(candidate);
    } catch (error) {
      if (isMissingPathError(error)) throw new Error("subdir does not exist");
      throw new Error(`Failed to inspect ${candidate}: ${formatErrorMessage(error)}`);
    }
    if (!candidateStat.isDirectory()) {
      throw new Error("subdir is not a directory");
    }

    const checkoutReal = await fs.realpath(normalizedCheckoutPath);
    const candidateReal = await fs.realpath(candidate);
    const checkoutPrefix = checkoutReal.endsWith(path.sep) ? checkoutReal : `${checkoutReal}${path.sep}`;
    if (candidateReal !== checkoutReal && !candidateReal.startsWith(checkoutPrefix)) {
      throw new Error("subdir escapes checkout root");
    }

    resolvedPath = candidate;
    const missing = await detectMissingHubScaffoldFiles(resolvedPath);
    if (missing.length > 0) notes.push(`note: missing scaffold: ${missing.join(", ")}`);
  } else {
    const missing = await detectMissingHubScaffoldFiles(resolvedPath);
    if (missing.length > 0) notes.push(`note: missing scaffold: ${missing.join(", ")}`);
  }

  const defaultHubPath = path.resolve(getDefaultHubPath(params.homeDir));
  if (path.resolve(resolvedPath) === defaultHubPath) {
    await ensureDefaultHubScaffold(params.homeDir);
    if (!parsed.path) {
      return { path: resolvedPath, notes };
    }
    await removeHubConfig(params.homeDir);
    return { path: resolvedPath, notes };
  }

  if (parsed.path) {
    await writeHubConfig(params.homeDir, resolvedPath);
  }

  return { path: resolvedPath, notes };
}

export function createKhalaHubCommandHandlers(params: {
  pi: ExtensionAPI;
  homeDir: string;
  packageSkillsPath: string;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
}): {
  khalaHub: CommandHandler;
} {
  return {
    khalaHub: async (args, ctx) => {
      try {
        const resolution = await resolveHubPath({
          args,
          cwd: ctx.cwd,
          homeDir: params.homeDir,
          packageSkillsPath: params.packageSkillsPath,
        });

        const message = formatHubOutput(resolution.path, resolution.notes);
        if (ctx.isIdle()) {
          params.pi.sendUserMessage(message);
        } else {
          params.pi.sendUserMessage(message, { deliverAs: "followUp" });
        }
      } catch (error) {
        params.notify(
          ctx,
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };
}
