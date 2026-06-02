import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantEvidenceClaimReason,
  assistantHasCitationResponse,
  assistantCommandVerificationClaimReason,
  assistantClaimedSkillNames,
  assistantMutationClaimReason,
  assistantToolWorkCompletionReason,
  assistantToolWorkPromiseReason,
  conversationHasCommandEvidence,
  conversationHasEvidenceTool,
  conversationHasLocalEvidenceTarget,
  conversationHasLearningCapture,
  conversationHasMemorySearch,
  conversationHasMemorySearchBeforeFirstMutation,
  conversationHasModelEscalation,
  conversationHasMutationEvidence,
  conversationHasSkillRead,
  countToolFailures,
  citationResponseNeedReason,
  evaluateEvidenceRouting,
  evaluateHarnessTurn,
  evaluateLearningCapture,
  evaluateMemorySearchRouting,
  evaluateModelEscalation,
  evaluateSkillRouting,
  evaluateToolEfficiency,
  evidenceNeedReason,
  externalEvidenceQueryQuality,
  explicitSkillNamesForUserText,
  extractResponseConfidence,
  findInefficientShellEvidenceCall,
  findBroadEvidenceQueryCall,
  findRedundantEvidenceToolCall,
  hasKnowledgeGapSignal,
  learningCaptureNeedReason,
  localArtifactTargetsFromText,
  memorySearchNeedReason,
  memorySearchQueryQuality,
  modelEscalationRequestQuality,
  recommendedSkillsForUserText,
  skillNeedReason,
} from "../../extensions/runtime/escalation.ts";

type Message = Parameters<typeof conversationHasModelEscalation>[0][number];

function textMessage(role: Message["role"], text: string): Message {
  return {
    role,
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}

function toolResult(text: string): Message {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
  };
}

const concreteLearnArgs = {
  trigger: "repo search workflow",
  lesson: "Use rg before slower repository search tools on codebase tasks.",
  evidenceSnippet: "User explicitly asked to remember this repo search lesson.",
  score: 0.9,
  confidence: 0.86,
};

const lintLearnArgs = {
  trigger: "TypeScript finalization lint",
  lesson: "Run lint before finalizing TypeScript changes for the user.",
  evidenceSnippet: "User explicitly asked to remember the lint finalization rule.",
  score: 0.91,
  confidence: 0.88,
};

test("extracts normalized confidence footer values", () => {
  assert.equal(extractResponseConfidence("Confidence: 0.42"), 0.42);
  assert.equal(extractResponseConfidence("Confidence: 42%"), 0.42);
  assert.equal(extractResponseConfidence("Confidence: 42"), 0.42);
  assert.equal(extractResponseConfidence("Confidence: nope"), null);
});

test("detects explicit knowledge-gap language", () => {
  assert.equal(
    hasKnowledgeGapSignal("I cannot verify that from current evidence."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I couldn't verify that from current evidence."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I wasn't able to confirm the current API behavior."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I wasn't able to validate the migration locally."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("We were not able to determine the root cause."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I am unable to verify the latest release notes."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("This needs a stronger model before finalizing."),
    true,
  );
  assert.equal(hasKnowledgeGapSignal("This is a low-confidence answer."), true);
  assert.equal(hasKnowledgeGapSignal("I am not confident in this fix."), true);
  assert.equal(hasKnowledgeGapSignal("I have no confidence in this answer."), true);
  assert.equal(
    hasKnowledgeGapSignal("The root cause is unclear from the current logs."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I cannot determine this with the available evidence."),
    true,
  );
  assert.equal(hasKnowledgeGapSignal("I can't run the tests here."), true);
  assert.equal(hasKnowledgeGapSignal("I couldn't typecheck this here."), true);
  assert.equal(hasKnowledgeGapSignal("I cannot build the project here."), true);
  assert.equal(
    hasKnowledgeGapSignal("I couldn't reproduce the issue locally."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I don't have enough information to answer safely."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I don't have enough data to answer safely."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("This is my best guess and I may be wrong."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I do not have enough context to answer this safely."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I cannot access the current docs from here."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("Without seeing the logs, this is likely a timeout."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I don't have the file contents needed to verify it."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("Without access to the command output, I would infer it passed."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("As of my knowledge cutoff, this may have changed."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I don't have live web access to verify the current release."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I cannot browse the web from here."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I'd need to see the logs to confirm the root cause."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I would need access to the command output to verify it."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I don't have visibility into the deployment state."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("There is no way to verify the release status from here."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I haven't verified the latest docs yet."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I did not run the tests, but this should work."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("I have not validated the lint result yet."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("This remains unverified until the command output is checked."),
    true,
  );
  assert.equal(
    hasKnowledgeGapSignal("The tests passed and the evidence is direct."),
    false,
  );
  assert.equal(
    hasKnowledgeGapSignal("The API behavior is verified by the cited docs."),
    false,
  );
});

test("recognizes stronger advisory subagent escalation after the latest user turn", () => {
  const messages: Message[] = [
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4",
      task: "review",
    }),
    textMessage("user", "Now answer the new question."),
    assistantToolCall("subagent", {
      agent: "researcher",
      model: "google/gemini-3-pro",
      task: "verify current API answer",
    }),
    toolResult("advisory result: current API answer verified"),
  ];

  assert.equal(conversationHasModelEscalation(messages), true);
});

test("ignores stale escalation from an earlier user turn", () => {
  const messages: Message[] = [
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4",
      task: "review",
    }),
    textMessage("user", "Now answer the new question."),
    textMessage("assistant", "I am not sure. Confidence: 0.4"),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("does not treat a same-model subagent role as model escalation", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", { agent: "oracle", task: "review" }),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("requires a successful advisory result for model escalation", () => {
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior is possibly verified"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior verified, but not conclusive"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: preliminary API behavior analysis verified"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult(
        JSON.stringify({
          success: false,
          result: "advisory result: API behavior is verified",
        }),
      ),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("failed with timeout"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult(
        "advisory analysis: API behavior is still uncertain and cannot be verified",
      ),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior is likely verified"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior appears resolved"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: README documentation is verified"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API docs are verified"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior is verified"),
    ]),
    true,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior is verified"),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("failed with timeout"),
    ]),
    false,
  );
  assert.equal(
    conversationHasModelEscalation([
      textMessage("user", "Verify this uncertain answer."),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("failed with timeout"),
      assistantToolCall("subagent", {
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "resolve low-confidence API behavior",
      }),
      toolResult("advisory result: API behavior is verified"),
    ]),
    true,
  );
});

test("requires concrete task context for model escalation", () => {
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
      }),
    ),
    {
      focused: false,
      reason: "escalation request is missing task context",
    },
  );
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "review",
      }),
    ),
    {
      focused: false,
      reason:
        "escalation request is too vague; include the uncertainty, failure, artifact, API, command, or exact question",
    },
  );
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "review",
        reason: "low confidence",
      }),
    ),
    {
      focused: false,
      reason:
        "escalation request is too vague; include the uncertainty, failure, artifact, API, command, or exact question",
    },
  );
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "verify latest docs",
      }),
    ),
    {
      focused: false,
      reason:
        "escalation request is too vague; include the uncertainty, failure, artifact, API, command, or exact question",
    },
  );
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "verify latest TypeScript decorators docs",
      }),
    ),
    {
      focused: true,
      reason: "escalation has concrete task context",
    },
  );
  assert.deepEqual(
    modelEscalationRequestQuality(
      JSON.stringify({
        agent: "oracle",
        model: "anthropic/claude-sonnet-4",
        task: "diagnose repeated npm test failures",
      }),
    ),
    {
      focused: true,
      reason: "escalation has concrete task context",
    },
  );
});

test("does not treat a vague stronger-model request as model escalation", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4",
      task: "review",
    }),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("does not treat knowledge-gap-only escalation as focused", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4",
      task: "review",
      reason: "low confidence",
    }),
    toolResult("verified answer is resolved"),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("does not treat vague latest-docs escalation as model escalation", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4",
      task: "verify latest docs",
    }),
    toolResult("advisory result: latest docs verified"),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("does not treat incidental high-thinking words as model escalation", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", {
      agent: "oracle",
      task: "review high risk code and explain thinking",
    }),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
});

test("recognizes explicit high-effort subagent escalation", () => {
  const messages: Message[] = [
    textMessage("user", "Verify this uncertain answer."),
    assistantToolCall("subagent", {
      agent: "oracle",
      reasoningEffort: "high",
      task: "resolve low-confidence API behavior",
    }),
    toolResult("advisory result: API behavior resolved"),
  ];

  assert.equal(conversationHasModelEscalation(messages), true);
});

test("detects when source-backed evidence is required", () => {
  assert.equal(
    evidenceNeedReason("What is the latest OpenAI API model for coding?"),
    "request depends on recent, external, or documentation facts",
  );
  assert.equal(
    evidenceNeedReason("Verify this against the official docs."),
    "request depends on recent, external, or documentation facts; user requested source-backed verification",
  );
  assert.equal(
    evidenceNeedReason("Explain src/runtime/bootstrap.ts"),
    "user referenced a URL, repository, path, or file",
  );
  assert.equal(evidenceNeedReason("Explain the idea at a high level."), null);
});

test("recognizes evidence tools after the latest user turn", () => {
  const messages: Message[] = [
    assistantToolCall("read", { path: "old.ts" }),
    textMessage("user", "What changed in README.md?"),
    assistantToolCall("khala_search_memory", { query: "README.md" }),
    toolResult("memory result"),
  ];

  assert.equal(conversationHasEvidenceTool(messages), true);

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("read", { path: "README.md" }),
      toolResult("README contents"),
      assistantToolCall("read", { path: "README.md" }),
      toolResult("failed: no such file"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("read", { path: "README.md" }),
      toolResult("failed: no such file"),
      assistantToolCall("read", { path: "README.md" }),
      toolResult("README contents"),
    ]),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("bash", { command: "pwd || true" }),
      toolResult("/tmp/project"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", { query: "latest docs" }),
      toolResult("generic docs result"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web.run", {
        search_query: [{ q: "latest docs" }],
      }),
      toolResult("generic docs result"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web.run", {
        search_query: [{ q: "pricing" }],
      }),
      toolResult("generic pricing result"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("khala_search_memory", { query: "fix repo" }),
      toolResult("generic memory result"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult("focused docs result"),
    ]),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web.run", {
        search_query: [{ q: "official TypeScript decorators docs" }],
      }),
      toolResult("focused docs result"),
    ]),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web.run", {
        search_query: [{ q: "pricing", domains: ["openai.com"] }],
      }),
      toolResult("focused OpenAI pricing result"),
    ]),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult("No results found"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('[{"query":"TypeScript decorators","results":[]}]'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('[{"success":true,"count":1,"query":"TypeScript decorators"}]'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult("0 results"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("grep", { pattern: "decorators", path: "README.md" }),
      toolResult("no matches"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult("ok"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult("[]"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('{"query":"TypeScript decorators","results":[]}'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('{"success":true,"count":0,"query":"TypeScript decorators"}'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('{"ok":true,"status":"success","totalCount":0}'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("web_search", {
        query: "official TypeScript decorators docs",
      }),
      toolResult('{"results":[{"title":"TypeScript decorators"}]}'),
    ]),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("khala_search_memory", {
        query: "README.md docs lesson",
      }),
      toolResult("no relevant memory found"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("khala_search_memory", {
        query: "README.md docs lesson",
      }),
      toolResult('{"memories":[]}'),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("khala_search_memory", {
        query: "README.md docs lesson",
      }),
      toolResult("done"),
    ]),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool([
      textMessage("user", "Verify this."),
      assistantToolCall("khala_search_memory", {
        query: "README.md docs lesson",
      }),
      toolResult("0 matches"),
    ]),
    false,
  );
});

test("ignores stale evidence tools from an earlier user turn", () => {
  const messages: Message[] = [
    assistantToolCall("read", { path: "README.md" }),
    textMessage("user", "What changed in README.md?"),
    textMessage("assistant", "It changed."),
  ];

  assert.equal(conversationHasEvidenceTool(messages), false);
});

test("requires evidence routing for source-backed or artifact-specific requests", () => {
  assert.deepEqual(externalEvidenceQueryQuality("latest docs"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("latest release notes"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("pricing schedule"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("weather schedule"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("law regulation"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("news score"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("installation guide"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("best practices"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(externalEvidenceQueryQuality("setup tutorial"), {
    focused: false,
    reason:
      "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  });
  assert.deepEqual(
    externalEvidenceQueryQuality("latest TypeScript release official"),
    {
      focused: true,
      reason: "query has concrete external target terms",
    },
  );
  assert.deepEqual(externalEvidenceQueryQuality("OpenAI pricing"), {
    focused: true,
    reason: "query has concrete external target terms",
  });
  assert.deepEqual(externalEvidenceQueryQuality("California law"), {
    focused: true,
    reason: "query has concrete external target terms",
  });
  assert.deepEqual(externalEvidenceQueryQuality("Lakers score"), {
    focused: true,
    reason: "query has concrete external target terms",
  });
  assert.deepEqual(externalEvidenceQueryQuality("TypeScript changelog"), {
    focused: true,
    reason: "query has concrete external target terms",
  });
  assert.deepEqual(externalEvidenceQueryQuality("React installation guide"), {
    focused: true,
    reason: "query has concrete external target terms",
  });
  assert.deepEqual(externalEvidenceQueryQuality("OpenAI API best practices"), {
    focused: true,
    reason: "query has concrete external target terms",
  });

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [textMessage("user", "What is the latest TypeScript release?")],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("read", { path: "package.json" }),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("docs_search", {
          query: "latest docs",
        }),
        toolResult("generic docs result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("docs_search", {
          query: "latest TypeScript release official",
        }),
        toolResult("TypeScript release result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest docs",
        }),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest React release official",
        }),
        toolResult("React release result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "official TypeScript handbook docs",
        }),
        toolResult("TypeScript handbook result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest TypeScript release official",
        }),
        toolResult("TypeScript release result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("bash", {
          command: "curl https://www.typescriptlang.org/releases/ || true",
        }),
        toolResult("TypeScript release result"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "official React latest release",
        }),
        toolResult("React release result"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    false,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "official TypeScript handbook docs",
        }),
        toolResult("TypeScript handbook result"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    false,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest typescript-eslint release official",
        }),
        toolResult("TypeScript ESLint release result"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    false,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What do the latest React docs say?"),
        assistantToolCall("web_search", {
          query: "latest react-native docs official",
        }),
        toolResult("React Native docs result"),
      ],
      "external",
      "What do the latest React docs say?",
    ),
    false,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest TypeScript release official",
        }),
        toolResult("done"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    false,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("browser_open", {
          url: "https://www.typescriptlang.org/releases/",
        }),
        toolResult("TypeScript releases page"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    true,
  );
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("browser_open", {
          url: "https://www.typescriptlang.org/docs/",
        }),
        toolResult("TypeScript docs page"),
      ],
      "external",
      "What is the latest TypeScript release?",
    ),
    false,
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest TypeScript release official",
        }),
        toolResult("TypeScript release result"),
        assistantToolCall("web_search", {
          query: "official TypeScript latest release",
        }),
        toolResult("failed: network timeout"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("web_search", {
          query: "latest TypeScript release official",
        }),
        toolResult("TypeScript release result"),
        assistantToolCall("web_search", {
          query: "TypeScript release npm registry",
        }),
        toolResult("failed: network timeout"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Verify TypeScript decorators against the official documentation.",
        ),
        assistantToolCall("web_search", {
          query: "TypeScript decorators docs",
        }),
        toolResult("Stack Overflow discussion about TypeScript decorators"),
      ],
      userText: "Verify TypeScript decorators against the official documentation.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request depends on recent, external, or documentation facts; user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Verify TypeScript decorators against the official documentation.",
        ),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("unofficial TypeScript decorators docs mirror"),
      ],
      userText: "Verify TypeScript decorators against the official documentation.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request depends on recent, external, or documentation facts; user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Verify TypeScript decorators against the official documentation.",
        ),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("not an official source: Stack Overflow discussion"),
      ],
      userText: "Verify TypeScript decorators against the official documentation.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request depends on recent, external, or documentation facts; user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Verify TypeScript decorators against the official documentation.",
        ),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("Stack Overflow discussion about TypeScript decorators"),
      ],
      userText: "Verify TypeScript decorators against the official documentation.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request depends on recent, external, or documentation facts; user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Verify TypeScript decorators against the official documentation.",
        ),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official TypeScript decorators docs"),
      ],
      userText: "Verify TypeScript decorators against the official documentation.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "request depends on recent, external, or documentation facts; user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Verify this."),
        assistantToolCall("web_search", { query: "latest docs" }),
        toolResult("generic docs result"),
      ],
      userText: "Verify this.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user requested source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain src/runtime/bootstrap.ts"),
        assistantToolCall("read", { path: "package.json" }),
      ],
      userText: "Explain src/runtime/bootstrap.ts",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user referenced a URL, repository, path, or file",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain src/runtime/bootstrap.ts"),
        assistantToolCall("read", { path: "src/runtime/bootstrap.ts" }),
        toolResult("bootstrap contents"),
      ],
      userText: "Explain src/runtime/bootstrap.ts",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user referenced a URL, repository, path, or file",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Summarize https://example.com/spec."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "fetch https://example.com/spec",
        }),
        toolResult("spec summary"),
      ],
      userText: "Summarize https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user referenced a URL, repository, path, or file",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage(
          "user",
          "Summarize https://example.com/spec?utm_source=chat#intro.",
        ),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
      ],
      userText: "Summarize https://example.com/spec?utm_source=chat#intro.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user referenced a URL, repository, path, or file",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Summarize https://example.com/spec."),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
      ],
      userText: "Summarize https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user referenced a URL, repository, path, or file",
    },
  );
});

