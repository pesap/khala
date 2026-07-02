import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PREFLIGHT_LINE_REGEX } from "../lib/constants.ts";
import type { HarnessLimits } from "./profile.ts";
import {
  assistantClaimedSkillNames as registryAssistantClaimedSkillNames,
  explicitSkillNamesForUserText as registryExplicitSkillNamesForUserText,
  isSkillReadPath,
  recommendedSkillsForUserText as registryRecommendedSkillsForUserText,
  skillMetadataFromSkillReadPath,
  skillNeedReason as registrySkillNeedReason,
} from "./skill-registry.ts";
import {
  getToolMetadata,
  isCommandExecutionToolName,
  isDuplicateEvidenceCandidateToolCall,
  isEvidenceToolCall,
  isExternalEvidenceToolCall,
  isExternalOpenToolName,
  isExternalSearchToolName,
  isKhalaMemoryToolName,
  isLocalEvidenceToolCall,
  isLocalFileReadToolName,
  isMemoryPersistenceToolName,
  isMemoryRefreshToolName,
  isMemorySearchToolName,
  isMutationToolCall,
  isSkillLoaderToolName,
  MEMORY_SEARCH_TOOL_NAMES,
  resetsDuplicateEvidenceWindowToolCall,
  toolNameLooksLikeExternalEvidence,
} from "./tool-registry.ts";

type AgentEndEventMessage = {
  role: "assistant" | "user" | "toolResult" | "system" | string;
  content: unknown;
};
type MessageContentItem = AssistantMessage["content"][number];
type ToolCallContent = Extract<MessageContentItem, { type: "toolCall" }>;

interface ModelEscalationDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

interface EvidenceRoutingDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

type EvidenceSourceClass = "any" | "local" | "external" | "command" | "mutation";

interface SkillRoutingDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

interface MemorySearchRoutingDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

interface LearningCaptureDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

interface ToolEfficiencyDecision {
  efficient: boolean;
  reason: string;
}

interface WorkflowContractDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

interface ImplementationQualityDecision {
  required: boolean;
  satisfied: boolean;
  reason: string;
}

export interface HarnessTurnIssue {
  code:
    | "tool_efficiency"
    | "memory_search"
    | "learning_capture"
    | "skill_routing"
    | "evidence_routing"
    | "implementation_quality"
    | "workflow_drift"
    | "model_escalation";
  title: string;
  block: boolean;
  message: string;
  remediation: {
    action: string;
    cheapestTool: string;
    retry: string;
    avoid: string[];
  };
}

export interface HarnessTurnMetrics {
  scopedMessageCount: number;
  toolCallCount: number;
  memorySearches: {
    total: number;
    focused: number;
    successful: number;
  };
  skillLoads: number;
  externalEvidenceCalls: number;
  commandEvidenceCalls: number;
  mutationCalls: number;
  learningCaptures: number;
  modelEscalations: number;
  wasteSignals: {
    duplicateEvidence: boolean;
    inefficientShell: boolean;
    shellQuotingRepairLoop: boolean;
    fullSessionArtifactRead: boolean;
    broadQuery: boolean;
    duplicateLearning: boolean;
    count: number;
  };
}

const KNOWLEDGE_GAP_REGEX =
  /\b(?:i do not know|i don't know|not sure|uncertain|unclear|unknown|best guess|guessing|may be wrong|might be wrong|could be wrong|can't tell|cannot tell|can't determine|cannot determine|could(?: not|n't) determine|(?:can't|cannot|could(?: not|n't)|unable to) (?:verify|validate|confirm|determine|check|test|run|execute|inspect|reproduce|build|lint|typecheck)|low[- ]confidence|(?:not|no) confidence|not confident|knowledge cutoff|training data|no (?:live |current )?(?:web|internet|browser|browsing) access|(?:i|we) (?:do not|don't) have (?:live |current )?(?:web|internet|browser|browsing) access|(?:i|we) (?:do not|don't) have visibility into|(?:can't|cannot|unable to) (?:browse|search (?:the )?web|access (?:the )?(?:web|internet|browser|browsing|current docs?))|cannot verify|can't verify|could(?: not|n't) verify|(?:was|were)(?: not|n't) able to (?:verify|validate|confirm|determine|check|test|run|execute|inspect|access|look up|search|review|build|lint|typecheck)|unable to (?:verify|validate|confirm|determine|check|test|run|execute|inspect|build|lint|typecheck)|no way to verify|(?:i|we) (?:haven't|have not|didn't|did not) (?:check(?:ed)?|validat(?:e|ed)|verif(?:y|ied)|confirm(?:ed)?|test(?:ed)?|run|execute(?:d)?|inspect(?:ed)?|look(?:ed)? up|search(?:ed)?|review(?:ed)?|build|built|lint(?:ed)?|typecheck(?:ed)?)|not yet verified|not verified|unverified|cannot access|can't access|without (?:seeing|access to|the) (?:the )?(?:file|files|logs?|output|diff|source|docs?|context|evidence|artifact|command output|test output)|(?:i|we) (?:do not|don't) have (?:the )?(?:file|files|logs?|output|diff|source|docs?|context|evidence|artifact|command output|test output)|(?:i|we)(?:'d| would)? need (?:to see|access to|the) (?:the )?(?:file|files|logs?|output|diff|source|docs?|context|evidence|artifact|command output|test output)(?:\s+to\s+(?:confirm|verify|validate|know|tell|determine))?|do not have enough (?:context|information|data)|don't have enough (?:context|information|data)|not enough (?:context|information|evidence|data)|insufficient (?:evidence|data)|knowledge gap|need(?:s)? (?:a )?(?:better|stronger) model|escalat(?:e|ion))\b/i;

const HEDGED_RESULT_REGEX =
  /\b(?:probably|likely|maybe|possibly|seems?|appears?|looks like|i think|i believe|should be|presumably|tentative|preliminary|not conclusive|inconclusive|suggests?)\b/i;
const NON_OFFICIAL_SOURCE_RESULT_REGEX =
  /\b(?:unofficial|not\s+(?:an?\s+)?official|non[- ]official|third[- ]party|community(?:[- ]maintained)?|forum|stack\s*overflow|reddit|blog(?:\s+post)?|mirror|scraped|unverified)\b/i;
const STRONG_ESCALATION_AGENT_REGEX = /\b(?:oracle|researcher|reviewer)\b/i;
const STRONG_MODEL_REGEX =
  /\b(?:gpt-5|claude|sonnet|opus|gemini[-/ ]?(?:2\.5|3)?[-/ ]?pro)\b/i;
const HIGH_EFFORT_REGEX = /\b(?:high|xhigh|max|maximum)\b/i;
const RECENT_OR_EXTERNAL_FACT_REGEX =
  /\b(?:latest|current|currently|recent|today|yesterday|tomorrow|now|up[- ]?to[- ]?date|changed recently|release notes?|changelog|pricing|schedule|score|weather|news|law|regulation|standard|docs?|documentation|api reference)\b/i;
const SOURCE_EVIDENCE_REQUEST_REGEX =
  /\b(?:source|citation|cite|from docs?|from source|verify|confirm|look up|search|browse|web|official docs?|primary source)\b/i;
const OFFICIAL_SOURCE_REQUEST_REGEX =
  /\b(?:(?:official|primary|authoritative|vendor)\s+(?:docs?|documentation|source|sources|website|web|api reference|reference)|(?:docs?|documentation|source|sources|website|web|api reference|reference)\s+(?:from\s+)?(?:official|primary|authoritative|vendor))\b/i;
const CITATION_RESPONSE_REQUEST_REGEX =
  /\b(?:citations?|cite|sources?|references?|links?|with source|show source|from source|from docs?|official docs?)\b/i;
const ASSISTANT_CITATION_RESPONSE_REGEX =
  /(?:https?:\/\/|github\.com\/)/i;
const LOCAL_CITATION_MARKER_REGEX =
  /\b(?:sources?|references?|citation|cite|see|from|per|according to)\b/i;
const CITATION_URL_REGEX =
  /https?:\/\/[^\s)"'<>]+|github\.com\/[^\s)"'<>]+/gi;
const ASSISTANT_SOURCE_CLAIM_REGEX =
  /\b(?:according to|per|from|in)\s+(?:the\s+)?(?:(?:latest|current|official|primary)\s+){0,3}(?:[A-Z][A-Za-z0-9_.-]+\s+){0,2}(?:docs?|documentation|source|release notes?|changelog|api reference|website|web)|\b(?:the\s+)?(?:(?:latest|current|official|primary)\s+){0,3}(?:[A-Z][A-Za-z0-9_.-]+\s+){0,2}(?:docs?|documentation|release notes?|changelog|api reference)\s+(?:say|says|state|states|mention|mentions|note|notes|list|lists|show|shows|describe|describes|document|documents|recommend|recommends|confirm|confirms)\b|\b(?:MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\s+(?:say|says|state|states|mention|mentions|note|notes|list|lists|show|shows|describe|describes|document|documents|recommend|recommends|confirm|confirms)\b|\bi\s+(?:verified|confirmed|checked|consulted|referenced|looked up|searched|browsed)\b|\b(?:verified|confirmed|checked|consulted|referenced)\s+(?:against|with|from|in)\b|\b(?:latest|current)\s+(?:(?:official|primary)\s+)?(?:docs?|documentation|release|version|api|pricing|law|regulation|standard|schedule|score|weather|news)\b/i;
const ASSISTANT_COMMAND_VERIFICATION_CLAIM_REGEX =
  /\b(?:(?:all\s+)?(?:tests?|test suite|lint|typecheck|type check|build|checks?|ci|github actions?|verification|validation|preflight|postflight)\s+(?:(?:are|is|was|were)\s+)?(?:passed|pass|passing|succeeded|succeed|successful|green|clean|completed successfully)|(?:i|we)\s+(?:ran|executed|verified with|checked with)\s+(?:the\s+)?(?:tests?|test suite|lint|typecheck|type check|build|checks?|ci|github actions?|command|verification|validation|preflight|postflight)|(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?|(?:make|just|task)\s+)(?:test|lint|typecheck|build)\s+(?:passed|succeeded|was green)|(?:node\s+--test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test)\s+(?:passed|succeeded|was green))\b/i;
const ASSISTANT_EXACT_COMMAND_VERIFICATION_CLAIM_REGEX =
  /`[^`\n]{2,160}`(?:\s+(?:command|check))?(?:\s+(?:passed|succeeded|was\s+green|completed\s+successfully)|[\s\S]{0,40}\b(?:passed|succeeded|was\s+green|completed\s+successfully)\b)/i;
const ASSISTANT_MUTATION_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:updated|modified|changed|patched|edited|wrote|created|added|fixed|implemented)\b|\b(?:updated|modified|changed|patched|edited|wrote|created|added|fixed|implemented)\s+(?:the\s+)?(?:file|code|implementation|docs?|documentation|readme|tests?|feature|bug|issue|change)\b/i;
const ASSISTANT_TOOL_WORK_PROMISE_REGEX =
  /\b(?:i|we)(?:\s+(?:will|would|can|could|should|am going to|are going to)|'ll)\s+(read|load|open|fetch|download|inspect|check|review|analyze|grep|find|locate|search|browse|look up|look at|run|execute|test|verify|validate|build|lint|typecheck|edit|write|fix|implement|add|create|update|patch|modify)\b|\b(?:next|then|after that)\s+(?:i|we)(?:\s+will|'ll)\s+(read|load|open|fetch|download|inspect|check|review|analyze|grep|find|locate|search|browse|look up|look at|run|execute|test|verify|validate|build|lint|typecheck|edit|write|fix|implement|add|create|update|patch|modify)\b/i;
const ASSISTANT_TOOL_WORK_COMPLETION_REGEX =
  /\b(?:i|we)\s+(read|loaded|opened|fetched|downloaded|inspected|checked|reviewed|analyzed|grepped|found|located|searched|browsed|looked up|looked at|ran|executed|validated)\b/i;
const LOCAL_REPO_SEARCH_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:searched|grepped|found|located)\b[\s\S]*\b(?:repo|repository|codebase|project|worktree|source tree|files?)\b/i;
const LOCAL_REPO_SEARCH_TARGET_REGEX =
  /\b(?:repo|repository|codebase|project|worktree|source tree|files?)\b/i;
const WORKFLOW_CONTRACT_REGEX =
  /\b(?:Deterministic workflow contract|Ordered workflow steps|Treat the YAML workflow spec as the state machine)\b/i;
const WORKFLOW_GATHER_CONTEXT_REGEX =
  /\b(?:gather|inspect|load|read|review|collect)\b[\s\S]{0,40}\b(?:context|evidence|files?|source|repo|requirements?)\b|\bcontext\b[\s\S]{0,40}\b(?:first|before|evidence)\b/i;
const WORKFLOW_GUIDE_REQUIRED_REGEX =
  /\b(?:load|read|follow|apply)\b[\s\S]{0,40}\b(?:required\s+)?(?:guide|guidelines?|skills?|SKILL\.md|project rules?)\b|\b(?:guide|guidelines?|skills?|SKILL\.md|project rules?)\b[\s\S]{0,60}\b(?:before|required|active step checklist|constraints)\b/i;
const WORKFLOW_VALIDATION_REQUIRED_REGEX =
  /\b(?:run|targeted|required|passing|include)\b[\s\S]{0,50}\b(?:validation|validate|tests?|checks?|typecheck|lint|build|eval prompts?)\b|\b(?:validation|validate|tests?|checks?|typecheck|lint|build|eval prompts?)\b[\s\S]{0,50}\b(?:required|before|after|artifact|done|success)\b/i;
const WORKFLOW_MUTATION_EXPECTED_REGEX =
  /\b(?:add|create|edit|fix|implement|modify|patch|ship|update|write)\b/i;
const WORKFLOW_SUCCESS_RESPONSE_REGEX =
  /\b(?:Result|Status):\s*success\b|\b(?:done|completed|finished|implemented|created|updated|shipped|resolved)\b[\s\S]{0,80}\b(?:success|successful|successfully|complete|completed|done)\b|\b(?:workflow|task)\s+(?:is\s+)?(?:complete|completed|done|finished|successful)\b|\bi did\b/i;
const URL_TEXT_REGEX = /https?:\/\/|github\.com\//i;
const ARTIFACT_REFERENCE_REGEX =
  /(?:https?:\/\/|github\.com\/|(?:^|\s)[\w.-]+\/[\w.-]+(?:\s|$)|(?:^|\s)(?:\.{0,2}\/|~\/)[^\s]+|[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|lock|txt)\b)/i;
const LOCAL_ARTIFACT_TARGET_REGEX =
  /(?:^|\s)((?:\.{0,2}\/|~\/)?[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|jsonl|ya?ml|toml|lock|log|txt)\b)/gi;
const EXPLICIT_LEARNING_CAPTURE_REGEX =
  /\b(?:(?:remember|learn|store|save|record|note)\s+(?:this|that|the|my|a|an)\s+(?:lesson|rule|preference|correction|workflow|pattern|fact|instruction)|remember\s+to\s+(?:use|prefer|run|check|avoid|do|don't|do not|call|read|search|verify|store|save|keep)|(?:remember|learn|store|save|record|note)\s+this\s+for\s+(?:future|next time|later)|(?:from now on|going forward|next time)\s*,?\s+(?:remember|use|prefer|do|don't|do not)|don't forget\s+(?:this|that)|add\s+this\s+to\s+(?:memory|khala memory|your memory))\b/i;
const ASSISTANT_MEMORY_CLAIM_REGEX =
  /\b(?:i(?:'ll| will)?\s+(?:remember|learn|store|save|record|note)\s+(?:this|that|the lesson|the rule|the preference)|i(?:'ll| will| can)?\s+keep\s+(?:this|that|it|the lesson|the rule|the preference)\s+in\s+mind|i(?:'ve| have)\s+(?:remembered|learned|stored|saved|recorded|noted)|(?:stored|saved|recorded|learned)\s+(?:this|that|the lesson|the rule|the preference)\s+(?:in|to)\s+(?:memory|khala memory)|(?:stored|saved|recorded|learned|remembered)\s+(?:in|to)\s+(?:memory|khala memory)|(?:stored|saved|recorded|learned|remembered|noted)\b[\s\S]{0,80}\b(?:in|to)\s+(?:memory|khala memory)|(?:stored|saved|recorded|learned|remembered|noted)\s+for\s+(?:future|next time|later))\b/i;
const LEARNING_STORAGE_NEGATION_REGEX =
  /\b(?:not|never|no|did(?:n't| not)|was(?:n't| not)|is(?:n't| not)|could(?:n't| not)|failed to|unable to|skipped|skip(?:ped)?|temporary|session[- ]only|not durable|non[- ]durable)\b[\s\S]{0,40}\b(?:stored|saved|recorded|persisted|learned|written|created|memory|storage)\b|\b(?:stored|saved|recorded|persisted|learned|written|created)\b[\s\S]{0,40}\b(?:not|never|failed|temporary|session[- ]only|not durable|non[- ]durable)\b|["']?(?:stored|saved|recorded|persisted|learned|written|created|success|ok)["']?\s*[:=]\s*(?:false|null|0|["'](?:false|no)["'])\b/i;
const SESSION_ARTIFACT_SUMMARY_HINT_REGEX =
  /(?:^|[/\\])(?:sessions?|session-runs?|chain-runs?|agent-runs?|intercom)[/\\].+\.(?:jsonl?|log|txt|md)$|(?:^|[/\\])(?:transcript|messages|conversation|session|debug|progress)\.(?:jsonl?|log|txt|md)$/i;
const SHELL_QUOTING_ERROR_REGEX =
  /\b(?:unexpected eof|unexpected end of file|unterminated (?:quoted )?string|quote>|dquote>|squote>|syntax error near unexpected token|no closing quotation|unmatched [`'"]|bad substitution)\b/i;
const SUBSTANTIAL_TASK_REGEX =
  /\b(?:implement|fix|debug|review|refactor|audit|investigate|triage|ship|feature|continue working|keep working|make progress|improve|cleanup|clean up)\b/i;
