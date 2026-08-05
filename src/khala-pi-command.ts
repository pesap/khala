import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
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

type ExtensionArgument = Readonly<{ path: string; nextIndex: number }>;

function readExtensionArgument(arguments_: readonly string[], index: number): ExtensionArgument | undefined {
	const argument = arguments_[index];
	if (argument === "--extension" || argument === "-e") {
		const path = arguments_[index + 1];
		if (path === undefined) {
			throw new Error(`Configured Pi option '${argument}' requires a value.`);
		}
		return { path, nextIndex: index + 1 };
	}
	if (argument?.startsWith("--extension=") === true || argument?.startsWith("-e=") === true) {
		const equalsIndex = argument.indexOf("=");
		const path = argument.slice(equalsIndex + 1);
		if (path.length === 0) {
			throw new Error(`Configured Pi option '${argument.slice(0, equalsIndex)}' requires a value.`);
		}
		return { path, nextIndex: index };
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy the strict optional parser contract.
	return undefined;
}

function hasKhalaExtension(arguments_: readonly string[], extensionPath: string): boolean {
	const normalizedExtensionPath = resolvePath(extensionPath);
	for (let index = 0; index < arguments_.length; index += 1) {
		const configuredExtension = readExtensionArgument(arguments_, index);
		if (configuredExtension !== undefined) {
			if (resolvePath(configuredExtension.path) === normalizedExtensionPath) {
				return true;
			}
			index = configuredExtension.nextIndex;
		}
	}
	return false;
}

function addKhalaExtension(command: PiCommand, extensionPath: string): PiCommand {
	if (extensionPath.trim().length === 0) {
		throw new Error("Khala child launch requires a non-empty extension path.");
	}
	if (!existsSync(extensionPath)) {
		throw new Error(`Khala child extension was not found: ${extensionPath}`);
	}
	if (hasKhalaExtension(command.slice(1), extensionPath)) {
		return command;
	}
	return [...command, "--extension", extensionPath];
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

export { addKhalaExtension, assertPiCommand, isolateOraclePiCommand, removePiOptionSelection };
