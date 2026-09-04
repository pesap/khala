export type RuntimeClosePort = Readonly<{ close: () => Promise<void> }>;

export async function closeRuntimeAfterDrain(
	runtime: RuntimeClosePort,
	operations: Promise<void>,
	timeoutMs: number,
): Promise<void> {
	const drained = await waitForDrain(operations, timeoutMs);
	if (!drained) await runtime.close();
	await operations;
	if (drained) await runtime.close();
}

export function hasPendingOperations(
	autonomousCycleRun: Promise<void> | undefined,
	pendingEffectsRun: Promise<void> | undefined,
	backgroundOperations: ReadonlySet<Promise<void>>,
): boolean {
	return autonomousCycleRun !== undefined || pendingEffectsRun !== undefined || backgroundOperations.size > 0;
}

export function pendingOperations(
	autonomousCycleRun: Promise<void> | undefined,
	pendingEffectsRun: Promise<void> | undefined,
	backgroundOperations: ReadonlySet<Promise<void>>,
): readonly Promise<void>[] {
	return [
		...(autonomousCycleRun === undefined ? [] : [autonomousCycleRun]),
		...(pendingEffectsRun === undefined ? [] : [pendingEffectsRun]),
		...backgroundOperations,
	];
}

async function waitForDrain(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
		timer.unref();
	});
	const drained = await Promise.race([operation.then(() => true), timeout]);
	if (timer !== undefined) clearTimeout(timer);
	return drained;
}