export const DEFAULT_SUBSTANTIAL_TOOL_CALL_THRESHOLD = 4;
export const DEFAULT_TOOL_FAILURE_ESCALATION_THRESHOLD = 3;
const MIN_LEARNING_CAPTURE_SCORE = 0.75;
const MIN_LEARNING_CAPTURE_CONFIDENCE = 0.75;
const TOOL_FAILURE_TEXT_REGEX =
  /\b(?:errors?|errored|failed|failing|failure|fail\b(?!\s*0\b)|not ok|rejected|exception|traceback|panic(?:ked)?|fatal|aborted?|cancel(?:ed|led)|crashed?|killed|terminated|segmentation fault|segfault|sig(?:abrt|hup|int|kill|pipe|quit|segv|term)|permission denied|no such file|not found|cannot find module|module not found|command failed|exit code [1-9]\d*|exit status [1-9]\d*|exited with code [1-9]\d*|(?:exit|return)[_-]?(?:code|status)\b["']?\s*[:=]\s*[1-9]\d*|["']?(?:success|ok|succeeded|passed)["']?\s*[:=]\s*(?:false|null|0|["'](?:false|no)["'])\b|non[- ]zero exit|timed out|timeout|eacces|elifecycle|eperm|enoent|econnreset|etimedout|(?:syntax|type|reference|assertion|range|runtime)error|unhandled (?:exception|rejection))\b|npm ERR!|[✖×]/i;
const TOOL_NO_USABLE_RESULT_REGEX =
  /\b(?:no (?:results?|relevant results?|search results?|sources?|citations?|matches?|tests?) found|no matches?|no relevant (?:memory|evidence|sources?)|not relevant|irrelevant|unrelated|no tests? (?:ran|run|executed|collected|found)|0 (?:results?|matches?|sources?|citations?|tests?)|empty result|returned no data|no data returned|nothing found|unavailable|temporarily unavailable|output truncated|truncated output|truncated after|additional lines? omitted|omitted for brevity)\b/i;
const TOOL_ZERO_EXECUTION_RESULT_REGEX =
  /\b(?:(?:tests?|checks?|cases?)\s*[:=]\s*0\s+(?:passed|passing|run|executed|collected|found)|0\s+(?:passed|passing|run|executed|collected)|["']?(?:passed|passing|run|executed|collected)["']?\s*[:=]\s*0)\b/i;
const EXTERNAL_EVIDENCE_HTTP_FAILURE_REGEX =
  /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*(?:4\d\d|5\d\d)|["']?(?:status|statusCode|response|code)["']?\s*[:=]?\s*(?:4\d\d|5\d\d)|(?:4\d\d|5\d\d)\s+(?:not found|forbidden|unauthorized|bad gateway|service unavailable|gateway timeout|too many requests|server error))\b/i;
const GENERIC_ACK_RESULT_REGEX =
  /^\s*(?:ok(?:ay)?|done|success(?:ful)?|succeeded|completed|received|acknowledged|no output|(?:command|process)?\s*(?:exited|completed)?\s*(?:successfully|with\s+)?(?:exit\s+)?(?:code|status)?\s*0)\s*[.!]?\s*$/i;
const GENERIC_EXTERNAL_EVIDENCE_RESULT_REGEX =
  /^\s*(?:(?:page|url|source|link|site|website|docs?|documentation)\s+)?(?:opened|loaded|fetched|retrieved|found|available|accessible|visited|complete|completed)(?:\s+(?:successfully|ok|okay|source|result|page|url|link|site|website|docs?|documentation))*\s*[.!]?\s*$/i;
const GENERIC_MEMORY_SEARCH_RESULT_TERMS = new Set([
  "available",
  "count",
  "found",
  "hit",
  "hits",
  "item",
  "items",
  "lesson",
  "lessons",
  "match",
  "matches",
  "memories",
  "memory",
  "record",
  "records",
  "relevant",
  "result",
  "results",
  "retrieved",
  "returned",
  "success",
  "total",
]);
const EMPTY_EVIDENCE_RESULT_KEYS = new Set([
  "body",
  "content",
  "data",
  "items",
  "matches",
  "memories",
  "output",
  "results",
  "rows",
  "sources",
  "stderr",
  "stdout",
  "text",
]);
const METADATA_ONLY_RESULT_KEYS = new Set([
  "count",
  "duration",
  "elapsed",
  "ok",
  "query",
  "status",
  "statuscode",
  "success",
  "total",
  "totalcount",
]);
const BOUNDED_PIPE_REGEX =
  /\|\s*(?:head(?:\s+(?:-n\s+)?-?\d+)?\b|tail(?:\s+(?:-n\s+)?-?\d+)?\b|sed\s+-n\s+["']?\d+(?:,\d+)?p["']?)/i;
const BOUNDED_GREP_REGEX = /\b(?:grep|rg)\b[\s\S]*(?:\s-m\s*\d+|--max-count(?:=|\s+)\d+|\|\s*head)\b/i;
const MAX_BOUNDED_EVIDENCE_LINES = 200;
const GENERIC_MEMORY_QUERY_TERMS = new Set([
  "agent",
  "cache",
  "cached",
  "change",
  "changes",
  "code",
  "context",
  "debug",
  "follow-up",
  "followup",
  "fix",
  "history",
  "hit",
  "hits",
  "issue",
  "lesson",
  "lessons",
  "memory",
  "preference",
  "preferences",
  "previous",
  "prior",
  "repo",
  "review",
  "rule",
  "rules",
  "recent",
  "session",
  "task",
  "work",
]);
const GENERIC_MEMORY_TASK_TERMS = new Set([
  ...GENERIC_MEMORY_QUERY_TERMS,
  "analyze",
  "and",
  "after",
  "before",
  "check",
  "file",
  "files",
  "find",
  "fixing",
  "inspect",
  "load",
  "patching",
  "read",
  "review",
  "that",
  "the",
  "these",
  "this",
  "those",
  "update",
  "verify",
  "with",
]);
const MEMORY_QUERY_TERM_ALIASES = new Map<string, string>([
  ["corrections", "correction"],
  ["docs", "doc"],
  ["documentation", "doc"],
  ["errors", "error"],
  ["lessons", "lesson"],
  ["patches", "patch"],
  ["patching", "patch"],
  ["routes", "route"],
  ["routed", "route"],
  ["routing", "route"],
  ["skills", "skill"],
  ["tests", "test"],
  ["testing", "test"],
  ["workflows", "workflow"],
]);
const GENERIC_LEARNING_REQUEST_TERMS = new Set([
  "before",
  "capture",
  "changes",
  "correction",
  "future",
  "keep",
  "kept",
  "lesson",
  "learn",
  "learned",
  "later",
  "mind",
  "memory",
  "noted",
  "okay",
  "recorded",
  "remember",
  "remembered",
  "rule",
  "save",
  "saved",
  "store",
  "stored",
  "that",
  "this",
]);
const LEARNING_REQUEST_TERM_ALIASES = new Map<string, string>([
  ["changes", "change"],
  ["docs", "doc"],
  ["documentation", "doc"],
  ["fixes", "fix"],
  ["fixing", "fix"],
  ["verified", "verify"],
  ["verification", "verify"],
]);
const GENERIC_EXTERNAL_QUERY_TERMS = new Set([
  "agent",
  "api",
  "best",
  "browse",
  "browsed",
  "check",
  "checked",
  "config",
  "configuration",
  "current",
  "docs",
  "documentation",
  "example",
  "examples",
  "fetch",
  "find",
  "changelog",
  "guide",
  "guides",
  "how",
  "install",
  "installation",
  "latest",
  "law",
  "lookup",
  "news",
  "notes",
  "official",
  "oracle",
  "practice",
  "practices",
  "pricing",
  "reference",
  "regulation",
  "release",
  "research",
  "researched",
  "researcher",
  "schedule",
  "scout",
  "score",
  "search",
  "searched",
  "source",
  "standard",
  "setup",
  "subagent",
  "task",
  "today",
  "tutorial",
  "tutorials",
  "verify",
  "verified",
  "version",
  "weather",
  "web",
]);
const EXTERNAL_QUERY_TERM_ALIASES = new Map<string, string>([
  ["decorators", "decorator"],
  ["releases", "release"],
  ["versions", "version"],
]);
const EXTERNAL_TARGET_STOP_TERMS = new Set([
  "about",
  "according",
  "after",
  "and",
  "answer",
  "are",
  "against",
  "before",
  "changed",
  "confidence",
  "does",
  "fact",
  "fixing",
  "for",
  "from",
  "how",
  "is",
  "lesson",
  "local",
  "per",
  "list",
  "lists",
  "mention",
  "mentions",
  "remember",
  "recommend",
  "recommends",
  "say",
  "says",
  "show",
  "shows",
  "should",
  "sources",
  "state",
  "states",
  "summarize",
  "support",
  "supported",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);
const EXTERNAL_TARGET_TERM_ALIASES = new Map<string, Set<string>>([
  ["typescript", new Set(["typescriptlang"])],
]);
const EXTERNAL_TARGET_CONTEXT_TERMS = new Set([
  "api",
  "changelog",
  "docs",
  "documentation",
  "law",
  "news",
  "pricing",
  "reference",
  "regulation",
  "release",
  "releases",
  "schedule",
  "score",
  "standard",
  "version",
  "weather",
]);
const GENERIC_ESCALATION_TERMS = new Set([
  "agent",
  "anthropic",
  "check",
  "claude",
  "context",
  "diagnose",
  "effort",
  "gemini",
  "google",
  "high",
  "initial",
  "confidence",
  "max",
  "model",
  "oracle",
  "pro",
  "reasoning",
  "low",
  "researcher",
  "review",
  "reviewer",
  "sonnet",
  "strong",
  "task",
  "verify",
  "xhigh",
]);

function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isMessageContentItem(value: unknown): value is MessageContentItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function messageContentItems(content: unknown): MessageContentItem[] {
  if (Array.isArray(content)) {
    return content.filter(isMessageContentItem);
  }
  if (typeof content === "string") {
    return content.length > 0
      ? ([{ type: "text", text: content }] as MessageContentItem[])
      : [];
  }
  return isMessageContentItem(content) ? [content] : [];
}

function extractMessageText(content: unknown): string {
  return messageContentItems(content)
    .flatMap((item) => {
      if (item.type !== "text") return [];
      return typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  try {
    return stableStringify(value);
  } catch {
    return stringifyToolArguments(value).trim();
  }
}

function extractCommandArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return stringifyToolArguments(value);

  const record = value as Record<string, unknown>;
  for (const key of ["cmd", "command", "script", "input"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return stringifyToolArguments(value);
}

function extractQueryArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return stringifyToolArguments(value);

  const record = value as Record<string, unknown>;
  const query = record.query;
  if (typeof query === "string") return query;
  return stringifyToolArguments(value);
}

function extractExternalQueryArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return stringifyToolArguments(value);

  const record = value as Record<string, unknown>;
  for (const key of ["query", "q", "url", "ref_id"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }

  const queryParts: string[] = [];
  for (const key of ["search_query", "image_query"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const entryRecord = entry as Record<string, unknown>;
      const query = entryRecord.q;
      if (typeof query !== "string" || !query.trim()) continue;

      const domainText = externalSearchDomainsText(entryRecord.domains);
      queryParts.push(domainText ? `${query} ${domainText}` : query);
    }
  }
  if (queryParts.length > 0) {
    const domainText = externalSearchDomainsText(record.domains);
    return domainText ? `${queryParts.join("\n")} ${domainText}` : queryParts.join("\n");
  }

  const openEntries = record.open;
  if (Array.isArray(openEntries)) {
    for (const entry of openEntries) {
      if (!entry || typeof entry !== "object") continue;
      const refId = (entry as Record<string, unknown>).ref_id;
      if (typeof refId === "string" && refId.trim()) return refId;
    }
  }

  return stringifyToolArguments(value);
}

function extractExternalQueryArguments(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [""];
  if (typeof value !== "object") return [stringifyToolArguments(value)];

  const record = value as Record<string, unknown>;
  const queryParts: string[] = [];
  for (const key of ["search_query", "image_query"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const entryRecord = entry as Record<string, unknown>;
      const query = entryRecord.q;
      if (typeof query !== "string" || !query.trim()) continue;

      const domainText = externalSearchDomainsText(entryRecord.domains);
      queryParts.push(domainText ? `${query} ${domainText}` : query);
    }
  }

  if (queryParts.length > 0) {
    const domainText = externalSearchDomainsText(record.domains);
    return domainText
      ? queryParts.map((query) => `${query} ${domainText}`)
      : queryParts;
  }

  return [extractExternalQueryArgument(value)];
}

function externalSearchDomainsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((domain): domain is string => typeof domain === "string")
    .map((domain) => domain.trim())
    .filter(Boolean)
    .join(" ");
}

function commandVerificationTargetsFromText(text: string): string[] {
  const targets = new Set<string>();
  if (/\b(?:checks?|ci|github actions?|verification|validation|preflight|postflight)\b/i.test(text)) {
    targets.add("check");
  }
  if (/\b(?:tests?|test suite|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|bun\s+test|node\s+--test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test|(?:make|just|task)\s+test)\b/i.test(text)) {
    targets.add("test");
  }
  if (/\b(?:lint|npm\s+run\s+lint|pnpm\s+lint|yarn\s+lint|bun\s+lint|(?:make|just|task)\s+lint)\b/i.test(text)) {
    targets.add("lint");
  }
  if (/\b(?:typecheck|type check|tsc|npm\s+run\s+typecheck|pnpm\s+typecheck|yarn\s+typecheck|(?:make|just|task)\s+typecheck)\b/i.test(text)) {
    targets.add("typecheck");
  }
  if (/\b(?:build|npm\s+run\s+build|pnpm\s+build|yarn\s+build|bun\s+build|(?:make|just|task)\s+build)\b/i.test(text)) {
    targets.add("build");
  }
  return [...targets];
}

const COMMAND_LITERAL_START_REGEX =
  /^(?:npm|pnpm|yarn|bun|node|npx|pytest|cargo|go|make|just|task|uv|python3?|pipx?|tsc|eslint|biome|vitest|jest|deno|docker(?:\s+compose)?|gh)\b/i;
const COMMAND_LITERAL_START_PATTERN =
  "(?:npm|pnpm|yarn|bun|node|npx|pytest|cargo|go|make|just|task|uv|python3?|pipx?|tsc|eslint|biome|vitest|jest|deno|docker(?:\\s+compose)?|gh)";

function normalizeCommandTarget(command: string): string {
  return command
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/[.!?;:,)\]]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeNarrativeCommandTarget(command: string): string {
  return normalizeCommandTarget(command)
    .replace(/\s+(?:before|after)\s+(?:finalizing|responding|answering|continuing|that|i\b|we\b|the\b).*$/i, "")
    .replace(/\s+(?:and\s+then|then)\s+.*$/i, "")
    .replace(/\s+and\s+(?:it|i\b|we\b|the\s+command)\s+.*$/i, "")
    .replace(/\s+to\s+(?:confirm|verify|validate|check|see|make\s+sure)\b.*$/i, "")
    .replace(/\s+(?:successfully|cleanly|without\s+errors?|and\s+(?:it\s+)?(?:passed|succeeded|was\s+green))$/i, "")
    .trim();
}

function narrativeCommandTargets(command: string): string[] {
  const normalized = normalizeNarrativeCommandTarget(command);
  const commandStart = new RegExp(`\\s+and\\s+(?=${COMMAND_LITERAL_START_PATTERN}\\b)`, "i");
  return normalized
    .split(commandStart)
    .map((part) => part.trim())
    .filter((part) => COMMAND_LITERAL_START_REGEX.test(part));
}

function commandLiteralTargetsFromText(text: string): string[] {
  const targets = new Set<string>();

  for (const match of text.matchAll(/`([^`\n]{2,160})`/g)) {
    const command = normalizeCommandTarget(match[1] ?? "");
    if (COMMAND_LITERAL_START_REGEX.test(command)) {
      targets.add(`command:${command}`);
    }
  }

  for (const match of text.matchAll(
    /\b(?:ran|executed|run|execute|running|executing)\s+(?:the\s+)?(?:command\s+)?((?:npm|pnpm|yarn|bun|node|npx|pytest|cargo|go|make|just|task|uv|python3?|pipx?|tsc|eslint|biome|vitest|jest|deno|docker(?:\s+compose)?|gh)\b[^\n.;,]*)/gi,
  )) {
    for (const command of narrativeCommandTargets(match[1] ?? "")) {
      targets.add(`command:${command}`);
    }
  }

  return [...targets];
}

function commandSegments(command: string): string[] {
  return normalizeCommandTarget(command)
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function commandContainsNonExecutionFlag(command: string): boolean {
  const normalizedCommand = command
    .replace(/(?:^|\s)--watch(?:=|\s+)false(?:\s|$)/gi, " ")
    .replace(/(?:^|\s)--no-watch(?:\s|$)/gi, " ");
  return /(?:^|\s)(?:--help|-h|help|--version|version|--watch(?:All)?|watch|--list(?:Tests)?|--collect-only|--dry-run)(?:[=\s]|$)/i.test(
    normalizedCommand,
  );
}

function commandAddsDryRunMode(command: string, target: string): boolean {
  return /\s--dry-run(?:[=\s]|$)/i.test(command) && !/\s--dry-run(?:[=\s]|$)/i.test(target);
}

function commandIsNonExecutionVerification(command: string): boolean {
  return commandLooksLikeVerification(command) && commandContainsNonExecutionFlag(command);
}

function commandMatchesVerificationTarget(command: string, target: string): boolean {
  if (target.startsWith("command:")) {
    const normalizedCommand = normalizeCommandTarget(command);
    const normalizedTarget = normalizeCommandTarget(target.slice("command:".length));
    if (
      commandContainsNonExecutionFlag(normalizedCommand) ||
      commandAddsDryRunMode(normalizedCommand, normalizedTarget)
    ) {
      return normalizedCommand === normalizedTarget;
    }
    const segments = commandSegments(command);
    return (
      normalizedCommand === normalizedTarget ||
      normalizedCommand.startsWith(`${normalizedTarget} `) ||
      segments.some(
        (segment) =>
          segment === normalizedTarget || segment.startsWith(`${normalizedTarget} `),
      )
    );
  }

  switch (target) {
    case "test":
      return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)|\bnode\s+--test\b|\bpytest\b|\bpython3?\s+-m\s+pytest\b|\buv\s+run\s+pytest\b|\bcargo\s+test\b|\bgo\s+test\b|\b(?:make|just|task)\s+test\b/i.test(
        command,
      );
    case "lint":
      return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)|\bbiome\s+lint\b|\beslint\b|\b(?:make|just|task)\s+lint\b/i.test(
        command,
      );
    case "typecheck":
      return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck(?:\s|$)|\btsc\b|\b(?:make|just|task)\s+typecheck\b/i.test(
        command,
      );
    case "build":
      return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)|\bcargo\s+build\b|\bgo\s+build\b|\b(?:make|just|task)\s+build\b/i.test(
        command,
      );
    case "check":
      return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate|preflight|postflight)\b|\b(?:make|just|task)\s+(?:check|verify|validate|preflight|postflight)\b|\bcargo\s+check\b|\bgh\s+(?:pr\s+checks|run\s+view)\b/i.test(
        command,
      );
    default:
      return false;
  }
}

function commandLooksLikeVerification(command: string): boolean {
  return (
    commandMatchesVerificationTarget(command, "test") ||
    commandMatchesVerificationTarget(command, "lint") ||
    commandMatchesVerificationTarget(command, "typecheck") ||
    commandMatchesVerificationTarget(command, "build") ||
    commandMatchesVerificationTarget(command, "check")
  );
}

function verificationCommandIsFollowedBySemicolon(command: string): boolean {
  return /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight)|node\s+--test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+(?:test|build|check)|go\s+(?:test|build)|biome\s+lint|eslint|tsc|(?:make|just|task)\s+(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight))\b[^;&|]*;\s*(?!exit\s+\$?\?|\s*$)/i.test(
    command,
  );
}

function verificationCommandIsFollowedBySyntheticSuccess(command: string): boolean {
  return /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight)|node\s+--test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+(?:test|build|check)|go\s+(?:test|build)|biome\s+lint|eslint|tsc|(?:make|just|task)\s+(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight))\b[^;&|]*(?:&&|\band\b)\s*(?:echo|printf)\b/i.test(
    command,
  );
}

function commandMasksVerificationFailure(command: string): boolean {
  return (
    commandIsNonExecutionVerification(command) ||
    /(?:^|[;&])\s*set\s+\+e\b/i.test(command) ||
    /\|\|\s*(?!exit\s+[1-9]\d*\b)/i.test(command) ||
    /(?:;|&&)\s*(?:true|:|exit\s+0)\s*$/i.test(command) ||
    verificationCommandIsFollowedBySemicolon(command) ||
    verificationCommandIsFollowedBySyntheticSuccess(command) ||
    /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight)|node\s+--test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+(?:test|build|check)|go\s+(?:test|build)|biome\s+lint|eslint|tsc|(?:make|just|task)\s+(?:test|lint|typecheck|build|check|verify|validate|preflight|postflight))\b[\s\S]*\|(?!\|)/i.test(
      command,
    )
  );
}

function toolFailureTextMatches(text: string): boolean {
  const normalized = text
    .replace(/\\[nr]/g, " ")
    .replace(/\b0\s+(?:\w+\s+){0,2}(?:errors?|failed|failing|failures?|fails?)\b/gi, "")
    .replace(/\b(?:errors?|failed|failing|failures?|fails?|fail)\s*[:=]?\s*0\b/gi, "");
  return TOOL_FAILURE_TEXT_REGEX.test(normalized);
}

function valueIsEmptyEvidence(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return false;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return true;
  return entries.every(([, entryValue]) => valueIsEmptyEvidence(entryValue));
}

function structuredToolResultHasNoUsableContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }

  return structuredValueHasNoUsableContent(parsed);
}

function structuredValueHasNoUsableContent(value: unknown): boolean {
  if (valueIsEmptyEvidence(value)) return true;
  if (!value || typeof value !== "object") return false;

  if (Array.isArray(value)) {
    return value.length === 0 || value.every(structuredValueHasNoUsableContent);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return true;
  if (
    entries.every(([key, entryValue]) =>
      structuredResultEntryIsMetadataOnlyOrEmpty(key, entryValue),
    )
  ) {
    return true;
  }

  return entries.some(
    ([key, entryValue]) =>
      EMPTY_EVIDENCE_RESULT_KEYS.has(key.toLowerCase()) &&
      structuredValueHasNoUsableContent(entryValue),
  );
}

function structuredResultEntryIsMetadataOnlyOrEmpty(
  key: string,
  value: unknown,
): boolean {
  const normalizedKey = key.toLowerCase();
  if (structuredValueHasNoUsableContent(value)) return true;
  if (!METADATA_ONLY_RESULT_KEYS.has(normalizedKey)) return false;
  return true;
}

function toolResultSucceeded(message: AgentEndEventMessage | undefined): boolean {
  if (!message || message.role !== "toolResult") return false;
  const text = extractMessageText(message.content);
  return (
    !toolFailureTextMatches(text) &&
    !TOOL_NO_USABLE_RESULT_REGEX.test(text) &&
    !TOOL_ZERO_EXECUTION_RESULT_REGEX.test(text) &&
    !structuredToolResultHasNoUsableContent(text)
  );
}

function toolResultHasSubstantiveEvidence(
  message: AgentEndEventMessage | undefined,
): boolean {
  if (!toolResultSucceeded(message)) return false;
  return !GENERIC_ACK_RESULT_REGEX.test(extractMessageText(message.content));
}

function toolResultHasLearningStorageSuccess(
  message: AgentEndEventMessage | undefined,
): boolean {
  if (!toolResultSucceeded(message)) return false;
  if (LEARNING_STORAGE_NEGATION_REGEX.test(extractMessageText(message.content))) {
    return false;
  }
  return /\b(?:stored|saved|recorded|persisted|learned)\b/i.test(
    extractMessageText(message.content),
  );
}

function memorySearchToolResultHasSubstantiveEvidence(
  message: AgentEndEventMessage | undefined,
): boolean {
  if (!toolResultHasSubstantiveEvidence(message)) return false;
  const terms =
    extractMessageText(message?.content ?? [])
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]*/g) ?? [];
  if (terms.length === 0) return false;
  return terms.some((term) => !GENERIC_MEMORY_SEARCH_RESULT_TERMS.has(term));
}

function concreteEscalationTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
        ?.map((term) => term.replace(/(?:es|s)$/i, ""))
        ?.filter(
          (term) =>
            !GENERIC_ESCALATION_TERMS.has(term) &&
            !toolFailureTextMatches(term) &&
            !KNOWLEDGE_GAP_REGEX.test(term),
        ) ?? [],
    ),
  ];
}

function escalationConcreteTargetTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
        ?.filter((term) => {
          if (GENERIC_ESCALATION_TERMS.has(term)) return false;
          if (term === "api") return true;
          return !GENERIC_EXTERNAL_QUERY_TERMS.has(term);
        }) ?? [],
    ),
  ];
}

function advisoryResultSucceeded(
  message: AgentEndEventMessage | undefined,
  focusText = "",
): boolean {
  if (!toolResultSucceeded(message)) return false;

  const text = extractMessageText(message?.content ?? []).trim();
  if (text.split(/\s+/).filter(Boolean).length < 4) return false;
  if (hasKnowledgeGapSignal(text)) return false;
  if (HEDGED_RESULT_REGEX.test(text)) return false;

  if (
    !/\b(?:verified|resolved|confirmed|recommend(?:ed|s|ation)?|because|evidence|source|root cause|answer|found|fix(?:ed)?|explained)\b/i.test(
      text,
    )
  ) {
    return false;
  }

  const focusTerms = concreteEscalationTerms(focusText);
  if (focusTerms.length === 0) return true;

  const resultTerms = new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
      ?.map((term) => term.replace(/(?:es|s)$/i, "")) ?? [],
  );
  const matchedTerms = focusTerms.filter((term) => resultTerms.has(term));
  const requiredMatches = Math.min(2, focusTerms.length);
  return matchedTerms.length >= requiredMatches;
}

function toolCallRequiresMemorySearchBeforeMutation(item: ToolCallContent): boolean {
  if (typeof item.name !== "string") return false;
  const metadata = getToolMetadata({
    toolName: item.name,
    input: item.arguments,
  });
  return (
    metadata.memoryRefreshRequirement === "required_before_mutation" &&
    metadata.mutationClass !== "none"
  );
}

function toolMetadataForCall(name: string, args: unknown) {
  return getToolMetadata({ toolName: name, input: args });
}

function toolCallIsLocalEvidence(name: string, args: unknown): boolean {
  return isLocalEvidenceToolCall({ toolName: name, input: args });
}

function toolCallIsExternalEvidence(name: string, args: unknown): boolean {
  return isExternalEvidenceToolCall({ toolName: name, input: args });
}

function toolCallIsCommandEvidence(name: string, args: unknown): boolean {
  if (isCommandExecutionToolName(name)) return true;
  return toolMetadataForCall(name, args).sideEffectClass === "shell";
}

function toolCallIsMutationEvidence(name: string, args: unknown): boolean {
  return isMutationToolCall({ toolName: name, input: args });
}

function toolCallIsEvidence(name: string, args: unknown): boolean {
  return isEvidenceToolCall({ toolName: name, input: args });
}

function sedPrintRangeIsUnbounded(command: string): boolean {
  if (!/\bsed\s+-n\b/i.test(command)) return false;

  const printRangeMatches = command.matchAll(
    /(?:^|[\s;|&])(?:sed\s+-n\s+)?["']?(\d+)(?:,(\d+|\$))?p["']?/gi,
  );
  for (const match of printRangeMatches) {
    const start = Number(match[1]);
    const rawEnd = match[2];
    if (!Number.isFinite(start)) continue;
    if (!rawEnd || rawEnd === "$") return true;

    const end = Number(rawEnd);
    if (!Number.isFinite(end)) return true;
    if (end - start + 1 > MAX_BOUNDED_EVIDENCE_LINES) return true;
  }

  return false;
}

function headTailLineLimitIsExcessive(command: string): boolean {
  const lineLimitMatches = command.matchAll(
    /\b(?:head|tail)\b(?:\s+-n)?\s+-(\d+)\b|\b(?:head|tail)\b(?:\s+-n|\s+--lines(?:=|\s+))\s*(\d+)\b/gi,
  );

  for (const match of lineLimitMatches) {
    const rawLimit = match[1] ?? match[2];
    const limit = Number(rawLimit);
    if (Number.isFinite(limit) && limit > MAX_BOUNDED_EVIDENCE_LINES) {
      return true;
    }
  }

  return false;
}

function grepMatchLimitIsExcessive(command: string): boolean {
  if (!/\b(?:grep|rg)\b/i.test(command)) return false;

  const limitMatches = command.matchAll(
    /(?:\s-m\s*(\d+)\b|--max-count(?:=|\s+)(\d+)\b|\|\s*head(?:\s+-n)?\s+-?(\d+)\b)/gi,
  );
  for (const match of limitMatches) {
    const rawLimit = match[1] ?? match[2] ?? match[3];
    const limit = Number(rawLimit);
    if (Number.isFinite(limit) && limit > MAX_BOUNDED_EVIDENCE_LINES) {
      return true;
    }
  }

  return false;
}

function rgSearchIsUnbounded(command: string): boolean {
  if (!/\brg\b/i.test(command)) return false;
  if (/\brg\b[\s\S]*--files(?![-\w])/i.test(command)) return false;
  if (BOUNDED_GREP_REGEX.test(command)) return false;

  const words = shellWords(command);
  const rgIndex = words.indexOf("rg");
  if (rgIndex < 0) return false;

  let patternSeen = false;
  let patternProvidedByOption = false;
  let hasPathOrGlobScope = false;
  const paths: string[] = [];

  for (let index = rgIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;

    if (/^(?:-g|--glob)(?:=.+|$)/.test(word)) {
      hasPathOrGlobScope = true;
      if (!word.includes("=")) index += 1;
      continue;
    }

    if (/^(?:-e|--regexp)(?:=.+|$)/.test(word)) {
      patternProvidedByOption = true;
      if (!word.includes("=")) index += 1;
      continue;
    }

    if (
      /^(?:-t|-T|--type|--type-not|--type-add|-A|-B|-C|--after-context|--before-context|--context|--sort|--sortr)(?:=.+|$)/.test(
        word,
      )
    ) {
      if (!word.includes("=") && /^--|^-[tTABC]$/.test(word)) index += 1;
      continue;
    }

    if (word === "--") continue;
    if (/^-/.test(word)) continue;

    if (patternProvidedByOption || patternSeen) {
      paths.push(word);
      continue;
    }

    patternSeen = true;
  }

  if (paths.some((path) => path === "." || path === "/" || path === "~")) {
    return true;
  }

  return paths.length === 0 && !hasPathOrGlobScope;
}

function rgFilesListingIsUnbounded(command: string): boolean {
  if (!/\brg\b[\s\S]*--files(?![-\w])/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command)) return false;
  if (/(?:^|\s)(?:-g|--glob)(?:=|\s+)\S+/i.test(command)) return false;

  const targetMatch = command.match(/--files(?![-\w])\s+([^\s|;&]+)/i);
  if (!targetMatch) return true;

  const target = targetMatch[1].replace(/^["']|["']$/g, "");
  return target === "." || target === "/" || target === "~";
}

function jqOutputIsUnbounded(command: string): boolean {
  if (!/\bjq\b/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command)) return false;

  const words = shellWords(command);
  const jqIndex = words.indexOf("jq");
  if (jqIndex < 0) return false;

  const optionsWithValue = new Set([
    "-f",
    "--from-file",
    "--arg",
    "--argjson",
    "--slurpfile",
    "--rawfile",
    "--args",
    "--jsonargs",
  ]);
  const optionsWithoutValue = new Set([
    "-c",
    "--compact-output",
    "-r",
    "--raw-output",
    "-e",
    "--exit-status",
    "-s",
    "--slurp",
    "-M",
    "--monochrome-output",
    "-S",
    "--sort-keys",
  ]);

  let filter = "";
  for (let index = jqIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;
    if (optionsWithValue.has(word)) {
      index += 1;
      continue;
    }
    if (optionsWithoutValue.has(word) || /^--indent\b/.test(word)) continue;
    if (/^-/.test(word)) continue;
    filter = word;
    break;
  }

  return /^(?:\.|\.\[\]|\.\.)(?:$|[|,])/.test(filter.trim());
}

function vcsPatchOutputIsUnbounded(command: string): boolean {
  if (!/\b(?:git\s+(?:diff|show))\b/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command)) return false;
  if (/(?:^|\s)(?:-p|--patch)(?:\s|$)/i.test(command)) return true;
  return !/\s--(?:stat|shortstat|numstat|name-only|name-status|summary)\b/i.test(
    command,
  );
}

function vcsHistoryOutputIsUnbounded(command: string): boolean {
  if (!/\bgit\s+(?:log|reflog)\b/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command)) return false;
  return !/(?:^|\s)(?:-\d+\b|-n\s*\d+\b|--max-count(?:=|\s+)\d+\b)/i.test(
    command,
  );
}

function gitGrepIsUnbounded(command: string): boolean {
  if (!/\bgit\s+grep\b/i.test(command)) return false;
  if (BOUNDED_GREP_REGEX.test(command)) return false;

  const words = shellWords(command);
  const gitIndex = words.indexOf("git");
  if (gitIndex < 0 || words[gitIndex + 1] !== "grep") return false;

  let patternSeen = false;
  let afterPathSeparator = false;
  let hasPathScope = false;
  const optionsWithValue = new Set(["-e", "-f", "--and", "--or", "--not"]);

  for (let index = gitIndex + 2; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;

    if (word === "--") {
      afterPathSeparator = true;
      continue;
    }

    if (!afterPathSeparator && optionsWithValue.has(word)) {
      if (word === "-e") patternSeen = true;
      index += 1;
      continue;
    }

    if (!afterPathSeparator && /^-/.test(word)) continue;

    if (afterPathSeparator || patternSeen) {
      if (word === "." || word === "/" || word === "~") return true;
      hasPathScope = true;
      continue;
    }

    patternSeen = true;
  }

  return !hasPathScope;
}

function gitLsFilesIsUnbounded(command: string): boolean {
  if (!/\bgit\s+ls-files\b/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command) || /\|\s*wc\s+-l\b/i.test(command)) {
    return false;
  }

  const words = shellWords(command);
  const gitIndex = words.indexOf("git");
  const lsFilesIndex = words.indexOf("ls-files", gitIndex + 1);
  if (gitIndex < 0 || lsFilesIndex < 0) return false;

  let afterPathSeparator = false;
  const optionsWithValue = new Set([
    "-x",
    "--exclude",
    "-X",
    "--exclude-from",
    "--exclude-per-directory",
    "--with-tree",
    "--format",
  ]);

  for (let index = lsFilesIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;

    if (word === "--") {
      afterPathSeparator = true;
      continue;
    }

    if (!afterPathSeparator && optionsWithValue.has(word)) {
      index += 1;
      continue;
    }

    if (!afterPathSeparator && /^--format=/.test(word)) continue;
    if (!afterPathSeparator && /^-/.test(word)) continue;

    return word === "." || word === "/" || word === "~";
  }

  return true;
}

function gitLsTreeIsUnbounded(command: string): boolean {
  if (!/\bgit\s+ls-tree\b/i.test(command)) return false;
  if (BOUNDED_PIPE_REGEX.test(command) || /\|\s*wc\s+-l\b/i.test(command)) {
    return false;
  }

  const words = shellWords(command);
  const gitIndex = words.indexOf("git");
  const lsTreeIndex = words.indexOf("ls-tree", gitIndex + 1);
  if (gitIndex < 0 || lsTreeIndex < 0) return false;

  let recursive = false;
  let treeishSeen = false;
  let afterPathSeparator = false;
  const optionsWithValue = new Set(["--format", "--abbrev"]);

  for (let index = lsTreeIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;

    if (word === "--") {
      afterPathSeparator = true;
      continue;
    }

    if (!afterPathSeparator && optionsWithValue.has(word)) {
      index += 1;
      continue;
    }

    if (!afterPathSeparator && /^--format=|^--abbrev=/.test(word)) continue;

    if (!afterPathSeparator && /^-/.test(word)) {
      if (word === "--recursive" || /^-[A-Za-z]*r[A-Za-z]*$/.test(word)) {
        recursive = true;
      }
      continue;
    }

    if (afterPathSeparator || treeishSeen) {
      return recursive && (word === "." || word === "/" || word === "~");
    }

    treeishSeen = true;
  }

  return recursive;
}


function watchModeCommandIsUnbounded(command: string): boolean {
  if (/(?:^|\s)(?:--watch(?:=|\s+)?false|--no-watch)\b/i.test(command)) {
    return false;
  }

  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+\b[\s\S]*(?:--\s*)?--watch\b/i.test(
      command,
    ) ||
    /\b(?:jest|vitest|tsc|node|cargo)\b[\s\S]*\b(?:--watch|watch)\b/i.test(
      command,
    ) ||
    /\b(?:cargo\s+watch|watchexec|nodemon)\b/i.test(command) ||
    /\btail\b[\s\S]*(?:\s-f\b|--follow)\b/i.test(command)
  );
}

function networkFetchCommandMissingTimeout(command: string): boolean {
  if (!/\b(?:curl|wget|https?)\b[\s\S]*https?:\/\//i.test(command)) return false;

  const words = shellWords(command);
  if (
    /^(?:timeout|gtimeout)$/.test(words[0] ?? "") &&
    /^[0-9]+[smhd]?$/.test(words[1] ?? "")
  ) {
    return false;
  }

  const fetchIndex = words.findIndex((word) =>
    /^(?:curl|wget|https?)$/.test(word),
  );
  if (fetchIndex < 0) return false;
  const fetchCommand = words[fetchIndex];

  for (let index = fetchIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;

    if (fetchCommand === "curl") {
      if (/^(?:--max-time|--connect-timeout)=\d+/.test(word)) return false;
      if (/^(?:-m|--max-time|--connect-timeout)$/.test(word)) {
        return !/^\d+/.test(words[index + 1] ?? "");
      }
      continue;
    }

    if (/^(?:--timeout|--dns-timeout|--connect-timeout|--read-timeout)=\d+/.test(word)) {
      return false;
    }
    if (/^(?:-T|--timeout|--dns-timeout|--connect-timeout|--read-timeout)$/.test(word)) {
      return !/^\d+/.test(words[index + 1] ?? "");
    }
  }

  return true;
}

function scriptedNetworkFetchCommandMissingTimeout(command: string): boolean {
  if (!/\b(?:python3?|node)\b[\s\S]*https?:\/\//i.test(command)) return false;

  const words = shellWords(command);
  if (
    /^(?:timeout|gtimeout)$/.test(words[0] ?? "") &&
    /^[0-9]+[smhd]?$/.test(words[1] ?? "")
  ) {
    return false;
  }

  if (
    /\b(?:timeout\s*=|timeout=|AbortSignal\.timeout|signal\s*:|setTimeout\s*\()\b/i.test(
      command,
    )
  ) {
    return false;
  }

  if (
    /\bpython3?\b[\s\S]*\b(?:requests\.(?:get|post|put|patch|delete|head)|urllib\.request\.urlopen|httpx\.(?:get|post|put|patch|delete|head)|aiohttp\.ClientSession)\b/i.test(
      command,
    )
  ) {
    return true;
  }

  return /\bnode\b[\s\S]*\b(?:fetch\s*\(|https?\.get\s*\(|https?\.request\s*\()/i.test(
    command,
  );
}

function repoSummaryCommandIsUnbounded(command: string): boolean {
  if (
    /\btree\b[\s\S]*(?:\s\.|\s\/|\s~)(?:\s|$)/i.test(command) &&
    !/(?:^|\s)-L\s+\d+\b|\|\s*head\b/i.test(command)
  ) {
    return true;
  }

  if (
    /\bdu\b[\s\S]*(?:\s\.|\s\/|\s~)(?:\s|$)/i.test(command) &&
    !/(?:^|\s)-s[a-zA-Z]*\b|(?:^|\s)-[a-zA-Z]*s[a-zA-Z]*\b|--summarize\b|\|\s*head\b/i.test(
      command,
    )
  ) {
    return true;
  }

  return false;
}

function wordsHaveNumericOption(words: string[], option: string): boolean {
  return words.some((word, index) => {
    if (word === option) return /^\d+$/.test(words[index + 1] ?? "");
    return new RegExp(`^${escapeRegExp(option)}=\\d+$`).test(word);
  });
}

function broadListingCommandIsUnbounded(command: string): string | null {
  if (BOUNDED_PIPE_REGEX.test(command)) return null;

  const words = shellWords(command);
  const firstCommand = words.find((word) => !/^\w+=/.test(word));
  if (!firstCommand) return null;

  if (/^(?:env|printenv)$/.test(firstCommand)) {
    return words.length <= 1 || firstCommand === "env"
      ? "unbounded environment listing command"
      : null;
  }

  if (
    firstCommand === "ps" &&
    words.slice(1).some((word) => /^(?:aux|-ef|-eF|-ely)$/.test(word))
  ) {
    return "unbounded process listing command";
  }

  if (
    /^(?:npm|pnpm|yarn|bun)$/.test(firstCommand) &&
    /^(?:list|ls)$/.test(words[1] ?? "") &&
    !words.some((word) => /^--depth(?:=0)?$/.test(word))
  ) {
    return "unbounded dependency listing command";
  }

  if (
    /^(?:pip|pip3)$/.test(firstCommand) &&
    /^(?:list|freeze)$/.test(words[1] ?? "")
  ) {
    return "unbounded dependency listing command";
  }

  if (firstCommand === "cargo" && words[1] === "tree") {
    return "unbounded dependency listing command";
  }

  if (
    /^(?:docker|podman)$/.test(firstCommand) &&
    /^(?:ps|images)$/.test(words[1] ?? "")
  ) {
    return "unbounded container listing command";
  }

  if (
    /^(?:docker|podman)$/.test(firstCommand) &&
    words[1] === "logs" &&
    !wordsHaveNumericOption(words, "--tail")
  ) {
    return "unbounded container log command";
  }

  if (
    firstCommand === "kubectl" &&
    words[1] === "get" &&
    words.some((word) => /^(?:-A|--all-namespaces)$/.test(word))
  ) {
    return "unbounded cluster listing command";
  }

  if (
    firstCommand === "kubectl" &&
    words[1] === "logs" &&
    !wordsHaveNumericOption(words, "--tail")
  ) {
    return "unbounded cluster log command";
  }

  if (
    firstCommand === "helm" &&
    words[1] === "list" &&
    words.some((word) => /^(?:-A|--all-namespaces)$/.test(word))
  ) {
    return "unbounded cluster listing command";
  }

  return null;
}

function findCommandIsUnbounded(command: string): boolean {
  if (!/\bfind\s+(?!-)[^;&|]+/i.test(command)) {
    return false;
  }
  if (/(?:\s-print\s+-quit|\|\s*(?:head|sed\s+-n))\b/i.test(command)) {
    return false;
  }

  const maxDepthMatch = command.match(/\s-maxdepth\s+(\d+)\b/i);
  if (!maxDepthMatch) return true;

  const maxDepth = Number(maxDepthMatch[1]);
  if (!Number.isFinite(maxDepth) || maxDepth > 3) return true;

  return !/\s(?:-name|-iname|-path|-ipath|-regex)\s+\S+/i.test(command);
}

function fdCommandIsUnbounded(command: string): boolean {
  if (BOUNDED_PIPE_REGEX.test(command)) return false;

  const words = shellWords(command);
  const fdIndex = words.findIndex((word) => /^(?:fd|fdfind)$/.test(word));
  if (fdIndex < 0) return false;

  if (
    words.some((word, index) => {
      if (/^--max-results=\d+$/.test(word)) return true;
      return word === "--max-results" && /^\d+$/.test(words[index + 1] ?? "");
    })
  ) {
    return false;
  }

  const optionsWithValue = new Set([
    "-E",
    "-e",
    "-g",
    "-x",
    "-X",
    "--base-directory",
    "--changed-before",
    "--changed-within",
    "--exclude",
    "--extension",
    "--glob",
    "--exec",
    "--exec-batch",
    "--type",
  ]);
  const positionals: string[] = [];
  for (let index = fdIndex + 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word || /^(?:\||;|&&|\|\|)$/.test(word)) break;
    if (word === "--") continue;
    if (optionsWithValue.has(word)) {
      index += 1;
      continue;
    }
    if (/^--(?:base-directory|changed-before|changed-within|exclude|extension|glob|max-depth|type)=/.test(word)) {
      continue;
    }
    if (/^-/.test(word)) continue;
    positionals.push(word);
  }

  if (positionals.length === 0) return true;
  return positionals[0] === "." || positionals[0] === "/" || positionals[0] === "~";
}

function xargsEvidenceFanoutIsUnbounded(command: string): boolean {
  if (!/\|\s*xargs\b/i.test(command)) return false;
  if (!/\|\s*xargs\b[\s\S]*\b(?:cat|nl|bat|batcat|less|more|sed\s+-n|grep|rg)\b/i.test(command)) {
    return false;
  }

  const afterXargs = command.split(/\|\s*xargs\b/i).at(-1) ?? "";
  return !BOUNDED_PIPE_REGEX.test(afterXargs);
}

function commandSubstitutionEvidenceFanoutIsUnbounded(command: string): boolean {
  const substitutions = [
    ...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g),
  ].map((match) => match[1] ?? match[2] ?? "");

  if (substitutions.length === 0) return false;

  const outerCommand = command.replace(/\$\([^()]*\)|`[^`]*`/g, " ");
  if (!/\b(?:cat|nl|bat|batcat|less|more|sed\s+-n|head|tail|grep|rg)\b/i.test(outerCommand)) {
    return false;
  }

  return substitutions.some((substitution) => {
    if (BOUNDED_PIPE_REGEX.test(substitution)) return false;
    if (/\brg\b[\s\S]*--files(?![-\w])/i.test(substitution)) return true;
    if (/\bfind\s+(?!-)[^;&|]+/i.test(substitution)) {
      return !/\s-print\s+-quit\b/i.test(substitution);
    }
    if (/\b(?:fd|fdfind)\b/i.test(substitution)) {
      return !/\b--max-results(?:=|\s+)\d+\b/i.test(substitution);
    }
    return /\bgit\s+ls-files\b/i.test(substitution);
  });
}

function scriptedFileDumpIsUnbounded(command: string): boolean {
  if (BOUNDED_PIPE_REGEX.test(command)) return false;

  if (
    /\bawk\b[\s\S]*(?:(?:^|\s)(?:'1'|"1"|1)\s+\S+|['"]\s*\{\s*print(?:\s+\$0)?\s*;?\s*\}\s*['"]\s+\S+)/i.test(
      command,
    )
  ) {
    return true;
  }

  if (
    /\bperl\b[\s\S]*-[\w-]*n[\w-]*e\b[\s\S]*['"]?\s*print(?:\s+\$_)?\s*;?\s*['"]?\s+\S+/i.test(
      command,
    )
  ) {
    return true;
  }

  if (
    /\bpython3?\b[\s\S]*\bprint\s*\(\s*(?:open\s*\([^)]*\)\.read\s*\(\s*\)|Path\s*\([^)]*\)\.read_text\s*\(\s*\))/i.test(
      command,
    )
  ) {
    return true;
  }

  return /\b(?:node|bun|deno)\b[\s\S]*\b(?:console\.log|process\.stdout\.write)\s*\([\s\S]*(?:readFileSync\s*\(|Deno\.readTextFileSync\s*\()/i.test(
    command,
  );
}

function isLocalShellEvidenceCommand(command: string): boolean {
  return /\b(?:cat|nl|bat|batcat|less|more|sed\s+-n|grep|rg|fd|fdfind|find|ls|tree|du|head|tail|git\s+(?:diff|show|log|reflog))\b/i.test(command);
}

function localArtifactTargetsFromToolArguments(args: unknown): string[] {
  const targets = new Set<string>();

  function visit(value: unknown): void {
    if (typeof value === "string") {
      for (const target of localArtifactTargetsFromText(value)) {
        targets.add(target);
      }
      return;
    }

    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["path", "file", "filepath", "filename", "cwd"]) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        for (const target of localArtifactTargetsFromText(candidate)) {
          targets.add(target);
        }
      }
    }
    for (const key of ["paths", "files"]) {
      const candidates = record[key];
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) visit(candidate);
      }
    }
  }

  visit(args);
  return [...targets];
}

function localEvidenceDedupeTargets(
  name: string,
  args: unknown,
): Array<{ key: string; label: string }> {
  if (!toolCallIsLocalEvidence(name, args)) return [];
  if (isKhalaMemoryToolName(name)) return [];

  if (name === "bash") {
    const command = extractCommandArgument(args);
    if (!isLocalShellEvidenceCommand(command)) return [];
  }

  const targets =
    name === "bash"
      ? localArtifactTargetsFromText(extractCommandArgument(args))
      : localArtifactTargetsFromToolArguments(args);

  return targets.map((target) => ({
    key: normalizeLocalArtifactDedupeKey(target),
    label: target,
  }));
}

function normalizeLocalArtifactDedupeKey(target: string): string {
  const normalized = target
    .trim()
    .replaceAll("\\", "/")
    .replace(/^["'`]+|["'`.,:;!?)]$/g, "");
  const isAbsolute = normalized.startsWith("/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return `${isAbsolute ? "/" : ""}${parts.join("/")}`.toLowerCase();
}

function deleteSeenToolEntries(seen: Set<string>, toolName: string): void {
  for (const key of [...seen]) {
    if (key.startsWith(`${toolName}:`)) seen.delete(key);
  }
}

function canonicalMemorySearchQuery(args: unknown): {
  key: string;
  label: string;
} | null {
  const query = extractQueryArgument(args).trim();
  if (!query) return null;

  const terms =
    query
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.:/-]{1,}/g)
      ?.filter((term) => !GENERIC_MEMORY_QUERY_TERMS.has(term))
      .map((term) => MEMORY_QUERY_TERM_ALIASES.get(term) ?? term) ?? [];
  const labelTerms =
    query
      .match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,}/g)
      ?.filter((term) => !GENERIC_MEMORY_QUERY_TERMS.has(term.toLowerCase())) ??
    [];
  const canonicalTerms = [...new Set(terms)].sort();
  if (canonicalTerms.length < 2) return null;

  return {
    key: canonicalTerms.join(" "),
    label: [...new Set(labelTerms)].join(" "),
  };
}

function normalizedMemoryTaskTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.:-]{1,}/g)) {
    const raw = (match[0] ?? "").replace(/[.,:;!?)]$/g, "");
    const normalized = normalizeMemoryTaskTerm(raw);
    if (normalized.length < 2 || GENERIC_MEMORY_TASK_TERMS.has(normalized)) {
      continue;
    }
    terms.add(normalized);

    const fileStem = normalized.match(/^([a-z0-9_-]{2,})\.[a-z0-9]+$/)?.[1];
    if (fileStem && !GENERIC_MEMORY_TASK_TERMS.has(fileStem)) {
      terms.add(fileStem);
    }
  }
  return [...terms];
}

function memorySearchArgumentsMatchTask(args: unknown, userText = ""): boolean {
  const taskTerms = normalizedMemoryTaskConcepts(userText);
  if (taskTerms.length === 0) return true;

  const queryTerms = new Set(
    normalizedMemoryTaskConcepts(extractQueryArgument(args)),
  );
  const criticalTerms = memoryCriticalTaskTerms(userText);
  if (criticalTerms.some((term) => !queryTerms.has(term))) return false;

  const matchedTerms = taskTerms.filter((term) => queryTerms.has(term));
  return matchedTerms.length >= Math.min(2, taskTerms.length);
}

function memoryCriticalTaskTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const match of text.matchAll(
    /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[a-z0-9:_-]+|npx\s+[a-z0-9:_-]+(?:\s+(?:run|test|build|check|lint))?|node\s+--test|vitest(?:\s+run)?|jest|pytest|cargo\s+(?:test|build|check)|go\s+(?:test|build)|make\s+[a-z0-9:_-]+|just\s+[a-z0-9:_-]+|task\s+[a-z0-9:_-]+|uv\s+(?:run|test|sync|lock)|python3?\s+[^\s]+|biome\s+lint|eslint|tsc)\b/gi,
  )) {
    const commandTerms = normalizedMemoryTaskTerms(match[0] ?? "");
    for (const term of commandTerms) terms.add(term);
  }

  for (const match of text.matchAll(
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|ya?ml|toml|lock)\b/g,
  )) {
    const artifact = match[0] ?? "";
    const stem = artifact.match(/^([A-Za-z0-9_-]{2,})\.[A-Za-z0-9]+$/)?.[1];
    const term = normalizeMemoryTaskTerm(stem ?? artifact);
    if (!GENERIC_MEMORY_TASK_TERMS.has(term)) terms.add(term);
  }

  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_.-]{2,}\b/g)) {
    if (match.index === 0) continue;
    const raw = match[0] ?? "";
    const fileStem = raw.match(/^([A-Za-z0-9_-]{2,})\.[A-Za-z0-9]+$/)?.[1];
    const term = normalizeMemoryTaskTerm(fileStem ?? raw);
    if (!GENERIC_MEMORY_TASK_TERMS.has(term)) terms.add(term);
  }

  return [...terms];
}

