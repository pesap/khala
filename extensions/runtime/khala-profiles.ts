import { spawnSync } from "node:child_process";
import { parseProfileEntry } from "./workflow-model-config.ts";

export type KhalaProfileName = "planning" | "development" | "peer-review" | "agents" | (string & {});
export type KhalaThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type KhalaProfileSource = "builtin" | "pi-model-discovery" | "workflow-model-config";
export type KhalaProfileStatus = "ok" | "unresolved";

export interface KhalaModelProfile {
  name: string;
  model: string | null;
  thinkingLevel: KhalaThinkingLevel;
  source: KhalaProfileSource;
  status: KhalaProfileStatus;
  reason?: string;
  setupHint?: string;
}

interface DevelopmentModelDiscovery {
  model: string | null;
  reason?: string;
  setupHint?: string;
}

const PLANNING_MODEL = "github-copilot/gpt-5.5";
const PEER_REVIEW_MODEL = "github-copilot/opus4.7";
const DEVELOPMENT_PROVIDER = "github-copilot";
const DEVELOPMENT_MODEL = "gpt-5.4-mini";
const DEVELOPMENT_MODEL_ID = `${DEVELOPMENT_PROVIDER}/${DEVELOPMENT_MODEL}`;
const DEVELOPMENT_PROVIDER_PREFERENCE = [DEVELOPMENT_PROVIDER, "openai-codex"];
const DISCOVERY_TIMEOUT_MS = 5_000;

let copilotMiniDiscoveryCache: DevelopmentModelDiscovery | null = null;
let configuredProfileEntries: Record<string, string> = {};
let explicitConfiguredProfileNames = new Set<string>();

export function setKhalaWorkflowProfilesForRuntime(
  profiles: Record<string, string>,
  explicitProfileNames: Iterable<string> = Object.keys(profiles),
): void {
  configuredProfileEntries = { ...profiles };
  explicitConfiguredProfileNames = new Set(explicitProfileNames);
}

function setupHint(reason: string): string {
  return [
    `Run /khala-health to inspect model profiles (${reason}).`,
    `Ensure Pi model discovery lists a usable ${DEVELOPMENT_MODEL} with: pi --list-models ${DEVELOPMENT_MODEL}`,
    "If this environment intentionally lacks that model, pass /workon --model <provider/model> for an explicit override.",
  ].join(" ");
}

function parsePiListModelsTable(output: string): string | null {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [provider, model] = line.split(/\s+/);
      return provider && model ? { provider, model } : null;
    })
    .filter((candidate): candidate is { provider: string; model: string } => candidate !== null)
    .filter((candidate) => candidate.model === DEVELOPMENT_MODEL);

  for (const provider of DEVELOPMENT_PROVIDER_PREFERENCE) {
    const preferred = candidates.find((candidate) => candidate.provider === provider);
    if (preferred) return `${preferred.provider}/${preferred.model}`;
  }

  const fallback = candidates[0];
  return fallback ? `${fallback.provider}/${fallback.model}` : null;
}

export function discoverCopilotMiniId(): DevelopmentModelDiscovery {
  if (copilotMiniDiscoveryCache) return copilotMiniDiscoveryCache;

  const result = spawnSync("pi", ["--list-models", DEVELOPMENT_MODEL], {
    encoding: "utf8",
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const reason = result.error.message || "Pi model discovery failed";
    copilotMiniDiscoveryCache = {
      model: null,
      reason,
      setupHint: setupHint(reason),
    };
    return copilotMiniDiscoveryCache;
  }

  if (result.status !== 0) {
    const diagnostic = result.stderr?.trim() || result.stdout?.trim() || `pi --list-models exited ${result.status}`;
    copilotMiniDiscoveryCache = {
      model: null,
      reason: diagnostic,
      setupHint: setupHint(diagnostic),
    };
    return copilotMiniDiscoveryCache;
  }

  const discovered = parsePiListModelsTable(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (discovered) {
    copilotMiniDiscoveryCache = { model: discovered };
    return copilotMiniDiscoveryCache;
  }

  const reason = `No usable ${DEVELOPMENT_MODEL} provider was found in Pi model discovery output; preferred ${DEVELOPMENT_MODEL_ID}`;
  copilotMiniDiscoveryCache = {
    model: null,
    reason,
    setupHint: setupHint(reason),
  };
  return copilotMiniDiscoveryCache;
}

function resolveConfiguredProfile(name: KhalaProfileName): KhalaModelProfile | null {
  if (!explicitConfiguredProfileNames.has(name)) return null;

  const entry = configuredProfileEntries[name];
  const parsed = entry ? parseProfileEntry(entry) : null;
  if (!parsed) {
    const reason = `Invalid workflow model profile entry for '${name}'. Expected format: provider/model:thinking.`;
    return {
      name,
      model: null,
      thinkingLevel: "medium",
      source: "workflow-model-config",
      status: "unresolved",
      reason,
      setupHint: `Edit Khala workflow model config and run /khala-health again. ${reason}`,
    };
  }

  return {
    name,
    model: parsed.modelId,
    thinkingLevel: parsed.thinkingLevel,
    source: "workflow-model-config",
    status: "ok",
  };
}

export function resolveKhalaProfile(name: KhalaProfileName): KhalaModelProfile {
  const configured = resolveConfiguredProfile(name);
  if (configured) return configured;

  if (name === "planning") {
    return {
      name: "planning",
      model: PLANNING_MODEL,
      thinkingLevel: "xhigh",
      source: "builtin",
      status: "ok",
    };
  }

  if (name === "peer-review") {
    return {
      name: "peer-review",
      model: PEER_REVIEW_MODEL,
      thinkingLevel: "high",
      source: "builtin",
      status: "ok",
    };
  }

  const discovery = discoverCopilotMiniId();
  return {
    name: "development",
    model: discovery.model,
    thinkingLevel: "medium",
    source: "pi-model-discovery",
    status: discovery.model ? "ok" : "unresolved",
    reason: discovery.reason,
    setupHint: discovery.setupHint,
  };
}

export function formatKhalaModelProfilesStatus(): string {
  const profiles = [
    resolveKhalaProfile("planning"),
    resolveKhalaProfile("development"),
    resolveKhalaProfile("peer-review"),
  ];
  return [
    "Model profiles:",
    ...profiles.map((profile) => {
      const model = profile.model ?? "unresolved";
      const status = profile.status === "ok" ? "ok" : `unresolved (${profile.reason ?? "unknown reason"})`;
      const hint = profile.setupHint ? ` Setup: ${profile.setupHint}` : "";
      return `- ${profile.name}: model=${model}, thinking=${profile.thinkingLevel}, source=${profile.source}, ${status}.${hint}`;
    }),
  ].join("\n");
}

export function resetKhalaProfileDiscoveryForTests(): void {
  copilotMiniDiscoveryCache = null;
  configuredProfileEntries = {};
  explicitConfiguredProfileNames = new Set<string>();
}
