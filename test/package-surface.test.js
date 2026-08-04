import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));

function packagePath(path) {
	return join(projectRoot, path.replace(/^\.\//, ""));
}

test("package policy pins the supported npm and security versions", () => {
	assert.equal(packageJson.packageManager, "npm@12.0.0");
	assert.equal(packageJson.engines.node, ">=22.22.2");
	assert.equal(packageJson.engines.npm, ">=12.0.0");
	assert.deepEqual(packageJson.overrides, {
		"@earendil-works/pi-coding-agent": {
			"brace-expansion": "5.0.9",
			undici: "8.9.0",
		},
	});

	const selectedVersions = Object.fromEntries(
		Object.entries(lockfile.packages)
			.filter(([path]) => path.endsWith("/brace-expansion") || path.endsWith("/undici"))
			.map(([path, dependency]) => [path, dependency.version]),
	);
	assert.deepEqual(selectedVersions, {
		"node_modules/brace-expansion": "5.0.9",
		"node_modules/undici": "8.9.0",
	});
});

test("package surface has no Khala lifecycle hooks and declares upstream scripts", () => {
	const lifecycleHooks = [
		"preinstall",
		"install",
		"postinstall",
		"prepare",
		"prepublish",
		"prepublishOnly",
		"publish",
	];
	for (const hook of lifecycleHooks) {
		assert.equal(packageJson.scripts[hook], undefined, `unexpected Khala ${hook} hook`);
	}

	const installScriptPackages = Object.entries(lockfile.packages)
		.filter(([, dependency]) => dependency.hasInstallScript)
		.map(([path]) => path)
		.sort();
	assert.deepEqual(installScriptPackages, [
		"node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai",
		"node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
	]);
});

test("package manifest resources exist in the checkout", () => {
	const resources = [
		...packageJson.pi.extensions,
		...packageJson.pi.prompts,
		...packageJson.pi.themes,
		...packageJson.pi.skills,
		...packageJson.files,
	];
	for (const resource of resources) {
		assert.equal(existsSync(packagePath(resource)), true, `missing package resource: ${resource}`);
	}
});
