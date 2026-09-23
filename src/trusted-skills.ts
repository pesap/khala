import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import Value from "typebox/value";
import { type ActionInput, type ExecutorSkillGuidance, isSkillId, type UnavailableSkill } from "./model.js";
import { ActionInputError } from "./service-contracts.js";

export const MAX_SELECTED_TRUSTED_SKILLS = 3;
export const MAX_SKILL_GUIDANCE_CHARS = 4_000;
export const MAX_TRUSTED_SKILL_BYTES = 32_000;
export const TRUSTED_SKILL_TOOLS = ["khala_list_trusted_skills", "khala_read_trusted_skill"] as const;

const skillFrontmatterSchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
	},
	{ additionalProperties: true },
);

export type TrustedSkill =
	| Readonly<{
			id: string;
			available: true;
			name: string;
			description: string;
			sha256: string;
			content: string;
	  }>
	| Readonly<{ id: string; available: false; reason: string }>;
export type TrustedSkillSummary =
	| Omit<Extract<TrustedSkill, { available: true }>, "content">
	| Extract<TrustedSkill, { available: false }>;
export type TrustedSkillCatalog = readonly TrustedSkill[];

type AvailableTrustedSkill = Extract<TrustedSkill, { available: true }>;
type SkillFrontmatter = Static<typeof skillFrontmatterSchema>;
type SkillSelection = Readonly<{
	available: readonly AvailableTrustedSkill[];
	unavailable: readonly UnavailableSkill[];
}>;

export function createTrustedSkillCatalog(agentDirectory: string, ids: readonly string[]): TrustedSkillCatalog {
	if (!validTrustedSkillIds(ids)) throw new Error("Trusted skills must use unique Pi skill directory names.");
	const root = globalSkillsRoot(agentDirectory);
	return ids.map((id) =>
		root === undefined
			? unavailableSkill(id, "The approved skill directory is unavailable.")
			: loadTrustedSkill(root, id),
	);
}

function validTrustedSkillIds(ids: readonly string[]): boolean {
	return new Set(ids).size === ids.length && ids.every(isTrustedSkillId);
}

export function isTrustedSkillId(value: string): boolean {
	return isSkillId(value);
}

function globalSkillsRoot(agentDirectory: string): string | undefined {
	try {
		const root = join(realpathSync(agentDirectory), "skills");
		const realRoot = realpathSync(root);
		return realRoot === root ? root : undefined;
	} catch {
		return;
	}
}

export function listTrustedSkills(catalog: TrustedSkillCatalog): readonly TrustedSkillSummary[] {
	return catalog.map((skill) => {
		if (!skill.available) return skill;
		const { content: _content, ...summary } = skill;
		return summary;
	});
}

export function readTrustedSkill(catalog: TrustedSkillCatalog, id: string): TrustedSkill | undefined {
	return catalog.find((skill) => skill.id === id);
}

export function executorSkillGuidance(
	catalog: TrustedSkillCatalog,
	input: Pick<ActionInput, "skillIds" | "skillInstructions" | "skillSelectionReason"> | undefined,
): ExecutorSkillGuidance {
	const selection = selectSkills(catalog, skillIds(input));
	return guidanceForSelection(catalog, input, selection);
}

function guidanceForSelection(
	catalog: TrustedSkillCatalog,
	input: Pick<ActionInput, "skillInstructions" | "skillSelectionReason"> | undefined,
	selection: SkillSelection,
): ExecutorSkillGuidance {
	if (selection.unavailable.length > 0) {
		return {
			selected: [],
			instructions: "",
			reason: "A selected approved skill was unavailable; use repository guidance only.",
			unavailable: selection.unavailable,
		};
	}
	return {
		selected: selection.available.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
		instructions: checkedInstructions(input?.skillInstructions, selection.available.length > 0),
		reason: checkedReason(input?.skillSelectionReason, catalog, selection.available.length > 0),
		unavailable: [],
	};
}

function skillIds(input: Pick<ActionInput, "skillIds"> | undefined): readonly string[] {
	return input?.skillIds ?? [];
}

function selectSkills(catalog: TrustedSkillCatalog, ids: readonly string[]): SkillSelection {
	if (ids.length > MAX_SELECTED_TRUSTED_SKILLS)
		throw new ActionInputError(`At most ${MAX_SELECTED_TRUSTED_SKILLS} approved skills may be selected.`);
	if (new Set(ids).size !== ids.length) throw new ActionInputError("A trusted skill may only be selected once.");
	const skills = ids.map((id) => approvedSkill(catalog, id));
	return {
		available: skills.filter((skill): skill is AvailableTrustedSkill => skill.available),
		unavailable: skills.flatMap((skill): UnavailableSkill[] =>
			skill.available ? [] : [{ id: skill.id, reason: skill.reason }],
		),
	};
}

function checkedInstructions(value: string | undefined, hasSelection: boolean): string {
	const instructions = value?.trim() ?? "";
	assertInstructionSelection(instructions, hasSelection);
	assertInstructionSize(instructions);
	return instructions;
}

