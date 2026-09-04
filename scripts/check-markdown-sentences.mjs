import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sentenceBoundaryPattern = /[.!?](?:["'”’)]*)\s+(?=[A-Z0-9`[])/;
const sentenceSplitPattern = /([.!?](?:["'”’)]*))\s+(?=[A-Z0-9`[])/g;
const root = process.cwd();
const fix = process.argv.includes("--fix");
const markdownFiles = await trackedMarkdownFiles(root);
const violations = [];

for (const file of markdownFiles) {
	const lines = (await readFile(file, "utf8")).split("\n");
	let inFence = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || /^\s*\|/.test(line) || /^\s*</.test(line)) continue;
		if (isBulletLine(line)) {
			if (sentenceCount(line) > 2)
				violations.push(`${relative(root, file)}:${index + 1}: condense bullets to at most two sentences`);
			continue;
		}
		if (sentenceBoundary(line) === undefined) continue;
		violations.push(`${relative(root, file)}:${index + 1}: separate each sentence onto its own line`);
		if (fix) {
			const replacement = splitSentences(line).split("\n");
			lines.splice(index, 1, ...replacement);
			index += replacement.length - 1;
		}
	}
	if (fix) await writeFile(file, lines.join("\n"), "utf8");
}

if (violations.length > 0 && !fix) {
	process.stderr.write(`${violations.join("\n")}\n`);
	process.exitCode = 1;
}

async function trackedMarkdownFiles(directory) {
	const { stdout } = await execFileAsync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
		{ cwd: directory, encoding: "utf8" },
	);
	return stdout
		.split(/\r?\n/)
		.filter((path) => path.length > 0)
		.map((path) => join(directory, path))
		.sort();
}

function sentenceBoundary(line) {
	return line.match(sentenceBoundaryPattern) ?? undefined;
}

function isBulletLine(line) {
	return /^\s*(?:>\s*)?(?:[-+*]|\d+\.)\s+/.test(line);
}

function sentenceCount(line) {
	const boundaries = line.match(sentenceSplitPattern)?.length ?? 0;
	const ending = /[.!?](?:["'”’)]*)\s*$/.test(line) ? 1 : 0;
	return boundaries + ending;
}

function splitSentences(line) {
	const prefix = markdownPrefix(line);
	const body = line.slice(prefix.length);
	return `${prefix}${body.replace(sentenceSplitPattern, `$1\n${continuationPrefix(prefix)}`)}`;
}

function markdownPrefix(line) {
	return line.match(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+\.)\s+)?/)?.[0] ?? "";
}

function continuationPrefix(prefix) {
	const marker = prefix.match(/(?:[-+*]|\d+\.)\s+$/)?.[0];
	return marker === undefined ? prefix : `${prefix.slice(0, -marker.length)}${" ".repeat(marker.length)}`;
}
