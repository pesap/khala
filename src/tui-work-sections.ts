import type { SelectItem } from "@earendil-works/pi-tui";
import type { Actor, WorkView } from "./model.js";

export const WORK_SECTIONS = ["actions", "activity", "evidence", "archive", "peer-review", "blocking-signal"] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number];

export function executorActivityItems(work: WorkView, actor: Actor): SelectItem[] {
	const available = [
		actor === "user",
		work.state !== "succeeded",
		work.state !== "stopped",
		work.execution?.pi !== undefined,
	].every(Boolean);
	return available ? [{ value: "activity", label: "Executor activity" }] : [];
}
