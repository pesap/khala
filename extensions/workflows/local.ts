import type { RunLedgerLocalContext } from "../runtime/run-ledger.ts";

function stringFlag(flags: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function workflowLocalContextFromFlags(flags: Record<string, unknown>): RunLedgerLocalContext | undefined {
  const local = {
    worktreePath: stringFlag(flags, "worktreePath", "worktree", "worktree_path"),
    capsulePath: stringFlag(flags, "capsulePath", "capsule", "capsule_path"),
    ledgerPath: stringFlag(flags, "ledgerPath", "ledger", "ledger_path"),
  };
  return Object.values(local).some(Boolean) ? local : undefined;
}
