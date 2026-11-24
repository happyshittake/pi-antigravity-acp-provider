import { AntigravityAcpError } from "./errors.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface AntigravityQuotaAccountSample {
	accountId: string;
	ok: boolean;
	snapshot?: AntigravityQuotaSnapshot;
	error?: string;
}

export interface AntigravityQuotaSnapshot {
	at: number;
	groups: { displayName: string; buckets: { window: string; remainingFraction: number; resetTime?: string }[] }[];
	activeAccount?: string;
	reported?: number;
	total?: number;
	accounts?: AntigravityQuotaAccountSample[];
}

const GROUP = /^- \*\*(.+)\*\*$/u;
const BUCKET = /^ {2}- \*\*(.+?):\*\* (\d+)% remaining(?: \(resets (.+)\))?$/u;
const RESET = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}), (\\d{2}):(\\d{2}) UTC$`, "u");

/** Parses the Quota Limits section of agy's `/usage` reply; buckets reported as units or Available carry no fraction and are skipped. */
export function parseUsageQuota(text: string, now = Date.now()): AntigravityQuotaSnapshot {
	const section = /^### Quota Limits$([\s\S]*?)(?=^### |(?![\s\S]))/mu.exec(text)?.[1] ?? "";
	const groups: AntigravityQuotaSnapshot["groups"] = [];
	let notice: string | undefined;
	for (const line of section.split("\n")) {
		const group = GROUP.exec(line);
		if (group) {
			groups.push({ displayName: group[1]!, buckets: [] });
			continue;
		}
		const bucket = BUCKET.exec(line);
		if (bucket && groups.length) {
			const [, label, percent, reset] = bucket;
			const resetTime = reset ? resetIso(reset) : undefined;
			groups.at(-1)!.buckets.push({
				window: /weekly/iu.test(label!) ? "weekly" : /five hour/iu.test(label!) ? "5h" : label!,
				remainingFraction: Number(percent) / 100,
				...(resetTime ? { resetTime } : {}),
			});
			continue;
		}
		if (line.startsWith("- ")) notice ??= line.slice(2);
	}
	if (!groups.length) {
		throw new AntigravityAcpError("protocol", `Antigravity /usage reply had no quota groups: ${notice ?? "empty"}`);
	}
	return { at: now, groups };
}

function resetIso(text: string): string | undefined {
	const match = RESET.exec(text);
	if (!match) return undefined;
	const [, month, day, year, hours, minutes] = match;
	return new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hours), Number(minutes))).toISOString();
}

export function aggregateUsageQuotas(
	samples: ReadonlyArray<{ accountId: string; snapshot?: AntigravityQuotaSnapshot; error?: string }>,
	options: { activeAccount?: string; now?: number } = {},
): AntigravityQuotaSnapshot {
	const now = options.now ?? Date.now();
	const accounts: AntigravityQuotaAccountSample[] = samples.map((sample) =>
		sample.snapshot
			? { accountId: sample.accountId, ok: true, snapshot: sample.snapshot }
			: { accountId: sample.accountId, ok: false, error: sample.error ?? "unavailable" },
	);
	const succeeded = accounts.filter(
		(entry): entry is AntigravityQuotaAccountSample & { snapshot: AntigravityQuotaSnapshot } =>
			entry.ok && entry.snapshot !== undefined,
	);
	if (succeeded.length === 0) {
		const details = accounts.map((entry) => `${entry.accountId}: ${entry.error ?? "unavailable"}`).join("; ");
		throw new AntigravityAcpError("protocol", `Antigravity quota unavailable (${details || "no accounts"})`);
	}

	const groupOrder: string[] = [];
	const groupBuckets = new Map<
		string,
		Map<string, { values: number[]; earliestResetMs?: number }>
	>();

	for (const { snapshot } of succeeded) {
		for (const group of snapshot.groups) {
			if (!groupBuckets.has(group.displayName)) {
				groupOrder.push(group.displayName);
				groupBuckets.set(group.displayName, new Map());
			}
			const bucketMap = groupBuckets.get(group.displayName)!;
			const seen = new Set<string>();
			for (const bucket of group.buckets) {
				if (seen.has(bucket.window)) continue;
				seen.add(bucket.window);
				let acc = bucketMap.get(bucket.window);
				if (!acc) {
					acc = { values: [] };
					bucketMap.set(bucket.window, acc);
				}
				acc.values.push(bucket.remainingFraction);
				if (bucket.resetTime) {
					const resetMs = Date.parse(bucket.resetTime);
					if (Number.isFinite(resetMs) && resetMs > now) {
						acc.earliestResetMs =
							acc.earliestResetMs === undefined ? resetMs : Math.min(acc.earliestResetMs, resetMs);
					}
				}
			}
		}
	}

	const groups: AntigravityQuotaSnapshot["groups"] = groupOrder.map((displayName) => {
		const bucketMap = groupBuckets.get(displayName)!;
		return {
			displayName,
			buckets: [...bucketMap.entries()].map(([window, acc]) => {
				const mean = acc.values.reduce((sum, v) => sum + v, 0) / acc.values.length;
				return {
					window,
					remainingFraction: Math.round(mean * 10_000) / 10_000,
					...(acc.earliestResetMs !== undefined
						? { resetTime: new Date(acc.earliestResetMs).toISOString() }
						: {}),
				};
			}),
		};
	});

	return {
		at: now,
		groups,
		...(options.activeAccount ? { activeAccount: options.activeAccount } : {}),
		reported: succeeded.length,
		total: samples.length,
		accounts,
	};
}
