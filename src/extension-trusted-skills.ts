import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { throwIfAborted, toolErrorFromError, toolErrorText, toolResult } from "./extension-results.js";
import { requireSessionRole } from "./extension-role.js";
import { type ApplicationRuntime } from "./factory.js";
import { listTrustedSkills, readTrustedSkill } from "./trusted-skills.js";

const readTrustedSkillSchema = Type.Object({ skillId: Type.String({ minLength: 1, maxLength: 64 }) });
type ReadTrustedSkillParams = Static<typeof readTrustedSkillSchema>;

export function registerTrustedSkillTools(
	pi: ExtensionAPI,
	getRuntime: (context: ExtensionContext) => Promise<ApplicationRuntime>,
): void {
	pi.registerTool({
		name: "khala_list_trusted_skills",
		label: "List Approved Skills",
		description:
			"Inspect only explicitly allowlisted global Pi skills. Project skills are never discovered or included.",
		promptSnippet: "Inspect the approved skill catalog and select relevant guidance only",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, context) {
			try {
				throwIfAborted(signal);
				requireSessionRole(pi, "conclave");
				const application = await getRuntime(context);
				throwIfAborted(signal);
				return toolResult(listTrustedSkills(application.trustedSkillCatalog));
			} catch (error) {
				throwIfAborted(signal);
				return toolErrorFromError(
					error instanceof Error ? error : new Error(String(error)),
					"Trusted skill catalog read failed.",
				);
			}
		},
	});

	pi.registerTool({
		name: "khala_read_trusted_skill",
		label: "Read Approved Skill",
		description: "Read a selected SKILL.md only when its ID appears in the explicit trusted catalog.",
		promptSnippet: "Read selected approved skill guidance before starting an Executor",
		parameters: readTrustedSkillSchema,
		async execute(_toolCallId, params: ReadTrustedSkillParams, signal, _onUpdate, context) {
			try {
				throwIfAborted(signal);
				requireSessionRole(pi, "conclave");
				const application = await getRuntime(context);
				throwIfAborted(signal);
				const skill = readTrustedSkill(application.trustedSkillCatalog, params.skillId);
				if (skill === undefined) return toolErrorText("That skill ID is not in the trusted allowlist.");
				return toolResult(skill);
			} catch (error) {
				throwIfAborted(signal);
				return toolErrorFromError(
					error instanceof Error ? error : new Error(String(error)),
					"Trusted skill read failed.",
				);
			}
		},
	});
}
