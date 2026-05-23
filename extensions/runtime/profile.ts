import { load as loadYaml } from "js-yaml";
import path from "node:path";
import { exists, isRecord, readTextIfExists } from "../lib/io.ts";
import {
  parsePolicyMode,
  type FirstPrinciplesConfig,
} from "../policy/first-principles.ts";

export const WORKFLOW_TYPES = [
  "debug",
  "feature",
  "review",
  "git-review",
  "simplify",
  "ship",
  "learn-skill",
  "plan",
  "audit",
  "triage-issue",
  "tdd",
  "address-open-issues",
] as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export interface WorkflowCommandConfig {
  enabled: boolean;
  promptFile: string;
  workflowFile: string;
  entryType: string;
}

export interface RuntimeProfile {
  lowConfidenceThreshold: number;
  firstPrinciplesDefaults: FirstPrinciplesConfig;
  workflows: Record<WorkflowType, WorkflowCommandConfig>;
}

export interface RuntimeProfileLoadResult {
  profile: RuntimeProfile;
  warnings: string[];
}

export interface RuntimeProfileValidationResult {
  profile: RuntimeProfile;
  warnings: string[];
  enabledWorkflowCount: number;
  disabledWorkflowCount: number;
}

const DEFAULT_WORKFLOWS: Record<WorkflowType, WorkflowCommandConfig> = {
  debug: {
    enabled: true,
    promptFile: "debug-workflow.md",
    workflowFile: "debug-workflow.yaml",
    entryType: "khala-debug-command",
  },
  feature: {
    enabled: true,
    promptFile: "feature-workflow.md",
    workflowFile: "feature-workflow.yaml",
    entryType: "khala-feature-command",
  },
  review: {
    enabled: true,
    promptFile: "review-workflow.md",
    workflowFile: "review-workflow.yaml",
    entryType: "khala-review-command",
  },
  "git-review": {
    enabled: true,
    promptFile: "git-review-workflow.md",
    workflowFile: "git-review-workflow.yaml",
    entryType: "khala-git-review-command",
  },
  simplify: {
    enabled: true,
    promptFile: "simplify-workflow.md",
    workflowFile: "simplify-workflow.yaml",
    entryType: "khala-simplify-command",
  },
  ship: {
    enabled: true,
    promptFile: "ship-workflow.md",
    workflowFile: "ship-workflow.yaml",
    entryType: "khala-ship-command",
  },
  plan: {
    enabled: true,
    promptFile: "plan-workflow.md",
    workflowFile: "plan-workflow.yaml",
    entryType: "khala-plan-command",
  },
  audit: {
    enabled: true,
    promptFile: "audit-workflow.md",
    workflowFile: "audit-workflow.yaml",
    entryType: "khala-audit-command",
  },
  "triage-issue": {
    enabled: true,
    promptFile: "triage-issue-workflow.md",
    workflowFile: "triage-issue-workflow.yaml",
    entryType: "khala-triage-issue-command",
  },
  tdd: {
    enabled: true,
    promptFile: "tdd-workflow.md",
    workflowFile: "tdd-workflow.yaml",
    entryType: "khala-tdd-command",
  },
  "address-open-issues": {
    enabled: true,
    promptFile: "address-open-issues-workflow.md",
    workflowFile: "address-open-issues-workflow.yaml",
    entryType: "khala-address-open-issues-command",
  },
  "learn-skill": {
    enabled: true,
    promptFile: "learn-skill-workflow.md",
    workflowFile: "learn-skill-workflow.yaml",
    entryType: "khala-learn-skill-command",
  },
};

export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = {
  lowConfidenceThreshold: 0.7,
  firstPrinciplesDefaults: {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  },
  workflows: DEFAULT_WORKFLOWS,
};

export function cloneRuntimeProfile(profile: RuntimeProfile): RuntimeProfile {
  return {
    lowConfidenceThreshold: profile.lowConfidenceThreshold,
    firstPrinciplesDefaults: {
      ...profile.firstPrinciplesDefaults,
    },
    workflows: Object.fromEntries(
      WORKFLOW_TYPES.map((workflowType) => [
        workflowType,
        { ...profile.workflows[workflowType] },
      ]),
    ) as Record<WorkflowType, WorkflowCommandConfig>,
  };
}