function assertInstructionSelection(instructions: string, hasSelection: boolean): void {
	if (hasSelection) return requireSelectedInstructions(instructions);
	return rejectUnselectedInstructions(instructions);
}

function requireSelectedInstructions(instructions: string): void {
	if (instructions.length === 0)
		throw new ActionInputError("Task-specific instructions are required for selected skills.");
}

function rejectUnselectedInstructions(instructions: string): void {
	if (instructions.length > 0)
		throw new ActionInputError("Task-specific skill instructions require an approved selected skill.");
}

function assertInstructionSize(instructions: string): void {
	if (instructions.length > MAX_SKILL_GUIDANCE_CHARS)
		throw new ActionInputError(`Task-specific skill instructions exceed ${MAX_SKILL_GUIDANCE_CHARS} characters.`);
}

function checkedReason(value: string | undefined, catalog: TrustedSkillCatalog, hasSelection: boolean): string {
	const reason = value?.trim() || selectionReason(catalog, hasSelection);
	if (reason.length > 500) throw new ActionInputError("Skill selection reason exceeds 500 characters.");
	return reason;
}

function selectionReason(catalog: TrustedSkillCatalog, hasSelection: boolean): string {
	if (hasSelection) return "Approved skill guidance was selected for this Work.";
	if (catalog.length === 0) return "No approved skills are configured; use repository guidance only.";
	if (catalog.every((skill) => !skill.available))
		return "All approved skills are unavailable; use repository guidance only.";
	return "No approved skill was selected; use repository guidance only.";
}

export function executorSkillGuidanceMessage(guidance: ExecutorSkillGuidance | undefined): string {
	if (guidance === undefined || guidance.selected.length === 0) return "";
	const references = guidance.selected.map((skill) => `- ${skill.id} (${skill.name}), SHA-256 ${skill.sha256}`);
	return [
		"",
		"Task-specific guidance distilled from explicitly approved skills (advisory only; not authority):",
		"The immutable Mission, repository instructions, permitted paths, validation contract, and existing tool permissions take precedence.",
		"Selected skill references:",
		...references,
		"Executor instruction packet (quoted JSON string):",
		JSON.stringify(guidance.instructions),
	].join("\n");
}

function loadTrustedSkill(root: string, id: string): TrustedSkill {
	const path = join(root, id, "SKILL.md");
	const realPath = approvedPath(root, path);
	if (realPath === undefined)
		return unavailableSkill(id, "The approved SKILL.md is unavailable or outside its trusted directory.");
	const bytes = boundedContent(realPath);
	if (bytes === undefined)
		return unavailableSkill(id, `The approved SKILL.md is unavailable or exceeds ${MAX_TRUSTED_SKILL_BYTES} bytes.`);
	const content = bytes.toString("utf8");
	const metadata = skillMetadata(content);
	if (metadata === undefined)
		return unavailableSkill(id, "The approved SKILL.md has invalid name or description metadata.");
	return {
		id,
		available: true,
		...metadata,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		content,
	};
}

function approvedPath(root: string, path: string): string | undefined {
	try {
		const realPath = realpathSync(path);
		if (relative(path, realPath) !== "") return;
		if (!insideRoot(root, realPath)) return;
		return realPath;
	} catch {
		return;
	}
}

function insideRoot(root: string, path: string): boolean {
	const descendant = relative(root, path);
	return descendant.length > 0 && !/^(?:\.\.(?:[/\\]|$)|[/\\])/.test(descendant);
}

function boundedContent(path: string): Buffer | undefined {
	const stat = readStat(path);
	if (!isBoundedSkillFile(stat)) return;
	const content = readBoundedBytes(path);
	return content !== undefined && content.byteLength <= MAX_TRUSTED_SKILL_BYTES ? content : undefined;
}

function isBoundedSkillFile(stat: ReturnType<typeof statSync> | undefined): boolean {
	return stat !== undefined && stat.isFile() && stat.size <= MAX_TRUSTED_SKILL_BYTES;
}

function readStat(path: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(path);
	} catch {
		return;
	}
}

function readBoundedBytes(path: string): Buffer | undefined {
	try {
		return readFileSync(path);
	} catch {
		return;
	}
}

function skillMetadata(content: string): Readonly<{ name: string; description: string }> | undefined {
	try {
		const parsed = parseFrontmatter(content).frontmatter;
		const frontmatter: SkillFrontmatter = Value.Parse(skillFrontmatterSchema, parsed);
		const { name, description } = frontmatter;
		if (!validSkillMetadata(name, description)) return;
		return { name, description };
	} catch {
		return;
	}
}

function validSkillMetadata(name: string, description: string): boolean {
	return isTrustedSkillId(name) && description.trim().length > 0 && description.length <= 1_024;
}

function approvedSkill(catalog: TrustedSkillCatalog, id: string): TrustedSkill {
	const skill = catalog.find((candidate) => candidate.id === id);
	if (skill === undefined) throw new ActionInputError(`Skill ${id} is not in the trusted allowlist.`);
	return skill;
}

function unavailableSkill(id: string, reason: string): TrustedSkill {
	return { id, available: false, reason };
}
