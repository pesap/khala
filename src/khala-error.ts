function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function formatAttachedCleanupDiagnostic(error: unknown): string {
	if (!(error instanceof Error && "cleanupError" in error)) {
		return "";
	}
	return ` Cleanup also failed: ${formatError(error.cleanupError)}`;
}

function errorWithCause(message: string, cause: unknown): Error {
	const error = new Error(message);
	Object.defineProperty(error, "cause", { configurable: true, value: cause, writable: true });
	return error;
}

export { errorWithCause, formatAttachedCleanupDiagnostic, formatError };