test("requires local evidence tools to touch referenced artifact targets", () => {
  assert.deepEqual(localArtifactTargetsFromText("Explain ./src/a.ts and README.md."), [
    "./src/a.ts",
    "README.md",
  ]);

  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "package.json" }),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "README.md.bak" }),
        toolResult("backup README contents"),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "/repo/README.md" }),
        toolResult("README contents"),
      ],
      "README.md",
    ),
    true,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain src/runtime/bootstrap.ts."),
        assistantToolCall("grep", {
          pattern: "getBootstrapPayload",
          path: "extensions/runtime/bootstrap.ts",
        }),
        toolResult("matched getBootstrapPayload"),
      ],
      "src/runtime/bootstrap.ts",
    ),
    true,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain docs/README.md."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("root README contents"),
      ],
      "docs/README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain docs/README.md."),
        assistantToolCall("read", { path: "docs/README.md" }),
        toolResult("docs README contents"),
      ],
      "docs/README.md",
    ),
    true,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("grep", {
          pattern: "README.md",
          path: ".",
        }),
        toolResult("matched README.md in package metadata"),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("bash", { command: "rg README.md ." }),
        toolResult("matched README.md in package metadata"),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("bash", { command: "rg Usage README.md" }),
        toolResult("matched Usage in README.md"),
      ],
      "README.md",
    ),
    true,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
        toolResult("README contents"),
      ],
      "README.md",
    ),
    true,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("bash", {
          command: "sed -n '1,80p' README.md || true",
        }),
        toolResult("README contents"),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("khala_search_memory", { query: "README.md docs lesson" }),
        toolResult("stored lesson about README.md"),
      ],
      "README.md",
    ),
    false,
  );
  assert.equal(
    conversationHasLocalEvidenceTarget(
      [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("failed: no such file"),
      ],
      "README.md",
    ),
    false,
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain README.md and package.json."),
        assistantToolCall("read", { path: "README.md" }),
      ],
      userText: "Explain README.md and package.json.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user referenced a URL, repository, path, or file",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain README.md."),
        assistantToolCall("khala_search_memory", { query: "README.md docs lesson" }),
        toolResult("stored lesson about README.md"),
      ],
      userText: "Explain README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user referenced a URL, repository, path, or file",
    },
  );
});

test("requires latest matching generic evidence attempt to succeed", () => {
  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "Verify this local claim."),
        assistantToolCall("review", { path: "README.md" }),
        toolResult("reviewed README"),
        assistantToolCall("review", { path: "README.md" }),
        toolResult("failed: no such file"),
      ],
      "local",
    ),
    false,
  );

  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "Verify this local claim."),
        assistantToolCall("review", { path: "README.md" }),
        toolResult("failed: no such file"),
        assistantToolCall("review", { path: "README.md" }),
        toolResult("reviewed README"),
      ],
      "local",
    ),
    true,
  );

  assert.equal(
    conversationHasEvidenceTool(
      [
        textMessage("user", "Verify this local claim."),
        assistantToolCall("bash", { command: "sed -n '1,80p' README.md || true" }),
        toolResult("README contents"),
      ],
      "local",
    ),
    false,
  );
});

test("requires focused external evidence targets for researcher delegation", () => {
  assert.deepEqual(
    externalEvidenceQueryQuality(
      JSON.stringify({ agent: "researcher", task: "fetch source" }),
    ),
    {
      focused: false,
      reason:
        "query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "fetch source",
        }),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request depends on recent, external, or documentation facts",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is the latest TypeScript release?"),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "verify latest TypeScript release from official source",
        }),
        toolResult("verified TypeScript release"),
      ],
      userText: "What is the latest TypeScript release?",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request depends on recent, external, or documentation facts",
    },
  );
});

test("requires matching evidence when the assistant makes source-backed claims", () => {
  assert.deepEqual(
    assistantEvidenceClaimReason(
      "According to the official docs, this is the current API behavior.",
    ),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason(
      "The TypeScript docs say decorators are supported.",
    ),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason(
      "The release notes mention the migration step.",
    ),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason(
      "The TypeScript docs note decorators are supported.",
    ),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason(
      "The TypeScript docs confirm decorators are supported.",
    ),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason("MDN says CSS nesting is supported."),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason("OpenAI recommends structured tool outputs."),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(
    assistantEvidenceClaimReason("OpenAI confirms structured tool outputs."),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(assistantEvidenceClaimReason("I checked MDN for this."), {
    reason: "assistant claimed source-backed verification",
    sourceClass: "external",
  });
  assert.deepEqual(
    assistantEvidenceClaimReason("I consulted the TypeScript docs."),
    {
      reason: "assistant claimed source-backed verification",
      sourceClass: "external",
    },
  );
  assert.deepEqual(assistantEvidenceClaimReason("I verified README.md."), {
    reason: "assistant claimed source-backed verification",
    sourceClass: "local",
  });
  assert.equal(assistantEvidenceClaimReason("The idea is straightforward."), null);

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        textMessage(
          "assistant",
          "According to the official docs, this is supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "According to the official docs, this is supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        textMessage(
          "assistant",
          "The TypeScript docs note decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs note decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        textMessage(
          "assistant",
          "The TypeScript docs confirm decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs confirm decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official TypeScript decorators docs"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("browser_open", {
          url: "https://www.typescriptlang.org/docs/handbook/decorators.html",
        }),
        toolResult("page loaded"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("source found"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult(
          JSON.stringify({
            statusCode: 404,
            body: "not found",
          }),
        ),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript docs",
        }),
        toolResult("official TypeScript docs"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official TypeScript decorators docs likely found"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("HTTP 404 Not Found"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "MDN reference",
        }),
        toolResult("MDN reference result"),
        textMessage("assistant", "MDN says CSS nesting is supported."),
      ],
      userText: "Explain this concept.",
      assistantText: "MDN says CSS nesting is supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("bash", {
          command:
            "curl -L https://www.typescriptlang.org/docs/handbook/decorators.html",
        }),
        toolResult("HTTP/2 503 service unavailable"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official TypeScript decorators docs appears relevant"),
        textMessage(
          "assistant",
          "The TypeScript docs say decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "The TypeScript docs say decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "OpenAI structured outputs official docs",
        }),
        toolResult("official OpenAI structured outputs docs"),
        textMessage("assistant", "I checked MDN for this."),
      ],
      userText: "Explain this concept.",
      assistantText: "I checked MDN for this.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "MDN CSS nesting support official",
        }),
        toolResult("MDN CSS nesting support reference"),
        textMessage("assistant", "I checked MDN for this."),
      ],
      userText: "Explain this concept.",
      assistantText: "I checked MDN for this.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        textMessage("assistant", "MDN says CSS nesting is supported."),
      ],
      userText: "Explain this concept.",
      assistantText: "MDN says CSS nesting is supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "OpenAI structured outputs official docs",
        }),
        toolResult("official OpenAI structured outputs docs"),
        textMessage("assistant", "MDN says CSS nesting is supported."),
      ],
      userText: "Explain this concept.",
      assistantText: "MDN says CSS nesting is supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "MDN CSS nesting support official",
        }),
        toolResult("MDN CSS nesting support reference"),
        textMessage("assistant", "MDN says CSS nesting is supported."),
      ],
      userText: "Explain this concept.",
      assistantText: "MDN says CSS nesting is supported.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "TypeScript decorators docs",
        }),
        toolResult("Stack Overflow discussion about TypeScript decorators"),
        textMessage(
          "assistant",
          "According to the official docs, this is supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "According to the official docs, this is supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official decorators docs"),
        textMessage(
          "assistant",
          "According to the official docs, this is supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "According to the official docs, this is supported.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript release notes",
        }),
        toolResult("official TypeScript release result"),
        textMessage(
          "assistant",
          "According to the latest TypeScript docs, decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText:
        "According to the latest TypeScript docs, decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official React decorators docs",
        }),
        toolResult("official React docs"),
        textMessage(
          "assistant",
          "According to the latest TypeScript docs, decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText:
        "According to the latest TypeScript docs, decorators are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript decorators docs",
        }),
        toolResult("official TypeScript docs"),
        textMessage(
          "assistant",
          "According to the latest TypeScript docs, decorators are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText:
        "According to the latest TypeScript docs, decorators are supported.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official TypeScript hooks docs",
        }),
        toolResult("official TypeScript docs"),
        textMessage(
          "assistant",
          "According to the latest react docs, hooks are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "According to the latest react docs, hooks are supported.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain this concept."),
        assistantToolCall("web_search", {
          query: "official react hooks docs",
        }),
        toolResult("official react docs"),
        textMessage(
          "assistant",
          "According to the latest react docs, hooks are supported.",
        ),
      ],
      userText: "Explain this concept.",
      assistantText: "According to the latest react docs, hooks are supported.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed source-backed verification",
    },
  );
});

test("requires source markers in responses when the user asks for citations", () => {
  assert.equal(
    citationResponseNeedReason("Answer with citations and links."),
    "user requested citations, links, sources, or named references in the response",
  );
  assert.equal(citationResponseNeedReason("Verify this first."), null);
  assert.equal(
    assistantHasCitationResponse("Sources: https://example.com/spec"),
    true,
  );
  assert.equal(
    assistantHasCitationResponse("Sources: official docs"),
    false,
  );
  assert.equal(
    assistantHasCitationResponse("See README.md for the local reference."),
    true,
  );
  assert.equal(
    assistantHasCitationResponse("The README.md file changed."),
    false,
  );
  assert.equal(
    assistantHasCitationResponse("According to the official docs, this is supported."),
    false,
  );
  assert.equal(assistantHasCitationResponse("This is supported."), false);

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found"),
        textMessage("assistant", "This changed in the latest release."),
      ],
      userText: "What changed? Cite your sources.",
      assistantText: "This changed in the latest release.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: official docs",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: official docs",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found"),
        textMessage(
          "assistant",
          "According to the official docs, this changed in the latest release.",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "According to the official docs, this changed in the latest release.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("fetch", {
          url: "https://example.com/release-notes",
        }),
        toolResult("ok"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("fetch", {
          url: "https://example.com/release-notes",
        }),
        toolResult("release notes confirm the change"),
        assistantToolCall("fetch", {
          url: "https://example.com/release-notes",
        }),
        toolResult("HTTP 503 Service Unavailable"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "review https://example.com/release-notes",
        }),
        toolResult(
          "researcher source result: https://example.com/release-notes confirms the release note change",
        ),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "review https://example.com/release-notes",
        }),
        toolResult("failed: source unavailable"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "review https://example.com/release-notes",
        }),
        toolResult("review complete"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "reviewer",
          task: "review the draft answer",
        }),
        toolResult(
          "review result mentions https://example.com/release-notes as a possible source",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "find source",
        }),
        toolResult(
          "researcher source result: https://example.com/release-notes confirms the release note change",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "review https://example.com/release-notes",
        }),
        toolResult(
          "researcher source result: https://example.com/release-notes confirms the release note change",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("subagent", {
          agent: "researcher",
          task: "review https://example.com/release-notes",
        }),
        toolResult(
          "researcher source result: https://example.com/release-notes likely confirms the release note change",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found at https://example.com/release-notes"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult(
          "official source likely found at https://example.com/release-notes",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult("official source found at https://example.com/release-notes-v2"),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed? Cite your sources."),
        assistantToolCall("web_search", {
          query: "TypeScript release notes official source",
        }),
        toolResult(
          "official source found at https://example.com/release-notes?utm_source=chat#intro",
        ),
        textMessage(
          "assistant",
          "This changed in the latest release.\nSources: https://example.com/release-notes",
        ),
      ],
      userText: "What changed? Cite your sources.",
      assistantText:
        "This changed in the latest release.\nSources: https://example.com/release-notes",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user requested source-backed verification; user requested citations, links, sources, or named references in the response; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed in README.md? Cite your sources."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "The README.md file changed."),
      ],
      userText: "What changed in README.md? Cite your sources.",
      assistantText: "The README.md file changed.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user requested source-backed verification; user referenced a URL, repository, path, or file; user requested citations, links, sources, or named references in the response",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What changed in README.md? Cite your sources."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "The README changed.\nSources: README.md"),
      ],
      userText: "What changed in README.md? Cite your sources.",
      assistantText: "The README changed.\nSources: README.md",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user requested source-backed verification; user referenced a URL, repository, path, or file; user requested citations, links, sources, or named references in the response",
    },
  );
});

