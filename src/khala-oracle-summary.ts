// Contract and parser only: this module is not registered or rendered yet.
// It owns Oracle's packaged prompt loading and strict result parser; transport
// and Pi tool rendering stay elsewhere.
import { dirname, resolve } from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

const OracleReviewVerdict = {
	pass: "pass",
	revise: "revise",
	blocked: "blocked",
} as const;
const ORACLE_PROMPT_TEMPLATE_NAME = "khala-oracle";
const ORACLE_RESPONSE_HEADINGS = [
	"Review Summary",
	"Required Changes",
	"Review Gaps",
	"Human Reviewer Callouts",
	"Verdict",
] as const;
const REQUIRED_CHANGE_PATTERN =
	/^- \[(P0|P1|P2|P3)\] (.+)\n {2}- Evidence: (.+)\n {2}- Impact: (.+)\n {2}- Required action: (.+)$/;
const REQUIRED_CHANGE_SEPARATOR_PATTERN = /\n(?=- \[P[0-3]\] )/;
const BULLET_PATTERN = /^- (?!\(none\)$)(.+)$/;

type OracleReviewVerdictValue = (typeof OracleReviewVerdict)[keyof typeof OracleReviewVerdict];
type OracleReviewPriority = "P0" | "P1" | "P2" | "P3";
type OracleReviewFinding = Readonly<{
	priority: OracleReviewPriority;
	title: string;
	evidence: string;
	impact: string;
	requiredAction: string;
}>;
type OracleReviewSummary = Readonly<{
	verdict: OracleReviewVerdictValue;
	summary: string;
	requiredChanges: readonly OracleReviewFinding[];
	reviewGaps: readonly string[];
	humanReviewerCallouts: readonly string[];
}>;
async function loadOracleReviewPrompt(promptPath: string): Promise<string> {
	const resolvedPromptPath = resolve(promptPath);
	const loader = new DefaultResourceLoader({
		cwd: dirname(resolvedPromptPath),
		agentDir: getAgentDir(),
		additionalPromptTemplatePaths: [resolvedPromptPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const template = loader
		.getPrompts()
		.prompts.find(
			(candidate) => candidate.name === ORACLE_PROMPT_TEMPLATE_NAME && candidate.filePath === resolvedPromptPath,
		);
	if (template === undefined || template.content.trim().length === 0) {
		throw new Error(`Khala Oracle prompt template is unavailable: ${resolvedPromptPath}`);
	}
	return template.content.trim();
}

function parseOracleReviewSummary(response: string): OracleReviewSummary | undefined {
	const sections = readContractSections(response);
	let summary: OracleReviewSummary | undefined;
	if (sections !== undefined) {
		const reviewSummary = readRequiredText(sections, "Review Summary");
		const requiredChanges = readRequiredChanges(sections.get("Required Changes"));
		const reviewGaps = readBulletList(sections.get("Review Gaps"));
		const humanReviewerCallouts = readBulletList(sections.get("Human Reviewer Callouts"));
		const verdict = readOracleReviewVerdict(sections.get("Verdict"));
		if (
			reviewSummary !== undefined &&
			requiredChanges !== undefined &&
			reviewGaps !== undefined &&
			humanReviewerCallouts !== undefined &&
			verdict !== undefined &&
			isVerdictConsistent(verdict, requiredChanges)
		) {
			summary = {
				verdict,
				summary: reviewSummary,
				requiredChanges,
				reviewGaps,
				humanReviewerCallouts,
			};
		}
	}
	return summary;
}

function readContractSections(response: string): ReadonlyMap<string, string> | undefined {
	const normalized = response.trimEnd();
	const sections = new Map<string, string>();
	let offset = 0;
	for (let index = 0; index < ORACLE_RESPONSE_HEADINGS.length; index += 1) {
		const heading = ORACLE_RESPONSE_HEADINGS[index];
		if (heading === undefined) {
			return;
		}
		const marker = `## ${heading}\n`;
		if (!normalized.startsWith(marker, offset)) {
			return;
		}
		offset += marker.length;
		const nextHeading = ORACLE_RESPONSE_HEADINGS[index + 1];
		let nextOffset = normalized.length;
		if (nextHeading !== undefined) {
			nextOffset = normalized.indexOf(`\n\n## ${nextHeading}\n`, offset);
			if (nextOffset < 0) {
				return;
			}
		}
		const section = normalized.slice(offset, nextOffset).trim();
		if (section.length === 0) {
			return;
		}
		sections.set(heading, section);
		offset = nextOffset;
		if (nextHeading !== undefined) {
			offset += 2;
		}
	}
	return sections;
}

function readRequiredText(sections: ReadonlyMap<string, string>, heading: string): string | undefined {
	const text = sections.get(heading)?.trim();
	if (text === undefined || text.length === 0) {
		return;
	}
	return text;
}

function readRequiredChanges(section: string | undefined): readonly OracleReviewFinding[] | undefined {
	if (section === undefined) {
		return;
	}
	const normalized = section.trim();
	if (normalized === "- (none)") {
		return [];
	}
	const blocks = normalized.split(REQUIRED_CHANGE_SEPARATOR_PATTERN);
	const findings: OracleReviewFinding[] = [];
	for (const block of blocks) {
		const match = REQUIRED_CHANGE_PATTERN.exec(block.trim());
		if (
			match?.[1] === undefined ||
			match[2] === undefined ||
			match[3] === undefined ||
			match[4] === undefined ||
			match[5] === undefined
		) {
			return;
		}
		findings.push({
			priority: match[1] as OracleReviewPriority,
			title: match[2],
			evidence: match[3],
			impact: match[4],
			requiredAction: match[5],
		});
	}
	return findings;
}

function readBulletList(section: string | undefined): readonly string[] | undefined {
	if (section === undefined) {
		return;
	}
	const normalized = section.trim();
	if (normalized === "- (none)") {
		return [];
	}
	const items: string[] = [];
	for (const line of normalized.split("\n")) {
		const match = BULLET_PATTERN.exec(line);
		if (match?.[1] === undefined) {
			return;
		}
		items.push(match[1]);
	}
	return items;
}

function readOracleReviewVerdict(section: string | undefined): OracleReviewVerdictValue | undefined {
	let verdict: OracleReviewVerdictValue | undefined;
	if (
		section === OracleReviewVerdict.pass ||
		section === OracleReviewVerdict.revise ||
		section === OracleReviewVerdict.blocked
	) {
		verdict = section;
	}
	return verdict;
}

function isVerdictConsistent(
	verdict: OracleReviewVerdictValue,
	requiredChanges: readonly OracleReviewFinding[],
): boolean {
	if (verdict === OracleReviewVerdict.pass) {
		return requiredChanges.length === 0;
	}
	if (verdict === OracleReviewVerdict.revise) {
		return requiredChanges.length > 0;
	}
	return true;
}

export type { OracleReviewFinding, OracleReviewPriority, OracleReviewSummary, OracleReviewVerdictValue };
export { loadOracleReviewPrompt, OracleReviewVerdict, parseOracleReviewSummary };
