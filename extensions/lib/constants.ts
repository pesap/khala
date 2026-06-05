export const AGENT_STATE_TYPE = "khala-state";
export const LEARNING_STORE_DIRNAME = "khala";
export const LEARNING_VERSION = 1;
export const MEMORY_TAIL_LINES = 20;
export const PROMOTION_MIN_OBSERVATIONS = 3;
export const PROMOTION_SUCCESS_THRESHOLD = 0.75;
export const PROMOTION_IMPROVEMENT_THRESHOLD = 0.4;
export const RISK_APPROVAL_TYPE = "khala-risk-approval";
export const RISK_APPROVAL_TTL_MINUTES = 20;
export const PREFLIGHT_STATE_TYPE = "khala-preflight-state";
export const POSTFLIGHT_EVENT_TYPE = "khala-postflight-event";
export const POLICY_EVENT_TYPE = "khala-policy-event";
export const HARNESS_ISSUE_TYPE = "khala-harness-issue";
export const COMPLIANCE_MODE_TYPE = "khala-compliance-mode";

export const REVIEW_COMMAND_SOURCE = "https://github.com/earendil-works/pi-review";
export const GIT_REVIEW_COMMAND_SOURCE = "https://piechowski.io/post/git-commands-before-reading-code/";
export const SIMPLIFY_COMMAND_SOURCE = "https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md";
export const PLAN_COMMAND_SOURCE = "https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs";
export const SHIP_COMMAND_SOURCE = "khala://workflow/ship";
export const INBOX_COMMAND_SOURCE = "khala://workflow/inbox";
export const WORKON_COMMAND_SOURCE = "khala://workflow/workon";
export const AUDIT_COMMAND_SOURCE = "khala://workflow/audit";
export const TRIAGE_ISSUE_COMMAND_SOURCE = "https://github.com/mattpocock/skills/tree/main/skills/engineering/triage";
export const TDD_COMMAND_SOURCE = "https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd";
export const ADDRESS_OPEN_ISSUES_COMMAND_SOURCE = "khala://workflow/address-open-issues";

export const PREFLIGHT_LINE_REGEX = /^Preflight:\s+skill=([a-zA-Z0-9_.-]+|none)\s+reason="([^"]{1,200})"\s+clarify=(yes|no)\s*$/;
export const POSTFLIGHT_LINE_REGEX = /^Postflight:\s+verify="([^"]{1,280})"\s+result=(pass|fail|not-run)\s*$/;
export const MUTATION_BASH_PATTERN = /(?:^|\n|[;|&]{1,2})\s*(?:git\s+(?:add|apply|am|commit|checkout|switch|merge|rebase|cherry-pick|revert|reset|restore|clean|stash|tag|branch|push|pull)(?=\s|$|[;|&])|rm\b|mv\b|cp\b|mkdir\b|rmdir\b|touch\b|chmod\b|chown\b|sed\b[^\n;|&]*\s-i\b|perl\b[^\n;|&]*\s-i\b|tee\b|truncate\b|dd\b)/m;
export const POSTFLIGHT_INSTRUCTION = "Instruction: If you ran any mutation tool (edit/write/mutating bash), include exactly one line: `Postflight: verify=\"<command_or_check>\" result=<pass|fail|not-run>`.";
export const REQUIRED_WORKFLOW_FOOTER_INSTRUCTION = "Instruction: End your final response with a `Bias Check (Tier 1)` section containing: claim/hypothesis tested, key assumptions, strongest supporting evidence, strongest contradicting/weakening evidence, most plausible alternative explanation, confidence (0..1), and what would change your mind; then include `Result: success|partial|failed` and `Confidence: <0..1>`. Missing result or confidence line is treated as failed.";

export const BLOCKED_COMMAND_PATTERNS = {
  pip: /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m,
  pip3: /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m,
  poetry: /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m,
  pythonPip: /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m,
  pythonVenv: /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m,
  pythonPyCompile:
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m,
  pythonExplicitPath:
    /(?:^|\n|[;|&]{1,2})\s*(?:(?:env(?:\s+-\S+(?:\s+\S+)?)?(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+)|(?:command|builtin|exec|nohup|time)(?:\s+-\S+(?:\s+\S+)?)*\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:\S+\/)python(?:3(?:\.\d+)?)?\b(?=\s|$)/m,
};

export const UV_INSTALL_GUIDANCE = [
  "To install a package for a script: uv run --with PACKAGE python script.py",
  "To add a dependency to the project: uv add PACKAGE",
];

export const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /(?:^|\n|[;|&]{1,2})\s*(?:sudo\s+)?rm\b[^\n;|&]*\s-(?:[^\s\n;|&]*r[^\s\n;|&]*f|[^\s\n;|&]*f[^\s\n;|&]*r)\b/m,
    detail: "recursive forced delete",
  },
  { pattern: /(?:^|\n|[;|&]{1,2})\s*(?:sudo\s+)?find\b[^\n;|&]*\s-delete\b/m, detail: "find -delete" },
  { pattern: /(?:^|\n|[;|&]{1,2})\s*git\s+reset\b[^\n;|&]*\s--hard\b/m, detail: "git reset --hard" },
  { pattern: /(?:^|\n|[;|&]{1,2})\s*git\s+clean\b[^\n;|&]*\s-[^\s\n;|&]*f[^\s\n;|&]*\b/m, detail: "git clean -f" },
  {
    pattern: /(?:^|\n|[;|&]{1,2})\s*git\s+push\b[^\n;|&]*(?:\s--force(?:-with-lease)?\b|\s-[^\s\n;|&]*f[^\s\n;|&]*\b)/m,
    detail: "forced git push",
  },
  { pattern: /(?:^|\n|[;|&]{1,2})\s*(?:sudo\s+)?mkfs\.[a-z0-9]+\b/m, detail: "filesystem formatting" },
];

export const SENSITIVE_COMMAND_PATTERNS: Array<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /(?:^|\n|[;|&]{1,2})\s*(?:cat|less|more|head|tail)\s+[^\n;|&]*(?:\.env(?:\.[\w-]+)?|id_rsa|id_ed25519|\.pem|credentials?|secrets?)\b/m,
    detail: "potential secret material read",
  },
  {
    pattern: /(?:^|\n|[;|&]{1,2})\s*(?:printenv|env)\b[^\n;|&]*(?:token|secret|password|api[_-]?key)\b/i,
    detail: "potential secret environment output",
  },
];