test("requires each evidence class when request and assistant claim differ", () => {
  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "README.md" }),
        textMessage(
          "assistant",
          "According to the latest official docs, README.md should mention this.",
        ),
      ],
      userText: "Explain README.md.",
      assistantText:
        "According to the latest official docs, README.md should mention this.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user referenced a URL, repository, path, or file; assistant claimed source-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Explain README.md."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        assistantToolCall("web_search", {
          query: "official TypeScript README documentation guidance",
        }),
        toolResult("official documentation guidance"),
        textMessage(
          "assistant",
          "According to the latest official docs, README.md should mention this.",
        ),
      ],
      userText: "Explain README.md.",
      assistantText:
        "According to the latest official docs, README.md should mention this.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user referenced a URL, repository, path, or file; assistant claimed source-backed verification",
    },
  );
});

test("requires command evidence when the assistant claims checks passed", () => {
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Tests passed and lint is clean."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["test", "lint"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Checks passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("All checks are green."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Tests are passing."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["test"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("make test passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["test"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("uv run pytest passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["test"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("python -m pytest succeeded."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["test"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("`npm run lint:fix` passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["command:npm run lint:fix"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason(
      "The `npm run lint:fix` command passed.",
    ),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["command:npm run lint:fix"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Build completed successfully."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["build"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Verification completed successfully."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Validation passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("Preflight passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("CI is green."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.deepEqual(
    assistantCommandVerificationClaimReason("GitHub Actions passed."),
    {
      reason: "assistant claimed command-backed verification",
      targets: ["check"],
    },
  );
  assert.equal(
    assistantCommandVerificationClaimReason("I inspected the test file."),
    null,
  );

  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "make test" }),
        toolResult("test suite passed\n0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "just test" }),
        toolResult("tests passed\n0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "task test" }),
        toolResult("tests passed\n0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "uv run pytest" }),
        toolResult("12 passed, 0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "python -m pytest" }),
        toolResult("12 passed, 0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("Tests: 42 passed, 0 failed"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("Tests: failed 0, passed 42"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("Tests: failed 0, passed 42\n[output truncated]"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("Tests: failed 0, passed 42\nadditional lines omitted"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("No tests found"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("0 tests"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "pwd" }),
        toolResult("/repo"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "pwd" }),
      toolResult("/repo"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test -- --help" }),
      toolResult("Usage: test runner\nOptions:\n  --watch"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test -- --listTests" }),
      toolResult("tests/runtime/escalation.test.ts"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "pytest --collect-only" }),
      toolResult("collected 12 items"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test -- --watch" }),
      toolResult("watching for file changes"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test -- --watch=false" }),
      toolResult("Tests: 42 passed, 0 failed"),
    ]),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "tsc --version" }),
      toolResult("Version 5.8.3"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm run test:e2e" }),
        toolResult("ok"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm run lint:fix" }),
        toolResult("ok"),
      ],
      ["lint"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Run the custom check."),
        assistantToolCall("bash", { command: "npm install --dry-run" }),
        toolResult("added 0 packages in 1s"),
      ],
      ["command:npm install"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Run the custom check."),
        assistantToolCall("bash", { command: "npm pack --dry-run" }),
        toolResult("package.tgz"),
      ],
      ["command:npm pack --dry-run"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Run the custom check."),
        assistantToolCall("bash", { command: "npm run test:e2e" }),
        toolResult("ok"),
      ],
      ["command:npm run test:e2e"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Run the custom check."),
        assistantToolCall("bash", { command: "npm run test:e2e" }),
        toolResult("e2e suite passed\n0 failed"),
      ],
      ["command:npm run test:e2e"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test || true" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "set +e; npm test" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test; echo ok" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", {
        command: "npm test && echo 'tests passed'",
      }),
      toolResult("tests passed\n0 failed"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", {
        command: "pytest && printf 'tests passed\\n0 failed\\n'",
      }),
      toolResult("tests passed\n0 failed"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "cd packages/app; npm test" }),
      toolResult("ok\n# pass 12\n# fail 0"),
    ]),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test && npm run lint" }),
      toolResult("ok\n# pass 12\n# fail 0\nlint passed"),
    ]),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test && npm run lint" }),
        toolResult("ok\n# pass 12\n# fail 0\nlint passed"),
      ],
      ["command:npm run lint"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test && npm run lint:fix" }),
        toolResult("ok"),
      ],
      ["command:npm run lint"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test | tee test.log" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test | head -40" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test 2>&1 | sed -n '1,120p'" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "pytest | head -40" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "uv run pytest | head -40" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "python -m pytest; echo ok" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "cargo test | tail -40" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "tsc | head -40" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "echo check" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test" }),
      toolResult("exit code 0"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test" }),
      toolResult("process exited with code 0"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult("check passed\n0 failed"),
    ]),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test" }),
      toolResult("Tests: 0 passed, 0 failed"),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult(JSON.stringify({ success: true, output: "" })),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult(JSON.stringify({ success: true, stdout: "", stderr: "" })),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult(JSON.stringify({ success: true, count: 1 })),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm test" }),
      toolResult(JSON.stringify({ success: true, passed: 0, failed: 0 })),
    ]),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence([
      textMessage("user", "Fix the bug."),
      assistantToolCall("bash", { command: "npm run check" }),
      toolResult(JSON.stringify({ success: true, output: "check passed\n0 failed" })),
    ]),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("FAIL tests/runtime/escalation.test.ts\n1 test failed"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("not ok 1 tests/runtime/escalation.test.ts"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("1 failing\n12 passing"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("12 passing\n2 errors"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("12 passing\n0 errors"),
      ],
      ["test"],
    ),
    true,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("thread 'main' panicked at tests/runtime/escalation.test.ts"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("fatal: process aborted"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("command cancelled by user"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("killed by SIGTERM"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("npm ERR! code ELIFECYCLE"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("TypeError: Cannot read properties of undefined"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("failed\nexit code 1"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("failed\nexit code 1"),
      ],
      ["test"],
    ),
    false,
  );
  assert.equal(
    conversationHasCommandEvidence(
      [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        assistantToolCall("bash", { command: "npm test || true" }),
        toolResult("ok"),
      ],
      ["test"],
    ),
    false,
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok"),
        textMessage("assistant", "Checks passed."),
      ],
      userText: "Finish the change.",
      assistantText: "Checks passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "npm run check" }),
        toolResult("check passed\n0 failed"),
        textMessage("assistant", "Checks passed."),
      ],
      userText: "Finish the change.",
      assistantText: "Checks passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "echo check" }),
        toolResult("ok"),
        textMessage("assistant", "Postflight passed."),
      ],
      userText: "Finish the change.",
      assistantText: "Postflight passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("read", { path: "package.json" }),
        textMessage("assistant", "Tests passed."),
      ],
      userText: "Fix the bug.",
      assistantText: "Tests passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("read", { path: "package.json" }),
        textMessage("assistant", "All checks are green."),
      ],
      userText: "Fix the bug.",
      assistantText: "All checks are green.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm run check" }),
        toolResult("check passed\n0 failed"),
        textMessage("assistant", "All checks are green."),
      ],
      userText: "Fix the bug.",
      assistantText: "All checks are green.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "gh pr checks 123" }),
        toolResult("build pass\nlint pass\n0 failing checks"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "gh run list" }),
        toolResult("build completed success"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "gh workflow view ci" }),
        toolResult("workflow ci is active"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "gh run view 123" }),
        toolResult("conclusion: success\n0 failing jobs"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the PR."),
        assistantToolCall("bash", { command: "gh pr checks 123" }),
        toolResult("build pass\nlint fail\n1 failing check"),
        textMessage("assistant", "CI is green."),
      ],
      userText: "Prepare the PR.",
      assistantText: "CI is green.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "Build completed successfully."),
      ],
      userText: "Prepare the release.",
      assistantText: "Build completed successfully.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm run build" }),
        toolResult("build completed successfully"),
        textMessage("assistant", "Build completed successfully."),
      ],
      userText: "Prepare the release.",
      assistantText: "Build completed successfully.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "Validation passed."),
      ],
      userText: "Prepare the release.",
      assistantText: "Validation passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "Preflight passed."),
      ],
      userText: "Prepare the release.",
      assistantText: "Preflight passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm run preflight" }),
        toolResult("preflight passed\n0 failed"),
        textMessage("assistant", "Preflight passed."),
      ],
      userText: "Prepare the release.",
      assistantText: "Preflight passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Prepare the release."),
        assistantToolCall("bash", { command: "npm run validate" }),
        toolResult("validation passed\n0 failed"),
        textMessage("assistant", "Validation passed."),
      ],
      userText: "Prepare the release.",
      assistantText: "Validation passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "Tests passed."),
      ],
      userText: "Fix the bug.",
      assistantText: "Tests passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        textMessage("assistant", "`npm run lint:fix` passed."),
      ],
      userText: "Finish the change.",
      assistantText: "`npm run lint:fix` passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "npm run lint:fix" }),
        toolResult("lint fix completed\n0 failed"),
        textMessage("assistant", "`npm run lint:fix` passed."),
      ],
      userText: "Finish the change.",
      assistantText: "`npm run lint:fix` passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "make test" }),
        toolResult("test suite passed\n0 failed"),
        textMessage("assistant", "make test passed."),
      ],
      userText: "Fix the bug.",
      assistantText: "make test passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Fix the bug."),
        assistantToolCall("bash", { command: "npm test || true" }),
        toolResult("ok"),
        textMessage("assistant", "Tests passed."),
      ],
      userText: "Fix the bug.",
      assistantText: "Tests passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );
});

test("requires every named command check claimed by the assistant", () => {
  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok"),
        textMessage("assistant", "Tests passed and typecheck passed."),
      ],
      userText: "Finish the change.",
      assistantText: "Tests passed and typecheck passed.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed command-backed verification",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Finish the change."),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        assistantToolCall("bash", { command: "npm run typecheck" }),
        toolResult("typecheck passed"),
        textMessage("assistant", "Tests passed and typecheck passed."),
      ],
      userText: "Finish the change.",
      assistantText: "Tests passed and typecheck passed.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed command-backed verification",
    },
  );
});

test("requires mutation evidence when the assistant claims file changes", () => {
  assert.deepEqual(assistantMutationClaimReason("I updated README.md."), {
    reason: "assistant claimed file or code mutation",
    targets: ["README.md"],
  });
  assert.equal(assistantMutationClaimReason("I explained README.md."), null);

  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("read", { path: "README.md" }),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "package.json" }),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("failed with conflict"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", { command: "sed -i 's/a/b/' README.md" }),
        toolResult("exit code 1"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "README.md.bak" }),
        toolResult("patched README.md.bak"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", { command: "sed -i 's/a/b/' README.md.bak" }),
        toolResult("patched README.md.bak"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", { command: "cat generated.md >README.md" }),
        toolResult("wrote README.md"),
      ],
      ["README.md"],
    ),
    true,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("ok"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("patched README.md"),
      ],
      ["README.md"],
    ),
    true,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("patched README.md"),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("failed with conflict"),
      ],
      ["README.md"],
    ),
    false,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", { command: "sed -i 's/a/b/' README.md" }),
        toolResult("patched README.md"),
      ],
      ["README.md"],
    ),
    true,
  );
  assert.equal(
    conversationHasMutationEvidence(
      [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", { command: "sed -i 's/a/b/' README.md || true" }),
        toolResult("ok"),
      ],
      ["README.md"],
    ),
    false,
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("read", { path: "README.md" }),
        textMessage("assistant", "I updated README.md."),
      ],
      userText: "Patch README.md.",
      assistantText: "I updated README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "user referenced a URL, repository, path, or file; assistant claimed file or code mutation",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("patched README.md"),
        textMessage("assistant", "I updated README.md."),
      ],
      userText: "Patch README.md.",
      assistantText: "I updated README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "user referenced a URL, repository, path, or file; assistant claimed file or code mutation",
    },
  );
});

test("requires matching tools when the assistant promises tool work", () => {
  assert.deepEqual(
    assistantToolWorkPromiseReason("I'll run tests before finalizing."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: ["test"],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I'll run `npm install --no-audit`."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: ["command:npm install --no-audit"],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I'll run npm install before finalizing."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: ["command:npm install"],
      mutationTargets: [],
    },
  );
  assert.deepEqual(assistantToolWorkPromiseReason("I will inspect README.md."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.deepEqual(assistantToolWorkPromiseReason("I will open README.md."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.deepEqual(assistantToolWorkPromiseReason("I will look at README.md."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.deepEqual(
    assistantToolWorkPromiseReason("I will open https://example.com/spec."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I will read https://example.com/spec."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I will load https://example.com/spec."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I will fetch https://example.com/spec."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I will download https://example.com/spec."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(assistantToolWorkPromiseReason("I will search README.md."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.deepEqual(assistantToolWorkPromiseReason("I'll search the repo."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["local"],
    localTargets: [],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.deepEqual(assistantToolWorkPromiseReason("I'll verify with npm test."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: ["test"],
    mutationTargets: [],
  });
  assert.deepEqual(
    assistantToolWorkPromiseReason("I'll validate with npm test."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: ["test"],
      mutationTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkPromiseReason("I'll verify latest TypeScript docs."),
    {
      reason: "assistant promised tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
      mutationTargets: [],
    },
  );
  assert.deepEqual(assistantToolWorkPromiseReason("I'll check MDN first."), {
    reason: "assistant promised tool-backed work",
    sourceClasses: ["external"],
    localTargets: [],
    commandTargets: [],
    mutationTargets: [],
  });
  assert.equal(
    assistantToolWorkPromiseReason("I can explain the tradeoff."),
    null,
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        textMessage("assistant", "I'll run tests before finalizing."),
      ],
      userText: "What is next?",
      assistantText: "I'll run tests before finalizing.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I'll verify with npm test."),
      ],
      userText: "What is next?",
      assistantText: "I'll verify with npm test.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I will open https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will open https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I will open https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will open https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I will fetch https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will fetch https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I will download https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will download https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I will read https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will read https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I will load https://example.com/spec."),
      ],
      userText: "What is next?",
      assistantText: "I will load https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I'll validate with npm test."),
      ],
      userText: "What is next?",
      assistantText: "I'll validate with npm test.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I'll verify with npm test."),
      ],
      userText: "What is next?",
      assistantText: "I'll verify with npm test.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I'll validate with npm test."),
      ],
      userText: "What is next?",
      assistantText: "I'll validate with npm test.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I'll verify latest TypeScript docs."),
      ],
      userText: "What is next?",
      assistantText: "I'll verify latest TypeScript docs.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("web_search", {
          query: "latest TypeScript docs official",
        }),
        toolResult("official TypeScript docs result"),
        textMessage("assistant", "I'll verify latest TypeScript docs."),
      ],
      userText: "What is next?",
      assistantText: "I'll verify latest TypeScript docs.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("web_search", {
          query: "OpenAI structured outputs official docs",
        }),
        toolResult("official OpenAI structured outputs docs"),
        textMessage("assistant", "I'll check MDN first."),
      ],
      userText: "What is next?",
      assistantText: "I'll check MDN first.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("web_search", {
          query: "MDN CSS nesting support official",
        }),
        toolResult("MDN CSS nesting support reference"),
        textMessage("assistant", "I'll check MDN first."),
      ],
      userText: "What is next?",
      assistantText: "I'll check MDN first.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I'll run tests before finalizing."),
      ],
      userText: "What is next?",
      assistantText: "I'll run tests before finalizing.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok"),
        textMessage("assistant", "I'll run `npm install --no-audit`."),
      ],
      userText: "What is next?",
      assistantText: "I'll run `npm install --no-audit`.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm install --no-audit" }),
        toolResult("added 12 packages in 2s"),
        textMessage("assistant", "I'll run `npm install --no-audit`."),
      ],
      userText: "What is next?",
      assistantText: "I'll run `npm install --no-audit`.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("bash", { command: "npm install" }),
        toolResult("added 12 packages in 2s"),
        textMessage("assistant", "I'll run npm install before finalizing."),
      ],
      userText: "What is next?",
      assistantText: "I'll run npm install before finalizing.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I will inspect README.md."),
      ],
      userText: "What is next?",
      assistantText: "I will inspect README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What is next?"),
        assistantToolCall("edit", { path: "README.md" }),
        toolResult("patched README.md"),
        textMessage("assistant", "I will update README.md."),
      ],
      userText: "What is next?",
      assistantText: "I will update README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant promised tool-backed work",
    },
  );
});

