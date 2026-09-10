import { assertNonBlank, type GovernedRole, type RoleSetting, type RoleSettingsMap } from "./model.js";
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
		if (setting === "usdMax") {
			const usdMax = Number(normalized);
			if (!Number.isFinite(usdMax) || usdMax <= 0) throw new Error(`${role} USD max must be a positive number.`);
		}
		this.value = { ...this.value, ...roleSettingChange(role, setting, normalized) };
	}
}
