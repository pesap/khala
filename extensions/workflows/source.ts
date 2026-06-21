import type { RunLedgerSourceContext } from "../runtime/run-ledger.ts";

function sourceFromUrl(url: string): RunLedgerSourceContext {
  const githubUrl = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)(?:[/?#].*)?$/);
  if (!githubUrl) return { url };
  const number = Number(githubUrl[2]);
  return {
    ...(githubUrl[1] === "issues" ? { issue: number } : { pr: number }),
    url,
  };
}

export function workflowSourceFromFlags(flags: Record<string, unknown>): RunLedgerSourceContext | undefined {
  const target = typeof flags.target === "string" ? flags.target.trim() : "";
  const repo = typeof flags.repo === "string" ? flags.repo.trim() : "";
  const pr = typeof flags.pr === "string" ? flags.pr.trim() : "";
  if (/^\d+$/.test(pr)) {
    return {
      pr: Number(pr),
      ...(repo ? { url: `https://github.com/${repo}/pull/${pr}` } : {}),
    };
  }
  if (/^https?:\/\//.test(pr)) return sourceFromUrl(pr);
  if (/^\d+$/.test(target)) {
    return {
      issue: Number(target),
      ...(repo ? { url: `https://github.com/${repo}/issues/${target}` } : {}),
    };
  }
  if (/^https?:\/\//.test(target)) return sourceFromUrl(target);
  return undefined;
}