test("requires matching tools when the assistant claims completed tool work", () => {
  assert.deepEqual(
    assistantToolWorkCompletionReason("I inspected README.md."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["local"],
      localTargets: ["README.md"],
      commandTargets: [],
    },
  );
  assert.deepEqual(assistantToolWorkCompletionReason("I opened README.md."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I looked at README.md."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
  });
  assert.deepEqual(
    assistantToolWorkCompletionReason("I opened https://example.com/spec."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkCompletionReason("I read https://example.com/spec."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkCompletionReason("I loaded https://example.com/spec."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkCompletionReason("I fetched https://example.com/spec."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
    },
  );
  assert.deepEqual(
    assistantToolWorkCompletionReason("I downloaded https://example.com/spec."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["external"],
      localTargets: [],
      commandTargets: [],
    },
  );
  assert.deepEqual(assistantToolWorkCompletionReason("I ran npm test."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: ["test", "command:npm test"],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I ran npm test successfully."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: ["test", "command:npm test"],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I ran npm install."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: ["command:npm install"],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I validated with npm test."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: ["test"],
  });
  assert.deepEqual(
    assistantToolWorkCompletionReason("I ran npm install and then checked logs."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: ["command:npm install"],
    },
  );
  assert.deepEqual(
    assistantToolWorkCompletionReason("I ran npm test and npm run lint."),
    {
      reason: "assistant claimed completed tool-backed work",
      sourceClasses: ["command"],
      localTargets: [],
      commandTargets: [
        "test",
        "lint",
        "command:npm test",
        "command:npm run lint",
      ],
    },
  );
  assert.deepEqual(assistantToolWorkCompletionReason("I ran the command."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["command"],
    localTargets: [],
    commandTargets: [],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I searched the repo."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["local"],
    localTargets: [],
    commandTargets: [],
  });
  assert.deepEqual(assistantToolWorkCompletionReason("I searched README.md."), {
    reason: "assistant claimed completed tool-backed work",
    sourceClasses: ["local"],
    localTargets: ["README.md"],
    commandTargets: [],
  });
  assert.equal(assistantToolWorkCompletionReason("I reviewed the idea."), null);

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        textMessage("assistant", "I inspected README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I inspected README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("web_search", { query: "README docs" }),
        toolResult("external README docs"),
        textMessage("assistant", "I searched README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I searched README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "assistant claimed source-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I searched README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I searched README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "assistant claimed source-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I inspected README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I inspected README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I opened https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I opened https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I opened https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I opened https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I fetched https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I fetched https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I downloaded https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I downloaded https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/other" }),
        toolResult("other contents"),
        textMessage("assistant", "I read https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I read https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("browser_open", { url: "https://example.com/spec" }),
        toolResult("spec contents"),
        textMessage("assistant", "I loaded https://example.com/spec."),
      ],
      userText: "What did you do?",
      assistantText: "I loaded https://example.com/spec.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        textMessage("assistant", "I opened README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I opened README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("read", { path: "README.md" }),
        toolResult("README contents"),
        textMessage("assistant", "I looked at README.md."),
      ],
      userText: "What did you do?",
      assistantText: "I looked at README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "pwd" }),
        toolResult("/repo"),
        textMessage("assistant", "I ran npm test."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm test.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "pwd" }),
        toolResult("/repo"),
        textMessage("assistant", "I validated with npm test."),
      ],
      userText: "What did you do?",
      assistantText: "I validated with npm test.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I validated with npm test."),
      ],
      userText: "What did you do?",
      assistantText: "I validated with npm test.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I ran npm test successfully."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm test successfully.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "pwd" }),
        toolResult("ok"),
        textMessage("assistant", "I ran the command."),
      ],
      userText: "What did you do?",
      assistantText: "I ran the command.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "assistant claimed command-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "pwd" }),
        toolResult("/repo"),
        textMessage("assistant", "I ran the command."),
      ],
      userText: "What did you do?",
      assistantText: "I ran the command.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "assistant claimed command-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("subagent", {
          agent: "reviewer",
          task: "inspect the requested command result",
        }),
        toolResult("reviewed command plan"),
        textMessage("assistant", "I ran the command."),
      ],
      userText: "What did you do?",
      assistantText: "I ran the command.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "assistant claimed command-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("subagent", {
          agent: "reviewer",
          task: "review implementation approach",
        }),
        toolResult("implementation reviewed"),
        textMessage("assistant", "I implemented the change."),
      ],
      userText: "What did you do?",
      assistantText: "I implemented the change.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed file or code mutation",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "pwd || true" }),
        toolResult("/repo"),
        textMessage("assistant", "I ran the command."),
      ],
      userText: "What did you do?",
      assistantText: "I ran the command.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "assistant claimed command-backed verification; assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok"),
        textMessage("assistant", "I ran npm install."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm install.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm install --no-audit" }),
        toolResult("added 12 packages in 2s"),
        textMessage("assistant", "I ran npm install."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm install.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test && npm run lint" }),
        toolResult("ok\n# pass 12\n# fail 0\nlint passed"),
        textMessage("assistant", "I ran npm run lint."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm run lint.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("web_search", { query: "repo search best practices" }),
        toolResult("external search result"),
        textMessage("assistant", "I searched the repo."),
      ],
      userText: "What did you do?",
      assistantText: "I searched the repo.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("khala_search_memory", { query: "repo search workflow" }),
        toolResult("stored lesson about repo search"),
        textMessage("assistant", "I searched the repo."),
      ],
      userText: "What did you do?",
      assistantText: "I searched the repo.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("khala_read_memory", {}),
        toolResult("recent repo-search lesson"),
        textMessage("assistant", "I searched the repo."),
      ],
      userText: "What did you do?",
      assistantText: "I searched the repo.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("grep", { pattern: "TODO", path: "." }),
        toolResult("matched TODO"),
        textMessage("assistant", "I searched the repo."),
      ],
      userText: "What did you do?",
      assistantText: "I searched the repo.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test" }),
        toolResult("ok\n# pass 12\n# fail 0"),
        textMessage("assistant", "I ran npm test and npm run lint."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm test and npm run lint.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed completed tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateEvidenceRouting({
      messages: [
        textMessage("user", "What did you do?"),
        assistantToolCall("bash", { command: "npm test && npm run lint" }),
        toolResult("ok\n# pass 12\n# fail 0\nlint passed"),
        textMessage("assistant", "I ran npm test and npm run lint."),
      ],
      userText: "What did you do?",
      assistantText: "I ran npm test and npm run lint.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed completed tool-backed work",
    },
  );
});

test("detects explicit skill requests without triggering on generic skill mentions", () => {
  assert.equal(
    skillNeedReason("Load your librarian skill before inspecting the repo."),
    "user explicitly requested a skill",
  );
  assert.equal(
    skillNeedReason("Use tdd-core skill for this fix."),
    "user explicitly requested a skill",
  );
  assert.equal(
    skillNeedReason("Use a skill for this failing TypeScript test."),
    "user explicitly requested a skill",
  );
  assert.equal(
    skillNeedReason("Use GitHub and code review skills for this PR."),
    "user explicitly requested a skill",
  );
  assert.equal(skillNeedReason("Improve skill routing in the runtime."), null);
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Use tdd-core skill and /skill:github before reading skills/typescript/SKILL.md.",
    ),
    ["tdd-core", "github", "typescript"],
  );
  assert.deepEqual(explicitSkillNamesForUserText("Use the code review skill."), [
    "code-review",
  ]);
  assert.deepEqual(
    explicitSkillNamesForUserText("Use GitHub and code review skills for this PR."),
    ["github", "code-review"],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText("Use commit and github skills."),
    ["commit", "github"],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Use the code-review skill and github skill for this PR.",
    ),
    ["code-review", "github"],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Do not count skills/typescript/SKILL.md.bak as a skill read.",
    ),
    [],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText("Use a skill for this failing TypeScript test."),
    [],
  );
  assert.deepEqual(
    assistantClaimedSkillNames(
      "I used the TypeScript skill and followed github skill guidance.",
    ),
    ["typescript", "github"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I used the TypeScript and code review skills."),
    ["typescript", "code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I used the TypeScript skill and code review skill."),
    ["typescript", "code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I followed code review guidance."),
    ["code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames(
      "I followed TypeScript and code review best practices.",
    ),
    ["typescript", "code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I applied TypeScript best practices."),
    ["typescript"],
  );
  assert.deepEqual(assistantClaimedSkillNames("I used the code review skill."), [
    "code-review",
  ]);
  assert.deepEqual(assistantClaimedSkillNames("I used a skill."), []);
  assert.deepEqual(assistantClaimedSkillNames("I used a few skills."), []);
  assert.deepEqual(assistantClaimedSkillNames("I followed best practices."), []);
});

test("recognizes skill reads after the latest user turn", () => {
  const messages: Message[] = [
    assistantToolCall("read", { path: "skills/old/SKILL.md" }),
    textMessage("user", "Load your librarian skill."),
    assistantToolCall("read", { path: "skills/librarian/SKILL.md" }),
    toolResult("loaded librarian skill"),
  ];

  assert.equal(conversationHasSkillRead(messages), true);
});

test("recognizes Codex system skill reads", () => {
  assert.equal(
    conversationHasSkillRead(
      [
        textMessage("user", "Load your openai-docs skill."),
        assistantToolCall("read", {
          path: "/home/morgoth/.codex/skills/.system/openai-docs/SKILL.md",
        }),
        toolResult("official OpenAI API documentation skill instructions"),
      ],
      ["openai-docs"],
    ),
    true,
  );
});

test("ignores stale skill reads from an earlier user turn", () => {
  const messages: Message[] = [
    assistantToolCall("read", { path: "skills/librarian/SKILL.md" }),
    textMessage("user", "Load your librarian skill."),
    textMessage("assistant", "I loaded it."),
  ];

  assert.equal(conversationHasSkillRead(messages), false);
});

test("does not accept non-exact SKILL.md path reads", () => {
  assert.equal(
    conversationHasSkillRead([
      textMessage("user", "Load your TypeScript skill."),
      assistantToolCall("read", {
        path: "/repo/skills/typescript/SKILL.md.bak",
      }),
      toolResult("backup file contents"),
    ]),
    false,
  );
  assert.equal(
    conversationHasSkillRead(
      [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md.bak",
          reason: "Need /repo/skills/typescript/SKILL.md before editing.",
        }),
        toolResult("backup file contents"),
      ],
      ["typescript"],
    ),
    false,
  );
  assert.equal(
    conversationHasSkillRead(
      [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("read", {
          path: "/repo/README.md",
          note: "/repo/skills/typescript/SKILL.md is required",
        }),
        toolResult("README contents"),
      ],
      ["typescript"],
    ),
    false,
  );
  assert.equal(
    conversationHasSkillRead([
      textMessage("user", "Load your TypeScript skill."),
      assistantToolCall("read", {
        path: "/repo/skills/typescript/SKILL.md/notes",
      }),
      toolResult("nested notes"),
    ]),
    false,
  );
  assert.equal(
    conversationHasSkillRead([
      textMessage("user", "Load your TypeScript skill."),
      assistantToolCall("read", {
        path: "/repo/skills/typescript/SKILL.md",
      }),
      toolResult("ok"),
    ]),
    false,
  );
});

test("requires skill routing for explicit skill requests", () => {
  assert.deepEqual(
    evaluateSkillRouting({
      messages: [textMessage("user", "Load your github skill.")],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", { path: "/repo/skills/typescript/SKILL.md" }),
        toolResult("loaded TypeScript skill"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", {
          path: "/repo/skills/github/SKILL.md.bak",
        }),
        toolResult("loaded backup file"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("failed: no such file"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("loaded GitHub skill"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("loaded GitHub skill"),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("failed: no such file"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your github skill."),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("loaded GitHub skill"),
        assistantToolCall("read", { path: "/repo/skills/typescript/SKILL.md" }),
        toolResult("failed: no such file"),
      ],
      userText: "Load your github skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Use the code review skill."),
        assistantToolCall("read", { path: "/repo/skills/code-review/SKILL.md" }),
        toolResult("loaded code review skill"),
      ],
      userText: "Use the code review skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Use the code-review skill and github skill."),
        assistantToolCall("read", { path: "/repo/skills/code-review/SKILL.md" }),
        toolResult("loaded code review skill"),
      ],
      userText: "Use the code-review skill and github skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Use the code-review skill and github skill."),
        assistantToolCall("read", { path: "/repo/skills/code-review/SKILL.md" }),
        toolResult("loaded code review skill"),
        assistantToolCall("read", { path: "/repo/skills/github/SKILL.md" }),
        toolResult("loaded GitHub skill"),
      ],
      userText: "Use the code-review skill and github skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("loadSkill", { name: "typescript-old" }),
        toolResult("loaded adjacent skill"),
      ],
      userText: "Load your TypeScript skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("loadSkill", {
          name: "typescript-old",
          reason: "Need the TypeScript skill for this task.",
        }),
        toolResult("loaded adjacent skill"),
      ],
      userText: "Load your TypeScript skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("loadSkill", { name: "typescript" }),
        toolResult("loaded TypeScript skill"),
      ],
      userText: "Load your TypeScript skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("loadSkill", { name: "typescript" }),
        toolResult("ok"),
      ],
      userText: "Load your TypeScript skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Load your TypeScript skill."),
        assistantToolCall("subagent", {
          task: "Use skill=typescript-old to inspect this.",
        }),
        toolResult("subagent used adjacent skill"),
      ],
      userText: "Load your TypeScript skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Use a skill for this failing TypeScript test."),
        assistantToolCall("read", { path: "/repo/skills/code-review/SKILL.md" }),
        toolResult("loaded code review skill"),
      ],
      userText: "Use a skill for this failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested a skill",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Use a skill for this failing TypeScript test."),
        assistantToolCall("read", {
          path: "/repo/skills/debug-investigation/SKILL.md",
        }),
        toolResult("loaded debug skill"),
        assistantToolCall("read", { path: "/repo/skills/typescript/SKILL.md" }),
        toolResult("loaded TypeScript skill"),
      ],
      userText: "Use a skill for this failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested a skill",
    },
  );
});

