import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";
import { inspectAntigravityAuth, resolveAntigravityAcpDirectory } from "./antigravity.js";
import { FORCE_FILE_STORAGE_ENV } from "./credential-storage.js";
import { withStoreLock } from "./store-lock.js";

export const DEFAULT_ACCOUNT_ID = "default";

const RESERVED_LABELS = new Set([DEFAULT_ACCOUNT_ID, "auto"]);
const RAW_LABEL_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,47}$/iu;
const NORMALIZED_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

export interface AccountsState {
	accounts: string[];
	preferred?: string;
}

export function normalizeAccountLabel(raw: string): string {
	const trimmed = raw.trim();
	if (!RAW_LABEL_PATTERN.test(trimmed)) {
		throw new Error(`Invalid account label '${raw}'. Use letters, digits, spaces, underscores, or hyphens.`);
	}
	const normalized = trimmed.toLowerCase().replace(/[ _-]+/gu, "-").replace(/^-+|-+$/gu, "");
	if (!NORMALIZED_LABEL_PATTERN.test(normalized) || RESERVED_LABELS.has(normalized)) {
		throw new Error(`Account label '${raw}' is invalid or reserved.`);
	}
	return normalized;
}

export function isValidAccountId(value: string): boolean {
	if (value === DEFAULT_ACCOUNT_ID) return true;
	return NORMALIZED_LABEL_PATTERN.test(value) && !RESERVED_LABELS.has(value);
}

export function resolveAccountsPath(): string {
	return path.join(resolveConfigRoot(), "accounts.json");
}

export function resolveAccountsDir(): string {
	return path.join(resolveConfigRoot(), "accounts");
}

export function resolveAccountGeminiHome(accountId: string, _env?: NodeJS.ProcessEnv): string | undefined {
	if (accountId === DEFAULT_ACCOUNT_ID) return undefined;
	if (!isValidAccountId(accountId)) throw new Error(`Invalid account id '${accountId}'.`);
	return path.join(resolveAccountsDir(), accountId);
}

export function resolveAccountAcpDirectory(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
	const geminiHome = resolveAccountGeminiHome(accountId, env);
	if (!geminiHome) return resolveAntigravityAcpDirectory(env);
	return path.join(geminiHome, "antigravity-acp");
}

export function buildAccountEnv(accountId: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	const geminiHome = resolveAccountGeminiHome(accountId, baseEnv);
	if (!geminiHome) return env;
	env.GEMINI_HOME = geminiHome;
	env[FORCE_FILE_STORAGE_ENV] = "1";
	// Named accounts are OAuth profiles; ambient API keys must not hijack them.
	delete env.GEMINI_API_KEY;
	return env;
}

export function loadAccountsState(file = resolveAccountsPath()): AccountsState {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			accounts?: unknown;
			preferred?: unknown;
		};
		const accounts = Array.isArray(parsed?.accounts)
			? [...new Set(parsed.accounts.filter((item): item is string => typeof item === "string" && item !== DEFAULT_ACCOUNT_ID && isValidAccountId(item)))]
			: [];
		const preferred =
			typeof parsed?.preferred === "string" &&
			(parsed.preferred === DEFAULT_ACCOUNT_ID || accounts.includes(parsed.preferred))
				? parsed.preferred
				: undefined;
		return preferred ? { accounts, preferred } : { accounts };
	} catch {
		return { accounts: [] };
	}
}

export function saveAccountsState(state: AccountsState, file = resolveAccountsPath()): void {
	const accounts = [...new Set(state.accounts.filter((item) => item !== DEFAULT_ACCOUNT_ID && isValidAccountId(item)))];
	const preferred =
		state.preferred && (state.preferred === DEFAULT_ACCOUNT_ID || accounts.includes(state.preferred))
			? state.preferred
			: undefined;
	const clean: AccountsState = preferred ? { accounts, preferred } : { accounts };
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

export function addAccount(label: string, file = resolveAccountsPath()): string {
	const normalized = normalizeAccountLabel(label);
	withStoreLock(file, () => {
		const state = loadAccountsState(file);
		if (!state.accounts.includes(normalized)) {
			state.accounts.push(normalized);
			saveAccountsState(state, file);
		}
	});
	return normalized;
}

export function removeAccount(label: string, file = resolveAccountsPath()): void {
	if (label.trim().toLowerCase() === DEFAULT_ACCOUNT_ID) {
		throw new Error("Cannot remove the default account. Use /antigravity-acp logout default instead.");
	}
	const normalized = normalizeAccountLabel(label);
	withStoreLock(file, () => {
		const state = loadAccountsState(file);
		const accounts = state.accounts.filter((item) => item !== normalized);
		const preferred = state.preferred === normalized ? undefined : state.preferred;
		saveAccountsState(preferred ? { accounts, preferred } : { accounts }, file);
	});
	const dir = path.join(path.dirname(file), "accounts", normalized);
	fs.rmSync(dir, { recursive: true, force: true });
}

export function setPreferredAccount(accountId: string | undefined, file = resolveAccountsPath()): void {
	withStoreLock(file, () => {
		const state = loadAccountsState(file);
		if (accountId === undefined) {
			saveAccountsState({ accounts: state.accounts }, file);
			return;
		}
		if (accountId !== DEFAULT_ACCOUNT_ID && !state.accounts.includes(accountId)) {
			throw new Error(`Unknown account '${accountId}'.`);
		}
		saveAccountsState({ accounts: state.accounts, preferred: accountId }, file);
	});
}

export function listAccountIds(file = resolveAccountsPath()): string[] {
	return [DEFAULT_ACCOUNT_ID, ...loadAccountsState(file).accounts];
}

export function listAuthenticatedAccountIds(
	file = resolveAccountsPath(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return listAccountIds(file).filter((accountId) => {
		const accountEnv = buildAccountEnv(accountId, env);
		const health = inspectAntigravityAuth(resolveAccountAcpDirectory(accountId, env), accountEnv);
		return health.status === "oauth-refreshable" || health.status === "api-key-env";
	});
}
