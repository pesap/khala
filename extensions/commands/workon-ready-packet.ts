export const WORKON_READY_PACKET_HEADINGS = [
  "Current behavior",
  "Desired behavior or Goal",
  "Acceptance criteria",
  "Validation plan",
  "Non-goals",
  "Breaking-change risk",
  "Review-size risk",
  "/workon readiness notes",
] as const;

export type WorkonReadyPacketHeading = (typeof WORKON_READY_PACKET_HEADINGS)[number];

export const WORKON_READY_LABEL = "workon-ready";
export const IMPROVE_LABEL = "improve";

export function normalizeWorkonPacketHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[–—-]/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:$/, "");
}

export const WORKON_READY_PACKET_NORMALIZED_HEADINGS = WORKON_READY_PACKET_HEADINGS.map(
  normalizeWorkonPacketHeading,
) as readonly string[];

export function renderWorkonReadyPacketHeadingList(): string {
  return WORKON_READY_PACKET_HEADINGS.map((heading) => `- ${heading}`).join("\n");
}

export function workonReadyPacketContractInstruction(params: {
  subject: "proposed issue" | "issue body" | "draft work packet";
  action: "produce" | "produce or update" | "review";
}): string {
  const headingList = WORKON_READY_PACKET_HEADINGS.join(", ");
  const base = `${params.action[0].toUpperCase()}${params.action.slice(1)} the ${params.subject} as a /workon-ready work packet using canonical headings that /workon parses exactly: ${headingList}.`;
  if (params.action === "review") {
    return `${base} Treat missing headings, unresolved risks, vague acceptance criteria, missing validation, broad review-size risk, or deferred scope decisions as readiness blockers.`;
  }
  return `${base} State low/absent/resolved risks explicitly instead of omitting them. Use plain markdown bullets for Acceptance criteria, not task-list checkboxes.`;
}
