import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateHarnessTurn,
  evaluateHarnessTurnMetrics,
  type HarnessTurnIssue,
} from "../../extensions/runtime/escalation.ts";

type ReplayToolCall = {
  name: string;
  arguments?: unknown;
};

type ReplayMessage = {
  role: "assistant" | "user" | "toolResult" | "system";
  text?: string;
  toolCall?: ReplayToolCall;
};

type ReplayCase = {
  name: string;
  userText: string;
  assistantText: string;
  messages: ReplayMessage[];
  expectedIssueCodes: HarnessTurnIssue["code"][];
  expectedMetrics?: {
    toolCallCount?: number;
    focusedMemorySearches?: number;
    successfulMemorySearches?: number;
    skillLoads?: number;
    externalEvidenceCalls?: number;
    modelEscalations?: number;
    wasteSignalCount?: number;
    duplicateEvidence?: boolean;
  };
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  harnessLimits?: Parameters<typeof evaluateHarnessTurn>[0]["harnessLimits"];
};

type ReplayFile = {
  cases: ReplayCase[];
};

type HarnessMessage = Parameters<typeof evaluateHarnessTurn>[0]["messages"][number];

function replayMessageToHarnessMessage(message: ReplayMessage): HarnessMessage {
  if (message.toolCall) {
    return {
      role: message.role,
      content: [
        {
          type: "toolCall" as const,
          id: `call-${message.toolCall.name}`,
          name: message.toolCall.name,
          arguments: message.toolCall.arguments ?? {},
        },
      ],
    };
  }

  return {
    role: message.role,
    content: [{ type: "text" as const, text: message.text ?? "" }],
  };
}

async function loadReplayCases(): Promise<ReplayCase[]> {
  const fixture = await readFile(
    new URL("./fixtures/harness-replay.json", import.meta.url),
    "utf8",
  );
  const parsed = JSON.parse(fixture) as ReplayFile;
  return parsed.cases;
}

test("harness replay fixtures evaluate expected issue codes", async (t) => {
  const cases = await loadReplayCases();
  assert.ok(cases.length > 0, "expected at least one harness replay fixture");

  for (const replayCase of cases) {
    await t.test(replayCase.name, () => {
      const messages = replayCase.messages.map(replayMessageToHarnessMessage);
      const issues = evaluateHarnessTurn({
        assistantText: replayCase.assistantText,
        harnessLimits: replayCase.harnessLimits,
        lowConfidenceThreshold: replayCase.lowConfidenceThreshold ?? 0.7,
        messages,
        responseComplianceMode: replayCase.responseComplianceMode ?? "enforce",
        userText: replayCase.userText,
      });

      assert.deepEqual(
        issues.map((issue) => issue.code),
        replayCase.expectedIssueCodes,
      );

      if (replayCase.expectedMetrics) {
        const metrics = evaluateHarnessTurnMetrics({ messages });
        assert.equal(
          metrics.toolCallCount,
          replayCase.expectedMetrics.toolCallCount ?? metrics.toolCallCount,
        );
        assert.equal(
          metrics.memorySearches.focused,
          replayCase.expectedMetrics.focusedMemorySearches ??
            metrics.memorySearches.focused,
        );
        assert.equal(
          metrics.memorySearches.successful,
          replayCase.expectedMetrics.successfulMemorySearches ??
            metrics.memorySearches.successful,
        );
        assert.equal(
          metrics.skillLoads,
          replayCase.expectedMetrics.skillLoads ?? metrics.skillLoads,
        );
        assert.equal(
          metrics.externalEvidenceCalls,
          replayCase.expectedMetrics.externalEvidenceCalls ??
            metrics.externalEvidenceCalls,
        );
        assert.equal(
          metrics.modelEscalations,
          replayCase.expectedMetrics.modelEscalations ?? metrics.modelEscalations,
        );
        assert.equal(
          metrics.wasteSignals.count,
          replayCase.expectedMetrics.wasteSignalCount ??
            metrics.wasteSignals.count,
        );
        assert.equal(
          metrics.wasteSignals.duplicateEvidence,
          replayCase.expectedMetrics.duplicateEvidence ??
            metrics.wasteSignals.duplicateEvidence,
        );
      }
    });
  }
});
