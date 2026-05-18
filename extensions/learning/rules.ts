import { promises as fs } from "node:fs";
import {
  appendLine,
  isRecord,
  readTextIfExists,
} from "../lib/io.ts";
import { normalizeWhitespace, slugify } from "../lib/text.ts";
import type { LearningPaths } from "./store.ts";

export type RuntimeRuleScope = "repo" | "global";
export type RuntimeRuleLifetime = "durable" | "session";
export type RuntimeRuleStatus =
  | "candidate"
  | "active"
  | "disabled"
  | "superseded";
export type RuntimeRuleSeverity = "advisory" | "warn" | "enforce";
export type RuntimeRuleSource = "manual" | "promotion" | "policy" | "workflow";
export type RuntimeRuleSurface = "prompt" | "tool_call" | "agent_end";

export interface RuntimeRule {
  version: 1;
  id: string;
  scope: RuntimeRuleScope;
  lifetime: RuntimeRuleLifetime;
  status: RuntimeRuleStatus;
  severity: RuntimeRuleSeverity;
  trigger: string;
  instruction: string;
  rationale: string;
  evidenceIds: string[];
  source: RuntimeRuleSource;
  confidence: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
  hitCount: number;
  surface?: RuntimeRuleSurface;
  predicate?: string;
  lastHitAt?: string;
  supersedes?: string[];
  replacedBy?: string;
}

export interface RuleAuditEvent {
  version: 1;
  id: string;
  ruleId: string;
  at: string;
  action: "hit" | "warn" | "block" | "promote" | "disable" | "replace" | "reload";
  detail: string;
}

export interface RuleSelectionContext {
  query?: string;
  workflowType?: string;
  workflowId?: string;
  loadedSkills?: string[];
  toolNames?: string[];
  paths?: string[];
  errors?: string[];
  policyWarnings?: string[];
  limit?: number;
}

function isScope(value: unknown): value is RuntimeRuleScope {
  return value === "repo" || value === "global";
}

function isLifetime(value: unknown): value is RuntimeRuleLifetime {
  return value === "durable" || value === "session";
}

function isStatus(value: unknown): value is RuntimeRuleStatus {
  return (
    value === "candidate" ||
    value === "active" ||
    value === "disabled" ||
    value === "superseded"
  );
}

function isSeverity(value: unknown): value is RuntimeRuleSeverity {
  return value === "advisory" || value === "warn" || value === "enforce";
}

function isSource(value: unknown): value is RuntimeRuleSource {
  return (
    value === "manual" ||
    value === "promotion" ||
    value === "policy" ||
    value === "workflow"
  );
}

function isSurface(value: unknown): value is RuntimeRuleSurface {
  return value === "prompt" || value === "tool_call" || value === "agent_end";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

export function parseRuntimeRule(value: unknown): RuntimeRule | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !isScope(value.scope) ||
    !isLifetime(value.lifetime) ||
    !isStatus(value.status) ||
    !isSeverity(value.severity) ||
    typeof value.trigger !== "string" ||
    typeof value.instruction !== "string" ||
    typeof value.rationale !== "string" ||
    !isSource(value.source) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const surface = isSurface(value.surface) ? value.surface : undefined;
  const predicate =
    typeof value.predicate === "string" ? value.predicate : undefined;
  const lastHitAt =
    typeof value.lastHitAt === "string" ? value.lastHitAt : undefined;
  const replacedBy =
    typeof value.replacedBy === "string" ? value.replacedBy : undefined;

  return {
    version: 1,
    id: value.id,
    scope: value.scope,
    lifetime: value.lifetime,
    status: value.status,
    severity: value.severity,
    trigger: value.trigger,
    instruction: value.instruction,
    rationale: value.rationale,
    evidenceIds: stringArray(value.evidenceIds),
    source: value.source,
    confidence: finiteNumber(value.confidence, 0.5),
    priority: finiteNumber(value.priority, 0),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    hitCount: finiteNumber(value.hitCount, 0),
    ...(surface ? { surface } : {}),
    ...(predicate ? { predicate } : {}),
    ...(lastHitAt ? { lastHitAt } : {}),
    supersedes: stringArray(value.supersedes),
    ...(replacedBy ? { replacedBy } : {}),
  };
}

export function parseRuntimeRulesJsonl(raw: string): RuntimeRule[] {
  const rules: RuntimeRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseRuntimeRule(JSON.parse(trimmed));
      if (parsed) rules.push(parsed);
    } catch {
    }
  }
  return rules;
}

async function readRulesFile(filePath: string): Promise<RuntimeRule[]> {
  return parseRuntimeRulesJsonl(await readTextIfExists(filePath));
}

