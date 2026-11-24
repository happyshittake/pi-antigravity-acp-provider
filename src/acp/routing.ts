import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";
import { withStoreLock } from "./store-lock.js";

export const ACCOUNT_LEASE_MS = 5 * 60_000;
export const AUTH_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;

export interface AccountLease {
	owner: string;
	conversation: string;
	account: string;
	expires: number;
}

export interface RoutingState {
	leases: AccountLease[];
	cooldowns: Record<string, number>;
}

export interface SelectAccountOptions {
	preferred?: string;
	modelId?: string;
	now?: number;
}

export function resolveRoutingPath(): string {
	return path.join(resolveConfigRoot(), "routing.json");
}

export function quotaCooldownKey(accountId: string, modelId: string): string {
	return `${accountId}::${modelId}`;
}

export class AccountRouter {
	constructor(
		private readonly ownerId: string,
		private readonly file?: string,
	) {}

	private targetFile(): string {
		return this.file ?? resolveRoutingPath();
	}

	select(
		conversation: string,
		accounts: string[],
		tried: Set<string>,
		options: SelectAccountOptions = {},
	): string | undefined {
		const now = options.now ?? Date.now();
		return this.update(now, (data) => {
			const eligible = [...new Set(accounts)].filter((id) => {
				if (tried.has(id)) return false;
				if ((data.cooldowns[id] ?? 0) > now) return false;
				if (options.modelId && (data.cooldowns[quotaCooldownKey(id, options.modelId)] ?? 0) > now) {
					return false;
				}
				return true;
			});
			const sticky = data.leases.find(
				(lease) => lease.owner === this.ownerId && lease.conversation === conversation,
			);
			if (sticky && eligible.includes(sticky.account)) {
				sticky.expires = now + ACCOUNT_LEASE_MS;
				return sticky.account;
			}
			this.removeLeases(data, conversation);
			if (eligible.length === 0) return undefined;
			const counts = new Map(
				eligible.map((id) => [id, data.leases.filter((lease) => lease.account === id).length]),
			);
			const min = Math.min(...counts.values());
			const candidates = eligible.filter((id) => counts.get(id) === min);
			const account =
				options.preferred && candidates.includes(options.preferred)
					? options.preferred
					: candidates[0];
			if (account) {
				data.leases.push({
					owner: this.ownerId,
					conversation,
					account,
					expires: now + ACCOUNT_LEASE_MS,
				});
			}
			return account;
		});
	}

	pin(conversation: string, account: string, now = Date.now()): void {
		this.update(now, (data) => {
			this.removeLeases(data, conversation);
			data.leases.push({
				owner: this.ownerId,
				conversation,
				account,
				expires: now + ACCOUNT_LEASE_MS,
			});
		});
	}

	cooldownAccount(account: string, until: number, now = Date.now()): void {
		this.update(now, (data) => {
			if (until > now) data.cooldowns[account] = Math.max(data.cooldowns[account] ?? 0, until);
		});
	}

	cooldownModel(account: string, modelId: string, until: number, now = Date.now()): void {
		const key = quotaCooldownKey(account, modelId);
		this.update(now, (data) => {
			if (until > now) data.cooldowns[key] = Math.max(data.cooldowns[key] ?? 0, until);
		});
	}

	clearAccount(account: string, now = Date.now()): void {
		const prefix = `${account}::`;
		this.update(now, (data) => {
			data.leases = data.leases.filter((lease) => lease.account !== account);
			for (const key of Object.keys(data.cooldowns)) {
				if (key === account || key.startsWith(prefix)) delete data.cooldowns[key];
			}
		});
	}

	renew(now = Date.now()): void {
		this.update(now, (data) => {
			for (const lease of data.leases) {
				if (lease.owner === this.ownerId) lease.expires = now + ACCOUNT_LEASE_MS;
			}
		});
	}

	release(conversation?: string, now = Date.now()): void {
		this.update(now, (data) => {
			this.removeLeases(data, conversation);
		});
	}

	getLease(conversation: string, now = Date.now()): string | undefined {
		const data = this.read(now);
		return data.leases.find(
			(lease) => lease.owner === this.ownerId && lease.conversation === conversation,
		)?.account;
	}

	listCooldowns(now = Date.now()): Record<string, number> {
		return this.read(now).cooldowns;
	}

	private removeLeases(data: RoutingState, conversation?: string): void {
		data.leases = data.leases.filter(
			(lease) =>
				lease.owner !== this.ownerId ||
				(conversation !== undefined && lease.conversation !== conversation),
		);
	}

	private update<T>(now: number, fn: (data: RoutingState) => T): T {
		let result!: T;
		const file = this.targetFile();
		withStoreLock(file, () => {
			const data = this.read(now, file);
			result = fn(data);
			this.write(data, file);
		});
		return result;
	}

	private read(now: number, file = this.targetFile()): RoutingState {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
				leases?: unknown;
				cooldowns?: unknown;
			};
			const leases = Array.isArray(parsed?.leases)
				? parsed.leases.filter((item): item is AccountLease => validLease(item) && item.expires > now)
				: [];
			const rawCooldowns =
				parsed?.cooldowns && typeof parsed.cooldowns === "object" && !Array.isArray(parsed.cooldowns)
					? (parsed.cooldowns as Record<string, unknown>)
					: {};
			const cooldowns: Record<string, number> = {};
			for (const [key, until] of Object.entries(rawCooldowns)) {
				if (typeof until === "number" && Number.isFinite(until) && until > now) {
					cooldowns[key] = until;
				}
			}
			return { leases, cooldowns };
		} catch {
			return { leases: [], cooldowns: {} };
		}
	}

	private write(data: RoutingState, file: string): void {
		if (data.leases.length === 0 && Object.keys(data.cooldowns).length === 0) {
			fs.rmSync(file, { force: true });
			return;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	}
}

function validLease(value: unknown): value is AccountLease {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<AccountLease>;
	return (
		typeof lease.owner === "string" &&
		typeof lease.conversation === "string" &&
		typeof lease.account === "string" &&
		typeof lease.expires === "number" &&
		Number.isFinite(lease.expires)
	);
}
