import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/** @import { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime" */
/** @import { Readable } from "node:stream" */
/** @import { IsolatedCommandInput, IsolatedCommandOutput, IsolatedCommandMessage } from "./validation-isolation.js" */

/**
 * @param {IsolatedCommandInput} input
 * @returns {Promise<IsolatedCommandOutput>}
 */
async function execute(input) {
	const dependencies = await SandboxManager.checkDependenciesAsync();
	const unavailable = [...dependencies.errors, ...dependencies.warnings];
	if (unavailable.length > 0)
		throw new Error(
			`Validation isolation prerequisites are unavailable; no command was run. ${unavailable.join(". ")}`,
		);
	const cachePaths = input.npmCache === undefined ? [] : [input.npmCache];
	const rootFiles = (await readdir("/", { withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => join("/", entry.name));
	/** @type {SandboxRuntimeConfig} */
	const config = {
		network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
		filesystem: {
			denyRead: ["/", "/sys", ...rootFiles],
			allowRead: [
				input.cwd,
				input.home,
				input.temporary,
				...input.readonlyPaths,
				...cachePaths,
				"/dev/null",
				"/dev/zero",
				"/dev/random",
				"/dev/urandom",
			],
			allowWrite: [input.cwd, input.home, input.temporary, ...cachePaths],
			denyWrite: ["/tmp/claude", "/private/tmp/claude"],
		},
		enableWeakerNestedSandbox: false,
		enableWeakerNetworkIsolation: false,
		allowAppleEvents: false,
	};
	try {
		await SandboxManager.initialize(config, undefined, false);
		const environment = {
			PATH: input.path,
			LANG: input.lang,
			HOME: input.home,
			TMPDIR: input.temporary,
			TMP: input.temporary,
			TEMP: input.temporary,
		};
		// The SDK supplies a shared TMPDIR. Override it inside the sandbox without changing the declared command.
		const command = [
			"env",
			...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
			input.command,
			...input.args,
		]
			.map((value) => `'${value.replace(/'/g, "'\\''")}'`)
			.join(" ");
		const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/sh");
		/** @type {Promise<IsolatedCommandOutput>} */
		const result = new Promise((resolvePromise) => {
			const child = execFile(
				"/bin/sh",
				["-c", wrapped],
				// Resolve the isolation launcher before exposing the workspace's executable PATH inside the sandbox.
				{ cwd: input.cwd, env: process.env, maxBuffer: input.maxBuffer, encoding: "utf8" },
				(error, stdout, stderr) => {
					const output = { stdout: stdout.slice(-4_000), stderr: stderr.slice(-4_000) };
					if (error === null) resolvePromise(output);
					else
						resolvePromise({
							...output,
							error: `Validation command failed (${String(error.signal ?? error.code ?? "unknown")}).`,
						});
				},
			);
			forwardOutput(child.stdout, "stdout");
			forwardOutput(child.stderr, "stderr");
		});
		return await result;
	} finally {
		SandboxManager.cleanupAfterCommand();
		await SandboxManager.reset();
	}
}

/**
 * @param {Readable | null} pipe
 * @param {"stdout" | "stderr"} stream
 */
function forwardOutput(pipe, stream) {
	// Keep bounded command evidence in the parent even if the helper is killed before its final result.
	pipe?.setEncoding("utf8").on(
		"data",
		/** @param {string} text */ (text) => {
			/** @type {IsolatedCommandMessage} */
			const message = { kind: "output", stream, text: text.slice(-4_000) };
			if (process.send !== undefined) process.send(message);
		},
	);
}

process.once(
	"message",
	/** @param {IsolatedCommandInput} input */ (input) => {
		void execute(input)
			.catch(
				/**
				 * @param {Error} error
				 * @returns {IsolatedCommandOutput}
				 */
				(error) => ({
					stdout: "",
					stderr: "",
					error: String(error),
				}),
			)
			.then((output) => {
				/** @type {IsolatedCommandMessage} */
				const message = { kind: "result", ...output };
				if (process.send !== undefined) process.send(message, () => process.exit(0));
			});
	},
);
