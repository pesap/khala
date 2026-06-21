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
  const githubUrl = target.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)(?:[/?#].*)?$/);
  if (githubUrl) {
    const number = Number(githubUrl[2]);
    return {
      ...(githubUrl[1] === "issues" ? { issue: number } : { pr: number }),
      url: target,
    };
  }
  if (/^https?:\/\//.test(target)) return { url: target };
  return undefined;
}
