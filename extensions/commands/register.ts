import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type ArgumentCompletions = (prefix: string) => AutocompleteItem[] | null;

interface CommandRegistrarDeps {
  pi: ExtensionAPI;
  handlers: {
    khalaMode: CommandHandler;
    khalaHealth: CommandHandler;
    khalaHub: CommandHandler;
    approveRisk: CommandHandler;
    preflight: CommandHandler;
    postflight: CommandHandler;
    debug: CommandHandler;
    review: CommandHandler;
    gitReview: CommandHandler;
    simplify: CommandHandler;
    ship: CommandHandler;
    inbox: CommandHandler;
    workon: CommandHandler;
    plan: CommandHandler;
    audit: CommandHandler;
    triage: CommandHandler;
    addressOpenIssues: CommandHandler;
    learnSkill: CommandHandler;
    skillStatus: CommandHandler;
    skillReport: CommandHandler;
    pinSkill: CommandHandler;
    archiveSkill: CommandHandler;
    restoreSkill: CommandHandler;
    khalaReload: CommandHandler;
    workflowList: CommandHandler;
    workflowShow: CommandHandler;
    workflowRun: CommandHandler;
    runList: CommandHandler;
    runShow: CommandHandler;
    runResume: CommandHandler;
    runCheckpoint: CommandHandler;
    ruleList: CommandHandler;
    ruleShow: CommandHandler;
    ruleAdd: CommandHandler;
    rulePromote: CommandHandler;
    ruleSession: CommandHandler;
    ruleReplace: CommandHandler;
    ruleDisable: CommandHandler;
    ruleAudit: CommandHandler;
    ruleReload: CommandHandler;
  };
  completions?: {
    learnedSkills?: ArgumentCompletions;
    learnedWorkflows?: ArgumentCompletions;
  };
}

export function registerCommands({
  pi,
  handlers,
  completions,
}: CommandRegistrarDeps): void {
  const commands = [
    { name: "khala-mode", description: "Inspect or change Khala compliance modes without enabling Khala (/khala-mode warn); use /khala-health for read-only status", handler: handlers.khalaMode },
    { name: "khala-health", description: "Inspect read-only Khala health/status without enabling Khala or changing compliance", handler: handlers.khalaHealth },
    { name: "khala-hub", description: "Report or set the Khala hub storage path for the LLM wiki", handler: handlers.khalaHub },
    { name: "approve-risk", description: "Record checker approval for one high-risk command", handler: handlers.approveRisk },
    { name: "preflight", description: "Set mutation intent line for first-principles gate", handler: handlers.preflight },
    { name: "postflight", description: "Record verification evidence line for first-principles gate", handler: handlers.postflight },
    { name: "debug", description: "Investigate a maintainer-observed unreported symptom and draft a new issue proposal", handler: handlers.debug },
    { name: "review", description: "Run the khala code review workflow (adapted from pi-review)", handler: handlers.review },
    { name: "git-review", description: "Run git history diagnostics before reading code", handler: handlers.gitReview },
    { name: "simplify", description: "Run the khala code simplification workflow", handler: handlers.simplify },
    { name: "ship", description: "Simplify, verify, push current branch, and open PR/MR", handler: handlers.ship },
    { name: "inbox", description: "Show a read-only maintainer inbox from local, forge, and session signals", handler: handlers.inbox },
    { name: "workon", description: "Bootstrap autonomous work from a ready issue/work packet", handler: handlers.workon },
    { name: "plan", description: "Run rigorous planning workflow with edge-case capture and context/ADR updates", handler: handlers.plan },
    { name: "audit", description: "Run a full anti-confirmation-bias claim audit", handler: handlers.audit },
    { name: "triage", description: "Clean a user-posted issue or request into an approved /workon-ready packet", handler: handlers.triage },
    { name: "address-open-issues", description: "Sweep open issues authored by you through triage, workon, review, and remediation", handler: handlers.addressOpenIssues },
    { name: "learn-skill", description: "Create and refine a reusable skill", handler: handlers.learnSkill },
    { name: "skill-status", description: "Show learned skill provenance and lifecycle status", handler: handlers.skillStatus },
    { name: "skill-report", description: "Regenerate the learned skill curator report", handler: handlers.skillReport },
    { name: "pin-skill", description: "Pin or unpin a learned skill to exclude it from autonomous curation", handler: handlers.pinSkill },
    { name: "archive-skill", description: "Archive a learned skill without deleting it", handler: handlers.archiveSkill },
    { name: "restore-skill", description: "Restore an archived learned skill", handler: handlers.restoreSkill },
    { name: "khala-reload", description: "Reload Pi resources so khala learned skills and workflow prompts become slash commands", handler: handlers.khalaReload },
    { name: "workflow-list", description: "List reviewed khala learned workflows", handler: handlers.workflowList },
    { name: "workflow-show", description: "Show a khala learned workflow artifact and prompt template", handler: handlers.workflowShow },
    { name: "workflow-run", description: "Run a khala learned workflow by sending it to the agent", handler: handlers.workflowRun },
    { name: "run-list", description: "List khala durable run ledgers, optionally filtered by text", handler: handlers.runList },
    { name: "run-show", description: "Show a khala durable run ledger", handler: handlers.runShow },
    { name: "run-resume", description: "Resume a khala durable run only when recovery is classified safe", handler: handlers.runResume },
    { name: "run-checkpoint", description: "Record a safe checkpoint in a khala durable run ledger", handler: handlers.runCheckpoint },
    { name: "rule-list", description: "List active khala runtime rules", handler: handlers.ruleList },
    { name: "rule-show", description: "Show a khala runtime rule by id", handler: handlers.ruleShow },
    { name: "rule-add", description: "Add a durable khala runtime rule", handler: handlers.ruleAdd },
    { name: "rule-promote", description: "Promote a khala runtime rule candidate", handler: handlers.rulePromote },
    { name: "rule-session", description: "Add a per-session khala runtime rule", handler: handlers.ruleSession },
    { name: "rule-replace", description: "Append a replacement record for a khala runtime rule", handler: handlers.ruleReplace },
    { name: "rule-disable", description: "Disable a khala runtime rule", handler: handlers.ruleDisable },
    { name: "rule-audit", description: "Show recent khala runtime rule audit events", handler: handlers.ruleAudit },
    { name: "rule-reload", description: "Reload user-edited khala rules/RULES.md", handler: handlers.ruleReload },
  ] as const;

  for (const command of commands) {
    const getArgumentCompletions =
      command.name === "skill-status" ||
      command.name === "pin-skill" ||
      command.name === "archive-skill" ||
      command.name === "restore-skill"
        ? completions?.learnedSkills
        : command.name === "workflow-show" || command.name === "workflow-run"
          ? completions?.learnedWorkflows
          : undefined;
    pi.registerCommand(command.name, {
      description: command.description,
      ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
      handler: command.handler,
    });
  }
}
