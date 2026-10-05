import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("npm-packaged source runs isolated validation through Pi's public resource loader", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-packaged-validation-"));
	const modules = join(root, "node_modules");
	const installed = join(modules, "@pesap", "khala");
	const extracted = join(root, "extracted");
	const workspace = join(root, "workspace");
	try {
		await mkdir(join(modules, "@pesap"), { recursive: true });
		await mkdir(extracted);
		await mkdir(workspace);
		const [artifact] = Object.values(JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { encoding: "utf8" })));
		execFileSync("tar", ["-xzf", join(root, artifact.filename), "-C", extracted]);
		await rename(join(extracted, "package"), installed);
		// Keep SDK assets beneath a denied tree even when host dependencies are installed under /usr.
		const runtime = join(modules, "@anthropic-ai", "sandbox-runtime");
		await cp(resolve("node_modules", "@anthropic-ai", "sandbox-runtime"), runtime, { recursive: true });
		const manifest = join(runtime, "package.json");
		const runtimePackage = JSON.parse(await readFile(manifest, "utf8"));
		for (const dependency of ["nanoid", "typebox", ...Object.keys(runtimePackage.dependencies)]) {
			await mkdir(dirname(join(modules, dependency)), { recursive: true });
			await symlink(resolve("node_modules", dependency), join(modules, dependency), "dir");
		}
		const secret = join(modules, "@anthropic-ai", "host-secret");
		await writeFile(secret, "do not expose");
		const runtimeChecks = process.platform === "linux" ? [
			`assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(manifest)}, "utf8")).name, "@anthropic-ai/sandbox-runtime");`,
			`assert.throws(() => fs.accessSync(${JSON.stringify(manifest)}, fs.constants.W_OK));`,
		] : [];
		const script = [
			'const fs = require("node:fs"), assert = require("node:assert/strict");',
			...runtimeChecks,
			`assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));`,
			'fs.writeFileSync("marker", "packaged"); process.stdout.write("packaged");',
		].join(" ");
		const command = `node -e '${script.replace(/'/g, "'\\''")}'`;
		const extension = join(root, "validation-fixture.ts");
		await writeFile(extension, `
import { Type } from "typebox";
import { GitWorkspace } from ${JSON.stringify(join(installed, "src", "adapters.ts"))};
export default function (pi) {
	pi.registerTool({
		name: "validate_package",
		label: "Validate package",
		description: "Exercise isolated validation from installed source.",
		parameters: Type.Object({}),
		execute: async () => {
			const results = await new GitWorkspace(${JSON.stringify(workspace)}, "test/").runValidation({
				path: ${JSON.stringify(workspace)},
				commands: [${JSON.stringify(command)}],
			});
			return { content: [{ type: "text", text: JSON.stringify(results) }], details: results };
		},
	});
}
`);
		const loader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir: root,
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [extension],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const tool = loaded.extensions.flatMap((entry) => [...entry.tools.values()]).find((entry) => entry.definition.name === "validate_package");
		assert.ok(tool);
		const result = await tool.definition.execute("validation-fixture", {}, undefined, undefined, undefined);
		assert.equal(result.details[0].passed, true, result.details[0].output);
		assert.equal(result.details[0].output, "packaged");
		assert.equal(await readFile(join(workspace, "marker"), "utf8"), "packaged");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
