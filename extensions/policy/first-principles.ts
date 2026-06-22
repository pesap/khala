import { load as loadYaml } from "js-yaml";
import { POSTFLIGHT_LINE_REGEX, PREFLIGHT_LINE_REGEX } from "../lib/constants.ts";
import { isRecord } from "../lib/io.ts";

export type PolicyMode = "monitor" | "warn" | "enforce";
export type PolicyOutcome = "allow" | "warn" | "block";
export type PreflightClarify = "yes" | "no";
export type PreflightSource = "manual" | "auto";
export type PostflightResult = "pass" | "fail" | "not-run";

export interface FirstPrinciplesConfig {
  preflightMode: PolicyMode;
  postflightMode: PolicyMode;
  responseComplianceMode: PolicyMode;
}

export interface PreflightRecord {
  at: string;
  skill: string;
  reason: string;
  clarify: PreflightClarify;
  raw: string;
  source: PreflightSource;
  workflowId?: string | null;
}

export interface PostflightRecord {
  at: string;
  verify: string;
  result: PostflightResult;
  raw: string;
}

export function parsePolicyMode(value: string | undefined): PolicyMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "monitor" || normalized === "warn" || normalized === "enforce") return normalized;
  return null;
}

export function parseFirstPrinciplesConfig(
  raw: string,
  defaults: FirstPrinciplesConfig = { preflightMode: "warn", postflightMode: "warn", responseComplianceMode: "warn" },
): { config: FirstPrinciplesConfig; warnings: string[] } {
  if (!raw.trim()) {
    return {
      config: { ...defaults },
      warnings: ["first-principles-gate.yaml missing or empty; using profile/default modes."],
    };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = loadYaml(raw);
  } catch (error) {
    return {
      config: { ...defaults },
      warnings: [`first-principles-gate.yaml parse error (${error instanceof Error ? error.message : String(error)}); using profile/default modes.`],
    };
  }

  if (!isRecord(parsedYaml)) {
    return {
      config: { ...defaults },
      warnings: ["first-principles-gate.yaml must contain a mapping root; using profile/default modes."],
    };
  }

  const warnings: string[] = [];
  const parseModeField = (field: "preflight_mode" | "postflight_mode" | "response_compliance"): PolicyMode | null => {
    const rawValue = parsedYaml[field];
    if (typeof rawValue !== "string") {
      if (rawValue !== undefined) {
        warnings.push(`Invalid ${field} value '${String(rawValue)}' in first-principles-gate.yaml.`);
      }
      return null;
    }

    const mode = parsePolicyMode(rawValue);
    if (!mode) {
      warnings.push(`Invalid ${field} value '${rawValue}' in first-principles-gate.yaml.`);
      return null;
    }

    return mode;
  };

  return {
    config: {
      preflightMode: parseModeField("preflight_mode") ?? defaults.preflightMode,
      postflightMode: parseModeField("postflight_mode") ?? defaults.postflightMode,
      responseComplianceMode: parseModeField("response_compliance") ?? defaults.responseComplianceMode,
    },
    warnings,
  };
}

export function parsePreflightLine(line: string, nowIso: () => string): PreflightRecord | null {
  const match = line.trim().match(PREFLIGHT_LINE_REGEX);
  if (!match) return null;

  const clarify = match[3];
  if (clarify !== "yes" && clarify !== "no") return null;

  return {
    at: nowIso(),
    skill: match[1],
    reason: match[2],
    clarify,
    raw: line.trim(),
    source: "manual",
  };
}

export function parsePostflightLine(line: string, nowIso: () => string): PostflightRecord | null {
  const match = line.trim().match(POSTFLIGHT_LINE_REGEX);
  if (!match) return null;

  const result = match[2];
  if (result !== "pass" && result !== "fail" && result !== "not-run") return null;

  return {
    at: nowIso(),
    verify: match[1],
    result,
    raw: line.trim(),
  };
}

export function extractPostflightFromAssistantText(text: string, nowIso: () => string): PostflightRecord | null {
  for (const line of text.split(/\r?\n/)) {
    const parsed = parsePostflightLine(line, nowIso);
    if (parsed) return parsed;
  }

  return null;
}

export function modeOutcome(mode: PolicyMode, violation: boolean): PolicyOutcome {
  if (!violation) return "allow";
  if (mode === "enforce") return "block";
  if (mode === "warn") return "warn";
  return "allow";
}

export function buildPreflightRawLine(record: PreflightRecord): string {
  return `Preflight: skill=${record.skill} reason="${record.reason}" clarify=${record.clarify}`;
}