function normalizedMemoryTaskConcepts(text: string): string[] {
  return [
    ...new Set(
      normalizedMemoryTaskTerms(text).map((term) => {
        const fileStem = term.match(/^([a-z0-9_-]{2,})\.[a-z0-9]+$/)?.[1];
        return fileStem ?? term;
      }),
    ),
  ];
}

function normalizeMemoryTaskTerm(term: string): string {
  const lower = term.toLowerCase();
  return MEMORY_QUERY_TERM_ALIASES.get(lower) ?? lower.replace(/s$/i, "");
}

function canonicalExternalSearchQuery(args: unknown): {
  key: string;
  label: string;
} | null {
  const query = extractExternalQueryArgument(args).trim();
  if (!query) return null;

  const terms =
    query
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.:/-]{1,}/g)
      ?.map((term) => EXTERNAL_QUERY_TERM_ALIASES.get(term) ?? term)
      ?.filter((term) => !GENERIC_EXTERNAL_QUERY_TERMS.has(term)) ?? [];
  const contextTerms =
    query
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.:/-]{1,}/g)
      ?.map((term) => EXTERNAL_QUERY_TERM_ALIASES.get(term) ?? term)
      ?.filter((term) => EXTERNAL_TARGET_CONTEXT_TERMS.has(term)) ?? [];
  const labelTerms =
    query
      .match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,}/g)
      ?.filter((term) => !GENERIC_EXTERNAL_QUERY_TERMS.has(term.toLowerCase())) ??
    [];
  const labelContextTerms =
    query
      .match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,}/g)
      ?.filter((term) => EXTERNAL_TARGET_CONTEXT_TERMS.has(term.toLowerCase())) ??
    [];
  const canonicalTerms = [
    ...new Set(terms.length < 2 ? [...terms, ...contextTerms] : terms),
  ].sort();
  if (
    canonicalTerms.length < 2 &&
    !(
      canonicalTerms.length === 1 &&
      externalEvidenceQueryQuality(query).focused
    )
  ) {
    return null;
  }

  return {
    key: canonicalTerms.join(" "),
    label: [
      ...new Set(
        terms.length < 2 ? [...labelTerms, ...labelContextTerms] : labelTerms,
      ),
    ].join(" "),
  };
}

