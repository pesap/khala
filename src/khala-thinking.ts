type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingModel = Readonly<{
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}>;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function getSupportedThinkingLevels(model: ThinkingModel | undefined): ThinkingLevel[] {
	if (model === undefined) {
		return [];
	}
	if (model.reasoning !== true) {
		return ["off"];
	}
	return THINKING_LEVELS.filter((level) => {
		const mappedLevel = model.thinkingLevelMap?.[level];
		if (mappedLevel === null) {
			return false;
		}
		if (level === "xhigh" || level === "max") {
			return mappedLevel !== undefined;
		}
		return true;
	});
}

function isSupportedThinkingLevel(model: ThinkingModel, level: string): boolean {
	return getSupportedThinkingLevels(model).some((supportedLevel) => supportedLevel === level);
}

export type { ThinkingLevel, ThinkingModel };
export { getSupportedThinkingLevels, isSupportedThinkingLevel };
