import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateUsageQuotas, parseUsageQuota } from "../src/acp/usage-quota.js";

const reply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const unavailable = (line: string) =>
	`### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n${line}`;

describe("parseUsageQuota", () => {
	it("reads every group from the server's /usage reply", () => {
		expect(parseUsageQuota(reply, now)).toEqual({
			at: now,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.75, resetTime: "2026-01-12T18:00:00.000Z" },
						{ window: "5h", remainingFraction: 0.9, resetTime: "2026-01-08T04:30:00.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.6, resetTime: "2026-01-14T09:15:00.000Z" },
						{ window: "5h", remainingFraction: 1, resetTime: "2026-01-08T06:45:00.000Z" },
					],
				},
				{
					displayName: "Gemini 4 Argon",
					buckets: [{ window: "weekly", remainingFraction: 0.4, resetTime: "2026-01-13T12:00:00.000Z" }],
				},
			],
		});
	});

	it("keeps a group without active limits and buckets without a reset", () => {
		const text = unavailable(
			"- **Gemini Models**\n  - **Daily Cap:** 50% remaining\n- **Other**\n  - No active bucket limits",
		);
		expect(parseUsageQuota(text, now)).toEqual({
			at: now,
			groups: [
				{ displayName: "Gemini Models", buckets: [{ window: "Daily Cap", remainingFraction: 0.5 }] },
				{ displayName: "Other", buckets: [] },
			],
		});
	});

	it("rejects replies without quota groups", () => {
		expect(() => parseUsageQuota(unavailable("- Unable to retrieve quota status (backend unavailable)"), now))
			.toThrow("Unable to retrieve quota status (backend unavailable)");
		expect(() => parseUsageQuota(unavailable("- Not applicable for current authentication method."), now))
			.toThrow("Not applicable for current authentication method.");
		expect(() => parseUsageQuota("Hello", now)).toThrow("no quota groups");
	});
});

describe("aggregateUsageQuotas", () => {
	it("averages remaining fractions and keeps the earliest future reset across accounts", () => {
		const base = Date.parse("2026-11-24T12:00:00.000Z");
		const first = {
			at: base,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "5h", remainingFraction: 0.6, resetTime: "2026-11-24T15:00:00.000Z" },
						{ window: "weekly", remainingFraction: 0.8, resetTime: "2026-11-30T00:00:00.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [{ window: "5h", remainingFraction: 0.5, resetTime: "2026-11-24T14:00:00.000Z" }],
				},
			],
		};
		const second = {
			at: base,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "5h", remainingFraction: 1, resetTime: "2026-11-24T13:30:00.000Z" },
						{ window: "weekly", remainingFraction: 0.6, resetTime: "1970-01-01T00:00:00.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [{ window: "5h", remainingFraction: 0.9, resetTime: "2026-11-24T16:00:00.000Z" }],
				},
			],
		};

		const aggregated = aggregateUsageQuotas(
			[
				{ accountId: "default", snapshot: first },
				{ accountId: "work", snapshot: second },
			],
			{ activeAccount: "work", now: base },
		);

		expect(aggregated.activeAccount).toBe("work");
		expect(aggregated.reported).toBe(2);
		expect(aggregated.total).toBe(2);
		expect(aggregated.groups).toEqual([
			{
				displayName: "Gemini Models",
				buckets: [
					{ window: "5h", remainingFraction: 0.8, resetTime: "2026-11-24T13:30:00.000Z" },
					{ window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-30T00:00:00.000Z" },
				],
			},
			{
				displayName: "Claude and GPT models",
				buckets: [{ window: "5h", remainingFraction: 0.7, resetTime: "2026-11-24T14:00:00.000Z" }],
			},
		]);
		expect(aggregated.accounts).toEqual([
			{ accountId: "default", ok: true, snapshot: first },
			{ accountId: "work", ok: true, snapshot: second },
		]);
	});

	it("tracks partial coverage when some accounts fail and throws when all fail", () => {
		const base = Date.parse("2026-11-24T12:00:00.000Z");
		const okSnapshot = {
			at: base,
			groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.5 }] }],
		};

		const partial = aggregateUsageQuotas(
			[
				{ accountId: "default", snapshot: okSnapshot },
				{ accountId: "work", error: "backend unavailable" },
			],
			{ now: base },
		);
		expect(partial.reported).toBe(1);
		expect(partial.total).toBe(2);
		expect(partial.accounts?.[1]).toEqual({ accountId: "work", ok: false, error: "backend unavailable" });

		expect(() =>
			aggregateUsageQuotas([{ accountId: "default", error: "auth expired" }], { now: base }),
		).toThrow("auth expired");
	});
});