function canonicalExternalOpenTarget(args: unknown): {
  key: string;
  label: string;
} | null {
  const argsText = stringifyToolArguments(args);
  const url = argsText.match(/https?:\/\/[^\s)"'}]+|github\.com\/[^\s)"'}]+/i)?.[0];
  if (!url) return null;

  const label = normalizeExternalEvidenceUrl(url);
  return {
    key: externalEvidenceUrlKey(url),
    label,
  };
}

function canonicalExternalSearchQueries(
  args: unknown,
): Array<{ key: string; label: string }> {
  return extractExternalQueryArguments(args)
    .map((query) => canonicalExternalSearchQuery(query))
    .filter((query): query is { key: string; label: string } => Boolean(query));
}

function externalEvidenceUrlKey(url: string): string {
  return normalizeExternalEvidenceUrl(url)
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
}

function canonicalExternalOpenTargets(
  args: unknown,
): Array<{ key: string; label: string }> {
  const argsText = stringifyToolArguments(args);
  const urls = argsText.match(/https?:\/\/[^\s)"'}]+|github\.com\/[^\s)"'}]+/gi);
  if (!urls) return [];

  return [...new Set(urls)].map((url) => {
    const label = normalizeExternalEvidenceUrl(url);
    return {
      key: externalEvidenceUrlKey(url),
      label,
    };
  });
}

function normalizeExternalEvidenceUrl(url: string): string {
  const cleanUrl = url.replace(/[.,:;!?)]$/g, "");
  const withScheme = /^github\.com\//i.test(cleanUrl)
    ? `https://${cleanUrl}`
    : cleanUrl;

  try {
    const parsed = new URL(withScheme);
    for (const key of [...parsed.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        /^(?:fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref|ref_src|source)$/i.test(
          key,
        )
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/g, "");
  } catch {
    return cleanUrl.replace(/\/+$/g, "");
  }
}

function externalTargetTermsFromText(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.:/-]{2,}/g)
        ?.filter(
          (term) =>
            !/[./]/.test(term) &&
            (!GENERIC_EXTERNAL_QUERY_TERMS.has(term) ||
              EXTERNAL_TARGET_CONTEXT_TERMS.has(term)) &&
            !EXTERNAL_TARGET_STOP_TERMS.has(term),
        ) ?? [],
    ),
  ];
}

function externalContextTermsFromText(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.:/-]{2,}/g)
        ?.filter((term) => EXTERNAL_TARGET_CONTEXT_TERMS.has(term)) ?? [],
    ),
  ];
}

function externalClaimTokenIsConcrete(token: string): boolean {
  const lowerToken = token.toLowerCase();
  return (
    !/[./]/.test(token) &&
    !GENERIC_EXTERNAL_QUERY_TERMS.has(lowerToken) &&
    !EXTERNAL_TARGET_STOP_TERMS.has(lowerToken)
  );
}

function externalClaimSubjectTerms(text: string): string[] {
  const authorityTerms = new Set([
    "aws",
    "azure",
    "github",
    "google",
    "mdn",
    "microsoft",
    "mozilla",
    "node.js",
    "npm",
    "openai",
    "python",
    "react",
    "rust",
    "typescript",
  ]);

  return externalTargetTermsFromText(text).filter(
    (term) => !authorityTerms.has(term),
  );
}

function assistantExternalClaimTargetText(text: string): string {
  const contextTerms = externalContextTermsFromText(text);
  const subjectTerms = externalClaimSubjectTerms(text).filter(
    (term) => !contextTerms.includes(term),
  );

  const namedAuthorityMention = text.match(
    /\b(MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\b/i,
  );
  if (namedAuthorityMention?.[1]) {
    return [
      namedAuthorityMention[1],
      ...new Set([...contextTerms, ...subjectTerms]),
    ].join(" ");
  }

  const namedAuthorityMatch = text.match(
    /\b(MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\s+(?:say|says|state|states|mention|mentions|list|lists|show|shows|describe|describes|document|documents|recommend|recommends)\b/i,
  );
  if (namedAuthorityMatch?.[1]) {
    return [
      namedAuthorityMatch[1],
      ...new Set([...contextTerms, ...subjectTerms]),
    ].join(" ");
  }

  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_.-]{2,})\b/g)) {
    const token = match[1] ?? "";
    if (match.index === 0) continue;
    if (!externalClaimTokenIsConcrete(token)) continue;
    return [token, ...new Set(contextTerms)].join(" ");
  }

  for (const match of text.matchAll(
    /\b([a-z][a-z0-9_-]{2,})\s+(?:docs?|documentation|source|release notes?|changelog|api reference|website|web|api|version|pricing|law|regulation|standard|schedule|score|weather|news)\b/gi,
  )) {
    const token = match[1] ?? "";
    if (!externalClaimTokenIsConcrete(token)) continue;
    return [token, ...contextTerms].join(" ");
  }

  return "";
}

function assistantExternalToolTargetText(text: string): string {
  return URL_TEXT_REGEX.test(text) ? text : assistantExternalClaimTargetText(text);
}

function externalEvidenceAttemptMatchesTarget(
  args: unknown,
  targetText = "",
  resultText = "",
): boolean {
  const normalizedTargetText = targetText.trim();
  if (!normalizedTargetText) return true;

  const argsText = stringifyToolArguments(args).toLowerCase();
  if (
    externalEvidenceRequiresOfficialSource(normalizedTargetText) &&
    !externalEvidenceAttemptIndicatesOfficialSource(
      normalizedTargetText,
      argsText,
      resultText,
    )
  ) {
    return false;
  }

  const targetUrls =
    normalizedTargetText
      .match(/https?:\/\/[^\s)"']+|github\.com\/[^\s)"']+/gi)
      ?.map((url) => externalEvidenceUrlKey(url)) ?? [];
  if (targetUrls.length > 0) {
    const attemptUrls = new Set(
      argsText
        .match(/https?:\/\/[^\s)"']+|github\.com\/[^\s)"']+/gi)
        ?.map((url) => externalEvidenceUrlKey(url)) ?? [],
    );
    return targetUrls.some((url) => attemptUrls.has(url));
  }

  const targetTerms = externalTargetTermsFromText(normalizedTargetText);
  if (targetTerms.length === 0) return true;

  const attemptTerms = new Set(
    argsText
      .match(/[a-z0-9][a-z0-9_.:/-]{2,}/g)
      ?.filter(
        (term) =>
          !GENERIC_EXTERNAL_QUERY_TERMS.has(term) ||
          EXTERNAL_TARGET_CONTEXT_TERMS.has(term),
      ) ?? [],
  );
  return targetTerms.every((term) =>
    [...attemptTerms].some((attemptTerm) =>
      externalAttemptTermMatchesTarget(attemptTerm, term),
    ),
  );
}

function externalEvidenceRequiresOfficialSource(text: string): boolean {
  return OFFICIAL_SOURCE_REQUEST_REGEX.test(text);
}

function externalEvidenceAttemptIndicatesOfficialSource(
  targetText: string,
  argsText: string,
  resultText: string,
): boolean {
  if (NON_OFFICIAL_SOURCE_RESULT_REGEX.test(resultText)) return false;
  if (/\b(?:official|primary|authoritative|vendor)\b/i.test(resultText)) {
    return true;
  }

  const targetTerms = externalTargetTermsFromText(targetText).filter(
    (term) => !EXTERNAL_TARGET_CONTEXT_TERMS.has(term),
  );
  if (targetTerms.length === 0) return false;

  const urls =
    argsText.match(/https?:\/\/[^\s)"']+|github\.com\/[^\s)"']+/gi) ?? [];
  return urls.some((url) => {
    try {
      const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const host = new URL(withScheme).hostname.toLowerCase();
      return targetTerms.some((term) =>
        host
          .split(/[^a-z0-9]+/)
          .some((part) => externalAttemptTermMatchesTarget(part, term)),
      );
    } catch {
      return false;
    }
  });
}

function externalAttemptTermMatchesTarget(
  attemptTerm: string,
  targetTerm: string,
): boolean {
  if (attemptTerm === targetTerm) return true;
  const targetAliases = EXTERNAL_TARGET_TERM_ALIASES.get(targetTerm);
  if (
    targetAliases &&
    attemptTerm
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((part) => targetAliases.has(part))
  ) {
    return true;
  }
  if (EXTERNAL_TARGET_CONTEXT_TERMS.has(targetTerm)) {
    const singularTarget = normalizeExternalContextTerm(targetTerm);
    return attemptTerm
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((part) => normalizeExternalContextTerm(part) === singularTarget);
  }

  const singularTarget = targetTerm.replace(/s$/, "");
  const singularAttempt = attemptTerm.replace(/s$/, "");
  return singularTarget.length >= 5 && singularAttempt === singularTarget;
}

function normalizeExternalContextTerm(term: string): string {
  const normalized = term.toLowerCase().replace(/s$/, "");
  if (normalized === "documentation" || normalized === "doc") return "doc";
  if (normalized === "release") return "release";
  return normalized;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function learningCaptureArgumentsAreConcrete(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;

  const record = args as Record<string, unknown>;
  const trigger = readStringField(record, "trigger");
  const lesson = readStringField(record, "lesson");
  const evidenceSnippet = readStringField(record, "evidenceSnippet");
  const score = readNumberField(record, "score");
  const confidence = readNumberField(record, "confidence");

  return (
    trigger.split(/\s+/).filter(Boolean).length >= 3 &&
    lesson.split(/\s+/).filter(Boolean).length >= 6 &&
    evidenceSnippet.split(/\s+/).filter(Boolean).length >= 4 &&
    score !== null &&
    score >= MIN_LEARNING_CAPTURE_SCORE &&
    score <= 1 &&
    confidence !== null &&
    confidence >= MIN_LEARNING_CAPTURE_CONFIDENCE &&
    confidence <= 1
  );
}

function canonicalLearningCaptureKey(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;

  const record = args as Record<string, unknown>;
  const trigger = readStringField(record, "trigger");
  const lesson = readStringField(record, "lesson");
  if (!trigger || !lesson) return null;

  return `${trigger} ${lesson}`
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.:-]{1,}/g)
    ?.map((term) => term.replace(/(?:es|s)$/i, ""))
    .join(" ") ?? null;
}

function learningCaptureArgumentsMatchRequest(
  args: unknown,
  userText = "",
): boolean {
  const requestTerms = learningRequestTerms(userText);
  if (requestTerms.length === 0) return true;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;

  const argsText = stringifyToolArguments(args).toLowerCase();
  const argsTerms = new Set(learningRequestTerms(argsText));
  const criticalTerms = learningCriticalRequestTerms(userText);
  if (criticalTerms.some((term) => !argsTerms.has(term))) return false;

  const lessonTerms = new Set(
    learningRequestTerms(readStringField(args as Record<string, unknown>, "lesson")),
  );
  if (criticalTerms.some((term) => !lessonTerms.has(term))) return false;

  const matchedTerms = requestTerms.filter((term) => argsTerms.has(term));
  const requiredMatches =
    requestTerms.length <= 4
      ? requestTerms.length
      : Math.max(3, Math.ceil(Math.min(requestTerms.length, 6) * 0.6));

  return matchedTerms.length >= requiredMatches;
}

function normalizeLearningRequestTerm(term: string): string {
  const lower = term.toLowerCase();
  return LEARNING_REQUEST_TERM_ALIASES.get(lower) ?? lower.replace(/(?:es|s)$/i, "");
}

function learningCriticalRequestTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const match of text.matchAll(
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|ya?ml|toml|lock)\b/g,
  )) {
    const artifact = match[0] ?? "";
    const stem = artifact.match(/^([A-Za-z0-9_-]{2,})\.[A-Za-z0-9]+$/)?.[1];
    if (stem) terms.add(normalizeLearningRequestTerm(stem));
  }

  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_.-]{2,}\b/g)) {
    const raw = match[0] ?? "";
    const fileStem = raw.match(/^([A-Za-z0-9_-]{2,})\.[A-Za-z0-9]+$/)?.[1];
    const term = normalizeLearningRequestTerm(fileStem ?? raw);
    if (!GENERIC_LEARNING_REQUEST_TERMS.has(term)) terms.add(term);
  }

  return [...terms];
}

function learningRequestTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.:-]{1,}/g)) {
    const term = normalizeLearningRequestTerm(match[0] ?? "");
    if (term.length < 2 || GENERIC_LEARNING_REQUEST_TERMS.has(term)) continue;
    terms.add(term);

    const fileStem = term.match(/^([a-z0-9_-]{2,})\.[a-z0-9]+$/)?.[1];
    if (fileStem && !GENERIC_LEARNING_REQUEST_TERMS.has(fileStem)) {
      terms.add(fileStem);
    }
  }
  return [...terms];
}

export function memorySearchQueryQuality(query: string): {
  focused: boolean;
  reason: string;
} {
  const normalized = query.trim();
  if (!normalized) {
    return { focused: false, reason: "query is empty" };
  }

  const hasArtifactSignal =
    /(?:(?:\.{0,2}\/|~\/|\/)[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|ya?ml|toml|lock)\b)/i.test(
      normalized,
    );
  const hasErrorSignal =
    /\b(?:error|failed|failure|exception|traceback|timeout|timed out|denied|not found|exit code|exit status|non[- ]zero exit|eacces|eperm|enoent|econnreset|etimedout)\b/i.test(
      normalized,
    );
  const specificTerms = normalized
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
    ?.filter((term) => !GENERIC_MEMORY_QUERY_TERMS.has(term)) ?? [];

  if (hasArtifactSignal || hasErrorSignal || specificTerms.length >= 2) {
    return { focused: true, reason: "query has task-specific signal" };
  }

  return {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  };
}

export function externalEvidenceQueryQuality(query: string): {
  focused: boolean;
  reason: string;
} {
  const normalized = query.trim();
  if (!normalized) {
    return { focused: false, reason: "query is empty" };
  }

  if (/https?:\/\/|github\.com\//i.test(normalized)) {
    return { focused: true, reason: "query targets a concrete URL" };
  }

  const specificTerms = normalized
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
    ?.filter((term) => !GENERIC_EXTERNAL_QUERY_TERMS.has(term)) ?? [];
  const hasExternalContextTerm =
    /\b(?:best practices?|config(?:uration)?|current|examples?|guides?|how to|install(?:ation)?|latest|official|release|release notes?|changelog|docs?|documentation|law|news|pricing|reference|regulation|schedule|score|setup|source|standard|tutorials?|verify|version|weather)\b/i.test(
      normalized,
    );

  if (
    specificTerms.length >= 2 ||
    (specificTerms.length >= 1 && hasExternalContextTerm)
  ) {
    return { focused: true, reason: "query has concrete external target terms" };
  }

  return {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  };
}