test("requires skill reads when assistant claims skill use", () => {
  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Explain this TypeScript error."),
        textMessage("assistant", "I used the TypeScript skill."),
      ],
      userText: "Explain this TypeScript error.",
      assistantText: "I used the TypeScript skill.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed skill use: typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Explain this TypeScript error."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        textMessage("assistant", "I used the TypeScript skill."),
      ],
      userText: "Explain this TypeScript error.",
      assistantText: "I used the TypeScript skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed skill use: typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("read", {
          path: "/repo/skills/code-review/SKILL.md",
        }),
        toolResult("loaded code review skill"),
        textMessage("assistant", "I used the code review skill."),
      ],
      userText: "Review this change.",
      assistantText: "I used the code review skill.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed skill use: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        textMessage("assistant", "I followed code review guidance."),
      ],
      userText: "Review this change.",
      assistantText: "I followed code review guidance.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed skill use: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Explain this TypeScript error."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        textMessage("assistant", "I applied TypeScript best practices."),
      ],
      userText: "Explain this TypeScript error.",
      assistantText: "I applied TypeScript best practices.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed skill use: typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this TypeScript change."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        textMessage("assistant", "I used the TypeScript and code review skills."),
      ],
      userText: "Review this TypeScript change.",
      assistantText: "I used the TypeScript and code review skills.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed skill use: typescript, code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this TypeScript change."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        assistantToolCall("read", {
          path: "/repo/skills/code-review/SKILL.md",
        }),
        toolResult("loaded code review skill"),
        textMessage("assistant", "I used the TypeScript and code review skills."),
      ],
      userText: "Review this TypeScript change.",
      assistantText: "I used the TypeScript and code review skills.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed skill use: typescript, code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this TypeScript change."),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        textMessage(
          "assistant",
          "I followed TypeScript and code review best practices.",
        ),
      ],
      userText: "Review this TypeScript change.",
      assistantText: "I followed TypeScript and code review best practices.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed skill use: typescript, code-review",
    },
  );
});

test("recommends packaged skills for common best-practice task classes", () => {
  assert.deepEqual(recommendedSkillsForUserText("Review this PR."), [
    "code-review",
    "github",
  ]);
  assert.deepEqual(
    recommendedSkillsForUserText("Commit the current changes."),
    ["commit"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Commit the staged fix."),
    ["commit"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Review this commit for bugs."),
    ["code-review"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Debug the failing pytest test."),
    ["debug-investigation", "python-developer", "testing-pytest"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Fix the CI failure."),
    ["debug-investigation"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Fix the failing GitHub Actions check."),
    ["debug-investigation", "github"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Create a new agent skill for planning."),
    ["skill-creator"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Challenge this approach from first principles."),
    ["academic-review"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Break circular dependencies in the import graph."),
    ["dependency-untangler"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Turn these loose dicts into a typed data contract."),
    ["data-model"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Build this with the OpenAI Responses API."),
    ["openai-docs"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Review this SDK design for API ergonomics."),
    ["code-review", "good-api"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Remove unused exports after proving dead code."),
    ["dead-code-proof"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Tighten the types and remove any unsafe casts."),
    ["type-hardening"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Preserve public API compatibility."),
    ["public-api-guard"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Add a feature from these acceptance criteria."),
    ["feature-delivery"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Refactor this Rust crate and run clippy."),
    ["rust-developer", "simplify"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Replace pip install with uv run for this Python script."),
    ["python-developer", "uv"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Debug infrasys component graph serialization."),
    ["debug-investigation", "infrasys"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Review this bash script for ShellCheck fixes."),
    ["code-review", "bash-script"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Improve CLI help text, exit codes, and --json output."),
    ["cli-ux"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Improve skill routing in the runtime."),
    [],
  );
});

test("requires relevant skill reads for proactive skill routes", () => {
  assert.deepEqual(
    evaluateSkillRouting({
      messages: [textMessage("user", "Debug the failing TypeScript test.")],
      userText: "Debug the failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request matches packaged skill route: debug-investigation, typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Debug the failing TypeScript test."),
        assistantToolCall("read", {
          path: "/repo/skills/code-review/SKILL.md",
        }),
        toolResult("loaded code review skill"),
      ],
      userText: "Debug the failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request matches packaged skill route: debug-investigation, typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Commit the current changes."),
        assistantToolCall("read", {
          path: "/repo/skills/commit/SKILL.md",
        }),
        toolResult("loaded commit skill"),
      ],
      userText: "Commit the current changes.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: commit",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("subagent", {
          agent: "worker",
          skills: ["code review"],
          task: "Review the change.",
        }),
        toolResult("subagent completed change review"),
      ],
      userText: "Review this change.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("subagent", {
          task: "assignedSkills: code review; review the change.",
        }),
        toolResult("subagent completed change review"),
      ],
      userText: "Review this change.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("subagent", {
          task: "assignedSkills: code review old; review the change.",
        }),
        toolResult("subagent completed change review"),
      ],
      userText: "Review this change.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("subagent", {
          agent: "worker",
          skills: ["code review"],
          task: "Review the change.",
        }),
        toolResult("ok"),
      ],
      userText: "Review this change.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Review this change."),
        assistantToolCall("subagent", {
          agent: "worker",
          skills: ["code review old"],
          task: "Review the change.",
        }),
        toolResult("subagent completed change review"),
      ],
      userText: "Review this change.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: code-review",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Commit the current changes."),
        assistantToolCall("read", {
          path: "/repo/skills/commit/SKILL.md",
        }),
        toolResult("loaded commit skill"),
              ],
      userText: "Commit the current changes.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: commit",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Commit the current changes."),
        assistantToolCall("subagent", {
          agent: "worker",
          task: "Use the commit skill to prepare the commit.",
        }),
        toolResult("subagent completed commit prep"),
      ],
      userText: "Commit the current changes.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: commit",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Commit the current changes."),
        assistantToolCall("subagent", {
          agent: "worker",
          skills: ["commit"],
          task: "Prepare the commit.",
        }),
        toolResult("subagent completed commit prep"),
        assistantToolCall("subagent", {
          agent: "worker",
          task: "Use the commit skill to prepare the commit.",
        }),
        toolResult("subagent completed commit prep"),
      ],
      userText: "Commit the current changes.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: commit",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Commit the current changes."),
        assistantToolCall("subagent", {
          agent: "worker",
          skills: ["commit"],
          task: "Prepare the commit.",
        }),
        toolResult("subagent completed commit prep"),
      ],
      userText: "Commit the current changes.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: commit",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Debug the failing TypeScript test."),
        assistantToolCall("read", {
          path: "/repo/skills/debug-investigation/SKILL.md",
        }),
        toolResult("loaded debug skill"),
      ],
      userText: "Debug the failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request matches packaged skill route: debug-investigation, typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Debug the failing TypeScript test."),
        assistantToolCall("read", {
          path: "/repo/skills/debug-investigation/SKILL.md",
        }),
        toolResult("loaded debug skill"),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
      ],
      userText: "Debug the failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "request matches packaged skill route: debug-investigation, typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage(
          "user",
          "Tighten the public API types without breaking compatibility.",
        ),
        assistantToolCall("read", {
          path: "/repo/skills/type-hardening/SKILL.md",
        }),
        toolResult("loaded type hardening skill"),
        assistantToolCall("read", {
          path: "/repo/skills/public-api-guard/SKILL.md",
        }),
        toolResult("loaded API guard skill"),
      ],
      userText: "Tighten the public API types without breaking compatibility.",
    }),
    {
      required: true,
      satisfied: true,
      reason:
        "request matches packaged skill route: type-hardening, public-api-guard",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [textMessage("user", "Build this with the OpenAI Responses API.")],
      userText: "Build this with the OpenAI Responses API.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: openai-docs",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Build this with the OpenAI Responses API."),
        assistantToolCall("read", {
          path: "/home/morgoth/.codex/skills/.system/openai-docs/SKILL.md",
        }),
        toolResult("loaded OpenAI docs skill"),
      ],
      userText: "Build this with the OpenAI Responses API.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: openai-docs",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Debug the failing TypeScript test."),
        assistantToolCall("read", {
          path: "/repo/skills/debug-investigation/SKILL.md",
        }),
        toolResult("loaded debug skill"),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("loaded TypeScript skill"),
        assistantToolCall("read", {
          path: "/repo/skills/typescript/SKILL.md",
        }),
        toolResult("failed: no such file"),
      ],
      userText: "Debug the failing TypeScript test.",
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "request matches packaged skill route: debug-investigation, typescript",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [textMessage("user", "Fix the failing GitHub Actions check.")],
      userText: "Fix the failing GitHub Actions check.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "request matches packaged skill route: debug-investigation, github",
    },
  );

  assert.deepEqual(
    evaluateSkillRouting({
      messages: [
        textMessage("user", "Fix the failing GitHub Actions check."),
        assistantToolCall("read", {
          path: "/repo/skills/debug-investigation/SKILL.md",
        }),
        toolResult("loaded debug skill"),
        assistantToolCall("read", {
          path: "/repo/skills/github/SKILL.md",
        }),
        toolResult("loaded GitHub skill"),
      ],
      userText: "Fix the failing GitHub Actions check.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "request matches packaged skill route: debug-investigation, github",
    },
  );
});

test("detects repeated identical evidence tool calls after the latest user turn", () => {
  const messages: Message[] = [
    assistantToolCall("read", { path: "README.md" }),
    textMessage("user", "Inspect README.md."),
    assistantToolCall("read", { path: "README.md" }),
    assistantToolCall("read", { path: "README.md" }),
  ];

  assert.equal(findRedundantEvidenceToolCall(messages), "read");
});

test("does not treat rereads after mutation as redundant", () => {
  const messages: Message[] = [
    textMessage("user", "Patch README.md."),
    assistantToolCall("read", { path: "README.md" }),
    assistantToolCall("edit", { path: "README.md" }),
    assistantToolCall("read", { path: "README.md" }),
  ];

  assert.equal(findRedundantEvidenceToolCall(messages), null);
});

test("learning capture only resets memory-search dedupe state", () => {
  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Inspect README.md and remember the workflow."),
      assistantToolCall("read", { path: "README.md" }),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored"),
      assistantToolCall("read", { path: "README.md" }),
    ]),
    "read",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Read recent memory, remember the workflow, then read it again."),
      assistantToolCall("khala_read_memory", {}),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored"),
      assistantToolCall("khala_read_memory", {}),
    ]),
    "khala_read_memory",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Search memory, remember the workflow, then recheck memory."),
      assistantToolCall("khala_search_memory", { query: "README harness routing" }),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored"),
      assistantToolCall("khala_search_memory", { query: "README harness routing" }),
    ]),
    null,
  );
});

test("detects repeated identical recent-memory reads", () => {
  const messages: Message[] = [
    textMessage("user", "Read recent memory."),
    assistantToolCall("khala_read_memory", {}),
    assistantToolCall("khala_read_memory", {}),
  ];

  assert.equal(findRedundantEvidenceToolCall(messages), "khala_read_memory");
  assert.deepEqual(evaluateToolEfficiency({ messages }), {
    efficient: false,
    reason:
      "repeated identical khala_read_memory call without an intervening mutation",
  });
});

test("detects repeated identical non-mutating bash evidence commands", () => {
  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Run the checks."),
      assistantToolCall("bash", { command: "npm test" }),
      assistantToolCall("bash", { command: "npm test" }),
    ]),
    "bash",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Patch README.md."),
      assistantToolCall("bash", { command: "npm test" }),
      assistantToolCall("bash", { command: "sed -i 's/a/b/' README.md" }),
      assistantToolCall("bash", { command: "npm test" }),
    ]),
    null,
  );
});

test("detects repeated local artifact evidence across tool types", () => {
  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Inspect README.md."),
      assistantToolCall("read", { path: "README.md" }),
      assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
    ]),
    "local artifact README.md",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Inspect README.md."),
      assistantToolCall("read", { path: "./README.md" }),
      assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
    ]),
    "local artifact ./README.md",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Inspect docs/README.md and README.md."),
      assistantToolCall("read", { path: "docs/README.md" }),
      assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
    ]),
    null,
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Inspect README.md."),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated local evidence for README.md without an intervening mutation",
    },
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Patch README.md."),
      assistantToolCall("read", { path: "README.md" }),
      assistantToolCall("edit", { path: "README.md" }),
      assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
    ]),
    null,
  );
});

