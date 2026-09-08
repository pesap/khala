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
			conclave: { model: this.value.conclaveModel, thinking: this.value.conclaveThinking },
			executor: { model: this.value.executorModel, thinking: this.value.executorThinking },
			observer: { model: this.value.observerModel, thinking: this.value.observerThinking },
			oracle: { model: this.value.oracleModel, thinking: this.value.oracleThinking },
		};
	}

	updateRoleSetting(role: GovernedRole, setting: RoleSetting, value: string): void {
		const normalized = assertNonBlank(value, `${role} ${setting}`);
		this.value = { ...this.value, ...roleSettingChange(role, setting, normalized) };
	}
}
