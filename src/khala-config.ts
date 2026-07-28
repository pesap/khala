import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiCommand } from "./executor.js";

const LauncherName = {
	zellij: "zellij",
	tmux: "tmux",
	herdr: "herdr",
} as const;
type LauncherNameValue = (typeof LauncherName)[keyof typeof LauncherName];

const ConfigScope = {
	global: "global",
	project: "project",
} as const;
type ConfigScopeValue = (typeof ConfigScope)[keyof typeof ConfigScope];

interface KhalaConfig {
	worktreeRoot: string;
	worktreeBranchPrefix: string;
	launcher: LauncherNameValue;
	piCommand: PiCommand;
	observerPiCommand: PiCommand;
	conclaveModel: string;
	observerModel: string;
	archiveRoot: string;
}

type ConfigValues = Record<string, unknown>;

// The config shape follows the package's GitHub release version; it does not carry a separate persisted version.
const CONFIG_FILE_NAME = "khala.json";
const DEFAULT_CONFIG: Omit<KhalaConfig, "archiveRoot"> = {
	worktreeRoot: join(homedir(), "worktrees"),
	worktreeBranchPrefix: "khala/",
	launcher: LauncherName.zellij,
	piCommand: ["pi"],
	observerPiCommand: ["pi"],
	conclaveModel: "",
	observerModel: "",
};

function getDefaultConfig(): KhalaConfig {
	return { ...DEFAULT_CONFIG, archiveRoot: join(getAgentDir(), "khala", "conclaves") };
}

function loadKhalaConfig(projectPath?: string, projectTrusted = false): KhalaConfig {
	let config = applyConfig(getDefaultConfig(), readConfigFile(getKhalaConfigPath(ConfigScope.global)));
	if (projectPath !== undefined && projectTrusted) {
		config = applyConfig(config, readConfigFile(getKhalaConfigPath(ConfigScope.project, projectPath)));
	}
	return config;
}

function getKhalaConfigPath(scope: ConfigScopeValue, projectPath?: string): string {
	if (scope === ConfigScope.global) {
		return join(getAgentDir(), CONFIG_FILE_NAME);
	}
	if (projectPath === undefined) {
		throw new Error("A project path is required for project Khala configuration.");
	}
	return join(projectPath, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Configuration merging is intentionally centralized to preserve inheritance semantics.
function applyConfig(base: KhalaConfig, values: ConfigValues | undefined): KhalaConfig {
	if (values === undefined) {
		return base;
	}

	const configuredWorktreeRoot = readConfigString(values, "worktreeRoot");
	const configuredBranchPrefix = readConfigString(values, "worktreeBranchPrefix");
	const configuredLauncher = readLauncher(values, "launcher");
	const configuredPiCommand = readPiCommand(values, "piCommand");
	const configuredObserverPiCommand = readPiCommand(values, "observerPiCommand");
	const configuredConclaveModel = readConfigString(values, "conclaveModel");
	const configuredObserverModel = readConfigString(values, "observerModel");
	const configuredArchiveRoot = readConfigString(values, "archiveRoot");
	const {
		worktreeRoot: defaultWorktreeRoot,
		worktreeBranchPrefix: defaultBranchPrefix,
		launcher: defaultLauncher,
		piCommand: defaultPiCommand,
		observerPiCommand: defaultObserverPiCommand,
		conclaveModel: defaultConclaveModel,
		observerModel: defaultObserverModel,
		archiveRoot: defaultArchiveRoot,
	} = base;
	let worktreeRoot = defaultWorktreeRoot;
	let worktreeBranchPrefix = defaultBranchPrefix;
	let launcher = defaultLauncher;
	let piCommand = defaultPiCommand;
	let observerPiCommand = defaultObserverPiCommand;
	let conclaveModel = defaultConclaveModel;
	let observerModel = defaultObserverModel;
	let archiveRoot = defaultArchiveRoot;
	if (configuredWorktreeRoot !== undefined) {
		worktreeRoot = expandHome(configuredWorktreeRoot);
	}
	if (configuredBranchPrefix !== undefined) {
		worktreeBranchPrefix = configuredBranchPrefix;
	}
	if (configuredLauncher !== undefined) {
		launcher = configuredLauncher;
	}
	if (configuredPiCommand !== undefined) {
		piCommand = configuredPiCommand;
		if (configuredObserverPiCommand === undefined) {
			observerPiCommand = configuredPiCommand;
		}
	}
	if (configuredObserverPiCommand !== undefined) {
		observerPiCommand = configuredObserverPiCommand;
	}
	if (configuredConclaveModel !== undefined) {
		conclaveModel = configuredConclaveModel;
	}
	if (configuredObserverModel !== undefined) {
		observerModel = configuredObserverModel;
	}
	if (configuredArchiveRoot !== undefined) {
		archiveRoot = expandHome(configuredArchiveRoot);
	}
	return {
		worktreeRoot,
		worktreeBranchPrefix,
		launcher,
		piCommand,
		observerPiCommand,
		conclaveModel,
		observerModel,
		archiveRoot,
	};
}

function readConfigFile(configPath: string): ConfigValues | undefined {
	if (!existsSync(configPath)) {
		return;
	}

	const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error(`Khala config must be an object: ${configPath}`);
	}
	return parsed;
}

function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice("~/".length));
	}
	return path;
}

function isRecord(value: unknown): value is ConfigValues {
	return typeof value === "object" && value !== null;
}

function readLauncher(config: ConfigValues, key: string): LauncherNameValue | undefined {
	const value = config[key];
	let launcher: LauncherNameValue | undefined;
	if (value === LauncherName.zellij || value === LauncherName.tmux || value === LauncherName.herdr) {
		launcher = value;
	}
	return launcher;
}

function readConfigString(config: ConfigValues, key: string): string | undefined {
	const value = config[key];
	let result: string | undefined;
	if (typeof value === "string" && value.trim().length > 0) {
		result = value;
	}
	return result;
}

function readPiCommand(config: ConfigValues, key: string): PiCommand | undefined {
	const value = config[key];
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	if (!Array.isArray(value) || value.length === 0) {
		return;
	}
	const [command, ...parts] = value as unknown[];
	if (typeof command !== "string" || command.trim().length === 0) {
		return;
	}
	const args: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string" || part.trim().length === 0) {
			return;
		}
		args.push(part);
	}
	return [command, ...args];
}

export type { ConfigScopeValue, KhalaConfig, LauncherNameValue };
export { ConfigScope, getKhalaConfigPath, LauncherName, loadKhalaConfig };
