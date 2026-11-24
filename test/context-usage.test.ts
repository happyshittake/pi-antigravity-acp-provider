import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildPromptParts } from "../src/stream/context.js";
import { quotaFromPrompt } from "../src/status.js";
import { contextUsageFromPrompt, usageFromPrompt } from "../src/stream/usage.js";

describe("prompt context", () => {
	it("reconstructs history only for a fresh binding", () => {
		const context: Context = {
			systemPrompt: "Follow project rules",
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "prior" }],
					api: "antigravity-acp",
					provider: "antigravity-acp",
					model: "auto",
					usage: usageFromPrompt({ stopReason: "end_turn" }),
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "new", timestamp: 3 },
			],
		};
		const fresh = buildPromptParts(context, true);
		const warm = buildPromptParts(context, false);
		expect(fresh.prompt).toHaveLength(3);
		expect(fresh.prompt[0]?.type).toBe("resource");
		expect(warm.prompt).toEqual([{ type: "text", text: "new" }]);
	});

	it("reconstructs trailing tools and sends the active request explicitly to a fresh session", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "inspect", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
					api: "antigravity-acp",
					provider: "antigravity-acp",
					model: "auto",
					usage: usageFromPrompt({ stopReason: "end_turn" }),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const result = buildPromptParts(context, true);
		expect(result.prompt).toHaveLength(3);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: { text: expect.stringMatching(/tool call read[\s\S]*file contents/u) },
		});
		expect(result.prompt[1]).toMatchObject({ type: "text", text: expect.stringContaining("Continue") });
		expect(result.prompt[2]).toEqual({ type: "text", text: "inspect" });
	});

	it("replays transcript system sections separately from conversation history", () => {
		const context: Context = {
			messages: [
				{ role: "system", content: "Base instructions", sections: { rules: "Old rules", removed: "Obsolete" }, timestamp: 0 },
				{ role: "user", content: "old", timestamp: 1 },
				{ role: "system", content: "Additional instructions", sections: { rules: "New rules", removed: null }, timestamp: 2 },
				{ role: "user", content: "new", timestamp: 3 },
			],
		};
		const result = buildPromptParts(context, true);
		const block = result.prompt[0];
		if (block?.type !== "resource" || !("text" in block.resource)) throw new Error("missing context");
		expect(block.resource.text).toContain("Base instructions");
		expect(block.resource.text).toContain("Additional instructions");
		expect(block.resource.text).toContain("New rules");
		expect(block.resource.text).not.toContain("Old rules");
		expect(block.resource.text).not.toContain("Obsolete");
		expect(block.resource.text).not.toContain("Tool result (undefined");
		expect(result.prompt.slice(1)).toEqual([{ type: "text", text: "\n\n---\n\n# Current Pi user request" }, { type: "text", text: "new" }]);
	});

	it("adds only unseen external deltas to a warm prompt", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "already owned", timestamp: 1 },
				{ role: "user", content: "externally inserted", timestamp: 2 },
				{ role: "user", content: "current", timestamp: 3 },
			],
		};
		const result = buildPromptParts(context, false, 1);
		expect(result.prompt).toHaveLength(3);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: { text: expect.stringContaining("externally inserted") },
		});
		expect(result.prompt.slice(1)).toEqual([{ type: "text", text: "\n\n---\n\n# Current Pi user request" }, { type: "text", text: "current" }]);
	});
});

describe("instruction safety", () => {
	it("preserves instructions and untrusted-history labels despite long history", () => {
		const result = buildPromptParts({ systemPrompt: "  REQUIRED_PROJECT_RULE  ", messages: [
			{ role: "user", content: "x".repeat(40_000), timestamp: 1 },
			{ role: "user", content: "next", timestamp: 2 },
		]}, true);
		const text = JSON.stringify(result.prompt);
		expect(text).toContain("  REQUIRED_PROJECT_RULE  ");
		expect(text).toContain("untrusted conversation data");
		expect(text).toContain("truncated older context");
	});

	it("rejects oversized instructions instead of silently truncating them", () => {
		expect(() => buildPromptParts({ systemPrompt: "π".repeat(140_000), messages: [
			{ role: "user", content: "hello", timestamp: 1 },
		]}, true)).toThrow("system instructions exceed");
	});

	it("does not mistake a trailing system update for a tool result", () => {
		const result = buildPromptParts({ messages: [
			{ role: "user", content: "current request", timestamp: 1 },
			{ role: "system", content: "Updated rule", timestamp: 2 },
		]}, true);
		expect(result.prompt.at(-1)).toEqual({ type: "text", text: "current request" });
	});
});

