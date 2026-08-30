/**
 * Pure marker helpers for the -clarify trigger.
 * Kept free of Pi runtime imports so they are easy to unit test.
 */

/** Whole-token marker so words like "pre-clarify" and "-clarify-now" are ignored. */
export const CLARIFY_MARKER_RE = /(?<![\p{L}\p{N}_-])-clarify(?![\p{L}\p{N}_-])/giu;

export function hasClarifyMarker(text: string): boolean {
	CLARIFY_MARKER_RE.lastIndex = 0;
	return CLARIFY_MARKER_RE.test(text);
}

/** Remove every -clarify marker and only the separator whitespace attached to it. */
const CLARIFY_STRIP_RE = /(^|[^\p{L}\p{N}_-])([ \t]*)-clarify([ \t]*)(?![\p{L}\p{N}_-])/giu;
const HORIZONTAL_SPACES: ReadonlySet<string> = new Set([" ", "\t"]);
const LINE_BREAKS: ReadonlySet<string | undefined> = new Set(["\n", "\r"]);
const NO_SEPARATOR_FOLLOWING: ReadonlySet<string | undefined> = new Set([
	undefined,
	" ",
	"\t",
	"\n",
	"\r",
	".",
	",",
	";",
	":",
	"!",
	"?",
	"…",
	")",
	"]",
	"}",
	">",
	"'",
	'"',
	"”",
	"’",
	"»",
]);

export function stripClarifyMarker(text: string): string {
	return text.replace(CLARIFY_STRIP_RE, markerReplacement).trim();
}

function markerReplacement(
	match: string,
	prefix: string,
	_beforeMarker: string,
	afterMarker: string,
	offset: number,
	source: string,
): string {
	return replacementText(prefix, afterMarker, source[offset + match.length]);
}

function replacementText(prefix: string, afterMarker: string, following: string | undefined): string {
	if (LINE_BREAKS.has(prefix)) return prefix;
	if (prefix.length === 0) return "";
	if (HORIZONTAL_SPACES.has(prefix)) return separatorFor(following);
	return `${prefix}${separatorAfterMarker(afterMarker, following)}`;
}

function separatorAfterMarker(afterMarker: string, following: string | undefined): string {
	return afterMarker.length === 0 ? "" : separatorFor(following);
}

function separatorFor(following: string | undefined): string {
	return NO_SEPARATOR_FOLLOWING.has(following) ? "" : " ";
}
