export type AntigravityAcpErrorCode =
	| "aborted"
	| "auth"
	| "model"
	| "protocol"
	| "quota"
	| "spawn"
	| "timeout"
	| "process_exit"
	| "invalid_input";

export interface AntigravityAcpErrorOptions extends ErrorOptions {
	resetAt?: string;
}

export class AntigravityAcpError extends Error {
	readonly resetAt: string | undefined;

	constructor(
		readonly code: AntigravityAcpErrorCode,
		message: string,
		options?: AntigravityAcpErrorOptions,
	) {
		super(message, options);
		this.name = "AntigravityAcpError";
		this.resetAt = options?.resetAt;
	}
}

export function abortError(message = "Antigravity ACP request aborted"): AntigravityAcpError {
	return new AntigravityAcpError("aborted", message);
}

export const ERROR_MESSAGE_LIMIT = 4_096;

export function errorMessage(cause: unknown): string {
	const raw = cause instanceof Error && cause.message ? cause.message : String(cause);
	return redact(raw).slice(0, ERROR_MESSAGE_LIMIT);
}

export function redact(text: string): string {
	return text
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1<redacted>@")
		.replace(/(?:AIza|sk-|npm_|gh[opurs]_)[A-Za-z0-9_-]{12,}/gu, "<redacted>")
		.replace(/\b(?:ya29\.|1\/\/)[A-Za-z0-9._~+/-]{12,}/gu, "<redacted>")
		.replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/giu, "$1<redacted>")
		.replace(
			/((?:["']?(?:access_token|refresh_token|id_token|client_secret|api[-_]?key)["']?)\s*[:=]\s*["']?)[^"'\s,;&}]+/giu,
			"$1<redacted>",
		);
}