test("evaluates tool efficiency for duplicate evidence collection", () => {
  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Search memory for routing."),
        assistantToolCall("khala_search_memory", { query: "routing" }),
        assistantToolCall("khala_search_memory", { query: "routing" }),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated identical khala_search_memory call without an intervening mutation",
    },
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Search memory for harness routing."),
      assistantToolCall("khala_search_memory", {
        query: "README harness routing",
      }),
      assistantToolCall("khala_search_memory", {
        query: "routing README harness memory",
      }),
    ]),
    "khala_search_memory query README harness routing",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Search memory for harness routing."),
      assistantToolCall("khala_search_memory", {
        query: "README harness routing workflows",
      }),
      assistantToolCall("khala_search_memory", {
        query: "README harness routes workflow",
      }),
    ]),
    "khala_search_memory query README harness routing workflows",
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Search memory for harness routing."),
        assistantToolCall("khala_search_memory", {
          query: "README harness routing",
        }),
        assistantToolCall("khala_search_memory", {
          query: "routing README harness memory",
        }),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated khala_search_memory query for README harness routing without an intervening mutation",
    },
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("web_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("web_search", {
        query: "official docs TypeScript decorators latest",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorator docs."),
      assistantToolCall("web_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("web_search", {
        query: "TypeScript decorator documentation",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("web.run", {
        search_query: [{ q: "current TypeScript decorators official docs" }],
      }),
      assistantToolCall("web.run", {
        search_query: [{ q: "official docs TypeScript decorators latest" }],
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up TypeScript docs and OpenAI pricing."),
      assistantToolCall("web.run", {
        search_query: [
          { q: "current TypeScript decorators official docs" },
          { q: "OpenAI pricing official" },
        ],
      }),
      assistantToolCall("web.run", {
        search_query: [
          { q: "React docs official" },
          { q: "latest OpenAI pricing" },
        ],
      }),
    ]),
    "external search query OpenAI pricing",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up current OpenAI pricing."),
      assistantToolCall("web.run", {
        search_query: [{ q: "pricing", domains: ["openai.com"] }],
      }),
      assistantToolCall("web.run", {
        search_query: [{ q: "latest pricing", domains: ["openai.com"] }],
      }),
    ]),
    "external search query openai.com pricing",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("browser_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("browser_search", {
        query: "official docs TypeScript decorators latest",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("web_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("browser_search", {
        query: "official docs TypeScript decorators latest",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("docs_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("docs_search", {
        query: "official docs TypeScript decorators latest",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Look up the current TypeScript decorators docs."),
      assistantToolCall("docs_search", {
        query: "current TypeScript decorators official docs",
      }),
      assistantToolCall("web_search", {
        query: "official docs TypeScript decorators latest",
      }),
    ]),
    "external search query TypeScript decorators",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Open the TypeScript release notes."),
      assistantToolCall("browser_open", {
        url: "https://www.typescriptlang.org/docs/",
      }),
      assistantToolCall("browser_open", {
        url: "https://www.typescriptlang.org/docs/",
      }),
    ]),
    "browser_open",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Fetch the TypeScript release notes."),
      assistantToolCall("fetch", {
        url: "https://www.typescriptlang.org/docs/",
      }),
      assistantToolCall("fetch", {
        url: "https://www.typescriptlang.org/docs/",
      }),
    ]),
    "fetch",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Open and fetch the TypeScript docs."),
      assistantToolCall("browser_open", {
        url: "https://www.typescriptlang.org/docs/",
      }),
      assistantToolCall("fetch", {
        url: "https://www.typescriptlang.org/docs",
      }),
    ]),
    "external URL https://www.typescriptlang.org/docs",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Open and fetch the TypeScript docs."),
      assistantToolCall("browser_open", {
        url: "https://www.typescriptlang.org/docs/?utm_source=chat#handbook",
      }),
      assistantToolCall("fetch", {
        url: "https://www.typescriptlang.org/docs",
      }),
    ]),
    "external URL https://www.typescriptlang.org/docs",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Open the TypeScript docs."),
      assistantToolCall("web.run", {
        open: [
          {
            ref_id:
              "https://www.typescriptlang.org/docs/?utm_source=chat#handbook",
          },
        ],
      }),
      assistantToolCall("web.run", {
        open: [{ ref_id: "https://www.typescriptlang.org/docs" }],
      }),
    ]),
    "external URL https://www.typescriptlang.org/docs",
  );

  assert.equal(
    findRedundantEvidenceToolCall([
      textMessage("user", "Open the TypeScript docs and OpenAI pricing."),
      assistantToolCall("web.run", {
        open: [
          { ref_id: "https://react.dev/reference/react" },
          { ref_id: "https://openai.com/api/pricing/?utm_source=chat#models" },
        ],
      }),
      assistantToolCall("web.run", {
        open: [
          { ref_id: "https://www.typescriptlang.org/docs/" },
          { ref_id: "https://openai.com/api/pricing" },
        ],
      }),
    ]),
    "external URL https://openai.com/api/pricing",
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Look up the current TypeScript decorators docs."),
        assistantToolCall("web_search", {
          query: "current TypeScript decorators official docs",
        }),
        assistantToolCall("web_search", {
          query: "official docs TypeScript decorators latest",
        }),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated external search query for TypeScript decorators without an intervening mutation",
    },
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Open and fetch the TypeScript docs."),
        assistantToolCall("browser_open", {
          url: "https://www.typescriptlang.org/docs/",
        }),
        assistantToolCall("fetch", {
          url: "https://www.typescriptlang.org/docs",
        }),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated external URL evidence for https://www.typescriptlang.org/docs without an intervening mutation",
    },
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated khala_learn storage for the same trigger and lesson after a successful write; reuse the stored lesson instead of writing it again",
    },
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
        assistantToolCall("khala_learn", {
          ...concreteLearnArgs,
          evidenceSnippet:
            "User repeated the same repo search lesson in different words.",
          score: 0.95,
          confidence: 0.9,
        }),
        toolResult("stored"),
      ],
    }),
    {
      efficient: false,
      reason:
        "repeated khala_learn storage for the same trigger and lesson after a successful write; reuse the stored lesson instead of writing it again",
    },
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("khala_learn rejected candidate below storage threshold"),
        assistantToolCall("khala_learn", {
          ...concreteLearnArgs,
          evidenceSnippet:
            "User repeated the same repo search lesson in different words.",
        }),
        toolResult("stored"),
      ],
    }),
    {
      efficient: true,
      reason:
        "no redundant evidence, unbounded shell, broad query, or duplicate learning-storage calls detected",
    },
  );

  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("ok"),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
      ],
    }),
    {
      efficient: true,
      reason:
        "no redundant evidence, unbounded shell, broad query, or duplicate learning-storage calls detected",
    },
  );
});

test("detects unbounded local shell evidence commands", () => {
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "cat README.md" }),
    ]),
    "unbounded cat command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("exec_command", { cmd: "cat README.md" }),
    ]),
    "unbounded cat command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package metadata."),
      assistantToolCall("exec_command", {
        cmd: "cat package.json | head -40",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find generated files."),
      assistantToolCall("bash", { command: "find . -type f" }),
    ]),
    "unbounded find command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find shallow files."),
      assistantToolCall("bash", { command: "find . -maxdepth 2 -type f" }),
    ]),
    "unbounded find command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find one config file."),
      assistantToolCall("bash", {
        command: "find . -maxdepth 3 -name package.json",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find a few files."),
      assistantToolCall("bash", {
        command: "find . -maxdepth 2 -type f | head -40",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find generated files."),
      assistantToolCall("bash", {
        command: "find . -maxdepth 20 -name '*.generated.ts'",
      }),
    ]),
    "unbounded find command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find files quickly."),
      assistantToolCall("bash", { command: "fd" }),
    ]),
    "unbounded fd command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find all files quickly."),
      assistantToolCall("bash", { command: "fd . ." }),
    ]),
    "unbounded fd command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find package manifests."),
      assistantToolCall("bash", { command: "fd package.json" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find a few TypeScript files."),
      assistantToolCall("bash", { command: "fd -e ts --max-results 40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect generated files."),
      assistantToolCall("bash", { command: "rg --files | xargs cat" }),
    ]),
    "unbounded xargs evidence fanout command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a bounded sample of generated files."),
      assistantToolCall("bash", {
        command: "rg --files | xargs cat | head -120",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect source snippets."),
      assistantToolCall("bash", {
        command: "sed -n '1,80p' $(rg --files)",
      }),
    ]),
    "unbounded command substitution evidence fanout command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect TypeScript snippets."),
      assistantToolCall("bash", {
        command: "sed -n '1,80p' $(rg --files -g '*.ts')",
      }),
    ]),
    "unbounded command substitution evidence fanout command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a bounded snippet sample."),
      assistantToolCall("bash", {
        command: "sed -n '1,80p' $(rg --files | head -10)",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect one config file."),
      assistantToolCall("bash", {
        command:
          "sed -n '1,80p' $(find . -maxdepth 3 -name package.json -print -quit)",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "awk '1' README.md" }),
    ]),
    "unbounded scripted file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "awk '{print}' README.md" }),
    ]),
    "unbounded scripted file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", {
        command: "awk '{print}' README.md | head -80",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "perl -ne 'print' README.md" }),
    ]),
    "unbounded scripted file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", {
        command:
          "python -c \"from pathlib import Path; print(Path('README.md').read_text())\"",
      }),
    ]),
    "unbounded scripted file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", {
        command:
          "node -e \"console.log(require('fs').readFileSync('README.md', 'utf8'))\"",
      }),
    ]),
    "unbounded scripted file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package metadata."),
      assistantToolCall("bash", { command: "cat package.json | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package metadata."),
      assistantToolCall("bash", {
        command: "cat package.json | sed -n '1,80p'",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "cat README.md | sed -n p" }),
    ]),
    "unbounded cat command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "cat README.md | awk '{print}'" }),
    ]),
    "unbounded cat command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "nl -ba README.md" }),
    ]),
    "unbounded file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", {
        command: "bat --style=plain README.md | head -80",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "less README.md" }),
    ]),
    "unbounded file dump command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "cat README.md | head -1000" }),
    ]),
    "excessive head/tail line limit",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent logs."),
      assistantToolCall("bash", { command: "tail -n 500 runtime.log" }),
    ]),
    "excessive head/tail line limit",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README."),
      assistantToolCall("bash", { command: "sed -n '1,999p' README.md" }),
    ]),
    "unbounded sed print command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the README intro."),
      assistantToolCall("bash", { command: "sed -n '1,80p' README.md" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search the repo."),
      assistantToolCall("bash", { command: "rg TODO . --max-count 1000" }),
    ]),
    "excessive grep/rg match limit",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find source files."),
      assistantToolCall("bash", { command: "rg --files" }),
    ]),
    "unbounded rg --files command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find source files."),
      assistantToolCall("bash", { command: "rg --files ." }),
    ]),
    "unbounded rg --files command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find TypeScript source files."),
      assistantToolCall("bash", { command: "rg --files -g '*.ts'" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search the repo."),
      assistantToolCall("bash", { command: "rg TODO" }),
    ]),
    "unbounded rg command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search TypeScript files."),
      assistantToolCall("bash", { command: "rg -g '*.ts' TODO" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search one file."),
      assistantToolCall("bash", {
        command: "rg TODO extensions/runtime/escalation.ts",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search with a small limit."),
      assistantToolCall("bash", { command: "rg TODO -m 40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package lock metadata."),
      assistantToolCall("bash", { command: "jq . package-lock.json" }),
    ]),
    "unbounded jq command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect compact package lock metadata."),
      assistantToolCall("bash", { command: "jq -c . package-lock.json" }),
    ]),
    "unbounded jq command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package scripts."),
      assistantToolCall("bash", { command: "jq '.scripts' package.json" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect package lock metadata."),
      assistantToolCall("bash", { command: "jq . package-lock.json | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find test files."),
      assistantToolCall("bash", { command: "rg --files tests/runtime" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Review the changes."),
      assistantToolCall("bash", { command: "git diff" }),
    ]),
    "unbounded VCS patch output command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Review the changed files."),
      assistantToolCall("bash", { command: "git diff --name-only" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Review the changes."),
      assistantToolCall("bash", { command: "git diff --stat --patch" }),
    ]),
    "unbounded VCS patch output command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent history."),
      assistantToolCall("bash", { command: "git log --oneline" }),
    ]),
    "unbounded VCS history output command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent history."),
      assistantToolCall("bash", { command: "git log --oneline -5" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent history."),
      assistantToolCall("bash", { command: "git reflog --max-count=20" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search tracked files."),
      assistantToolCall("bash", { command: "git grep TODO" }),
    ]),
    "unbounded git grep command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search tracked files with a small limit."),
      assistantToolCall("bash", { command: "git grep -m 40 TODO" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search one tracked file."),
      assistantToolCall("bash", {
        command: "git grep TODO -- extensions/runtime/escalation.ts",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List tracked files."),
      assistantToolCall("bash", { command: "git ls-files" }),
    ]),
    "unbounded git ls-files command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Count tracked files."),
      assistantToolCall("bash", { command: "git ls-files | wc -l" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List tracked runtime files."),
      assistantToolCall("bash", { command: "git ls-files -- extensions/runtime" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List the repository tree."),
      assistantToolCall("bash", { command: "git ls-tree -r HEAD" }),
    ]),
    "unbounded git ls-tree command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Count repository tree entries."),
      assistantToolCall("bash", { command: "git ls-tree -r HEAD | wc -l" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List runtime tree entries."),
      assistantToolCall("bash", {
        command: "git ls-tree -r HEAD -- extensions/runtime",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the current change state."),
      assistantToolCall("bash", { command: "git status" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect branches."),
      assistantToolCall("bash", { command: "git branch --show-current" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect repo shape."),
      assistantToolCall("bash", { command: "tree ." }),
    ]),
    "unbounded repo summary command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect repo shape."),
      assistantToolCall("bash", { command: "tree -L 2 ." }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect repo sizes."),
      assistantToolCall("bash", { command: "du -ah ." }),
    ]),
    "unbounded repo summary command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect repo size."),
      assistantToolCall("bash", { command: "du -sh ." }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect environment."),
      assistantToolCall("bash", { command: "env" }),
    ]),
    "unbounded environment listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect one environment variable."),
      assistantToolCall("bash", { command: "printenv PATH" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a few environment variables."),
      assistantToolCall("bash", { command: "printenv | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect processes."),
      assistantToolCall("bash", { command: "ps aux" }),
    ]),
    "unbounded process listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a few processes."),
      assistantToolCall("bash", { command: "ps -ef | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect dependency tree."),
      assistantToolCall("bash", { command: "npm list" }),
    ]),
    "unbounded dependency listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect top-level dependencies."),
      assistantToolCall("bash", { command: "npm list --depth=0" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect Python packages."),
      assistantToolCall("bash", { command: "pip freeze" }),
    ]),
    "unbounded dependency listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a few Python packages."),
      assistantToolCall("bash", { command: "pip list | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect Rust dependency tree."),
      assistantToolCall("bash", { command: "cargo tree" }),
    ]),
    "unbounded dependency listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect containers."),
      assistantToolCall("bash", { command: "docker ps" }),
    ]),
    "unbounded container listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect a few containers."),
      assistantToolCall("bash", { command: "docker ps | head -40" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect container logs."),
      assistantToolCall("bash", { command: "docker logs api" }),
    ]),
    "unbounded container log command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent container logs."),
      assistantToolCall("bash", { command: "docker logs --tail=80 api" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect cluster resources."),
      assistantToolCall("bash", { command: "kubectl get pods -A" }),
    ]),
    "unbounded cluster listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect namespace pods."),
      assistantToolCall("bash", { command: "kubectl get pods -n default" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect pod logs."),
      assistantToolCall("bash", { command: "kubectl logs deploy/api" }),
    ]),
    "unbounded cluster log command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect recent pod logs."),
      assistantToolCall("bash", { command: "kubectl logs deploy/api --tail 80" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect Helm releases."),
      assistantToolCall("bash", { command: "helm list --all-namespaces" }),
    ]),
    "unbounded cluster listing command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect part of the diff."),
      assistantToolCall("bash", { command: "git diff | head -200" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Run the test suite."),
      assistantToolCall("bash", { command: "npm test -- --watch" }),
    ]),
    "unbounded watch/follow command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Run TypeScript in watch mode."),
      assistantToolCall("bash", { command: "tsc --watch" }),
    ]),
    "unbounded watch/follow command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Inspect the live log."),
      assistantToolCall("bash", { command: "tail -f runtime.log" }),
    ]),
    "unbounded watch/follow command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Run the test suite once."),
      assistantToolCall("bash", { command: "npm test -- --watch=false" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch release notes."),
      assistantToolCall("bash", {
        command: "curl -L https://www.typescriptlang.org/docs/",
      }),
    ]),
    "network fetch command without timeout",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch release notes."),
      assistantToolCall("bash", {
        command: "curl --max-time 20 -L https://www.typescriptlang.org/docs/",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch release notes."),
      assistantToolCall("bash", {
        command: "timeout 20 curl -L https://www.typescriptlang.org/docs/",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch release notes."),
      assistantToolCall("bash", {
        command: "wget https://www.typescriptlang.org/docs/",
      }),
    ]),
    "network fetch command without timeout",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch release notes."),
      assistantToolCall("bash", {
        command: "wget -T 20 https://www.typescriptlang.org/docs/",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command: "http https://api.github.com/repos/openai/openai-node",
      }),
    ]),
    "network fetch command without timeout",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command: "http --timeout=20 https://api.github.com/repos/openai/openai-node",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command: "https --timeout 20 api.github.com/repos/openai/openai-node",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command:
          "python - <<'PY'\nimport requests\nprint(requests.get('https://api.github.com/repos/openai/openai-node').status_code)\nPY",
      }),
    ]),
    "scripted network fetch command without timeout",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command:
          "python - <<'PY'\nimport requests\nprint(requests.get('https://api.github.com/repos/openai/openai-node', timeout=20).status_code)\nPY",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command:
          "node -e \"fetch('https://api.github.com/repos/openai/openai-node').then(r => console.log(r.status))\"",
      }),
    ]),
    "scripted network fetch command without timeout",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Fetch API metadata."),
      assistantToolCall("bash", {
        command:
          "node -e \"fetch('https://api.github.com/repos/openai/openai-node', { signal: AbortSignal.timeout(20000) }).then(r => console.log(r.status))\"",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search the repo."),
      assistantToolCall("bash", { command: "grep -R -m 40 TODO ." }),
    ]),
    "recursive grep command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Search runtime tests."),
      assistantToolCall("bash", { command: "grep -R -m 40 TODO tests/runtime" }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List test files."),
      assistantToolCall("bash", { command: "find tests -type f" }),
    ]),
    "unbounded find command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List source files."),
      assistantToolCall("bash", { command: "find src -type f" }),
    ]),
    "unbounded find command",
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "Find one runtime test file."),
      assistantToolCall("bash", {
        command: "find tests/runtime -name '*escalation*' -print -quit",
      }),
    ]),
    null,
  );
  assert.equal(
    findInefficientShellEvidenceCall([
      textMessage("user", "List a shallow package folder."),
      assistantToolCall("bash", {
        command: "find extensions -maxdepth 2 -name '*.ts'",
      }),
    ]),
    null,
  );
  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Search the repo."),
        assistantToolCall("bash", { command: "grep -R TODO ." }),
      ],
    }),
    {
      efficient: false,
      reason:
        "recursive grep command; use bounded read/search tools or add explicit limits",
    },
  );
});

