import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isContainedPath, isRealContainedPath } from "./adapter-shared.js";
export async function readPullRequestTemplate(projectPath: string): Promise<string | undefined> {
	const root = await realpath(projectPath).catch(() => undefined);
	if (root === undefined) return undefined;
	return readTemplateSources(root);
}

async function readTemplateSources(root: string): Promise<string | undefined> {
	const known = await readFirstTemplate(root, [
		"pull_request_template.md",
		"docs/pull_request_template.md",
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
	]);
	if (known !== undefined) return known;
	const templateDirectory = await safeTemplateDirectory(root);
	if (templateDirectory === undefined) return undefined;
	return readTemplateDirectory(root, templateDirectory);
}

async function readFirstTemplate(root: string, paths: readonly string[]): Promise<string | undefined> {
	for (const relativePath of paths) {
		const content = await readSafeTemplateFile(root, relativePath);
		if (hasTemplateContent(content)) return content;
	}
	return undefined;
}

async function readTemplateDirectory(root: string, directory: string): Promise<string | undefined> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter((candidate) => candidate.isFile())
		.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of files) {
		const content = await readSafeTemplateFile(root, join(".github", "PULL_REQUEST_TEMPLATE", entry.name));
		if (hasTemplateContent(content)) return content;
	}
	return undefined;
}

function hasTemplateContent(content: string | undefined): content is string {
	return content !== undefined && content.trim().length > 0;
}

async function readSafeTemplateFile(root: string, relativePath: string): Promise<string | undefined> {
	const candidate = resolve(root, relativePath);
	if (!isContainedPath(root, candidate)) return;
	if (!(await isRegularContainedFile(root, candidate))) return;
	return readFile(candidate, "utf8").catch(() => undefined);
}

async function isRegularContainedFile(root: string, candidate: string): Promise<boolean> {
	const info = await lstat(candidate).catch(() => undefined);
	if (info === undefined) return false;
	if (!info.isFile()) return false;
	return isRealContainedPath(root, candidate);
}

async function safeTemplateDirectory(root: string): Promise<string | undefined> {
	const directory = resolve(root, ".github", "PULL_REQUEST_TEMPLATE");
	const info = await lstat(directory).catch(() => undefined);
	if (info === undefined || !info.isDirectory() || !(await isRealContainedPath(root, directory))) return;
	return directory;
}
