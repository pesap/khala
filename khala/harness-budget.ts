import {
  normalizeKhalaTranscript,
  stableKhalaJsonStringify,
  type KhalaEvent,
  type KhalaTranscript,
} from "./harness-events.ts";

export type KhalaBudgetComponentName =
  | "bootstrap_context"
  | "runtime_instructions"
  | "workflow_prompt"
  | "skill_payload"
  | "handoff_capsule"
  | "memory_tail"
  | "runtime_rules"
  | "transcript_events";

export interface KhalaBudgetComponent {
  name: KhalaBudgetComponentName;
  label: string;
  tokens: number;
  sourceCount: number;
}

export interface KhalaBudgetWarning {
  code: "budget_total_exceeds_threshold";
  message: string;
  tokens: number;
  thresholdTokens: number;
}

export interface KhalaBudgetReport {
  estimator: "ceil_chars_div_4";
  totalTokens: number;
  components: KhalaBudgetComponent[];
  warnings: KhalaBudgetWarning[];
}

export interface KhalaBudgetInput {
  bootstrapContext?: unknown;
  runtimeInstructions?: unknown;
  workflowPrompt?: unknown;
  skillPayloads?: readonly unknown[];
  handoffCapsule?: unknown;
  memoryTail?: unknown;
  runtimeRules?: unknown;
  transcript?: KhalaTranscript;
  warningThresholdTokens?: number;
}

const COMPONENT_LABELS: Record<KhalaBudgetComponentName, string> = {
  bootstrap_context: "Bootstrap context",
  handoff_capsule: "Handoff/capsule",
  memory_tail: "Memory tail",
  runtime_instructions: "Runtime instructions",
  runtime_rules: "Runtime rules",
  skill_payload: "Skill payload",
  transcript_events: "Transcript events",
  workflow_prompt: "Workflow prompt",
};

const COMPONENT_ORDER: KhalaBudgetComponentName[] = [
  "bootstrap_context",
  "runtime_instructions",
  "workflow_prompt",
  "skill_payload",
  "handoff_capsule",
  "memory_tail",
  "runtime_rules",
  "transcript_events",
];

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateJsonTokens(value: unknown): number {
  if (typeof value === "string") return estimateTextTokens(value);
  return estimateTextTokens(stableKhalaJsonStringify(value));
}

function addValue(
  buckets: Map<KhalaBudgetComponentName, unknown[]>,
  name: KhalaBudgetComponentName,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  buckets.set(name, [...(buckets.get(name) ?? []), value]);
}

function eventBudgetComponent(event: KhalaEvent): KhalaBudgetComponentName {
  switch (event.type) {
    case "bootstrap_payload":
      return "bootstrap_context";
    case "workflow_state":
    case "user_input":
      return "workflow_prompt";
    case "skill_loaded":
    case "skill_missing":
    case "skill_routed":
      return "skill_payload";
    case "memory_gate":
      return "memory_tail";
    case "harness_issue":
    case "policy_issue":
      return "runtime_rules";
    default:
      return "transcript_events";
  }
}

function eventBudgetValue(event: KhalaEvent): unknown {
  switch (event.type) {
    case "user_input":
    case "bootstrap_payload":
    case "assistant_delta":
    case "assistant_final":
      return event.text;
    default:
      return event;
  }
}

export function estimateKhalaBudget(
  input: KhalaBudgetInput,
): KhalaBudgetReport {
  const buckets = new Map<KhalaBudgetComponentName, unknown[]>();

  addValue(buckets, "bootstrap_context", input.bootstrapContext);
  addValue(buckets, "runtime_instructions", input.runtimeInstructions);
  addValue(buckets, "workflow_prompt", input.workflowPrompt);
  for (const skillPayload of input.skillPayloads ?? []) {
    addValue(buckets, "skill_payload", skillPayload);
  }
  addValue(buckets, "handoff_capsule", input.handoffCapsule);
  addValue(buckets, "memory_tail", input.memoryTail);
  addValue(buckets, "runtime_rules", input.runtimeRules);

  if (input.transcript) {
    for (const event of normalizeKhalaTranscript(input.transcript).events) {
      addValue(buckets, eventBudgetComponent(event), eventBudgetValue(event));
    }
  }

  const components = COMPONENT_ORDER.map((name) => {
    const values: unknown[] = buckets.get(name) ?? [];
    return {
      label: COMPONENT_LABELS[name],
      name,
      sourceCount: values.length,
      tokens: values.reduce<number>(
        (sum, value) => sum + estimateJsonTokens(value),
        0,
      ),
    };
  });
  const totalTokens = components.reduce(
    (sum, component) => sum + component.tokens,
    0,
  );
  const warnings: KhalaBudgetWarning[] = [];
  if (
    input.warningThresholdTokens !== undefined &&
    totalTokens > input.warningThresholdTokens
  ) {
    warnings.push({
      code: "budget_total_exceeds_threshold",
      message: `estimated harness context budget ${totalTokens} exceeds threshold ${input.warningThresholdTokens}`,
      thresholdTokens: input.warningThresholdTokens,
      tokens: totalTokens,
    });
  }

  return {
    components,
    estimator: "ceil_chars_div_4",
    totalTokens,
    warnings,
  };
}
