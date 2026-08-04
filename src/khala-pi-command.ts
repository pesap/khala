import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { PiCommand } from "./executor.js";

const PI_COMMAND_SUFFIX_PATTERN = /\.(cmd|exe)$/i;
const PI_VALUE_OPTIONS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--mode",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--name",
	"-n",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--export",
]);

function assertPiCommand(command: readonly string[]): PiCommand {
	const [programPath, ...arguments_] = command;
	const program = basename(programPath ?? "")
		.replace(PI_COMMAND_SUFFIX_PATTERN, "")
		.toLowerCase();
	if (program !== "pi") {
		throw new Error("Khala only supports Pi child commands; configure piCommand to a pi executable.");
	}
	return [programPath ?? "pi", ...arguments_];
}

// Oracle must reuse the configured executable without inheriting session,
// resource, prompt, or capability arguments that would weaken fresh isolation.
function isolateOraclePiCommand(command: PiCommand): PiCommand {
	const [program, ...arguments_] = command;
	const safeArguments: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		switch (argument) {
			case "--":
				index = arguments_.length;
				break;
			case "--offline":
			case "--verbose":
				safeArguments.push(argument);
				break;
			case "--api-key": {
				const value = arguments_[index + 1];
				if (value === undefined) {
					throw new Error("Configured Pi option '--api-key' requires a value.");
				}
				safeArguments.push(argument, value);
				index += 1;
				break;
			}
			default:
				if (argument?.startsWith("--api-key=") === true) {
					safeArguments.push(argument);
				} else if (argument !== undefined && PI_VALUE_OPTIONS.has(argument)) {
					index += 1;
				}
		}
	}
	return [program, ...safeArguments];
}

function removePiOptionSelection(command: PiCommand, option: string): PiCommand {
	const [program, ...arguments_] = command;
	const filteredArguments: string[] = [];
	let skipNext = false;
	for (const argument of arguments_) {
		if (skipNext) {
			skipNext = false;
		} else if (argument === option) {
			skipNext = true;
		} else if (!argument.startsWith(`${option}=`)) {
			filteredArguments.push(argument);
		}
	}
	return [program, ...filteredArguments];
}

function ensureKhalaExtension(command: PiCommand, extensionPath: string): PiCommand {
	assertExtensionPath(extensionPath, "Khala extension");
	const [program, ...arguments_] = command;
	if (hasConfiguredExtension(arguments_)) {
		return [program, ...arguments_];
	}
	const separatorIndex = arguments_.indexOf("--");
	if (separatorIndex < 0) {
		return [program, ...arguments_, "--extension", extensionPath];
	}
	return [
		program,
		...arguments_.slice(0, separatorIndex),
		"--extension",
		extensionPath,
		...arguments_.slice(separatorIndex),
	];
}

function hasConfiguredExtension(arguments_: readonly string[]): boolean {
	for (let index = 0; index < arguments_.length; index += 1) {
		if (arguments_[index] === "--") {
			return false;
		}
		const configuredPath = readConfiguredExtensionPath(arguments_, index);
		if (configuredPath !== undefined) {
			assertExtensionPath(configuredPath, "Configured Pi extension");
			return true;
		}
	}
	return false;
}

function readConfiguredExtensionPath(arguments_: readonly string[], index: number) {
	const argument = arguments_[index];
	if (argument === undefined) {
		return;
	}
	if (argument === "--extension" || argument === "-e") {
		const configuredPath = arguments_[index + 1];
		if (configuredPath === undefined || configuredPath === "--") {
			throw new Error(`Configured Pi option '${argument}' requires an extension path.`);
		}
		return configuredPath;
	}
	if (argument.startsWith("--extension=") || argument.startsWith("-e=")) {
		const configuredPath = argument.slice(argument.indexOf("=") + 1);
		if (configuredPath.length === 0) {
			throw new Error(`Configured Pi option '${argument.split("=")[0]}' requires an extension path.`);
		}
		return configuredPath;
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy the inferred optional return contract.
	return undefined;
}

function assertExtensionPath(path: string, label: string): void {
	if (!existsSync(path)) {
		throw new Error(`${label} path is unavailable: ${path}`);
	}
}

export { assertPiCommand, ensureKhalaExtension, isolateOraclePiCommand, removePiOptionSelection };