function unboundedShellEvidenceReason(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return null;

  if (headTailLineLimitIsExcessive(normalized)) {
    return "excessive head/tail line limit";
  }

  if (grepMatchLimitIsExcessive(normalized)) {
    return "excessive grep/rg match limit";
  }

  if (xargsEvidenceFanoutIsUnbounded(normalized)) {
    return "unbounded xargs evidence fanout command";
  }

  if (commandSubstitutionEvidenceFanoutIsUnbounded(normalized)) {
    return "unbounded command substitution evidence fanout command";
  }

  if (scriptedFileDumpIsUnbounded(normalized)) {
    return "unbounded scripted file dump command";
  }

  if (rgFilesListingIsUnbounded(normalized)) {
    return "unbounded rg --files command";
  }

  if (rgSearchIsUnbounded(normalized)) {
    return "unbounded rg command";
  }

  if (jqOutputIsUnbounded(normalized)) {
    return "unbounded jq command";
  }

  if (vcsPatchOutputIsUnbounded(normalized)) {
    return "unbounded VCS patch output command";
  }

  if (vcsHistoryOutputIsUnbounded(normalized)) {
    return "unbounded VCS history output command";
  }

  if (gitGrepIsUnbounded(normalized)) {
    return "unbounded git grep command";
  }

  if (gitLsFilesIsUnbounded(normalized)) {
    return "unbounded git ls-files command";
  }

  if (gitLsTreeIsUnbounded(normalized)) {
    return "unbounded git ls-tree command";
  }


  if (watchModeCommandIsUnbounded(normalized)) {
    return "unbounded watch/follow command";
  }

  if (networkFetchCommandMissingTimeout(normalized)) {
    return "network fetch command without timeout";
  }

  if (scriptedNetworkFetchCommandMissingTimeout(normalized)) {
    return "scripted network fetch command without timeout";
  }

  if (repoSummaryCommandIsUnbounded(normalized)) {
    return "unbounded repo summary command";
  }

  const broadListingReason = broadListingCommandIsUnbounded(normalized);
  if (broadListingReason) {
    return broadListingReason;
  }

  if (/\bcat\s+(?!<<)[^;&|]+/i.test(normalized) && !BOUNDED_PIPE_REGEX.test(normalized)) {
    return "unbounded cat command";
  }

  if (
    /\b(?:nl|bat|batcat|less|more)\b(?:\s+-{1,2}[\w=,.-]+)*\s+(?!<<)[^;&|]+/i.test(
      normalized,
    ) &&
    !BOUNDED_PIPE_REGEX.test(normalized)
  ) {
    return "unbounded file dump command";
  }

  if (sedPrintRangeIsUnbounded(normalized)) {
    return "unbounded sed print command";
  }

  if (/\bgrep\b[\s\S]*(?:\s-R\b|\s-r\b|--recursive)[\s\S]*(?:\s\.|\s\/|\s~)(?:\s|$)/i.test(normalized)) {
    return "recursive grep command";
  }

  if (
    /\bgrep\b[\s\S]*(?:\s-R\b|\s-r\b|--recursive|\s\.)/i.test(normalized) &&
    !BOUNDED_GREP_REGEX.test(normalized)
  ) {
    return "unbounded grep command";
  }

  if (
    /\brg\b[\s\S]*(?:\s\.|\s\/|\s~)/i.test(normalized) &&
    !BOUNDED_GREP_REGEX.test(normalized)
  ) {
    return "unbounded rg command";
  }

  if (findCommandIsUnbounded(normalized)) {
    return "unbounded find command";
  }

  if (fdCommandIsUnbounded(normalized)) {
    return "unbounded fd command";
  }

  if (
    /\bls(?!-)\b[\s\S]*(?:\s-[^\n;|&]*R|--recursive)/i.test(normalized) &&
    !BOUNDED_PIPE_REGEX.test(normalized)
  ) {
    return "recursive ls command";
  }

  return null;
}

function scopedMessagesAfterLatestUser(
  messages: AgentEndEventMessage[],
): AgentEndEventMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages;
}

function matchingToolCallArguments(
  message: AgentEndEventMessage,
  predicate: (name: string, args: string) => boolean,
): string | null {
  for (const item of messageContentItems(message.content)) {
    if (item.type !== "toolCall") continue;
    if (typeof item.name !== "string") continue;
    const args = stringifyToolArguments(item.arguments);
    if (predicate(item.name, args)) return args;
  }
  return null;
}

function isModelEscalationToolCall(name: string, args: string): boolean {
  if (name === "subagent") {
    return isStrongSubagentRequest(args) && modelEscalationRequestQuality(args).focused;
  }
  return (
    (STRONG_ESCALATION_AGENT_REGEX.test(name) ||
      /\b(?:stronger_model|better_model)\b/i.test(name)) &&
    modelEscalationRequestQuality(args).focused
  );
}

function isStrongSubagentRequest(args: string): boolean {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const model = record.model;
      if (typeof model === "string" && STRONG_MODEL_REGEX.test(model)) {
        return true;
      }

      for (const key of [
        "thinking",
        "reasoning",
        "reasoningEffort",
        "thinkingLevel",
        "effort",
      ]) {
        const value = record[key];
        if (typeof value === "string" && HIGH_EFFORT_REGEX.test(value)) {
          return true;
        }
      }
    }
  } catch {
    // Fall through to conservative string detection for non-JSON tool args.
  }

  return (
    STRONG_MODEL_REGEX.test(args) ||
    /\b(?:thinking|reasoning|effort|reasoningEffort|thinkingLevel)\b\s*[:=]\s*["']?(?:high|xhigh|max|maximum)\b/i.test(
      args,
    )
  );
}

function toolCallMatchesSubagentRole(args: string, roles: RegExp): boolean {
  return roles.test(args);
}

function extractEscalationFocusText(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return [
        "task",
        "prompt",
        "question",
        "context",
        "reason",
        "instructions",
        "problem",
      ]
        .flatMap((key) => {
          const value = record[key];
          return typeof value === "string" ? [value] : [];
        })
        .join("\n");
    }
  } catch {
    // Non-JSON tool args can still carry useful task context.
  }

  return args;
}

export function modelEscalationRequestQuality(args: string): {
  focused: boolean;
  reason: string;
} {
  const focusText = extractEscalationFocusText(args).trim();
  if (!focusText) {
    return {
      focused: false,
      reason: "escalation request is missing task context",
    };
  }

  const hasKnowledgeFailureOrArtifactSignal =
    toolFailureTextMatches(focusText) ||
    ARTIFACT_REFERENCE_REGEX.test(focusText);
  const hasKnowledgeGapSignal = KNOWLEDGE_GAP_REGEX.test(focusText);
  const hasRecentOrExternalSignal = RECENT_OR_EXTERNAL_FACT_REGEX.test(focusText);
  const specificTerms = escalationConcreteTargetTerms(focusText);
  const hasConcreteSignal =
    hasKnowledgeFailureOrArtifactSignal ||
    (hasKnowledgeGapSignal && specificTerms.length > 0) ||
    (hasRecentOrExternalSignal && specificTerms.length > 0);

  if (hasConcreteSignal || specificTerms.length >= 2) {
    return { focused: true, reason: "escalation has concrete task context" };
  }

  return {
    focused: false,
    reason:
      "escalation request is too vague; include the uncertainty, failure, artifact, API, command, or exact question",
  };
}

function scopedToolCallNames(messages: AgentEndEventMessage[]): string[] {
  return scopedMessagesAfterLatestUser(messages).flatMap((message) =>
    messageContentItems(message.content).flatMap((item) => {
      if (item.type !== "toolCall") return [];
      return typeof item.name === "string" ? [item.name] : [];
    }),
  );
}

export function hasKnowledgeGapSignal(text: string): boolean {
  return KNOWLEDGE_GAP_REGEX.test(text);
}

export function countToolFailures(messages: AgentEndEventMessage[]): number {
  return scopedMessagesAfterLatestUser(messages).filter((message) => {
    if (message.role !== "toolResult") return false;
    return toolFailureTextMatches(extractMessageText(message.content));
  }).length;
}

function repeatedToolFailureTriggerIndex(
  messages: AgentEndEventMessage[],
  threshold: number,
): number | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let failureCount = 0;

  for (const [index, message] of scopedMessages.entries()) {
    if (message.role !== "toolResult") continue;
    if (!toolFailureTextMatches(extractMessageText(message.content))) {
      continue;
    }

    failureCount += 1;
    if (failureCount >= threshold) return index;
  }

  return null;
}

export function evidenceNeedReason(userText: string): string | null {
  const text = userText.trim();
  if (!text) return null;

  const reasons: string[] = [];
  if (RECENT_OR_EXTERNAL_FACT_REGEX.test(text)) {
    reasons.push("request depends on recent, external, or documentation facts");
  }
  if (SOURCE_EVIDENCE_REQUEST_REGEX.test(text)) {
    reasons.push("user requested source-backed verification");
  }
  if (ARTIFACT_REFERENCE_REGEX.test(text)) {
    reasons.push("user referenced a URL, repository, path, or file");
  }

  return reasons.length > 0 ? reasons.join("; ") : null;
}

export function citationResponseNeedReason(userText: string): string | null {
  return CITATION_RESPONSE_REQUEST_REGEX.test(userText)
    ? "user requested citations, links, sources, or named references in the response"
    : null;
}

export function assistantHasCitationResponse(assistantText: string): boolean {
  if (ASSISTANT_CITATION_RESPONSE_REGEX.test(assistantText)) return true;

  return assistantText
    .split(/\n+/)
    .some(
      (line) =>
        LOCAL_CITATION_MARKER_REGEX.test(line) &&
        localArtifactTargetsFromText(line).length > 0,
    );
}

function normalizeCitationUrl(url: string): string {
  return externalEvidenceUrlKey(url.trim());
}

function citationUrlTargetsFromText(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(CITATION_URL_REGEX)]
        .map((match) => normalizeCitationUrl(match[0] ?? ""))
        .filter(Boolean),
    ),
  ];
}

function citationEvidenceTextContainsUrl(text: string, target: string): boolean {
  const urls =
    text
      .match(CITATION_URL_REGEX)
      ?.map((url) => externalEvidenceUrlKey(url)) ?? [];
  return urls.includes(target);
}

function conversationHasCitationUrlEvidence(
  messages: AgentEndEventMessage[],
  target: string,
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestMatchingAttemptSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (
        !toolCallIsExternalEvidence(item.name, item.arguments) &&
        item.name !== "subagent"
      ) {
        continue;
      }

      const args = stringifyToolArguments(item.arguments);
      const resultMessage = scopedMessages[messageIndex + 1];
      const resultText =
        resultMessage?.role === "toolResult"
          ? extractMessageText(resultMessage.content)
          : "";
      if (
        item.name === "subagent" &&
        (!toolCallMatchesSubagentRole(
          args,
          /\b(?:researcher|scout|oracle)\b/i,
        ) ||
          !externalEvidenceQueryQuality(extractEscalationFocusText(args)).focused)
      ) {
        continue;
      }
      const attemptMentionsTarget =
        item.name === "subagent"
          ? citationEvidenceTextContainsUrl(args, target) ||
            citationEvidenceTextContainsUrl(resultText, target)
          : citationEvidenceTextContainsUrl(args, target) ||
            citationEvidenceTextContainsUrl(resultText, target);
      if (!attemptMentionsTarget) continue;

      const resultBacksTarget =
        item.name === "subagent"
          ? citationEvidenceTextContainsUrl(resultText, target)
          : citationEvidenceTextContainsUrl(args, target) ||
            citationEvidenceTextContainsUrl(resultText, target);
      latestMatchingAttemptSucceeded =
        externalEvidenceToolResultSucceeded(item, resultMessage) && resultBacksTarget;
      if (
        item.name === "subagent" &&
        !citationEvidenceTextContainsUrl(resultText, target)
      ) {
        latestMatchingAttemptSucceeded = false;
      }
    }
  }

  return latestMatchingAttemptSucceeded === true;
}

function assistantCitationTargetsBackedByEvidence(
  messages: AgentEndEventMessage[],
  assistantText: string,
): boolean {
  const urlTargets = citationUrlTargetsFromText(assistantText);
  const localTargets = localArtifactTargetsFromText(assistantText);
  if (urlTargets.length === 0 && localTargets.length === 0) return false;

  return (
    urlTargets.every((target) =>
      conversationHasCitationUrlEvidence(messages, target),
    ) &&
    localTargets.every((target) =>
      conversationHasLocalEvidenceTarget(messages, target),
    )
  );
}

