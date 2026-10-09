import { assertNonBlank, type GovernedRole, isConclaveMode, type RoleSetting, type RoleSettingsMap } from "./model.js";
import type { ServiceOptions } from "./service-contracts.js";
import { roleSettingChange } from "./service-runtime-policy.js";

export class ServiceConfiguration {
	private value: ServiceOptions;

	constructor(options: ServiceOptions) {
		this.value = options;
	}

	get options(): ServiceOptions {
		return this.value;
	}

	getRoleSettings(): RoleSettingsMap {
		return {
			conclave: {
				model: this.value.conclaveModel,
				thinking: this.value.conclaveThinking,
				usdMax: this.value.conclaveUsdMax,
				mode: this.value.conclaveMode ?? "headless",
			},
			executor: {
				model: this.value.executorModel,
				thinking: this.value.executorThinking,
				usdMax: this.value.executorUsdMax,
			},
			observer: {
				model: this.value.observerModel,
				thinking: this.value.observerThinking,
				usdMax: this.value.observerUsdMax,
			},
			oracle: { model: this.value.oracleModel, thinking: this.value.oracleThinking, usdMax: this.value.oracleUsdMax },
		};
	}

	updateRoleSetting(role: GovernedRole, setting: RoleSetting, value: string): void {
		const normalized = assertNonBlank(value, `${role} ${setting}`);
		if (setting === "mode") return this.updateConclaveMode(role, normalized);
		if (setting === "usdMax") validateUsdMax(role, normalized);
		this.value = { ...this.value, ...roleSettingChange(role, setting, normalized) };
	}

	private updateConclaveMode(role: GovernedRole, value: string): void {
		if (role !== "conclave") throw new Error("Only Conclave supports an invocation mode.");
		if (!isConclaveMode(value)) throw new Error("Conclave mode must be headless or subagent.");
		this.value = { ...this.value, conclaveMode: value };
	}
}

function validateUsdMax(role: GovernedRole, value: string): void {
	const usdMax = Number(value);
	if (!Number.isFinite(usdMax) || usdMax <= 0) throw new Error(`${role} USD max must be a positive number.`);
}
