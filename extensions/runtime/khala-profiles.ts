import { spawnSync } from "node:child_process";

export type KhalaProfileName = "planning" | "development" | "agents";
export type KhalaThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type KhalaProfileSource = "builtin" | "pi-model-discovery";
export type KhalaProfileStatus = "ok" | "unresolved";

export interface KhalaModelProfile {
  name: "planning" | "development";
  model: string | null;
  thinkingLevel: KhalaThinkingLevel;
  source: KhalaProfileSource;
  status: KhalaProfileStatus;
  reason?: string;
  setupHint?: string;
}

interface CopilotMiniDiscovery {
  model: string | null;
  reason?: string;
  setupHint?: string;
}

const PLANNING_MODEL = "github-copilot/gpt-5.5";
const DEVELOPMENT_PROVIDER = "github-copilot";
const DEVELOPMENT_MODEL = "gpt-5.4-mini";
const DEVELOPMENT_MODEL_ID = `${DEVELOPMENT_PROVIDER}/${DEVELOPMENT_MODEL}`;
const DISCOVERY_TIMEOUT_MS = 5_000;

let copilotMiniDiscoveryCache: CopilotMiniDiscovery | null = null;

function setupHint(reason: string): string {
  return [
    `Run /khala status to inspect model profiles (${reason}).`,
    `Ensure Pi model discovery lists ${DEVELOPMENT_MODEL_ID} with: pi --list-models ${DEVELOPMENT_MODEL}`,
    "If this environment intentionally lacks that model, pass /workon --model <provider/model> for an explicit override.",
  ].join(" ");
}

function parsePiListModelsTable(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [provider, model] = line.split(/\s+/);
    if (provider === DEVELOPMENT_PROVIDER && model === DEVELOPMENT_MODEL) {
      return `${provider}/${model}`;
    }
  }
  return null;
}

export function discoverCopilotMiniId(): CopilotMiniDiscovery {
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

  const reason = `${DEVELOPMENT_MODEL_ID} was not found in Pi model discovery output`;
  copilotMiniDiscoveryCache = {
    model: null,
    reason,
    setupHint: setupHint(reason),
  };
  return copilotMiniDiscoveryCache;
}

export function resolveKhalaProfile(name: KhalaProfileName): KhalaModelProfile {
  if (name === "planning") {
    return {
      name: "planning",
      model: PLANNING_MODEL,
      thinkingLevel: "xhigh",
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
  const profiles = [resolveKhalaProfile("planning"), resolveKhalaProfile("development")];
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
}
