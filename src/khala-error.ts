const CREDENTIAL_KEY_PATTERN = String.raw`(?:awsaccesskeyid|accesskeyid|awssecretaccesskey|awssecuritytoken|aws[_-](?:access[_-]key[_-]id|secret[_-]access[_-]key|session[_-]token)|securitytoken|password|passwd|(?:[a-z\d]+[_-])*(?:password|passwd)|credential(?:s)?|auth(?:orization)?|signature|sig|x-amz-(?:signature|credential|security-token)|(?:[a-z\d]+[_-])*(?:token|key|secret|credential(?:s)?)|(?:access|api|auth|client|id|oauth|private|refresh|session)(?:token|key|secret|credential(?:s)?))`;
const CREDENTIAL_VALUE_PATTERN = String.raw`(?:"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|[^\s,;&#"'()[\]{}]+)`;
const AUTHORIZATION_CREDENTIAL_PATTERN = new RegExp(
	String.raw`(["']?\bauthorization\b["']?[ \t]*(?::|=)?[ \t]*["']?(?:Basic|Bearer)[ \t]+)(${CREDENTIAL_VALUE_PATTERN})(["']?)`,
	"gi",
);
const BEARER_CREDENTIAL_PATTERN = new RegExp(
	String.raw`(\bBearer[ \t]+)(?!\[REDACTED\])(${CREDENTIAL_VALUE_PATTERN})`,
	"gi",
);
const CREDENTIAL_PAIR_PATTERN = new RegExp(
	String.raw`(["']?\b${CREDENTIAL_KEY_PATTERN}\b["']?[ \t]*(?:[:=][ \t]*|[ \t]+))(?!["']?(?:Bearer|Basic)\b)(${CREDENTIAL_VALUE_PATTERN})`,
	"gi",
);

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function redactCredentialValue(value: string): string {
	const [quote] = value;
	if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
		return `${quote}[REDACTED]${quote}`;
	}
	return "[REDACTED]";
}

function redactDiagnostic(value: string): string {
	return value
		.replace(
			AUTHORIZATION_CREDENTIAL_PATTERN,
			(_match: string, prefix: string, credential: string, closingQuote: string) =>
				`${prefix}${redactCredentialValue(credential)}${closingQuote}`,
		)
		.replace(
			BEARER_CREDENTIAL_PATTERN,
			(_match: string, prefix: string, credential: string) => `${prefix}${redactCredentialValue(credential)}`,
		)
		.replace(
			CREDENTIAL_PAIR_PATTERN,
			(_match: string, prefix: string, credential: string) => `${prefix}${redactCredentialValue(credential)}`,
		)
		.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
}

function boundDiagnostic(value: string, maxLength: number): string {
	const diagnostic = redactDiagnostic(value).trim();
	if (maxLength <= 0) {
		return "";
	}
	if (diagnostic.length <= maxLength) {
		return diagnostic;
	}
	const suffix = "… [truncated]";
	if (maxLength <= suffix.length) {
		return suffix.slice(0, maxLength);
	}
	return `${diagnostic.slice(0, maxLength - suffix.length)}${suffix}`;
}

function formatBoundedDiagnostic(error: unknown, maxLength = 4096): string {
	return boundDiagnostic(formatError(error), maxLength);
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

export {
	boundDiagnostic,
	errorWithCause,
	formatAttachedCleanupDiagnostic,
	formatBoundedDiagnostic,
	formatError,
	redactDiagnostic,
};