describe("usageFromPrompt", () => {
	it("reads Gemini quota metadata without estimating", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			_meta: { quota: { token_count: { input_tokens: 11, output_tokens: 5 } } },
		});
		expect(usage).toMatchObject({ input: 11, output: 5, totalTokens: 16 });
	});

	it("maps ACP 1.5.0 usage without double-adding thoughtTokens or clamping net input", () => {
		const turn1 = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				inputTokens: 18918,
				outputTokens: 150,
				cachedReadTokens: 0,
				thoughtTokens: 145,
				totalTokens: 19068,
			},
		});
		expect(turn1).toMatchObject({
			input: 18918,
			output: 150,
			reasoning: 145,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 19068,
		});

		const multiInference = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				inputTokens: 2506,
				outputTokens: 300,
				cachedReadTokens: 16877,
				thoughtTokens: 100,
				totalTokens: 19683,
			},
		});
		expect(multiInference).toMatchObject({
			input: 2506,
			output: 300,
			reasoning: 100,
			cacheRead: 16877,
			cacheWrite: 0,
			totalTokens: 19683,
		});
	});

	it("maps standard ACP cache and thought counters consistently with totalTokens", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				inputTokens: 20,
				outputTokens: 8,
				cachedReadTokens: 5,
				cachedWriteTokens: 2,
				thoughtTokens: 3,
				totalTokens: 28,
			},
		});
		expect(usage).toMatchObject({
			input: 13,
			output: 8,
			cacheRead: 5,
			cacheWrite: 2,
			reasoning: 3,
			totalTokens: 28,
		});
	});

	it("matches agy 1.4.3 totals: input includes cached tokens, output excludes thoughts", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			usage: { inputTokens: 128638, cachedReadTokens: 79242, outputTokens: 219, thoughtTokens: 12249, totalTokens: 141106 },
		});
		expect(usage).toMatchObject({ input: 49396, cacheRead: 79242, output: 12468, reasoning: 12249, totalTokens: 141106 });
	});

	it("never clamps net input to zero when totalTokens is omitted", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				inputTokens: 500,
				cachedReadTokens: 1200,
				outputTokens: 80,
				thoughtTokens: 50,
			} as unknown as NonNullable<Parameters<typeof usageFromPrompt>[0]["usage"]>,
		});
		expect(usage).toMatchObject({
			input: 500,
			cacheRead: 1200,
			output: 80,
			reasoning: 50,
			totalTokens: 1780,
		});
	});

	it("extracts quota metadata when the server supplies it", () => {
		expect(
			quotaFromPrompt({
				stopReason: "end_turn",
				_meta: {
					quota: {
						remainingQueries: 12,
						queryLimit: 100,
						resetTimestamp: 1_800_000_000,
						tier: "pro",
					},
				},
			}),
		).toMatchObject({ remaining: 12, limit: 100, tier: "pro" });
	});

	it("rejects malformed counts to zero", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			_meta: { quota: { token_count: { input_tokens: -1, output_tokens: "9" } } },
		});
		expect(usage.totalTokens).toBe(0);
	});
});

describe("contextUsageFromPrompt", () => {
	it("apportions multi-inference cache reads and writes into contextUsed while preserving the hit rate", () => {
		const aggregate = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				totalTokens: 79238,
				inputTokens: 7301,
				outputTokens: 457,
				thoughtTokens: 264,
				cachedReadTokens: 71480,
				cachedWriteTokens: 0,
			},
		});
		const mapped = contextUsageFromPrompt(aggregate, 26766, 3);
		expect(mapped).toMatchObject({
			input: 2481,
			cacheRead: 24285,
			cacheWrite: 0,
			output: 457,
			reasoning: 264,
			totalTokens: 26766,
		});
		expect(mapped.input + mapped.cacheRead + mapped.cacheWrite).toBe(26766);
	});

	it("keeps cacheWrite bounded and non-negative when rounding multi-inference splits", () => {
		const base = usageFromPrompt({
			stopReason: "end_turn",
			usage: { inputTokens: 0, outputTokens: 1, cachedReadTokens: 1, cachedWriteTokens: 1, totalTokens: 3 },
		});
		const mapped = contextUsageFromPrompt(base, 1, 2);
		expect(mapped.input).toBe(0);
		expect(mapped.cacheRead + mapped.cacheWrite).toBe(1);
		expect(mapped.totalTokens).toBe(1);

		const empty = usageFromPrompt({ stopReason: "end_turn" });
		expect(contextUsageFromPrompt(empty, 500, 2)).toMatchObject({
			input: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 500,
		});
	});

	it("keeps single-inference splits verbatim and corrects legacy duplicate cache reads only on exact match", () => {
		const single = usageFromPrompt({
			stopReason: "end_turn",
			usage: { inputTokens: 600, cachedReadTokens: 400, outputTokens: 200, thoughtTokens: 50, totalTokens: 1200 },
		});
		expect(contextUsageFromPrompt(single, 1600, 1)).toMatchObject({
			input: 600,
			cacheRead: 400,
			totalTokens: 1200,
		});
		expect(contextUsageFromPrompt(single, 1300, 1)).toMatchObject({
			input: 600,
			cacheRead: 400,
			totalTokens: 1300,
		});
	});
});
