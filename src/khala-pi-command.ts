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

export { assertPiCommand, isolateOraclePiCommand, removePiOptionSelection };