test("detects broad memory and external evidence queries as inefficient", () => {
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Search memory for this task."),
      assistantToolCall("khala_search_memory", { query: "fix repo" }),
    ]),
    "khala_search_memory: query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest docs."),
      assistantToolCall("web_search", { query: "latest docs" }),
    ]),
    "web_search: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest docs."),
      assistantToolCall("web.run", {
        search_query: [{ q: "latest docs" }],
      }),
    ]),
    "web.run: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest TypeScript release."),
      assistantToolCall("web.run", {
        search_query: [
          { q: "latest docs" },
          { q: "latest TypeScript release official" },
        ],
      }),
    ]),
    "web.run: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up current OpenAI pricing."),
      assistantToolCall("web.run", {
        search_query: [{ q: "pricing", domains: ["openai.com"] }],
      }),
    ]),
    null,
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up release notes."),
      assistantToolCall("web_search", { query: "latest release notes" }),
    ]),
    "web_search: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest docs."),
      assistantToolCall("docs_search", { query: "latest docs" }),
    ]),
    "docs_search: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest docs."),
      assistantToolCall("subagent", {
        agent: "researcher",
        task: "fetch source",
      }),
    ]),
    "subagent: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified",
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest TypeScript release."),
      assistantToolCall("web_search", {
        query: "latest TypeScript release official",
      }),
    ]),
    null,
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up TypeScript docs."),
      assistantToolCall("docs_search", {
        query: "TypeScript decorators official docs",
      }),
    ]),
    null,
  );
  assert.equal(
    findBroadEvidenceQueryCall([
      textMessage("user", "Look up the latest TypeScript release."),
      assistantToolCall("subagent", {
        agent: "researcher",
        task: "verify latest TypeScript release from official source",
      }),
      toolResult("verified TypeScript release"),
    ]),
    null,
  );
  assert.deepEqual(
    evaluateToolEfficiency({
      messages: [
        textMessage("user", "Look up the latest docs."),
        assistantToolCall("web_search", { query: "latest docs" }),
      ],
    }),
    {
      efficient: false,
      reason:
        "web_search: query is too broad; include the product, library, API, package, standard, organization, URL, or exact fact being verified; use a focused task-specific query",
    },
  );
});

test("requires memory search for substantial tool-backed work", () => {
  assert.equal(
    memorySearchNeedReason({
      messages: [
        textMessage("user", "Fix the runtime."),
        assistantToolCall("read", { path: "a.ts" }),
      ],
      userText: "Fix the runtime.",
    }),
    "user requested non-trivial tool-backed work",
  );
  assert.equal(
    memorySearchNeedReason({
      messages: [
        textMessage("user", "Inspect files."),
        assistantToolCall("read", { path: "a.ts" }),
        assistantToolCall("read", { path: "b.ts" }),
        assistantToolCall("grep", { pattern: "foo" }),
        assistantToolCall("find", { pattern: "bar" }),
      ],
      userText: "Inspect files.",
    }),
    "turn used 4 non-memory tool calls",
  );

  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Inspect files."),
      assistantToolCall("khala_search_memory", {
        query: "runtime inspection workflow",
      }),
      toolResult("relevant runtime inspection memory"),
      assistantToolCall("read", { path: "a.ts" }),
      assistantToolCall("read", { path: "b.ts" }),
      assistantToolCall("grep", { pattern: "foo" }),
      assistantToolCall("find", { pattern: "bar" }),
    ]),
    false,
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Inspect files."),
        assistantToolCall("khala_search_memory", {
          query: "runtime inspection workflow",
        }),
        toolResult("relevant runtime inspection memory"),
        assistantToolCall("read", { path: "a.ts" }),
        assistantToolCall("read", { path: "b.ts" }),
        assistantToolCall("grep", { pattern: "foo" }),
        assistantToolCall("find", { pattern: "bar" }),
      ],
      userText: "Inspect files.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn used 4 non-memory tool calls",
    },
  );

  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Inspect files."),
      assistantToolCall("khala_search_memory", {
        query: "runtime inspection workflow",
      }),
      toolResult("relevant runtime inspection memory"),
      assistantToolCall("khala_read_memory", {}),
      toolResult("recent runtime memory"),
      assistantToolCall("khala_read_memory", {}),
      toolResult("recent runtime memory"),
      assistantToolCall("read", { path: "a.ts" }),
      assistantToolCall("read", { path: "b.ts" }),
      assistantToolCall("grep", { pattern: "foo" }),
    ]),
    true,
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Inspect files."),
        assistantToolCall("khala_search_memory", {
          query: "runtime inspection workflow",
        }),
        toolResult("relevant runtime inspection memory"),
        assistantToolCall("read", { path: "a.ts" }),
        assistantToolCall("read", { path: "b.ts" }),
        assistantToolCall("grep", { pattern: "foo" }),
        assistantToolCall("khala_search_memory", {
          query: "runtime inspection workflow",
        }),
        toolResult("refreshed runtime inspection memory"),
        assistantToolCall("find", { pattern: "bar" }),
      ],
      userText: "Inspect files.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn used 4 non-memory tool calls",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix the runtime."),
        assistantToolCall("khala_search_memory", {
          query: "README patch workflow",
        }),
        toolResult("unrelated README memory"),
        assistantToolCall("read", { path: "a.ts" }),
      ],
      userText: "Fix the runtime.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user requested non-trivial tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix the runtime."),
        assistantToolCall("khala_search_memory", {
          query: "runtime fix workflow",
        }),
        toolResult("relevant runtime memory"),
        assistantToolCall("read", { path: "a.ts" }),
      ],
      userText: "Fix the runtime.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user requested non-trivial tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix README.md bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README.md docs lesson",
        }),
        toolResult("generic README documentation memory"),
        assistantToolCall("read", { path: "README.md" }),
      ],
      userText: "Fix README.md bootstrap section.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user requested non-trivial tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix README.md bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README bootstrap fix workflow",
        }),
        toolResult("relevant README bootstrap patch memory"),
        assistantToolCall("read", { path: "README.md" }),
      ],
      userText: "Fix README.md bootstrap section.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user requested non-trivial tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix README.md TypeScript bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README bootstrap fix workflow",
        }),
        toolResult("relevant README bootstrap patch memory"),
        assistantToolCall("read", { path: "README.md" }),
      ],
      userText: "Fix README.md TypeScript bootstrap section.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user requested non-trivial tool-backed work",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Fix README.md TypeScript bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README TypeScript bootstrap fix workflow",
        }),
        toolResult("relevant README TypeScript bootstrap patch memory"),
        assistantToolCall("read", { path: "README.md" }),
      ],
      userText: "Fix README.md TypeScript bootstrap section.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user requested non-trivial tool-backed work",
    },
  );
});

test("uses configured substantial tool-call threshold", () => {
  assert.equal(
    memorySearchNeedReason({
      messages: [
        textMessage("user", "Inspect files."),
        assistantToolCall("read", { path: "a.ts" }),
        assistantToolCall("read", { path: "b.ts" }),
      ],
      userText: "Inspect files.",
      harnessLimits: { substantialToolCallThreshold: 2 },
    }),
    "turn used 2 non-memory tool calls",
  );
});

test("requires memory search for mutations and accepts khala_search_memory", () => {
  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Fix the runtime."),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("relevant runtime memory"),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("failed: memory index unavailable"),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Fix the runtime."),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("failed: memory index unavailable"),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("relevant runtime memory"),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Fix the runtime."),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("ok"),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Fix the runtime."),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("relevant memory found"),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearch([
      textMessage("user", "Fix the runtime."),
      assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
      toolResult("3 relevant memories returned"),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("failed: memory index unavailable"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant memories found"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("apply_patch", { patch: "*** Begin Patch\n..." }),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("done"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("unrelated README patch memory"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("not relevant README patch memory"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("read", { path: "README.md" }),
      assistantToolCall("grep", { pattern: "bootstrap", path: "README.md" }),
      assistantToolCall("find", { pattern: "README.md" }),
      assistantToolCall("ls", { path: "." }),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("read", { path: "README.md" }),
      assistantToolCall("grep", { pattern: "bootstrap", path: "README.md" }),
      assistantToolCall("find", { pattern: "README.md" }),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("refreshed README patch memory"),
      assistantToolCall("ls", { path: "." }),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("bash", {
        command: "sed -i 's/old/new/' README.md",
      }),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("bash", {
        command: "sed -i 's/old/new/' README.md",
      }),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("failed: memory index unavailable"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("failed: memory index unavailable"),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
      toolResult("relevant README patch memory"),
      assistantToolCall("edit", { path: "README.md" }),
    ]),
    true,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("edit", { path: "README.md" }),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
    ]),
    false,
  );
  assert.equal(
    conversationHasMemorySearchBeforeFirstMutation([
      textMessage("user", "Patch README.md."),
      assistantToolCall("apply_patch", { patch: "*** Begin Patch\n..." }),
      assistantToolCall("khala_search_memory", { query: "README patch" }),
    ]),
    false,
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README.md docs lesson",
        }),
        toolResult("generic README documentation memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md bootstrap section.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md bootstrap section."),
        assistantToolCall("khala_search_memory", {
          query: "README bootstrap patch workflow",
        }),
        toolResult("relevant README bootstrap patch memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md bootstrap section.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", {
          command: "python3 -c \"from pathlib import Path; Path('README.md').write_text('new')\"",
        }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Install the lodash dependency."),
        assistantToolCall("bash", {
          command: "npm install lodash",
        }),
      ],
      userText: "Install the lodash dependency.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Install the lodash dependency."),
        assistantToolCall("khala_search_memory", {
          query: "lodash dependency install package.json",
        }),
        toolResult("relevant lodash package dependency memory"),
        assistantToolCall("bash", {
          command: "npm install lodash",
        }),
      ],
      userText: "Install the lodash dependency.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Overwrite README.md from stdin."),
        assistantToolCall("bash", {
          command: "printf new | dd of=README.md",
        }),
      ],
      userText: "Overwrite README.md from stdin.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Commit the current harness changes."),
        assistantToolCall("bash", {
          command: "git commit -am 'harness update'",
        }),
      ],
      userText: "Commit the current harness changes.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Commit the current harness changes."),
        assistantToolCall("khala_search_memory", {
          query: "harness commit workflow",
        }),
        toolResult("relevant harness commit memory"),
        assistantToolCall("bash", {
          command: "git commit -m 'harness update'",
        }),
      ],
      userText: "Commit the current harness changes.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("bash", {
          command:
            "node -e \"require('fs').writeFileSync('README.md', 'new')\"",
        }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "runtime fix workflow" }),
        toolResult("unrelated runtime memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("grep", { pattern: "bootstrap", path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
      harnessLimits: { substantialToolCallThreshold: 2 },
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md after npm test failure."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md after npm test failure.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md after npm test failure."),
        assistantToolCall("khala_search_memory", {
          query: "README npm test patch",
        }),
        toolResult("relevant README npm test patch memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md after npm test failure.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md after npx vitest failure."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md after npx vitest failure.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md after npx vitest failure."),
        assistantToolCall("khala_search_memory", {
          query: "README npx vitest patch",
        }),
        toolResult("relevant README npx vitest patch memory"),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md after npx vitest failure.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("bash", {
          command: "sed -i 's/old/new/' README.md",
        }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("bash", {
          command: "sed -i 's/old/new/' README.md",
        }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("failed: memory index unavailable"),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("failed: memory index unavailable"),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
        toolResult("relevant README patch memory"),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "turn performed mutation or memory persistence",
    },
  );

  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
        assistantToolCall("khala_search_memory", { query: "README patch" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );
});