function isWorkflowType(value: string): value is WorkflowType {
  return WORKFLOW_TYPES.includes(value as WorkflowType);
}

function parseBooleanField(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function parseNonEmptyStringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseRuntimeProfile(
  raw: string,
  defaults: RuntimeProfile = DEFAULT_RUNTIME_PROFILE,
): RuntimeProfileLoadResult {
  if (!raw.trim()) {
    return {
      profile: cloneRuntimeProfile(defaults),
      warnings: ["runtime/profile.yaml missing or empty; using defaults."],
    };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = loadYaml(raw);
  } catch (error) {
    return {
      profile: cloneRuntimeProfile(defaults),
      warnings: [
        `runtime/profile.yaml parse error (${error instanceof Error ? error.message : String(error)}); using defaults.`,
      ],
    };
  }

  if (!isRecord(parsedYaml)) {
    return {
      profile: cloneRuntimeProfile(defaults),
      warnings: [
        "runtime/profile.yaml must contain a mapping root; using defaults.",
      ],
    };
  }

  const profile = cloneRuntimeProfile(defaults);
  const warnings: string[] = [];

  const quality = parsedYaml.quality;
  if (quality !== undefined && !isRecord(quality)) {
    warnings.push(
      "runtime/profile.yaml: quality must be a mapping; defaults kept.",
    );
  }
  if (isRecord(quality) && quality.low_confidence_threshold !== undefined) {
    if (
      typeof quality.low_confidence_threshold === "number" &&
      Number.isFinite(quality.low_confidence_threshold)
    ) {
      if (
        quality.low_confidence_threshold >= 0 &&
        quality.low_confidence_threshold <= 1
      ) {
        profile.lowConfidenceThreshold = quality.low_confidence_threshold;
      } else {
        warnings.push(
          "runtime/profile.yaml: quality.low_confidence_threshold must be in [0,1]; default kept.",
        );
      }
    } else {
      warnings.push(
        "runtime/profile.yaml: quality.low_confidence_threshold must be numeric; default kept.",
      );
    }
  }

  const firstPrinciples = parsedYaml.first_principles;
  if (firstPrinciples !== undefined && !isRecord(firstPrinciples)) {
    warnings.push(
      "runtime/profile.yaml: first_principles must be a mapping; defaults kept.",
    );
  }

  if (isRecord(firstPrinciples)) {
    const modeFields = {
      preflight_mode: "preflightMode",
      postflight_mode: "postflightMode",
      response_compliance: "responseComplianceMode",
    } as const;

    for (const [field, target] of Object.entries(modeFields)) {
      const rawValue = firstPrinciples[field];
      if (rawValue === undefined) continue;
      if (typeof rawValue !== "string") {
        warnings.push(
          `runtime/profile.yaml: first_principles.${field} must be a string; default kept.`,
        );
        continue;
      }

      const mode = parsePolicyMode(rawValue);
      if (!mode) {
        warnings.push(
          `runtime/profile.yaml: first_principles.${field} must be monitor|warn|enforce; default kept.`,
        );
        continue;
      }

      profile.firstPrinciplesDefaults[target] = mode;
    }

    for (const key of Object.keys(firstPrinciples)) {
      if (!(key in modeFields)) {
        warnings.push(
          `runtime/profile.yaml: unknown first_principles key '${key}' ignored.`,
        );
      }
    }
  }

  const commands = parsedYaml.commands;
  if (commands !== undefined && !isRecord(commands)) {
    warnings.push(
      "runtime/profile.yaml: commands must be a mapping; defaults kept.",
    );
  }

  if (isRecord(commands)) {
    for (const [commandName, commandConfig] of Object.entries(commands)) {
      if (!isWorkflowType(commandName)) {
        warnings.push(
          `runtime/profile.yaml: unknown command '${commandName}' ignored.`,
        );
        continue;
      }

      if (typeof commandConfig === "boolean") {
        profile.workflows[commandName].enabled = commandConfig;
        continue;
      }

      if (!isRecord(commandConfig)) {
        warnings.push(
          `runtime/profile.yaml: commands.${commandName} must be boolean or mapping; defaults kept.`,
        );
        continue;
      }

      const enabled = parseBooleanField(commandConfig.enabled);
      if (enabled !== null) {
        profile.workflows[commandName].enabled = enabled;
      } else if (commandConfig.enabled !== undefined) {
        warnings.push(
          `runtime/profile.yaml: commands.${commandName}.enabled must be boolean; default kept.`,
        );
      }

      const prompt = parseNonEmptyStringField(commandConfig.prompt);
      if (prompt) {
        profile.workflows[commandName].promptFile = prompt;
      } else if (commandConfig.prompt !== undefined) {
        warnings.push(
          `runtime/profile.yaml: commands.${commandName}.prompt must be a non-empty string; default kept.`,
        );
      }

      const workflow = parseNonEmptyStringField(commandConfig.workflow);
      if (workflow) {
        profile.workflows[commandName].workflowFile = workflow;
      } else if (commandConfig.workflow !== undefined) {
        warnings.push(
          `runtime/profile.yaml: commands.${commandName}.workflow must be a non-empty string; default kept.`,
        );
      }

      for (const key of Object.keys(commandConfig)) {
        if (key !== "enabled" && key !== "prompt" && key !== "workflow") {
          warnings.push(
            `runtime/profile.yaml: commands.${commandName}.${key} is unknown and ignored.`,
          );
        }
      }
    }
  }

  for (const key of Object.keys(parsedYaml)) {
    if (
      key !== "version" &&
      key !== "quality" &&
      key !== "first_principles" &&
      key !== "commands"
    ) {
      warnings.push(
        `runtime/profile.yaml: unknown top-level key '${key}' ignored.`,
      );
    }
  }

  return {
    profile,
    warnings,
  };
}

export async function loadRuntimeProfile(
  profilePath: string,
  defaults: RuntimeProfile = DEFAULT_RUNTIME_PROFILE,
): Promise<RuntimeProfileLoadResult> {
  const raw = await readTextIfExists(profilePath);
  return parseRuntimeProfile(raw, defaults);
}

export async function validateRuntimeProfile(
  profile: RuntimeProfile,
  paths: {
    commandsDir: string;
    skillflowsDir: string;
  },
): Promise<RuntimeProfileValidationResult> {
  const warnings: string[] = [];
  const validated = cloneRuntimeProfile(profile);

  for (const workflowType of WORKFLOW_TYPES) {
    const workflow = validated.workflows[workflowType];
    if (!workflow.enabled) continue;

    const promptPath = path.join(paths.commandsDir, workflow.promptFile);
    const workflowPath = path.join(paths.skillflowsDir, workflow.workflowFile);

    const [promptExists, workflowExists] = await Promise.all([
      exists(promptPath),
      exists(workflowPath),
    ]);

    if (!promptExists || !workflowExists) {
      validated.workflows[workflowType].enabled = false;
      warnings.push(
        `Disabled /${workflowType}: ${!promptExists ? `missing prompt '${workflow.promptFile}'` : ""}${
          !promptExists && !workflowExists ? " and " : ""
        }${!workflowExists ? `missing workflow '${workflow.workflowFile}'` : ""}.`,
      );
    }
  }

  const enabledWorkflowCount = WORKFLOW_TYPES.filter(
    (workflowType) => validated.workflows[workflowType].enabled,
  ).length;

  return {
    profile: validated,
    warnings,
    enabledWorkflowCount,
    disabledWorkflowCount: WORKFLOW_TYPES.length - enabledWorkflowCount,
  };
}

export function getWorkflowConfig(
  profile: RuntimeProfile,
  workflowType: WorkflowType,
): WorkflowCommandConfig | null {
  const workflow = profile.workflows[workflowType];
  if (!workflow?.enabled) return null;
  return workflow;
}