function evidenceSourceClassForUserText(
  userText: string,
): EvidenceSourceClass | null {
  const text = userText.trim();
  if (!text) return null;

  const needsExternal =
    RECENT_OR_EXTERNAL_FACT_REGEX.test(text) ||
    /\b(?:MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\b/i.test(
      text,
    ) ||
    /https?:\/\/|github\.com\//i.test(text);
  if (needsExternal) return "external";

  if (ARTIFACT_REFERENCE_REGEX.test(text)) return "local";
  if (SOURCE_EVIDENCE_REQUEST_REGEX.test(text)) return "any";
  return null;
}

function evidenceSourceClassForAssistantText(
  assistantText: string,
): EvidenceSourceClass {
  const text = assistantText.trim();
  if (
    RECENT_OR_EXTERNAL_FACT_REGEX.test(text) ||
    SOURCE_EVIDENCE_REQUEST_REGEX.test(text) ||
    /\b(?:MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\b/i.test(
      text,
    ) ||
    /\b(?:MDN|OpenAI|GitHub|Microsoft|Mozilla|Google|AWS|Azure|npm|Node\.js|React|TypeScript|Rust|Python)\s+(?:say|says|state|states|mention|mentions|list|lists|show|shows|describe|describes|document|documents|recommend|recommends)\b/i.test(
      text,
    ) ||
    /\b(?:according to|per|from|in)\s+(?:the\s+)?(?:(?:latest|current|official|primary)\s+){0,3}(?:docs?|documentation|source|release notes?|changelog|api reference|website|web)\b/i.test(
      text,
    )
  ) {
    return "external";
  }

  if (ARTIFACT_REFERENCE_REGEX.test(text)) return "local";
  return "any";
}

export function localArtifactTargetsFromText(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(LOCAL_ARTIFACT_TARGET_REGEX)) {
    const target = match[1]?.trim();
    if (!target) continue;
    if (/^(?:https?:\/\/|github\.com\/)/i.test(target)) continue;
    targets.add(target.replace(/^["'`]|["'`.,:;!?)]$/g, ""));
  }
  return [...targets];
}

function localEvidenceArgumentsTouchTarget(args: unknown, target: string): boolean {
  const normalizedTarget = normalizeLocalArtifactDedupeKey(target);
  const targetParts = normalizedTarget.split("/").filter(Boolean);
  const targetBasename = targetParts.at(-1);
  const targetSuffix =
    targetParts.length >= 2 ? targetParts.slice(-2).join("/") : "";

  const matches = (value: string): boolean => {
    const normalizedValue = normalizeLocalArtifactDedupeKey(value);
    return (
      normalizedValue === normalizedTarget ||
      normalizedValue.endsWith(`/${normalizedTarget}`) ||
      (targetSuffix
        ? normalizedValue === targetSuffix ||
          normalizedValue.endsWith(`/${targetSuffix}`)
        : false) ||
      (targetParts.length === 1 && targetBasename
        ? normalizedValue === targetBasename ||
          normalizedValue.endsWith(`/${targetBasename}`)
        : false)
    );
  };

  if (typeof args === "string") return matches(args);
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;

  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "filepath", "filename", "cwd"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && matches(candidate)) return true;
  }
  for (const key of ["paths", "files"]) {
    const candidates = record[key];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (typeof candidate === "string" && matches(candidate)) return true;
    }
  }

  return false;
}

function shellWords(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function shellWordMatchesLocalTarget(word: string, target: string): boolean {
  const normalizedWord = word.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  const targetBasename = normalizedTarget.split("/").filter(Boolean).at(-1);
  return (
    normalizedWord === normalizedTarget ||
    normalizedWord.endsWith(`/${normalizedTarget}`) ||
    (targetBasename
      ? normalizedWord === targetBasename ||
        normalizedWord.endsWith(`/${targetBasename}`)
      : false)
  );
}

function bashLocalEvidenceTouchesTarget(command: string, target: string): boolean {
  const words = shellWords(command);
  const commandIndex = words.findIndex((word) =>
    /^(?:cat|nl|bat|batcat|less|more|sed|head|tail|grep|rg)$/.test(word),
  );
  if (commandIndex < 0) return false;

  const commandName = words[commandIndex];
  const operands = words.slice(commandIndex + 1).filter((word) => {
    if (!word || word === "--") return false;
    if (/^-/.test(word)) return false;
    if (/^\d+(?:,\d+)?p$/.test(word)) return false;
    return true;
  });

  if (commandName === "grep" || commandName === "rg") {
    const pathOperands = operands.slice(1);
    return pathOperands.some((word) => shellWordMatchesLocalTarget(word, target));
  }

  return operands.some((word) => shellWordMatchesLocalTarget(word, target));
}

function bashMutationTouchesTarget(command: string, target: string): boolean {
  return shellWords(command).some((word) =>
    shellWordMatchesLocalTarget(word.replace(/^(?:>>?|2>>?|&>>)/, ""), target),
  );
}

function mutationArgumentsTouchTarget(
  name: string,
  args: unknown,
  target: string,
): boolean {
  return name === "bash"
    ? bashMutationTouchesTarget(extractCommandArgument(args), target)
    : localEvidenceArgumentsTouchTarget(args, target);
}

export function assistantEvidenceClaimReason(
  assistantText: string,
): { reason: string; sourceClass: EvidenceSourceClass } | null {
  const text = assistantText.trim();
  if (LOCAL_REPO_SEARCH_CLAIM_REGEX.test(text)) return null;
  if (!text || !ASSISTANT_SOURCE_CLAIM_REGEX.test(text)) return null;

  return {
    reason: "assistant claimed source-backed verification",
    sourceClass: evidenceSourceClassForAssistantText(text),
  };
}

export function assistantCommandVerificationClaimReason(
  assistantText: string,
): { reason: string; targets: string[] } | null {
  const text = assistantText.trim();
  const exactCommandTargets = ASSISTANT_EXACT_COMMAND_VERIFICATION_CLAIM_REGEX.test(
    text,
  )
    ? commandLiteralTargetsFromText(text)
    : [];
  if (
    !text ||
    (!ASSISTANT_COMMAND_VERIFICATION_CLAIM_REGEX.test(text) &&
      exactCommandTargets.length === 0)
  ) {
    return null;
  }

  return {
    reason: "assistant claimed command-backed verification",
    targets: [
      ...new Set([
        ...commandVerificationTargetsFromText(
          exactCommandTargets.length > 0
            ? text.replace(/`[^`\n]{2,160}`/g, " ")
            : text,
        ),
        ...exactCommandTargets,
      ]),
    ],
  };
}

export function assistantMutationClaimReason(
  assistantText: string,
): { reason: string; targets: string[] } | null {
  const text = assistantText.trim();
  if (!text || !ASSISTANT_MUTATION_CLAIM_REGEX.test(text)) return null;

  return {
    reason: "assistant claimed file or code mutation",
    targets: localArtifactTargetsFromText(text),
  };
}

export function assistantToolWorkPromiseReason(
  assistantText: string,
): {
  reason: string;
  sourceClasses: EvidenceSourceClass[];
  localTargets: string[];
  commandTargets: string[];
  mutationTargets: string[];
} | null {
  const text = assistantText.trim();
  const match = text.match(ASSISTANT_TOOL_WORK_PROMISE_REGEX);
  if (!text || !match) return null;

  const verb = (match[1] ?? match[2] ?? "").toLowerCase();
  const sourceClasses = new Set<EvidenceSourceClass>();
  const localTargets = localArtifactTargetsFromText(text);
  let commandTargets = [
    ...new Set([
      ...commandVerificationTargetsFromText(text),
      ...commandLiteralTargetsFromText(text),
    ]),
  ];
  const mutationTargets: string[] = [];

  if (
    /^(?:edit|write|fix|implement|add|create|update|patch|modify)$/.test(verb)
  ) {
    sourceClasses.add("mutation");
    mutationTargets.push(...localTargets);
  } else if (/^(?:run|execute|test|build|lint|typecheck)$/.test(verb)) {
    sourceClasses.add("command");
  } else if (
    /^(?:check|verify|validate)$/.test(verb) &&
    evidenceSourceClassForUserText(text) === "external" &&
    !commandTargets.some((target) => target !== "check")
  ) {
    sourceClasses.add("external");
    commandTargets = commandTargets.filter((target) => target !== "check");
  } else if (commandTargets.length > 0) {
    sourceClasses.add("command");
  } else if (
    /^(?:search|browse|look up)$/.test(verb) &&
    (localTargets.length > 0 || LOCAL_REPO_SEARCH_TARGET_REGEX.test(text))
  ) {
    sourceClasses.add("local");
  } else if (
    /^(?:read|load|open|fetch|download|search|browse|look up|look at)$/.test(
      verb,
    ) &&
    (URL_TEXT_REGEX.test(text) || evidenceSourceClassForUserText(text) === "external")
  ) {
    sourceClasses.add("external");
  } else if (localTargets.length > 0) {
    sourceClasses.add("local");
  } else if (/^(?:check|verify|validate)$/.test(verb)) {
    sourceClasses.add("any");
  } else {
    sourceClasses.add("local");
  }

  return {
    reason: "assistant promised tool-backed work",
    sourceClasses: [...sourceClasses],
    localTargets,
    commandTargets,
    mutationTargets,
  };
}

export function assistantToolWorkCompletionReason(
  assistantText: string,
): {
  reason: string;
  sourceClasses: EvidenceSourceClass[];
  localTargets: string[];
  commandTargets: string[];
} | null {
  const text = assistantText.trim();
  const match = text.match(ASSISTANT_TOOL_WORK_COMPLETION_REGEX);
  if (!text || !match) return null;

  const verb = (match[1] ?? "").toLowerCase();
  const sourceClasses = new Set<EvidenceSourceClass>();
  const localTargets = localArtifactTargetsFromText(text);
  const commandTargets = [
    ...new Set([
      ...commandVerificationTargetsFromText(text),
      ...commandLiteralTargetsFromText(text),
    ]),
  ];
  const claimsLocalSearch =
    /^(?:searched|grepped|found|located)$/.test(verb) &&
    LOCAL_REPO_SEARCH_CLAIM_REGEX.test(text);
  const claimsLocalTargetSearch =
    /^(?:searched|browsed|looked up)$/.test(verb) && localTargets.length > 0;

  if (commandTargets.length > 0 || /^(?:ran|executed)$/.test(verb)) {
    sourceClasses.add("command");
  }
  if (
    (/^(?:searched|browsed|looked up)$/.test(verb) &&
      !claimsLocalSearch &&
      !claimsLocalTargetSearch) ||
    (/^(?:read|loaded|opened|fetched|downloaded|looked at)$/.test(verb) &&
      (URL_TEXT_REGEX.test(text) || evidenceSourceClassForUserText(text) === "external")) ||
    /\b(?:web|internet|docs?|documentation|source|official)\b/i.test(text)
  ) {
    sourceClasses.add("external");
  }
  if (claimsLocalSearch || localTargets.length > 0) {
    sourceClasses.add("local");
  }

  if (sourceClasses.size === 0) return null;

  return {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: [...sourceClasses],
    localTargets,
    commandTargets,
  };
}

export function skillNeedReason(userText: string): string | null {
  return registrySkillNeedReason(userText);
}

export function explicitSkillNamesForUserText(userText: string): string[] {
  return registryExplicitSkillNamesForUserText(userText);
}

export function assistantClaimedSkillNames(assistantText: string): string[] {
  return registryAssistantClaimedSkillNames(assistantText);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillNamePattern(skill: string): string {
  return escapeRegExp(skill).replaceAll("-", "[- ]");
}

function textHasExactSkillName(text: string, skill: string): boolean {
  const pattern = `(?:^|[^a-z0-9_.:-])${skillNamePattern(skill)}(?=$|[^a-z0-9_.:-])`;
  return new RegExp(pattern, "i").test(text);
}

function normalizeSkillAssignmentName(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, "-");
}

function skillReadPathTargetsFromArgs(args: unknown): string[] {
  if (typeof args === "string") return [args.replaceAll("\\", "/")];
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];

  const record = args as Record<string, unknown>;
  return ["path", "file", "filepath", "filename"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replaceAll("\\", "/"));
}

function skillLoaderTargetsFromArgs(args: unknown): string[] {
  if (typeof args === "string") return [normalizeSkillAssignmentName(args)];
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];

  const record = args as Record<string, unknown>;
  const targets = new Set<string>();
  for (const key of ["name", "skill", "skillName", "assignedSkill"]) {
    const value = record[key];
    if (typeof value === "string") {
      targets.add(normalizeSkillAssignmentName(value));
    }
  }
  for (const key of ["skills", "assignedSkills"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") targets.add(normalizeSkillAssignmentName(entry));
    }
  }
  return [...targets].filter(Boolean);
}

export function recommendedSkillsForUserText(userText: string): string[] {
  return registryRecommendedSkillsForUserText(userText);
}

function skillRoutingNeed(params: {
  assistantText?: string;
  userText: string;
}): { reason: string; requiredSkills: string[] } | null {
  if (skillNeedReason(params.userText)) {
    const explicitSkills = explicitSkillNamesForUserText(params.userText);
    const recommendedSkills = recommendedSkillsForUserText(params.userText);
    return {
      reason: "user explicitly requested a skill",
      requiredSkills:
        explicitSkills.length > 0 ? explicitSkills : recommendedSkills,
    };
  }

  const claimedSkills = assistantClaimedSkillNames(params.assistantText ?? "");
  if (claimedSkills.length > 0) {
    return {
      reason: `assistant claimed skill use: ${claimedSkills.join(", ")}`,
      requiredSkills: claimedSkills,
    };
  }

  const recommendedSkills = recommendedSkillsForUserText(params.userText);
  if (recommendedSkills.length === 0) return null;

  return {
    reason: `request matches packaged skill route: ${recommendedSkills.join(", ")}`,
    requiredSkills: recommendedSkills,
  };
}

function subagentHasExplicitSkillAssignment(args: string, skill: string): boolean {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of [
        "skill",
        "skills",
        "assignedSkill",
        "assignedSkills",
        "skillName",
      ]) {
        const value = record[key];
        if (
          typeof value === "string" &&
          normalizeSkillAssignmentName(value) === skill
        ) {
          return true;
        }
        if (
          Array.isArray(value) &&
          value.some(
            (entry) =>
              typeof entry === "string" &&
              normalizeSkillAssignmentName(entry) === skill,
          )
        ) {
          return true;
        }
      }
      return false;
    }
  } catch {
    // Fall back to string matching for non-JSON tool args.
  }

  const skillListPattern = `(?:skill|skills|assignedSkill|assignedSkills|skillName)\\b\\s*[:=]\\s*["'\\[]?[^}"'\\]]*${skillNamePattern(skill)}(?=\\s*(?:$|[,;\\]}"']))`;
  return new RegExp(skillListPattern, "i").test(args);
}

function subagentMentionsSkill(args: string, skill: string): boolean {
  return textHasExactSkillName(args, skill);
}

export function extractResponseConfidence(text: string): number | null {
  const confidenceMatch = text.match(
    /(?:^|\n)\s*Confidence\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?%?)/i,
  );
  if (!confidenceMatch) return null;

  const raw = confidenceMatch[1] ?? "";
  const value = raw.endsWith("%")
    ? Number(raw.slice(0, -1)) / 100
    : Number(raw);
  if (!Number.isFinite(value)) return null;

  const normalized = value > 1 ? value / 100 : value;
  if (normalized < 0) return 0;
  if (normalized > 1) return 1;
  return normalized;
}

export function conversationHasModelEscalation(
  messages: AgentEndEventMessage[],
  afterScopedMessageIndex = -1,
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestEscalationAttemptSucceeded: boolean | null = null;

  for (const [index, message] of scopedMessages.entries()) {
    if (index <= afterScopedMessageIndex) continue;
    const args = matchingToolCallArguments(message, isModelEscalationToolCall);
    if (!args) continue;
    latestEscalationAttemptSucceeded = advisoryResultSucceeded(
      scopedMessages[index + 1],
      extractEscalationFocusText(args),
    );
  }

  return latestEscalationAttemptSucceeded === true;
}

export function conversationHasEvidenceTool(
  messages: AgentEndEventMessage[],
  sourceClass: EvidenceSourceClass = "any",
  targetText = "",
): boolean {
  if (sourceClass === "external") {
    return conversationHasExternalEvidenceTool(messages, targetText);
  }

  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestMatchingAttemptSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      const args = stringifyToolArguments(item.arguments);
      if (sourceClass === "local" && toolCallIsLocalEvidence(item.name, item.arguments)) {
        latestMatchingAttemptSucceeded = shellSafeEvidenceResultSucceeded(
          item,
          scopedMessages[messageIndex + 1],
        );
        continue;
      }

      if (
        sourceClass === "command" &&
        toolCallIsCommandEvidence(item.name, item.arguments)
      ) {
        const command = extractCommandArgument(item.arguments);
        latestMatchingAttemptSucceeded =
          !commandMasksVerificationFailure(command) &&
          toolResultHasSubstantiveEvidence(scopedMessages[messageIndex + 1]);
        continue;
      }

      if (sourceClass === "mutation" && toolCallIsMutationEvidence(item.name, item.arguments)) {
        latestMatchingAttemptSucceeded = mutationToolResultSucceeded(
          item,
          scopedMessages[messageIndex + 1],
        );
        continue;
      }

      if (sourceClass === "any" && toolCallIsEvidence(item.name, item.arguments)) {
        latestMatchingAttemptSucceeded = evidenceToolCallQualitySatisfied(item)
          ? shellSafeEvidenceResultSucceeded(
              item,
              scopedMessages[messageIndex + 1],
            )
          : false;
        continue;
      }

      if (item.name === "subagent") {
        if (sourceClass === "command" || sourceClass === "mutation") {
          continue;
        }
        if (
          toolCallMatchesSubagentRole(
            args,
            /\b(?:researcher|scout|context-builder|reviewer|oracle)\b/i,
          )
        ) {
          latestMatchingAttemptSucceeded = toolResultHasSubstantiveEvidence(
            scopedMessages[messageIndex + 1],
          );
        }
        continue;
      }

      if (
        sourceClass === "local" &&
        /\b(?:read|grep|find|review|memory)\b/i.test(item.name)
      ) {
        latestMatchingAttemptSucceeded = toolResultHasSubstantiveEvidence(
          scopedMessages[messageIndex + 1],
        );
        continue;
      }

      if (
        sourceClass === "any" &&
        (toolCallIsExternalEvidence(item.name, item.arguments) ||
          /\b(?:memory|read|grep|find|review)\b/i.test(item.name))
      ) {
        latestMatchingAttemptSucceeded = evidenceToolCallQualitySatisfied(item)
          ? toolResultHasSubstantiveEvidence(scopedMessages[messageIndex + 1])
          : false;
      }
    }
  }

  return latestMatchingAttemptSucceeded === true;
}

function evidenceToolCallQualitySatisfied(item: ToolCallContent): boolean {
  if (isMemorySearchToolName(item.name)) {
    return memorySearchQueryQuality(extractQueryArgument(item.arguments)).focused;
  }
  if (
    isExternalSearchToolName(item.name) ||
    toolCallIsExternalEvidence(item.name, item.arguments)
  ) {
    return externalEvidenceQueryQuality(extractExternalQueryArgument(item.arguments))
      .focused;
  }
  return true;
}

function mutationToolResultSucceeded(
  item: ToolCallContent,
  resultMessage?: AgentEndEventMessage,
): boolean {
  if (
    item.name === "bash" &&
    commandMasksVerificationFailure(extractCommandArgument(item.arguments))
  ) {
    return false;
  }
  return toolResultHasSubstantiveEvidence(resultMessage);
}

function commandToolResultSucceeded(
  command: string,
  resultMessage?: AgentEndEventMessage,
): boolean {
  if (commandMasksVerificationFailure(command)) return false;
  return toolResultHasSubstantiveEvidence(resultMessage);
}

function shellSafeEvidenceResultSucceeded(
  item: ToolCallContent,
  resultMessage?: AgentEndEventMessage,
): boolean {
  if (
    item.name === "bash" &&
    commandMasksVerificationFailure(extractCommandArgument(item.arguments))
  ) {
    return false;
  }
  return toolResultHasSubstantiveEvidence(resultMessage);
}

function externalEvidenceToolResultSucceeded(
  item: ToolCallContent,
  resultMessage?: AgentEndEventMessage,
): boolean {
  if (!shellSafeEvidenceResultSucceeded(item, resultMessage)) return false;
  const text = extractMessageText(resultMessage?.content ?? []);
  if (EXTERNAL_EVIDENCE_HTTP_FAILURE_REGEX.test(text)) return false;
  if (GENERIC_EXTERNAL_EVIDENCE_RESULT_REGEX.test(text)) return false;
  return !HEDGED_RESULT_REGEX.test(text);
}

function externalEvidenceAttemptKey(name: string, args: unknown): string | null {
  const argsText = stringifyToolArguments(args);

  if (toolCallIsExternalEvidence(name, args)) {
    const openTarget = canonicalExternalOpenTarget(args);
    if (isExternalOpenToolName(name) || openTarget) {
      return openTarget ? `open:${openTarget.key}` : `open:${normalizeToolArguments(args)}`;
    }

    const query = canonicalExternalSearchQuery(args);
    return query ? `query:${query.key}` : null;
  }

  if (name === "bash") {
    const command = extractCommandArgument(args);
    if (
      /\b(?:curl|wget|gh\s+|git\s+(?:ls-remote|fetch)|npm\s+(?:view|info)|pnpm\s+info|yarn\s+info)\b/i.test(
        command,
      )
    ) {
      return `command:${command.trim().toLowerCase()}`;
    }
    return null;
  }

  if (name === "subagent") {
    if (!toolCallMatchesSubagentRole(argsText, /\b(?:researcher|scout|oracle)\b/i)) {
      return null;
    }
    const query = canonicalExternalSearchQuery(argsText);
    return query ? `query:${query.key}` : null;
  }

  if (toolNameLooksLikeExternalEvidence(name)) {
    const query = canonicalExternalSearchQuery(args);
    return query ? `query:${query.key}` : null;
  }

  return null;
}

function conversationHasExternalEvidenceTool(
  messages: AgentEndEventMessage[],
  targetText = "",
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestMatchingAttemptSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      const key = externalEvidenceAttemptKey(item.name, item.arguments);
      if (!key) continue;
      const resultMessage = scopedMessages[messageIndex + 1];
      const resultText =
        resultMessage?.role === "toolResult"
          ? extractMessageText(resultMessage.content)
          : "";
      if (
        !externalEvidenceAttemptMatchesTarget(
          item.arguments,
          targetText,
          resultText,
        )
      ) {
        continue;
      }
      latestMatchingAttemptSucceeded = externalEvidenceToolResultSucceeded(
        item,
        resultMessage,
      );
    }
  }

  return latestMatchingAttemptSucceeded === true;
}

export function conversationHasLocalEvidenceTarget(
  messages: AgentEndEventMessage[],
  target: string,
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestMatchingAttemptSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsLocalEvidence(item.name, item.arguments)) continue;
      if (isKhalaMemoryToolName(item.name)) {
        continue;
      }

      const matchesTarget =
        item.name === "bash"
          ? bashLocalEvidenceTouchesTarget(
              extractCommandArgument(item.arguments),
              target,
            )
          : localEvidenceArgumentsTouchTarget(item.arguments, target);
      if (!matchesTarget) continue;

      latestMatchingAttemptSucceeded = shellSafeEvidenceResultSucceeded(
        item,
        scopedMessages[messageIndex + 1],
      );
    }
  }

  return latestMatchingAttemptSucceeded === true;
}

export function conversationHasCommandEvidence(
  messages: AgentEndEventMessage[],
  targets: string[] = [],
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  const requiredTargets = new Set(targets);
  const latestTargetResults = new Map<string, boolean>();
  let latestGenericVerificationSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsCommandEvidence(item.name, item.arguments)) continue;

      const command = extractCommandArgument(item.arguments);
      const succeeded = commandToolResultSucceeded(
        command,
        scopedMessages[messageIndex + 1],
      );
      if (requiredTargets.size === 0) {
        if (commandLooksLikeVerification(command)) {
          latestGenericVerificationSucceeded = succeeded;
        }
        continue;
      }

      for (const target of requiredTargets) {
        if (commandMatchesVerificationTarget(command, target)) {
          latestTargetResults.set(target, succeeded);
        }
      }
    }
  }

  if (requiredTargets.size === 0) {
    return latestGenericVerificationSucceeded === true;
  }

  return (
    [...requiredTargets].length > 0 &&
    [...requiredTargets].every(
      (target) => latestTargetResults.get(target) === true,
    )
  );
}

export function conversationHasMutationEvidence(
  messages: AgentEndEventMessage[],
  targets: string[] = [],
): boolean {
  const requiredTargets = new Set(targets.map((target) => target.toLowerCase()));
  const latestTargetResults = new Map<string, boolean>();
  let latestUntargetedMutationSucceeded: boolean | null = null;
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsMutationEvidence(item.name, item.arguments)) continue;

      const succeeded = mutationToolResultSucceeded(
        item,
        scopedMessages[messageIndex + 1],
      );
      if (requiredTargets.size === 0) {
        latestUntargetedMutationSucceeded = succeeded;
        continue;
      }

      for (const target of requiredTargets) {
        if (mutationArgumentsTouchTarget(item.name, item.arguments, target)) {
          latestTargetResults.set(target, succeeded);
        }
      }
    }
  }

  if (requiredTargets.size === 0) {
    return latestUntargetedMutationSucceeded === true;
  }

  return [...requiredTargets].every(
    (target) => latestTargetResults.get(target) === true,
  );
}

export function conversationHasSkillRead(
  messages: AgentEndEventMessage[],
  requiredSkills: string[] = [],
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  const requiredSkillSet = new Set(
    requiredSkills.map((skill) => skill.toLowerCase()),
  );
  const requiresSpecificSkill = requiredSkillSet.size > 0;
  const latestSkillResults = new Map<string, boolean>();
  let latestGenericSkillAttemptSucceeded: boolean | null = null;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      const succeeded = toolResultHasSubstantiveEvidence(
        scopedMessages[messageIndex + 1],
      );

      const args = stringifyToolArguments(item.arguments).replaceAll("\\", "/");
      if (isLocalFileReadToolName(item.name)) {
        const skillReadTargets = skillReadPathTargetsFromArgs(item.arguments);
        const matchingSkillRead = skillReadTargets
          .map((target) => skillMetadataFromSkillReadPath(target))
          .find((metadata) => metadata !== null);
        if (!matchingSkillRead) continue;
        if (!requiresSpecificSkill) {
          latestGenericSkillAttemptSucceeded = succeeded;
          continue;
        }
        if (requiredSkillSet.has(matchingSkillRead.name)) {
          latestSkillResults.set(matchingSkillRead.name, succeeded);
        }
        continue;
      }

      if (item.name === "subagent") {
        if (!/\bskills?\b/i.test(args)) continue;
        if (!requiresSpecificSkill) {
          latestGenericSkillAttemptSucceeded = succeeded;
          continue;
        }
        for (const skill of requiredSkillSet) {
          if (subagentHasExplicitSkillAssignment(args, skill)) {
            latestSkillResults.set(skill, succeeded);
          } else if (subagentMentionsSkill(args, skill)) {
            latestSkillResults.set(skill, false);
          }
        }
        continue;
      }

      if (!isSkillLoaderToolName(item.name)) {
        continue;
      }
      const loaderTargets = skillLoaderTargetsFromArgs(item.arguments);
      if (!requiresSpecificSkill) {
        latestGenericSkillAttemptSucceeded =
          loaderTargets.length > 0 ? succeeded : false;
        continue;
      }
      for (const skill of requiredSkillSet) {
        if (loaderTargets.includes(skill)) {
          latestSkillResults.set(skill, succeeded);
        }
      }
    }
  }

  return requiresSpecificSkill
    ? [...requiredSkillSet].every((skill) => latestSkillResults.get(skill) === true)
    : latestGenericSkillAttemptSucceeded === true;
}

export function conversationHasMemorySearch(
  messages: AgentEndEventMessage[],
  maxNonMemoryToolCallsAfterSearch = DEFAULT_SUBSTANTIAL_TOOL_CALL_THRESHOLD,
  userText = "",
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestFocusedSearchSucceeded: boolean | null = null;
  let nonMemoryToolCallsAfterLatestSearch = 0;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (!isMemorySearchToolName(item.name)) {
        if (!isMemoryRefreshToolName(item.name)) {
          nonMemoryToolCallsAfterLatestSearch += 1;
        }
        continue;
      }
      if (
        !memorySearchQueryQuality(extractQueryArgument(item.arguments)).focused ||
        !memorySearchArgumentsMatchTask(item.arguments, userText)
      ) {
        continue;
      }
      nonMemoryToolCallsAfterLatestSearch = 0;
      latestFocusedSearchSucceeded = memorySearchToolResultHasSubstantiveEvidence(
        scopedMessages[messageIndex + 1],
      );
    }
  }

  return (
    latestFocusedSearchSucceeded === true &&
    nonMemoryToolCallsAfterLatestSearch < maxNonMemoryToolCallsAfterSearch
  );
}

export function conversationHasMemorySearchBeforeFirstMutation(
  messages: AgentEndEventMessage[],
  maxNonMemoryToolCallsAfterSearch = DEFAULT_SUBSTANTIAL_TOOL_CALL_THRESHOLD,
  userText = "",
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestFocusedSearchSucceeded: boolean | null = null;
  let nonMemoryToolCallsAfterLatestSearch = 0;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      if (toolCallRequiresMemorySearchBeforeMutation(item)) {
        return (
          latestFocusedSearchSucceeded === true &&
          nonMemoryToolCallsAfterLatestSearch < maxNonMemoryToolCallsAfterSearch
        );
      }
      if (!isMemorySearchToolName(item.name)) {
        if (!isMemoryRefreshToolName(item.name)) {
          nonMemoryToolCallsAfterLatestSearch += 1;
        }
        continue;
      }
      if (
        memorySearchQueryQuality(extractQueryArgument(item.arguments)).focused &&
        memorySearchArgumentsMatchTask(item.arguments, userText)
      ) {
        nonMemoryToolCallsAfterLatestSearch = 0;
        latestFocusedSearchSucceeded = memorySearchToolResultHasSubstantiveEvidence(
          scopedMessages[messageIndex + 1],
        );
      }
    }
  }

  return (
    latestFocusedSearchSucceeded === true &&
    nonMemoryToolCallsAfterLatestSearch < maxNonMemoryToolCallsAfterSearch
  );
}

export function conversationHasLearningCapture(
  messages: AgentEndEventMessage[],
  userText = "",
): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let latestLearningAttemptSucceeded: boolean | null = null;

  for (const [index, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (!isMemoryPersistenceToolName(item.name)) continue;
      latestLearningAttemptSucceeded =
        learningCaptureArgumentsAreConcrete(item.arguments) &&
        learningCaptureArgumentsMatchRequest(item.arguments, userText) &&
        toolResultHasLearningStorageSuccess(scopedMessages[index + 1]);
    }
  }

  return latestLearningAttemptSucceeded === true;
}

function workflowContractText(params: {
  messages: AgentEndEventMessage[];
  userText: string;
}): string {
  return [
    params.userText,
    ...scopedMessagesAfterLatestUser(params.messages).flatMap((message) =>
      message.role === "user" || message.role === "system"
        ? [extractMessageText(message.content)]
        : [],
    ),
  ]
    .join("\n")
    .trim();
}

function conversationHasToolCall(messages: AgentEndEventMessage[]): boolean {
  return scopedMessagesAfterLatestUser(messages).some((message) =>
    messageContentItems(message.content).some(
      (item) => item.type === "toolCall" && typeof item.name === "string",
    ),
  );
}

function conversationStartedMutationBeforeWorkflowContext(
  messages: AgentEndEventMessage[],
): boolean {
  let sawContextEvidence = false;
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      if (
        toolCallIsMutationEvidence(item.name, item.arguments)
      ) {
        return !sawContextEvidence;
      }

      if (!toolCallIsEvidence(item.name, item.arguments)) continue;
      if (toolResultHasSubstantiveEvidence(scopedMessages[messageIndex + 1])) {
        sawContextEvidence = true;
      }
    }
  }

  return false;
}

function conversationHasGuideLoad(messages: AgentEndEventMessage[]): boolean {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      const args = stringifyToolArguments(item.arguments).replaceAll("\\", "/");
      const succeeded = toolResultHasSubstantiveEvidence(
        scopedMessages[messageIndex + 1],
      );
      if (!succeeded) continue;

      if (isLocalFileReadToolName(item.name)) {
        const targets = localArtifactTargetsFromToolArguments(item.arguments);
        if (
          targets.some((target) =>
            /(?:SKILL\.md|(?:guide|guidelines?|rules?)\.(?:md|txt|ya?ml)|AGENTS\.md|CONTRIBUTING\.md|[-_]workflow\.(?:md|ya?ml)|[-_]handoff-template\.(?:md|txt))$/i.test(
              target,
            ),
          )
        ) {
          return true;
        }
      }

      if (
        isSkillLoaderToolName(item.name) &&
        skillLoaderTargetsFromArgs(item.arguments).length > 0
      ) {
        return true;
      }

      if (
        item.name === "subagent" &&
        /\b(?:skills?|guides?|guidelines?)\b/i.test(args)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function evaluateWorkflowContract(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  assistantText: string;
}): WorkflowContractDecision {
  const contractText = workflowContractText({
    messages: params.messages,
    userText: params.userText,
  });
  if (!WORKFLOW_CONTRACT_REGEX.test(contractText)) {
    return {
      required: false,
      satisfied: true,
      reason: "turn did not include a deterministic workflow contract",
    };
  }

  const finalClaimsSuccess = WORKFLOW_SUCCESS_RESPONSE_REGEX.test(
    params.assistantText,
  );
  const hasToolCall = conversationHasToolCall(params.messages);
  const expectsMutation =
    WORKFLOW_MUTATION_EXPECTED_REGEX.test(contractText) ||
    WORKFLOW_MUTATION_EXPECTED_REGEX.test(params.userText);
  const hasMutation = conversationHasMutationEvidence(params.messages);
  const requiresValidation = WORKFLOW_VALIDATION_REQUIRED_REGEX.test(contractText);
  const hasValidation = conversationHasCommandEvidence(params.messages);

  if (
    WORKFLOW_GATHER_CONTEXT_REGEX.test(contractText) &&
    conversationStartedMutationBeforeWorkflowContext(params.messages)
  ) {
    return {
      required: true,
      satisfied: false,
      reason:
        "started implementation before gathering evidence for earlier workflow steps",
    };
  }

  if (
    WORKFLOW_GUIDE_REQUIRED_REGEX.test(contractText) &&
    !conversationHasGuideLoad(params.messages)
  ) {
    return {
      required: true,
      satisfied: false,
      reason: "required workflow guide or skill was not loaded",
    };
  }

  if (hasMutation && requiresValidation && !hasValidation) {
    return {
      required: true,
      satisfied: false,
      reason: "mutated workflow output without targeted validation evidence",
    };
  }

  if (finalClaimsSuccess && !hasToolCall) {
    return {
      required: true,
      satisfied: false,
      reason: "reported workflow success without executing ordered steps",
    };
  }

  if (finalClaimsSuccess && expectsMutation && !hasMutation) {
    return {
      required: true,
      satisfied: false,
      reason: "reported success before completing implementation evidence",
    };
  }

  if (finalClaimsSuccess && requiresValidation && !hasValidation) {
    return {
      required: true,
      satisfied: false,
      reason: "reported success before running required validation",
    };
  }

  return {
    required: true,
    satisfied: true,
    reason: "workflow contract evidence is present",
  };
}

function localArtifactTargetMatches(candidate: string, target: string): boolean {
  return localEvidenceArgumentsTouchTarget({ path: candidate }, target);
}

function mutationTargetsFromToolCall(name: string, args: unknown): string[] {
  const targets =
    name === "bash"
      ? localArtifactTargetsFromText(extractCommandArgument(args))
      : localArtifactTargetsFromToolArguments(args);
  return [...new Set(targets)];
}

function targetBasename(target: string): string {
  return target.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? target;
}

function targetStem(target: string): string {
  return targetBasename(target)
    .replace(/\.(?:test|spec)\.[^.]+$/i, "")
    .replace(/\.[^.]+$/i, "")
    .toLowerCase();
}

function mutationTargetIsAllowedByRequestedScope(
  mutationTarget: string,
  requestedTargets: readonly string[],
): boolean {
  if (
    requestedTargets.some((requestedTarget) =>
      localArtifactTargetMatches(mutationTarget, requestedTarget),
    )
  ) {
    return true;
  }

  const normalizedMutation = normalizeLocalArtifactDedupeKey(mutationTarget);
  const requestedBasenames = new Set(
    requestedTargets.map((target) => targetBasename(target).toLowerCase()),
  );
  if (
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(
      normalizedMutation,
    ) &&
    requestedBasenames.has("package.json")
  ) {
    return true;
  }

  if (/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalizedMutation)) {
    const mutationStem = targetStem(normalizedMutation);
    return requestedTargets.some((target) => {
      if (!/\.[cm]?[jt]sx?$/i.test(target)) return false;
      const requestedStem = targetStem(target);
      return (
        mutationStem === requestedStem ||
        mutationStem.endsWith(`.${requestedStem}`) ||
        mutationStem.endsWith(`-${requestedStem}`)
      );
    });
  }

  return false;
}

function userRequestedNewLocalArtifact(userText: string, target: string): boolean {
  const basename = escapeRegExp(targetBasename(target));
  return new RegExp(
    `\\b(?:create|scaffold|generate)\\b[\\s\\S]{0,80}\\b${basename}\\b|\\bnew\\s+(?:file\\s+)?${basename}\\b`,
    "i",
  ).test(userText);
}

function mutationTargetRequiresPreEvidence(
  userText: string,
  target: string,
): boolean {
  if (userRequestedNewLocalArtifact(userText, target)) return false;
  return true;
}

function mutationTargetRequiresValidation(target: string): boolean {
  return /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|jsconfig[^/]*\.json|deno\.jsonc?|biome\.jsonc?|eslint\.config\.[cm]?js|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|Dockerfile|docker-compose\.ya?ml)$|(?:^|\/)[^/]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|jsonc?|ya?ml|toml|sql|sh|bash|zsh|fish)$/i.test(
    target,
  );
}

function localEvidenceToolCallTouchesTarget(
  item: ToolCallContent,
  target: string,
): boolean {
  if (typeof item.name !== "string") return false;
  if (!toolCallIsLocalEvidence(item.name, item.arguments)) return false;
  if (item.name === "bash") {
    return bashLocalEvidenceTouchesTarget(
      extractCommandArgument(item.arguments),
      target,
    );
  }
  return localEvidenceArgumentsTouchTarget(item.arguments, target);
}

function successfulLocalEvidenceBefore(
  scopedMessages: readonly AgentEndEventMessage[],
  beforeMessageIndex: number,
  target: string,
): boolean {
  for (const [messageIndex, message] of scopedMessages.entries()) {
    if (messageIndex >= beforeMessageIndex) break;
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (!localEvidenceToolCallTouchesTarget(item, target)) continue;
      if (shellSafeEvidenceResultSucceeded(item, scopedMessages[messageIndex + 1])) {
        return true;
      }
    }
  }
  return false;
}

function successfulValidationAfter(
  scopedMessages: readonly AgentEndEventMessage[],
  afterMessageIndex: number,
): boolean {
  for (const [messageIndex, message] of scopedMessages.entries()) {
    if (messageIndex <= afterMessageIndex) continue;
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsCommandEvidence(item.name, item.arguments)) continue;
      const command = extractCommandArgument(item.arguments);
      if (!commandLooksLikeVerification(command)) continue;
      if (commandToolResultSucceeded(command, scopedMessages[messageIndex + 1])) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateImplementationQuality(params: {
  messages: AgentEndEventMessage[];
  userText: string;
}): ImplementationQualityDecision {
  const scopedMessages = scopedMessagesAfterLatestUser(params.messages);
  const successfulMutations: Array<{
    messageIndex: number;
    name: string;
    targets: string[];
  }> = [];

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsMutationEvidence(item.name, item.arguments)) continue;
      if (!mutationToolResultSucceeded(item, scopedMessages[messageIndex + 1])) {
        continue;
      }
      successfulMutations.push({
        messageIndex,
        name: item.name,
        targets: mutationTargetsFromToolCall(item.name, item.arguments),
      });
    }
  }

  const localMutationTargets = [
    ...new Set(successfulMutations.flatMap((mutation) => mutation.targets)),
  ];
  if (localMutationTargets.length === 0) {
    return {
      required: false,
      satisfied: true,
      reason: "turn did not perform successful local file mutations",
    };
  }

  const requestedTargets = localArtifactTargetsFromText(params.userText);
  if (requestedTargets.length > 0) {
    for (const target of localMutationTargets) {
      if (mutationTargetIsAllowedByRequestedScope(target, requestedTargets)) {
        continue;
      }
      return {
        required: true,
        satisfied: false,
        reason: `mutated ${target} outside the requested local target scope (${requestedTargets.join(", ")})`,
      };
    }
  }

  for (const mutation of successfulMutations) {
    for (const target of mutation.targets) {
      if (!mutationTargetRequiresPreEvidence(params.userText, target)) continue;
      if (
        successfulLocalEvidenceBefore(
          scopedMessages,
          mutation.messageIndex,
          target,
        )
      ) {
        continue;
      }
      return {
        required: true,
        satisfied: false,
        reason: `mutated ${target} before collecting matching local source evidence`,
      };
    }
  }

  const validationTargets = localMutationTargets.filter(
    mutationTargetRequiresValidation,
  );
  if (validationTargets.length > 0) {
    const lastCodeMutationIndex = Math.max(
      ...successfulMutations
        .filter((mutation) =>
          mutation.targets.some(mutationTargetRequiresValidation),
        )
        .map((mutation) => mutation.messageIndex),
    );
    if (!successfulValidationAfter(scopedMessages, lastCodeMutationIndex)) {
      return {
        required: true,
        satisfied: false,
        reason: `mutated code or configuration without successful validation after the final mutation (${validationTargets.join(", ")})`,
      };
    }
  }

  return {
    required: true,
    satisfied: true,
    reason: "implementation stayed scoped, evidence-backed, and validated",
  };
}

export function memorySearchNeedReason(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  harnessLimits?: Pick<HarnessLimits, "substantialToolCallThreshold">;
}): string | null {
  const substantialToolCallThreshold =
    params.harnessLimits?.substantialToolCallThreshold ??
    DEFAULT_SUBSTANTIAL_TOOL_CALL_THRESHOLD;
  const toolNames = scopedToolCallNames(params.messages);
  const nonMemoryToolCount = toolNames.filter(
    (name) => !isKhalaMemoryToolName(name),
  ).length;

  const performedMemorySearchRequiredMutation = scopedMessagesAfterLatestUser(
    params.messages,
  ).some((message) =>
    messageContentItems(message.content).some(
      (item) =>
        item.type === "toolCall" &&
        toolCallRequiresMemorySearchBeforeMutation(item),
    ),
  );

  if (performedMemorySearchRequiredMutation) {
    return "turn performed mutation";
  }

  if (nonMemoryToolCount >= substantialToolCallThreshold) {
    return `turn used ${nonMemoryToolCount} non-memory tool calls`;
  }

  if (nonMemoryToolCount > 0 && SUBSTANTIAL_TASK_REGEX.test(params.userText)) {
    return "user requested non-trivial tool-backed work";
  }

  return null;
}

export function learningCaptureNeedReason(params: {
  userText: string;
  assistantText: string;
}): string | null {
  if (EXPLICIT_LEARNING_CAPTURE_REGEX.test(params.userText)) {
    return "user explicitly requested durable memory capture";
  }

  if (ASSISTANT_MEMORY_CLAIM_REGEX.test(params.assistantText)) {
    return "assistant claimed it stored or learned durable memory";
  }

  return null;
}

export function findRedundantEvidenceToolCall(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  const seen = new Set<string>();
  const seenLocalArtifacts = new Map<string, string>();
  const seenMemoryQueries = new Map<string, string>();
  const seenExternalQueries = new Map<string, string>();
  const seenExternalOpenTargets = new Map<string, string>();

  for (const message of scopedMessages) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      if (isMemoryPersistenceToolName(item.name)) {
        for (const toolName of MEMORY_SEARCH_TOOL_NAMES) {
          deleteSeenToolEntries(seen, toolName);
        }
        seenMemoryQueries.clear();
        continue;
      }

      if (resetsDuplicateEvidenceWindowToolCall({
        toolName: item.name,
        input: item.arguments,
      })) {
        seen.clear();
        seenLocalArtifacts.clear();
        seenMemoryQueries.clear();
        seenExternalQueries.clear();
        seenExternalOpenTargets.clear();
        continue;
      }

      if (!isDuplicateEvidenceCandidateToolCall({
        toolName: item.name,
        input: item.arguments,
      })) {
        continue;
      }

      const key = `${item.name}:${normalizeToolArguments(item.arguments)}`;
      if (seen.has(key)) return item.name;
      seen.add(key);

      for (const target of localEvidenceDedupeTargets(
        item.name,
        item.arguments,
      )) {
        if (seenLocalArtifacts.has(target.key)) {
          return `local artifact ${
            seenLocalArtifacts.get(target.key) ?? target.label
          }`;
        }
        seenLocalArtifacts.set(target.key, target.label);
      }

      if (isMemorySearchToolName(item.name)) {
        const memoryQuery = canonicalMemorySearchQuery(item.arguments);
        if (memoryQuery && seenMemoryQueries.has(memoryQuery.key)) {
          return `khala_search_memory query ${
            seenMemoryQueries.get(memoryQuery.key) ?? memoryQuery.label
          }`;
        }
        if (memoryQuery) {
          seenMemoryQueries.set(memoryQuery.key, memoryQuery.label);
        }
      }

      if (
        isExternalSearchToolName(item.name) ||
        toolCallIsExternalEvidence(item.name, item.arguments)
      ) {
        for (const externalQuery of canonicalExternalSearchQueries(
          item.arguments,
        )) {
          if (seenExternalQueries.has(externalQuery.key)) {
            return `external search query ${
              seenExternalQueries.get(externalQuery.key) ?? externalQuery.label
            }`;
          }
          seenExternalQueries.set(externalQuery.key, externalQuery.label);
        }
      }

      if (isExternalOpenToolName(item.name)) {
        for (const openTarget of canonicalExternalOpenTargets(item.arguments)) {
          if (seenExternalOpenTargets.has(openTarget.key)) {
            return `external URL ${
              seenExternalOpenTargets.get(openTarget.key) ?? openTarget.label
            }`;
          }
          seenExternalOpenTargets.set(openTarget.key, openTarget.label);
        }
      }
    }
  }

  return null;
}

function findRedundantLearningCaptureCall(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  const storedLearningPayloads = new Set<string>();

  for (const [index, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (!isMemoryPersistenceToolName(item.name)) continue;
      if (!learningCaptureArgumentsAreConcrete(item.arguments)) continue;

      const key =
        canonicalLearningCaptureKey(item.arguments) ??
        normalizeToolArguments(item.arguments);
      if (storedLearningPayloads.has(key)) return "khala_learn";

      if (toolResultHasLearningStorageSuccess(scopedMessages[index + 1])) {
        storedLearningPayloads.add(key);
      }
    }
  }

  return null;
}

export function findInefficientShellEvidenceCall(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const message of scopedMessages) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsCommandEvidence(item.name, item.arguments)) continue;

      const command = extractCommandArgument(item.arguments);
      const reason = unboundedShellEvidenceReason(command);
      if (reason) return reason;
    }
  }

  return null;
}

export function findShellQuotingRepairLoop(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);
  let quotingFailureAttempts = 0;

  for (const [index, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      if (!toolCallIsCommandEvidence(item.name, item.arguments)) continue;

      const result = scopedMessages[index + 1];
      const resultText =
        result?.role === "toolResult" ? extractMessageText(result.content) : "";
      if (SHELL_QUOTING_ERROR_REGEX.test(resultText)) {
        quotingFailureAttempts += 1;
        if (quotingFailureAttempts >= 2) {
          return "repeated shell quoting failures; switch to read/edit APIs, a heredoc, or a checked script instead of repairing ad hoc quoting";
        }
        continue;
      }

      if (toolResultSucceeded(result)) {
        quotingFailureAttempts = 0;
      }
    }
  }

  return null;
}

export function findFullSessionArtifactRead(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const message of scopedMessages) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      const targets =
        isLocalFileReadToolName(item.name)
          ? localArtifactTargetsFromToolArguments(item.arguments)
          : toolCallIsCommandEvidence(item.name, item.arguments)
            ? localArtifactTargetsFromText(extractCommandArgument(item.arguments))
            : [];
      const sessionArtifact = targets.find((target) =>
        SESSION_ARTIFACT_SUMMARY_HINT_REGEX.test(target),
      );
      if (sessionArtifact) {
        return `full session artifact read for ${sessionArtifact}; prefer capsule/progress summaries or bounded excerpts first`;
      }
    }
  }

  return null;
}

export function findBroadEvidenceQueryCall(
  messages: AgentEndEventMessage[],
): string | null {
  const scopedMessages = scopedMessagesAfterLatestUser(messages);

  for (const message of scopedMessages) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;

      if (isMemorySearchToolName(item.name)) {
        const quality = memorySearchQueryQuality(
          extractQueryArgument(item.arguments),
        );
        if (!quality.focused) return `${item.name}: ${quality.reason}`;
        continue;
      }

      if (
        isExternalSearchToolName(item.name) ||
        toolCallIsExternalEvidence(item.name, item.arguments)
      ) {
        for (const query of extractExternalQueryArguments(item.arguments)) {
          const quality = externalEvidenceQueryQuality(query);
          if (!quality.focused) return `${item.name}: ${quality.reason}`;
        }
        continue;
      }

      if (item.name === "subagent") {
        const args = stringifyToolArguments(item.arguments);
        if (!toolCallMatchesSubagentRole(args, /\b(?:researcher|scout|oracle)\b/i)) {
          continue;
        }

        const quality = externalEvidenceQueryQuality(args);
        if (!quality.focused) return `${item.name}: ${quality.reason}`;
      }
    }
  }

  return null;
}

export function evaluateModelEscalation(params: {
  messages: AgentEndEventMessage[];
  assistantText: string;
  lowConfidenceThreshold: number;
  harnessLimits?: Pick<HarnessLimits, "toolFailureEscalationThreshold">;
}): ModelEscalationDecision {
  const confidence = extractResponseConfidence(params.assistantText);
  const lowConfidence =
    confidence !== null && confidence < params.lowConfidenceThreshold;
  const knowledgeGap = hasKnowledgeGapSignal(params.assistantText);
  const toolFailureCount = countToolFailures(params.messages);
  const toolFailureEscalationThreshold =
    params.harnessLimits?.toolFailureEscalationThreshold ??
    DEFAULT_TOOL_FAILURE_ESCALATION_THRESHOLD;
  const repeatedToolFailures =
    toolFailureCount >= toolFailureEscalationThreshold;
  const repeatedToolFailureIndex = repeatedToolFailures
    ? repeatedToolFailureTriggerIndex(
        params.messages,
        toolFailureEscalationThreshold,
      )
    : null;

  if (!lowConfidence && !knowledgeGap && !repeatedToolFailures) {
    return {
      required: false,
      satisfied: true,
      reason: "no low-confidence or knowledge-gap signal",
    };
  }

  const escalationSucceeded = conversationHasModelEscalation(
    params.messages,
    repeatedToolFailureIndex ?? -1,
  );
  const finalAnswerStillUnresolved = lowConfidence || knowledgeGap;
  const reasonParts: string[] = [];
  if (lowConfidence) {
    reasonParts.push(
      `reported confidence ${confidence?.toFixed(2)} below threshold ${params.lowConfidenceThreshold.toFixed(2)}`,
    );
  }
  if (knowledgeGap) reasonParts.push("assistant surfaced a knowledge gap");
  if (repeatedToolFailures) {
    reasonParts.push(`${toolFailureCount} tool failure results in this turn`);
  }

  return {
    required: true,
    satisfied: escalationSucceeded && !finalAnswerStillUnresolved,
    reason: reasonParts.join("; "),
  };
}

export function evaluateEvidenceRouting(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  assistantText?: string;
}): EvidenceRoutingDecision {
  const reasons: string[] = [];
  const sourceClasses = new Set<EvidenceSourceClass>();
  const localTargets = new Set<string>();
  const externalTargets = new Set<string>();
  const commandTargets = new Set<string>();
  const mutationTargets = new Set<string>();
  let requiresCitationResponse = false;
  let requiresCommandEvidence = false;
  const userReason = evidenceNeedReason(params.userText);
  if (userReason) {
    reasons.push(userReason);
    const sourceClass = evidenceSourceClassForUserText(params.userText) ?? "any";
    sourceClasses.add(sourceClass);
    if (sourceClass === "local") {
      for (const target of localArtifactTargetsFromText(params.userText)) {
        localTargets.add(target);
      }
    } else if (sourceClass === "external") {
      externalTargets.add(params.userText);
    }
  }
  const citationReason = citationResponseNeedReason(params.userText);
  if (citationReason) {
    reasons.push(citationReason);
    requiresCitationResponse = true;
  }

  const assistantClaim = assistantEvidenceClaimReason(
    params.assistantText ?? "",
  );
  if (assistantClaim) {
    reasons.push(assistantClaim.reason);
    sourceClasses.add(assistantClaim.sourceClass);
    if (assistantClaim.sourceClass === "local") {
      for (const target of localArtifactTargetsFromText(
        params.assistantText ?? "",
      )) {
        localTargets.add(target);
      }
    } else if (assistantClaim.sourceClass === "external") {
      const targetText = assistantExternalClaimTargetText(
        params.assistantText ?? "",
      );
      if (targetText) {
        externalTargets.add(targetText);
      } else if (externalEvidenceRequiresOfficialSource(params.assistantText ?? "")) {
        externalTargets.add(params.assistantText ?? "");
      }
    }
  }

  const commandClaim = assistantCommandVerificationClaimReason(
    params.assistantText ?? "",
  );
  if (commandClaim) {
    reasons.push(commandClaim.reason);
    sourceClasses.add("command");
    for (const target of commandClaim.targets) commandTargets.add(target);
    if (commandClaim.targets.length > 0) {
      requiresCommandEvidence = true;
    }
  }

  const mutationClaim = assistantMutationClaimReason(params.assistantText ?? "");
  if (mutationClaim) {
    reasons.push(mutationClaim.reason);
    sourceClasses.add("mutation");
    for (const target of mutationClaim.targets) mutationTargets.add(target);
  }

  const toolPromise = assistantToolWorkPromiseReason(params.assistantText ?? "");
  if (toolPromise) {
    reasons.push(toolPromise.reason);
    for (const sourceClass of toolPromise.sourceClasses) {
      sourceClasses.add(sourceClass);
    }
    if (toolPromise.sourceClasses.includes("local")) {
      for (const target of toolPromise.localTargets) localTargets.add(target);
    }
    for (const target of toolPromise.commandTargets) commandTargets.add(target);
    if (
      toolPromise.sourceClasses.includes("command") &&
      toolPromise.commandTargets.length > 0
    ) {
      requiresCommandEvidence = true;
    }
    if (toolPromise.sourceClasses.includes("external")) {
      const targetText = assistantExternalToolTargetText(
        params.assistantText ?? "",
      );
      if (targetText) externalTargets.add(targetText);
    }
    for (const target of toolPromise.mutationTargets) {
      mutationTargets.add(target);
    }
  }

  const toolCompletion = assistantToolWorkCompletionReason(
    params.assistantText ?? "",
  );
  if (toolCompletion) {
    reasons.push(toolCompletion.reason);
    for (const sourceClass of toolCompletion.sourceClasses) {
      sourceClasses.add(sourceClass);
    }
    if (toolCompletion.sourceClasses.includes("local")) {
      for (const target of toolCompletion.localTargets) localTargets.add(target);
    }
    for (const target of toolCompletion.commandTargets) {
      commandTargets.add(target);
    }
    if (
      toolCompletion.sourceClasses.includes("command") &&
      toolCompletion.commandTargets.length > 0
    ) {
      requiresCommandEvidence = true;
    }
    if (toolCompletion.sourceClasses.includes("external")) {
      const targetText = assistantExternalToolTargetText(
        params.assistantText ?? "",
      );
      if (targetText) externalTargets.add(targetText);
    }
  }

  if (reasons.length === 0) {
    return {
      required: false,
      satisfied: true,
      reason: "request does not require source-backed evidence",
    };
  }

  const requiredSourceClasses = [...sourceClasses].filter(
    (sourceClass) => !(sourceClass === "command" && requiresCommandEvidence),
  );
  const hasRequiredEvidenceClasses = requiredSourceClasses.every((sourceClass) =>
    conversationHasEvidenceTool(
      params.messages,
      sourceClass,
      sourceClass === "external" ? [...externalTargets].join("\n") : "",
    ),
  );
  const hasRequiredLocalTargets =
    localTargets.size === 0 ||
    [...localTargets].every((target) =>
      conversationHasLocalEvidenceTarget(params.messages, target),
    );
  const hasRequiredCommandEvidence =
    !requiresCommandEvidence ||
    conversationHasCommandEvidence(params.messages, [...commandTargets]);
  const hasRequiredMutationEvidence =
    mutationTargets.size === 0 ||
    conversationHasMutationEvidence(params.messages, [...mutationTargets]);
  const hasRequiredCitationResponse =
    !requiresCitationResponse ||
    (assistantHasCitationResponse(params.assistantText ?? "") &&
      assistantCitationTargetsBackedByEvidence(
        params.messages,
        params.assistantText ?? "",
      ));

  return {
    required: true,
    satisfied:
      hasRequiredEvidenceClasses &&
      hasRequiredLocalTargets &&
      hasRequiredCommandEvidence &&
      hasRequiredMutationEvidence &&
      hasRequiredCitationResponse,
    reason: reasons.join("; "),
  };
}

export function evaluateSkillRouting(params: {
  assistantText?: string;
  messages: AgentEndEventMessage[];
  userText: string;
}): SkillRoutingDecision {
  const need = skillRoutingNeed(params);
  if (!need) {
    return {
      required: false,
      satisfied: true,
      reason: "request does not require a skill route",
    };
  }

  return {
    required: true,
    satisfied: conversationHasSkillRead(params.messages, need.requiredSkills),
    reason: need.reason,
  };
}

export function evaluateMemorySearchRouting(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  harnessLimits?: Pick<HarnessLimits, "substantialToolCallThreshold">;
}): MemorySearchRoutingDecision {
  const reason = memorySearchNeedReason(params);
  if (!reason) {
    return {
      required: false,
      satisfied: true,
      reason: "turn was trivial enough for bootstrap memory",
    };
  }

  const mutationOrPersistence = reason === "turn performed mutation";
  const substantialToolCallThreshold =
    params.harnessLimits?.substantialToolCallThreshold ??
    DEFAULT_SUBSTANTIAL_TOOL_CALL_THRESHOLD;

  return {
    required: true,
    satisfied: mutationOrPersistence
      ? conversationHasMemorySearchBeforeFirstMutation(
          params.messages,
          substantialToolCallThreshold,
          params.userText,
        )
      : conversationHasMemorySearch(
          params.messages,
          substantialToolCallThreshold,
          params.userText,
        ),
    reason,
  };
}

export function evaluateLearningCapture(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  assistantText: string;
}): LearningCaptureDecision {
  const reason = learningCaptureNeedReason(params);
  if (!reason) {
    return {
      required: false,
      satisfied: true,
      reason: "turn does not require durable learning capture",
    };
  }

  const learningTargetText =
    reason === "assistant claimed it stored or learned durable memory"
      ? `${params.userText}\n${params.assistantText}`
      : params.userText;

  return {
    required: true,
    satisfied: conversationHasLearningCapture(params.messages, learningTargetText),
    reason,
  };
}

export function evaluateToolEfficiency(params: {
  messages: AgentEndEventMessage[];
}): ToolEfficiencyDecision {
  const duplicateToolName = findRedundantEvidenceToolCall(params.messages);
  if (!duplicateToolName) {
    const shellQuotingRepairReason = findShellQuotingRepairLoop(params.messages);
    if (shellQuotingRepairReason) {
      return {
        efficient: false,
        reason: shellQuotingRepairReason,
      };
    }

    const inefficientShellReason = findInefficientShellEvidenceCall(
      params.messages,
    );
    if (inefficientShellReason) {
      return {
        efficient: false,
        reason: `${inefficientShellReason}; use bounded read/search tools or add explicit limits`,
      };
    }

    const fullSessionArtifactReason = findFullSessionArtifactRead(
      params.messages,
    );
    if (fullSessionArtifactReason) {
      return {
        efficient: false,
        reason: fullSessionArtifactReason,
      };
    }

    const broadQueryReason = findBroadEvidenceQueryCall(params.messages);
    if (broadQueryReason) {
      return {
        efficient: false,
        reason: `${broadQueryReason}; use a focused task-specific query`,
      };
    }

    const duplicateLearningToolName = findRedundantLearningCaptureCall(
      params.messages,
    );
    if (duplicateLearningToolName) {
      return {
        efficient: false,
        reason:
          "repeated khala_learn storage for the same trigger and lesson after a successful write; reuse the stored lesson instead of writing it again",
      };
    }

    return {
      efficient: true,
      reason:
        "no redundant evidence, unbounded shell, shell-quoting repair loop, full session artifact read, broad query, or duplicate learning-storage calls detected",
    };
  }

  return {
    efficient: false,
    reason: duplicateToolName.startsWith("local artifact ")
      ? `repeated local evidence for ${duplicateToolName.replace(/^local artifact /, "")} without an intervening mutation`
      : duplicateToolName.startsWith("khala_search_memory query ")
        ? `repeated khala_search_memory query for ${duplicateToolName.replace(/^khala_search_memory query /, "")} without an intervening mutation`
        : duplicateToolName.startsWith("external search query ")
          ? `repeated external search query for ${duplicateToolName.replace(/^external search query /, "")} without an intervening mutation`
        : duplicateToolName.startsWith("external URL ")
          ? `repeated external URL evidence for ${duplicateToolName.replace(/^external URL /, "")} without an intervening mutation`
      : `repeated identical ${duplicateToolName} call without an intervening mutation`,
  };
}

export function evaluateHarnessTurnMetrics(params: {
  messages: AgentEndEventMessage[];
}): HarnessTurnMetrics {
  const scopedMessages = scopedMessagesAfterLatestUser(params.messages);
  const metrics: HarnessTurnMetrics = {
    scopedMessageCount: scopedMessages.length,
    toolCallCount: 0,
    memorySearches: {
      total: 0,
      focused: 0,
      successful: 0,
    },
    skillLoads: 0,
    externalEvidenceCalls: 0,
    commandEvidenceCalls: 0,
    mutationCalls: 0,
    learningCaptures: 0,
    modelEscalations: 0,
    wasteSignals: {
      duplicateEvidence: findRedundantEvidenceToolCall(params.messages) !== null,
      inefficientShell: findInefficientShellEvidenceCall(params.messages) !== null,
      shellQuotingRepairLoop: findShellQuotingRepairLoop(params.messages) !== null,
      fullSessionArtifactRead: findFullSessionArtifactRead(params.messages) !== null,
      broadQuery: findBroadEvidenceQueryCall(params.messages) !== null,
      duplicateLearning: findRedundantLearningCaptureCall(params.messages) !== null,
      count: 0,
    },
  };
  metrics.wasteSignals.count = [
    metrics.wasteSignals.duplicateEvidence,
    metrics.wasteSignals.inefficientShell,
    metrics.wasteSignals.shellQuotingRepairLoop,
    metrics.wasteSignals.fullSessionArtifactRead,
    metrics.wasteSignals.broadQuery,
    metrics.wasteSignals.duplicateLearning,
  ].filter(Boolean).length;

  for (const [messageIndex, message] of scopedMessages.entries()) {
    for (const item of messageContentItems(message.content)) {
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      metrics.toolCallCount += 1;

      if (isMemorySearchToolName(item.name)) {
        metrics.memorySearches.total += 1;
        if (memorySearchQueryQuality(extractQueryArgument(item.arguments)).focused) {
          metrics.memorySearches.focused += 1;
        }
        if (
          memorySearchToolResultHasSubstantiveEvidence(
            scopedMessages[messageIndex + 1],
          )
        ) {
          metrics.memorySearches.successful += 1;
        }
      }

      if (isMemoryPersistenceToolName(item.name)) {
        metrics.learningCaptures += 1;
      }

      if (
        isLocalFileReadToolName(item.name) &&
        skillReadPathTargetsFromArgs(item.arguments).some(isSkillReadPath)
      ) {
        metrics.skillLoads += 1;
      } else if (
        isSkillLoaderToolName(item.name) &&
        skillLoaderTargetsFromArgs(item.arguments).length > 0
      ) {
        metrics.skillLoads += 1;
      } else if (
        item.name === "subagent" &&
        /\b(?:skills?|assignedSkills?)\b/i.test(stringifyToolArguments(item.arguments))
      ) {
        metrics.skillLoads += 1;
      }

      if (toolCallIsExternalEvidence(item.name, item.arguments)) {
        metrics.externalEvidenceCalls += 1;
      }

      if (toolCallIsCommandEvidence(item.name, item.arguments)) {
        metrics.commandEvidenceCalls += 1;
      }

      if (toolCallIsMutationEvidence(item.name, item.arguments)) {
        metrics.mutationCalls += 1;
      }

      if (isModelEscalationToolCall(item.name, stringifyToolArguments(item.arguments))) {
        metrics.modelEscalations += 1;
      }
    }
  }

  return metrics;
}

function shouldBlockHarnessIssue(mode: string): boolean {
  return mode === "enforce";
}

export function evaluateHarnessTurn(params: {
  messages: AgentEndEventMessage[];
  userText: string;
  assistantText: string;
  lowConfidenceThreshold: number;
  responseComplianceMode: string;
  harnessLimits?: Pick<
    HarnessLimits,
    "substantialToolCallThreshold" | "toolFailureEscalationThreshold"
  >;
}): HarnessTurnIssue[] {
  if (PREFLIGHT_LINE_REGEX.test(params.assistantText.trim())) return [];

  const block = shouldBlockHarnessIssue(params.responseComplianceMode);
  const issues: HarnessTurnIssue[] = [];

  const toolEfficiency = evaluateToolEfficiency({
    messages: params.messages,
  });
  if (!toolEfficiency.efficient) {
    issues.push({
      code: "tool_efficiency",
      title: "TOOL EFFICIENCY WARNING",
      block,
      remediation: {
        action: "reuse_cached_or_narrow_tool",
        cheapestTool: "cached observation or focused evidence tool",
        retry:
          "Reuse the first successful result, narrow the query, or switch to a different evidence source before answering.",
        avoid: [
          "duplicate evidence calls",
          "broad searches",
          "unbounded shell output",
          "shell-quoting repair loops",
          "full session artifact reads when summaries suffice",
          "placeholder tool results",
        ],
      },
      message: [
        "TOOL EFFICIENCY WARNING",
        "",
        `The turn repeated evidence collection unnecessarily (${toolEfficiency.reason}).`,
        "Prefer cached observations from the first result, narrower follow-up searches, or a different evidence source before finalizing.",
        "Repeated identical reads/searches waste tokens and usually do not improve confidence.",
      ].join("\n"),
    });
  }

  const memorySearchRouting = evaluateMemorySearchRouting({
    messages: params.messages,
    userText: params.userText,
    harnessLimits: params.harnessLimits,
  });
  if (memorySearchRouting.required && !memorySearchRouting.satisfied) {
    issues.push({
      code: "memory_search",
      title: "MEMORY SEARCH REQUIRED",
      block,
      remediation: {
        action: "run_focused_memory_search",
        cheapestTool: "khala_search_memory",
        retry:
          "Call khala_search_memory with concrete task terms from the latest user request, then retry with the memory result synthesized.",
        avoid: [
          "broad memory searches",
          "duplicate searches",
          "placeholder memory results",
        ],
      },
      message: [
        "MEMORY SEARCH REQUIRED",
        "",
        `The turn needed task-specific memory retrieval (${memorySearchRouting.reason}).`,
        "Call khala_search_memory with a focused query built from the user request, workflow, technologies, files, symbols, errors, skills, corrections, and user intent, then synthesize the result.",
        "Do not rely on the short bootstrap memory tail for substantial work.",
      ].join("\n"),
    });
  }

  const learningCapture = evaluateLearningCapture({
    messages: params.messages,
    userText: params.userText,
    assistantText: params.assistantText,
  });
  if (learningCapture.required && !learningCapture.satisfied) {
    issues.push({
      code: "learning_capture",
      title: "LEARNING CAPTURE REQUIRED",
      block,
      remediation: {
        action: "store_durable_learning",
        cheapestTool: "khala_learn",
        retry:
          "Persist the concrete trigger, lesson, evidence snippet, score, and confidence, then retry without promising memory that was not stored.",
        avoid: [
          "vague triggers",
          "low-confidence lessons",
          "placeholder storage results",
        ],
      },
      message: [
        "LEARNING CAPTURE REQUIRED",
        "",
        `The turn needed durable memory storage (${learningCapture.reason}).`,
        "Call khala_learn with a concrete trigger, lesson, evidence snippet, score, and confidence before claiming the lesson is remembered.",
        "Do not promise future recall unless the learning record was actually persisted.",
      ].join("\n"),
    });
  }

  const skillRouting = evaluateSkillRouting({
    assistantText: params.assistantText,
    messages: params.messages,
    userText: params.userText,
  });
  if (skillRouting.required && !skillRouting.satisfied) {
    issues.push({
      code: "skill_routing",
      title: "SKILL READ REQUIRED",
      block,
      remediation: {
        action: "load_required_skill",
        cheapestTool: "read SKILL.md",
        retry:
          "Read the exact required SKILL.md, or delegate to a subagent with that skill explicitly assigned, then retry using the loaded instructions.",
        avoid: [
          "manifest-only skill mentions",
          "unrelated skill loads",
          "placeholder skill results",
        ],
      },
      message: [
        "SKILL READ REQUIRED",
        "",
        `The latest turn required skill routing (${skillRouting.reason}).`,
        "Read the relevant SKILL.md first, or delegate to a subagent with that skill explicitly assigned, then retry the answer.",
        "Do not claim skill-specific behavior from the manifest alone.",
      ].join("\n"),
    });
  }

  const evidenceRouting = evaluateEvidenceRouting({
    messages: params.messages,
    userText: params.userText,
    assistantText: params.assistantText,
  });
  if (evidenceRouting.required && !evidenceRouting.satisfied) {
    issues.push({
      code: "evidence_routing",
      title: "EVIDENCE ROUTING REQUIRED",
      block,
      remediation: {
        action: "collect_matching_evidence",
        cheapestTool: "matching local, memory, command, or focused external evidence",
        retry:
          "Use the cheapest evidence source that matches the requested artifact, command, source, citation, or current fact, then retry with the result.",
        avoid: [
          "unrelated local reads",
          "unrun command claims",
          "broad external searches",
          "generic page-loaded results",
        ],
      },
      message: [
        "EVIDENCE ROUTING REQUIRED",
        "",
        `The latest turn needs matching evidence (${evidenceRouting.reason}).`,
        "Use the cheapest matching evidence path first: local read/search tools for local artifacts, khala_search_memory for stored lessons, and focused web/search/researcher tools for external, current, URL, or documentation facts.",
        "Do not answer from memory alone, unrelated local reads, or unrun commands when the turn requires source-backed, command-backed, current, or artifact-specific verification.",
      ].join("\n"),
    });
  }

  const implementationQuality = evaluateImplementationQuality({
    messages: params.messages,
    userText: params.userText,
  });
  if (implementationQuality.required && !implementationQuality.satisfied) {
    issues.push({
      code: "implementation_quality",
      title: "IMPLEMENTATION QUALITY REQUIRED",
      block,
      remediation: {
        action: "repair_scoped_validated_implementation",
        cheapestTool: "matching local read/search plus focused validation command",
        retry:
          "Inspect the target before mutating it, revert or explain unrelated mutations, run validation after the final code/config mutation, then retry the final response with scoped proof.",
        avoid: [
          "drive-by edits",
          "editing target files before reading them",
          "stale pre-change validation",
          "unvalidated code or config mutations",
        ],
      },
      message: [
        "IMPLEMENTATION QUALITY REQUIRED",
        "",
        `The implementation path was not best-solution quality (${implementationQuality.reason}).`,
        "Keep mutations scoped to concrete requested targets, inspect matching local evidence before edits, and run validation after the final code or configuration mutation.",
      ].join("\n"),
    });
  }

  const workflowContract = evaluateWorkflowContract({
    assistantText: params.assistantText,
    messages: params.messages,
    userText: params.userText,
  });
  if (workflowContract.required && !workflowContract.satisfied) {
    issues.push({
      code: "workflow_drift",
      title: "WORKFLOW DRIFT WARNING",
      block,
      remediation: {
        action: "resume_ordered_workflow_step",
        cheapestTool: "workflow contract and cheapest matching evidence tool",
        retry:
          "Resume at the earliest unfinished workflow step, load any required guide, collect matching evidence, run validation, then retry the final response with the result.",
        avoid: [
          "skipped workflow steps",
          "repeated evidence loops",
          "guide-free workflow claims",
          "unvalidated workflow success",
          "premature success reports",
        ],
      },
      message: [
        "WORKFLOW DRIFT WARNING",
        "",
        `The deterministic workflow contract was not satisfied (${workflowContract.reason}).`,
        "Resume at the earliest unfinished workflow step, take the smallest evidence-backed action for that step, and do not report success until required guides, implementation evidence, and validation are complete.",
      ].join("\n"),
    });
  }

  const escalation = evaluateModelEscalation({
    messages: params.messages,
    assistantText: params.assistantText,
    lowConfidenceThreshold: params.lowConfidenceThreshold,
    harnessLimits: params.harnessLimits,
  });
  if (escalation.required && !escalation.satisfied) {
    issues.push({
      code: "model_escalation",
      title: "MODEL ESCALATION REQUIRED",
      block,
      remediation: {
        action: "escalate_to_stronger_model",
        cheapestTool: "stronger advisory subagent",
        retry:
          "Ask an oracle, researcher, or reviewer subagent with a strong model or high-effort override a concrete question, then synthesize its substantive answer.",
        avoid: [
          "same-model delegation",
          "vague escalation tasks",
          "hedged advisory results",
          "echoed escalation prompts",
        ],
      },
      message: [
        "MODEL ESCALATION REQUIRED",
        "",
        `The assistant ended with unresolved uncertainty (${escalation.reason}).`,
        "Escalate before finalizing: use a stronger advisory path such as `subagent` with oracle/researcher/reviewer and a strong model or high-thinking override, then synthesize the result.",
        "Do not guess, bury the knowledge gap, or ask the user to trust a low-confidence answer.",
      ].join("\n"),
    });
  }

  return issues;
}