test("requires focused khala_search_memory queries for memory routing", () => {
  assert.deepEqual(memorySearchQueryQuality("fix repo"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("follow-up"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("current-task"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("cache hit"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("previous session"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("lesson workflow"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("rule preference"), {
    focused: false,
    reason:
      "query is too broad; include workflow, technology, file, symbol, error, correction, or user intent",
  });
  assert.deepEqual(memorySearchQueryQuality("README.md patch workflow"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(memorySearchQueryQuality("README.md lesson"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(memorySearchQueryQuality("README.md cache"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(memorySearchQueryQuality("src/runtime bootstrap"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(memorySearchQueryQuality("EACCES"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(memorySearchQueryQuality("non-zero exit"), {
    focused: true,
    reason: "query has task-specific signal",
  });
  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Patch README.md."),
        assistantToolCall("khala_search_memory", { query: "fix repo" }),
        toolResult("broad memory result"),
        assistantToolCall("read", { path: "README.md" }),
        assistantToolCall("edit", { path: "README.md" }),
      ],
      userText: "Patch README.md.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "turn performed mutation or memory persistence",
    },
  );
});

test("detects explicit durable learning capture requests and memory claims", () => {
  assert.equal(
    learningCaptureNeedReason({
      userText:
        "Remember this rule for future reviews: inspect the failing test before patching.",
      assistantText: "Understood.",
    }),
    "user explicitly requested durable memory capture",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Remember to run lint before finalizing TypeScript changes.",
      assistantText: "Understood.",
    }),
    "user explicitly requested durable memory capture",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Note this for future reviews: use rg before slower searches.",
      assistantText: "Understood.",
    }),
    "user explicitly requested durable memory capture",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "I've stored this in memory.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "Saved to memory.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "Recorded in khala memory for later.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "Remembered for next time.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "I'll keep that in mind.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "Noted for next time.",
    }),
    "assistant claimed it stored or learned durable memory",
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "Noted.",
    }),
    null,
  );
  assert.equal(
    learningCaptureNeedReason({
      userText: "Explain how the learning system works.",
      assistantText: "The learning system stores records when appropriate.",
    }),
    null,
  );
});

test("requires khala_learn for durable learning capture", () => {
  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_assess_learning", {
          taskSummary: "remember a search lesson",
        }),
      ],
      userText: "Remember this lesson: use rg before slower repo searches.",
      assistantText: "I assessed the lesson.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Explain how the learning system works."),
      ],
      userText: "Explain how the learning system works.",
      assistantText: "Saved to memory.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed it stored or learned durable memory",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Okay."),
        assistantToolCall("khala_learn", lintLearnArgs),
        toolResult("stored"),
      ],
      userText: "Okay.",
      assistantText: "Stored the Docker deployment rollback rule in memory.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed it stored or learned durable memory",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Okay."),
        assistantToolCall("khala_learn", {
          trigger: "Docker deployment rollback",
          lesson:
            "Before changing Docker deployment rollback workflows, inspect the previous rollback command and production evidence.",
          evidenceSnippet:
            "Assistant claimed it stored the Docker deployment rollback rule in memory.",
          score: 0.91,
          confidence: 0.88,
        }),
        toolResult("stored"),
      ],
      userText: "Okay.",
      assistantText: "Stored the Docker deployment rollback rule in memory.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed it stored or learned durable memory",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Explain how the learning system works."),
      ],
      userText: "Explain how the learning system works.",
      assistantText: "I'll keep that in mind.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant claimed it stored or learned durable memory",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Explain how the learning system works."),
        assistantToolCall("khala_learn", {
          trigger: "learning system explanation",
          lesson: "Explain the learning system storage requirements accurately.",
          evidenceSnippet: "Assistant claimed it saved the explanation to memory.",
          score: 0.91,
          confidence: 0.88,
        }),
        toolResult("stored"),
      ],
      userText: "Explain how the learning system works.",
      assistantText: "Saved to memory.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "assistant claimed it stored or learned durable memory",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage(
          "user",
          "Remember to run lint before finalizing TypeScript changes.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
      ],
      userText: "Remember to run lint before finalizing TypeScript changes.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Remember to run lint before finalizing TypeScript changes."),
        assistantToolCall("khala_learn", {
          trigger: "lint before finalizing",
          lesson: "Run lint before finalizing code changes for the user.",
          evidenceSnippet: "User explicitly asked to remember the lint finalization rule.",
          score: 0.91,
          confidence: 0.88,
        }),
        toolResult("stored"),
      ],
      userText: "Remember to run lint before finalizing TypeScript changes.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage("user", "Remember to run lint before finalizing TypeScript changes."),
        assistantToolCall("khala_learn", {
          trigger: "TypeScript lint finalization",
          lesson: "Run lint before finalizing code changes for the user.",
          evidenceSnippet:
            "User explicitly asked to remember the TypeScript lint finalization rule.",
          score: 0.91,
          confidence: 0.88,
        }),
        toolResult("stored"),
      ],
      userText: "Remember to run lint before finalizing TypeScript changes.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage(
          "user",
          "Remember to run lint before finalizing TypeScript changes.",
        ),
        assistantToolCall("khala_learn", lintLearnArgs),
        toolResult("stored"),
      ],
      userText: "Remember to run lint before finalizing TypeScript changes.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("khala_learn rejected candidate below storage threshold"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("created review candidate"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult(JSON.stringify({ created: true })),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult(JSON.stringify({ stored: false, reason: "duplicate" })),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored: false"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("not stored: duplicate candidate"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored in session-only memory, not durable"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", {
        ...concreteLearnArgs,
        score: 0.7,
        confidence: 0.92,
      }),
      toolResult("stored"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", {
        ...concreteLearnArgs,
        score: 0.92,
        confidence: 0.7,
      }),
      toolResult("stored"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", {
        trigger: "repo search",
        lesson: "Use rg before slower repository search tools.",
      }),
      toolResult("stored"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored"),
    ]),
    true,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("ok"),
    ]),
    false,
  );

  assert.equal(
    conversationHasLearningCapture([
      textMessage(
        "user",
        "Remember this lesson: use rg before slower repo searches.",
      ),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("stored"),
      assistantToolCall("khala_learn", concreteLearnArgs),
      toolResult("khala_learn rejected candidate below storage threshold"),
    ]),
    false,
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
      ],
      userText: "Remember this lesson: use rg before slower repo searches.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: true,
      reason: "user explicitly requested durable memory capture",
    },
  );

  assert.deepEqual(
    evaluateLearningCapture({
      messages: [
        textMessage(
          "user",
          "Remember this lesson: use rg before slower repo searches.",
        ),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("stored"),
        assistantToolCall("khala_learn", concreteLearnArgs),
        toolResult("khala_learn rejected candidate below storage threshold"),
      ],
      userText: "Remember this lesson: use rg before slower repo searches.",
      assistantText: "Stored.",
    }),
    {
      required: true,
      satisfied: false,
      reason: "user explicitly requested durable memory capture",
    },
  );
});

test("evaluates end-turn harness issues in deterministic enforcement order", () => {
  const messages: Message[] = [
    textMessage(
      "user",
      "Remember this lesson and verify the latest docs before fix README.md.",
    ),
    assistantToolCall("read", { path: "README.md" }),
    assistantToolCall("read", { path: "README.md" }),
    textMessage(
      "assistant",
      "I cannot verify the latest docs, but I remembered it.\nConfidence: 0.42",
    ),
  ];

  const issues = evaluateHarnessTurn({
    messages,
    userText:
      "Remember this lesson and verify the latest docs before fix README.md.",
    assistantText:
      "I cannot verify the latest docs, but I remembered it.\nConfidence: 0.42",
    lowConfidenceThreshold: 0.7,
    responseComplianceMode: "enforce",
  });

  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      "tool_efficiency",
      "memory_search",
      "learning_capture",
      "evidence_routing",
      "model_escalation",
    ],
  );
  assert.equal(issues.every((issue) => issue.block), true);
  assert.match(issues[0].message, /^TOOL EFFICIENCY WARNING/);
});

test("combined harness accepts cheap evidence, memory, learning, and escalation paths", () => {
  const messages: Message[] = [
    textMessage(
      "user",
      "Remember this lesson and verify docs before fixing README.md.",
    ),
    assistantToolCall("khala_search_memory", { query: "README docs lesson" }),
    toolResult("relevant README docs lesson"),
    assistantToolCall("khala_learn", {
      trigger: "README docs verification before fixing",
      lesson: "Search memory and source docs before README documentation fixes.",
      evidenceSnippet:
        "User asked to remember source-doc verification before fixing README documentation.",
      score: 0.9,
      confidence: 0.86,
    }),
    toolResult("stored"),
    assistantToolCall("read", { path: "README.md" }),
    toolResult("README contents"),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4:high",
      task: "check low-confidence docs claim",
    }),
    toolResult("advisory review ok"),
    textMessage(
      "assistant",
      "Verified with local docs and advisory review.\nConfidence: 0.82",
    ),
  ];

  assert.deepEqual(
    evaluateHarnessTurn({
      messages,
      userText:
        "Remember this lesson and verify docs before fixing README.md.",
      assistantText:
        "Verified with local docs and advisory review.\nConfidence: 0.82",
      lowConfidenceThreshold: 0.7,
      responseComplianceMode: "enforce",
    }),
    [],
  );
});

test("does not require memory search for trivial one-tool inspection", () => {
  assert.deepEqual(
    evaluateMemorySearchRouting({
      messages: [
        textMessage("user", "Show package name."),
        assistantToolCall("read", { path: "package.json" }),
      ],
      userText: "Show package name.",
    }),
    {
      required: false,
      satisfied: true,
      reason: "turn was trivial enough for bootstrap memory",
    },
  );
});

test("requires escalation for low confidence or unresolved knowledge gaps", () => {
  assert.deepEqual(
    evaluateModelEscalation({
      messages: [textMessage("assistant", "Result: partial\nConfidence: 0.62")],
      assistantText: "Result: partial\nConfidence: 0.62",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "reported confidence 0.62 below threshold 0.70",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        assistantToolCall("subagent", {
          agent: "oracle",
          model: "anthropic/claude-sonnet-4:high",
          task: "verify low-confidence API behavior",
        }),
        toolResult("advisory result: API behavior verified"),
        textMessage(
          "assistant",
          "I cannot verify the API behavior.\nConfidence: 0.5",
        ),
      ],
      assistantText: "I cannot verify the API behavior.\nConfidence: 0.5",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason:
        "reported confidence 0.50 below threshold 0.70; assistant surfaced a knowledge gap",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        toolResult("failed"),
        toolResult("Error: no such file"),
        toolResult("exited with code 127"),
        assistantToolCall("subagent", {
          agent: "oracle",
          model: "anthropic/claude-sonnet-4:high",
          task: "diagnose repeated npm test failures",
        }),
        toolResult("advisory result: npm test root cause found"),
      ],
      assistantText: "The npm test failure root cause is resolved.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: true,
      reason: "3 tool failure results in this turn",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        textMessage(
          "assistant",
          "I'd need to see the logs to confirm the root cause.",
        ),
      ],
      assistantText: "I'd need to see the logs to confirm the root cause.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant surfaced a knowledge gap",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        textMessage(
          "assistant",
          "I haven't verified the latest docs yet, so this is tentative.",
        ),
      ],
      assistantText: "I haven't verified the latest docs yet, so this is tentative.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant surfaced a knowledge gap",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        textMessage(
          "assistant",
          "I wasn't able to confirm the current API behavior.",
        ),
      ],
      assistantText: "I wasn't able to confirm the current API behavior.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant surfaced a knowledge gap",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        textMessage(
          "assistant",
          "I couldn't reproduce the issue locally, so this is my best guess.",
        ),
      ],
      assistantText:
        "I couldn't reproduce the issue locally, so this is my best guess.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant surfaced a knowledge gap",
    },
  );

  assert.deepEqual(
    evaluateModelEscalation({
      messages: [
        textMessage(
          "assistant",
          "I couldn't validate the build locally, so this is tentative.",
        ),
      ],
      assistantText: "I couldn't validate the build locally, so this is tentative.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "assistant surfaced a knowledge gap",
    },
  );
});

test("requires substantive advisory escalation results", () => {
  const messages: Message[] = [
    textMessage("user", "Fix the failing command."),
    toolResult("failed"),
    toolResult("Error: no such file"),
    toolResult("exited with code 127"),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4:high",
      task: "diagnose repeated npm test failures",
    }),
    toolResult("advisory result: diagnose repeated npm test failures"),
  ];

  assert.equal(conversationHasModelEscalation(messages), false);
  assert.deepEqual(
    evaluateModelEscalation({
      messages,
      assistantText: "I can fix this.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "3 tool failure results in this turn",
    },
  );
});

test("requires escalation after repeated tool failures even without admitted uncertainty", () => {
  const messages: Message[] = [
    textMessage("user", "Fix the failing command."),
    assistantToolCall("bash", { command: "npm test" }),
    toolResult("failed"),
    assistantToolCall("bash", { command: "npm test -- --watch=false" }),
    toolResult("Error: no such file"),
    assistantToolCall("bash", { command: "npm run missing" }),
    toolResult("exited with code 127"),
  ];

  assert.equal(countToolFailures(messages), 3);
  assert.deepEqual(
    evaluateModelEscalation({
      messages,
      assistantText: "I can fix this.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "3 tool failure results in this turn",
    },
  );
});

test("does not count zero-failure test summaries as tool failures", () => {
  const messages: Message[] = [
    textMessage("user", "Run the checks."),
    toolResult("Tests: 42 passed, 0 failed"),
    toolResult("summary: failed 0, skipped 0"),
    toolResult("summary: 0 errors, 42 passed"),
    toolResult("ok\n# pass 12\n# fail 0"),
    toolResult("Tests: 0 passed, 0 failed"),
    toolResult("process exited with code 0"),
    toolResult(JSON.stringify({ exit_code: 0 })),
    toolResult(JSON.stringify({ returnCode: 0 })),
  ];

  assert.equal(countToolFailures(messages), 0);
  assert.equal(
    countToolFailures([
      textMessage("user", "Search docs."),
      toolResult("No results found"),
      toolResult("temporarily unavailable"),
    ]),
    0,
  );
});

test("counts common nonzero status and system error results as tool failures", () => {
  assert.equal(
    countToolFailures([
      textMessage("user", "Run the checks."),
      toolResult("process exited with exit status 1"),
      toolResult("command returned a non-zero exit"),
      toolResult("EACCES: permission denied opening cache"),
      toolResult("ECONNRESET while fetching source"),
      toolResult("ETIMEDOUT connecting to registry"),
      toolResult("2 errors"),
      toolResult("segmentation fault"),
      toolResult("fatal: process aborted"),
      toolResult("command canceled"),
      toolResult("killed by SIGKILL"),
      toolResult("npm ERR! code ELIFECYCLE"),
      toolResult("Cannot find module './missing'"),
      toolResult("Unhandled rejection"),
      toolResult(JSON.stringify({ exit_code: 1 })),
      toolResult(JSON.stringify({ exitCode: 2 })),
      toolResult(JSON.stringify({ return_code: 3 })),
      toolResult(JSON.stringify({ returnStatus: 4 })),
      toolResult(JSON.stringify({ success: false })),
      toolResult(JSON.stringify({ ok: false })),
      toolResult(JSON.stringify({ passed: 0 })),
    ]),
    20,
  );
});

test("requires repeated-failure escalation after the threshold failure", () => {
  const messages: Message[] = [
    textMessage("user", "Fix the failing command."),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4:high",
      task: "initial review npm test failure",
    }),
    toolResult("root cause found: npm test command lacks setup"),
    toolResult("failed"),
    toolResult("Error: no such file"),
    toolResult("exited with code 127"),
  ];

  assert.equal(conversationHasModelEscalation(messages), true);
  assert.equal(conversationHasModelEscalation(messages, 4), false);
  assert.deepEqual(
    evaluateModelEscalation({
      messages,
      assistantText: "I can fix this.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: false,
      reason: "3 tool failure results in this turn",
    },
  );
});

test("accepts stronger-model escalation after repeated tool failures", () => {
  const messages: Message[] = [
    textMessage("user", "Fix the failing command."),
    toolResult("failed"),
    toolResult("Error: no such file"),
    toolResult("exited with code 127"),
    assistantToolCall("subagent", {
      agent: "oracle",
      model: "anthropic/claude-sonnet-4:high",
      task: "diagnose repeated npm test failures",
    }),
    toolResult("root cause found: npm test setup is missing"),
  ];

  assert.deepEqual(
    evaluateModelEscalation({
      messages,
      assistantText: "I can fix this.",
      lowConfidenceThreshold: 0.7,
    }),
    {
      required: true,
      satisfied: true,
      reason: "3 tool failure results in this turn",
    },
  );
});

test("uses configured tool-failure escalation threshold", () => {
  const messages: Message[] = [
    textMessage("user", "Fix the failing command."),
    toolResult("failed"),
    toolResult("Error: no such file"),
  ];

  assert.deepEqual(
    evaluateModelEscalation({
      messages,
      assistantText: "I can fix this.",
      lowConfidenceThreshold: 0.7,
      harnessLimits: { toolFailureEscalationThreshold: 2 },
    }),
    {
      required: true,
      satisfied: false,
      reason: "2 tool failure results in this turn",
    },
  );
});