export function resolveEffectiveRules(records: RuntimeRule[]): RuntimeRule[] {
  const latest = new Map<string, RuntimeRule>();
  for (const record of records) {
    const previous = latest.get(record.id);
    if (!previous || previous.updatedAt <= record.updatedAt) {
      latest.set(record.id, record);
    }
  }

  const replaced = new Set<string>();
  for (const record of latest.values()) {
    for (const id of record.supersedes ?? []) replaced.add(id);
    if (record.replacedBy) replaced.add(record.id);
  }

  return Array.from(latest.values())
    .filter(
      (rule) =>
        rule.status === "active" &&
        !rule.replacedBy &&
        !replaced.has(rule.id),
    )
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        b.priority - a.priority ||
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

function severityRank(severity: RuntimeRuleSeverity): number {
  if (severity === "enforce") return 3;
  if (severity === "warn") return 2;
  return 1;
}

export async function readEffectiveRuntimeRules(
  paths: LearningPaths,
): Promise<RuntimeRule[]> {
  const [active, session] = await Promise.all([
    readRulesFile(paths.rulesActiveJsonl),
    readRulesFile(paths.rulesSessionJsonl),
  ]);
  return resolveEffectiveRules([...active, ...session]);
}

export async function readRuntimeRuleRecords(
  paths: LearningPaths,
): Promise<RuntimeRule[]> {
  const [active, session, candidates] = await Promise.all([
    readRulesFile(paths.rulesActiveJsonl),
    readRulesFile(paths.rulesSessionJsonl),
    readRulesFile(paths.rulesCandidatesJsonl),
  ]);
  return [...active, ...session, ...candidates].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function ruleSearchText(rule: RuntimeRule): string {
  return [
    rule.id,
    rule.scope,
    rule.lifetime,
    rule.severity,
    rule.trigger,
    rule.instruction,
    rule.rationale,
    rule.surface ?? "",
    rule.predicate ?? "",
  ].join(" ");
}

function contextQuery(context: RuleSelectionContext): string {
  return normalizeWhitespace(
    [
      context.query,
      context.workflowType,
      context.workflowId,
      ...(context.loadedSkills ?? []),
      ...(context.toolNames ?? []),
      ...(context.paths ?? []),
      ...(context.errors ?? []),
      ...(context.policyWarnings ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export async function selectRuntimeRules(params: {
  paths: LearningPaths;
  context: RuleSelectionContext;
}): Promise<RuntimeRule[]> {
  const rules = await readEffectiveRuntimeRules(params.paths);
  const limit = Math.max(1, Math.min(params.context.limit ?? 12, 25));
  const query = contextQuery(params.context);
  if (!query) return rules.slice(0, limit);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = rules
    .map((rule) => {
      const text = ruleSearchText(rule).toLowerCase();
      const matchCount = terms.reduce(
        (acc, term) => acc + (text.includes(term) ? 1 : 0),
        0,
      );
      const score =
        matchCount +
        severityRank(rule.severity) +
        rule.priority / 10 +
        rule.confidence / 10;
      return { rule, score, matchCount };
    })
    .filter((entry) => entry.matchCount > 0)
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.score - a.score ||
        severityRank(b.rule.severity) - severityRank(a.rule.severity) ||
        b.rule.priority - a.rule.priority ||
        b.rule.updatedAt.localeCompare(a.rule.updatedAt) ||
        a.rule.id.localeCompare(b.rule.id),
    )
    .map((entry) => entry.rule);

  const selected = matched.length > 0 ? matched : rules;
  return selected.slice(0, limit);
}

export function formatRuntimeRulesForPrompt(rules: RuntimeRule[]): string {
  return rules
    .map((rule) => {
      const surface = rule.surface ? ` ${rule.surface}` : "";
      return `- ${rule.id} ${rule.severity}${surface}: ${rule.instruction}`;
    })
    .join("\n");
}

export function renderRulesMarkdown(rules: RuntimeRule[]): string {
  const lines = ["# Khala Active Rules", "", "<!-- khala-rules-version: 1 -->", ""];
  for (const rule of rules) {
    lines.push(`## ${rule.id}`);
    lines.push("");
    lines.push(`- status: ${rule.status}`);
    lines.push(`- scope: ${rule.scope}`);
    lines.push(`- lifetime: ${rule.lifetime}`);
    lines.push(`- severity: ${rule.severity}`);
    if (rule.surface) lines.push(`- surface: ${rule.surface}`);
    if (rule.predicate) lines.push(`- predicate: ${rule.predicate}`);
    lines.push(`- trigger: ${rule.trigger}`);
    lines.push(`- instruction: ${rule.instruction}`);
    lines.push(`- rationale: ${rule.rationale}`);
    lines.push(`- confidence: ${rule.confidence.toFixed(2)}`);
    lines.push(`- priority: ${rule.priority}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseFieldLine(line: string): [string, string] | null {
  const match = line.match(/^\s*-\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)\s*$/);
  if (!match) return null;
  return [match[1], match[2]];
}

export function parseRulesMarkdown(
  raw: string,
  params: { nowIso: string },
): RuntimeRule[] {
  const rules: RuntimeRule[] = [];
  const sections = raw.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split(/\r?\n/);
    const id = normalizeWhitespace(heading ?? "");
    if (!id) continue;
    const fields = new Map<string, string>();
    for (const line of body) {
      const parsed = parseFieldLine(line);
      if (parsed) fields.set(parsed[0], parsed[1]);
    }

    const record = parseRuntimeRule({
      version: 1,
      id,
      scope: fields.get("scope") ?? "repo",
      lifetime: fields.get("lifetime") ?? "durable",
      status: fields.get("status") ?? "active",
      severity: fields.get("severity") ?? "warn",
      trigger: fields.get("trigger") ?? "",
      instruction: fields.get("instruction") ?? "",
      rationale: fields.get("rationale") ?? "Edited in rules/RULES.md.",
      evidenceIds: [],
      source: "manual",
      confidence: Number.parseFloat(fields.get("confidence") ?? "0.8"),
      priority: Number.parseFloat(fields.get("priority") ?? "0"),
      createdAt: params.nowIso,
      updatedAt: params.nowIso,
      hitCount: 0,
      surface: fields.get("surface"),
      predicate: fields.get("predicate"),
    });
    if (record) rules.push(record);
  }
  return rules;
}

export async function appendRuntimeRule(
  paths: LearningPaths,
  rule: RuntimeRule,
): Promise<void> {
  await appendLine(
    rule.lifetime === "session"
      ? paths.rulesSessionJsonl
      : paths.rulesActiveJsonl,
    JSON.stringify(rule),
  );
}

export function makeRuntimeRule(params: {
  id?: string;
  scope?: RuntimeRuleScope;
  lifetime?: RuntimeRuleLifetime;
  status?: RuntimeRuleStatus;
  severity?: RuntimeRuleSeverity;
  trigger: string;
  instruction: string;
  rationale?: string;
  source?: RuntimeRuleSource;
  confidence?: number;
  priority?: number;
  nowIso: string;
  surface?: RuntimeRuleSurface;
  predicate?: string;
  supersedes?: string[];
}): RuntimeRule {
  const id =
    params.id ??
    `R-${slugify(`${params.trigger}-${params.instruction}`).slice(0, 40)}`;
  return {
    version: 1,
    id,
    scope: params.scope ?? "repo",
    lifetime: params.lifetime ?? "durable",
    status: params.status ?? "active",
    severity: params.severity ?? "warn",
    trigger: params.trigger,
    instruction: params.instruction,
    rationale: params.rationale ?? "Created by khala rule command.",
    evidenceIds: [],
    source: params.source ?? "manual",
    confidence: params.confidence ?? 0.8,
    priority: params.priority ?? 0,
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
    hitCount: 0,
    supersedes: params.supersedes ?? [],
    ...(params.surface ? { surface: params.surface } : {}),
    ...(params.predicate ? { predicate: params.predicate } : {}),
  };
}

export async function refreshRulesMarkdown(
  paths: LearningPaths,
): Promise<void> {
  const rules = (await readEffectiveRuntimeRules(paths)).filter(
    (rule) => rule.lifetime === "durable",
  );
  await fs.writeFile(paths.rulesMd, renderRulesMarkdown(rules), "utf8");
}

export async function reloadRulesMarkdown(params: {
  paths: LearningPaths;
  nowIso: string;
}): Promise<number> {
  const parsed = parseRulesMarkdown(
    await readTextIfExists(params.paths.rulesMd),
    { nowIso: params.nowIso },
  );
  for (const rule of parsed) {
    await appendRuntimeRule(params.paths, {
      ...rule,
      lifetime: "durable",
      updatedAt: params.nowIso,
    });
  }
  await refreshRulesMarkdown(params.paths);
  return parsed.length;
}

export async function appendRuleAudit(
  paths: LearningPaths,
  event: RuleAuditEvent,
): Promise<void> {
  await appendLine(paths.rulesAuditJsonl, JSON.stringify(event));
}

export async function readRuleAuditTail(
  paths: LearningPaths,
  limit: number,
): Promise<RuleAuditEvent[]> {
  const raw = await readTextIfExists(paths.rulesAuditJsonl);
  if (!raw.trim()) return [];
  const events: RuleAuditEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        typeof parsed.id === "string" &&
        typeof parsed.ruleId === "string" &&
        typeof parsed.at === "string" &&
        typeof parsed.action === "string" &&
        typeof parsed.detail === "string"
      ) {
        events.push(parsed as unknown as RuleAuditEvent);
      }
    } catch {
    }
  }
  return events.slice(-Math.max(1, limit));
}

export async function clearSessionRules(paths: LearningPaths): Promise<void> {
  await fs.writeFile(paths.rulesSessionJsonl, "", "utf8");
}
