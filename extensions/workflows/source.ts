import type { RunLedgerSourceContext } from "../runtime/run-ledger.ts";

export function workflowSourceFromFlags(flags: Record<string, unknown>): RunLedgerSourceContext | undefined {
  const target = typeof flags.target === "string" ? flags.target.trim() : "";
  const repo = typeof flags.repo === "string" ? flags.repo.trim() : "";
  if (/^\d+$/.test(target)) {
    return {
      issue: Number(target),
      ...(repo ? { url: `https://github.com/${repo}/issues/${target}` } : {}),
    };
  }
  if (/^https?:\/\//.test(target)) return { url: target };
  return undefined;
}
