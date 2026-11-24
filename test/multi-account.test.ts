import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	addAccount,
	DEFAULT_ACCOUNT_ID,
	resolveAccountAcpDirectory,
} from "../src/acp/accounts.js";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { FORCE_FILE_STORAGE_ENV } from "../src/acp/credential-storage.js";
import { AccountRouter, quotaCooldownKey } from "../src/acp/routing.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { AntigravityRuntime, MANAGED_AUTH_MARKER } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const geminiModel: Model<"antigravity-acp"> = {
	id: "gemini-3.1-pro",
	name: "Gemini",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8192,
};
const claudeModel: Model<"antigravity-acp"> = {
	...geminiModel,
	id: "claude-sonnet-4-6",
	name: "Claude",
};
const user = (content: string, timestamp = 1): Context["messages"][number] => ({ role: "user", content, timestamp });

let root: string;
let home: string;
let agentDir: string;
let runtimes: AntigravityRuntime[];

function writeOAuthToken(accountId: string): void {
	const dir = resolveAccountAcpDirectory(accountId, { HOME: home });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "acp_token.json"), JSON.stringify({ refresh_token: `rt-${accountId}` }));
}

function accountFromEnv(env?: NodeJS.ProcessEnv): string {
	const geminiHome = env?.GEMINI_HOME;
	if (!geminiHome) return DEFAULT_ACCOUNT_ID;
	return path.basename(geminiHome);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-multi-account-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agent");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("GEMINI_HOME", "");
	vi.stubEnv("GEMINI_API_KEY", "");
	vi.spyOn(os, "homedir").mockReturnValue(home);
	runtimes = [];
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function createTestRuntime(
	behaviors: Record<string, { scenario?: string; quotaModel?: string; usageReply?: string }>,
	options?: {
		sessionStore?: AcpSessionStore;
		router?: AccountRouter;
		onNotify?: (message: string, level: "info" | "warning" | "error") => void;
		onAccountChange?: (sessionId: string, accountId: string) => void;
	},
) {
	const spawned: Array<{ accountId: string; env?: NodeJS.ProcessEnv | undefined }> = [];
	const runtime = new AntigravityRuntime(
		(connOptions) => {
			const accountId = accountFromEnv(connOptions.env);
			spawned.push({ accountId, env: connOptions.env });
			const behavior = behaviors[accountId] ?? {};
			return new AntigravityAcpConnection({
				...connOptions,
				command: process.execPath,
				args: behavior.scenario ? [fakeAgent, behavior.scenario] : [fakeAgent],
				env: {
					...process.env,
					...connOptions.env,
					FAKE_ACCOUNT_TAG: accountId,
					...(behavior.quotaModel ? { FAKE_QUOTA_EXHAUSTED_MODEL: behavior.quotaModel } : {}),
					...(behavior.usageReply ? { FAKE_USAGE_REPLY: behavior.usageReply } : {}),
				},
			});
		},
		"yolo",
		options?.sessionStore,
		{
			...(options?.router ? { router: options.router } : {}),
			...(options?.onNotify ? { onNotify: options.onNotify } : {}),
			...(options?.onAccountChange ? { onAccountChange: options.onAccountChange } : {}),
		},
	);
	runtimes.push(runtime);
	return { runtime, spawned };
}

describe("multi-account failover and quota aggregation", () => {
	it("fails over transparently pre-output on quota notice, suppresses notice text, and sets model-scoped cooldown", async () => {
		addAccount("work");
		writeOAuthToken("default");
		writeOAuthToken("work");

		const notices: Array<[string, string]> = [];
		const accountChanges: Array<[string, string]> = [];
		const router = new AccountRouter("test-owner", path.join(root, "routing.json"));
		const { runtime, spawned } = createTestRuntime(
			{ default: { quotaModel: "gemini-3.1-pro" }, work: {} },
			{
				router,
				onNotify: (message, level) => notices.push([message, level]),
				onAccountChange: (sessionId, accountId) => accountChanges.push([sessionId, accountId]),
			},
		);

		const result = await runtime
			.stream(geminiModel, normalizeContext({ messages: [user("hello")] }), {
				sessionId: "chat-1",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();

		expect(result.stopReason).toBe("stop");
		const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		expect(text).toBe("Hello:work");
		expect(text).not.toContain("Usage Limit Reached");
		expect(spawned.map((s) => s.accountId)).toEqual(["default", "work"]);
		expect(spawned[1]!.env?.[FORCE_FILE_STORAGE_ENV]).toBe("1");
		expect(notices.some(([msg]) => msg.includes("default") && msg.includes("work"))).toBe(true);
		expect(accountChanges.at(-1)).toEqual(["chat-1", "work"]);

		// Cooldown is model-scoped: default is cooled down for gemini, but still eligible for claude!
		const cooldowns = router.listCooldowns();
		expect(cooldowns[quotaCooldownKey("default", "gemini-3.1-pro")]).toBeGreaterThan(Date.now());
		expect(cooldowns["default"]).toBeUndefined();

		const claudeResult = await runtime
			.stream(claudeModel, normalizeContext({ messages: [user("hello claude")] }), {
				sessionId: "chat-2",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(claudeResult.stopReason).toBe("stop");
		expect(claudeResult.content.filter((b) => b.type === "text").map((b) => b.text).join("")).toBe("Hello:default");
	});

	it("fails over on pre-output auth failure and reports exhaustion when all accounts fail", async () => {
		addAccount("work");
		writeOAuthToken("default");
		writeOAuthToken("work");

		const router = new AccountRouter("test-owner", path.join(root, "routing.json"));
		const { runtime } = createTestRuntime(
			{ default: { scenario: "auth-failed" }, work: {} },
			{ router },
		);

		const ok = await runtime
			.stream(geminiModel, normalizeContext({ messages: [user("hi")] }), {
				sessionId: "chat-auth",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(ok.stopReason).toBe("stop");
		expect(ok.content.filter((b) => b.type === "text").map((b) => b.text).join("")).toBe("Hello:work");
		expect(router.listCooldowns()["default"]).toBeGreaterThan(Date.now());

		// All accounts exhausted produces an error naming exhausted accounts.
		const router2 = new AccountRouter("test-owner-2", path.join(root, "routing-2.json"));
		const allBad = createTestRuntime(
			{ default: { scenario: "quota-exhausted" }, work: { scenario: "quota-exhausted" } },
			{ router: router2 },
		);
		const failed = await allBad.runtime
			.stream(geminiModel, normalizeContext({ messages: [user("hi")] }), {
				sessionId: "chat-all-bad",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("quota exceeded");
		expect(failed.errorMessage).toContain("default");
		expect(failed.errorMessage).toContain("work");
	});

	it("does not replay mid-turn after output has streamed, but switches accounts on the next turn", async () => {
		addAccount("work");
		writeOAuthToken("default");
		writeOAuthToken("work");

		const router = new AccountRouter("test-owner", path.join(root, "routing.json"));
		const { runtime, spawned } = createTestRuntime(
			{ default: { scenario: "midturn-quota" }, work: {} },
			{ router },
		);

		const first = await runtime
			.stream(geminiModel, normalizeContext({ messages: [user("hi")] }), {
				sessionId: "chat-mid",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(first.stopReason).toBe("error");
		expect(first.content.filter((b) => b.type === "text").map((b) => b.text).join("")).toBe("Partial ");
		expect(spawned.map((s) => s.accountId)).toEqual(["default"]);

		// Next turn automatically routes to work because default is on model cooldown.
		const second = await runtime
			.stream(geminiModel, normalizeContext({ messages: [user("retry", 2)] }), {
				sessionId: "chat-mid",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(second.stopReason).toBe("stop");
		expect(second.content.filter((b) => b.type === "text").map((b) => b.text).join("")).toBe("Hello:work");
	});

	it("never resumes another account's saved session from sessions.json", async () => {
		addAccount("work");
		writeOAuthToken("default");
		writeOAuthToken("work");

		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		store.save({
			piSessionId: "chat-isolated",
			acpSessionId: "acp-from-default",
			acpModelId: "gemini-3.1-pro",
			accountId: "default",
			cwd: process.cwd(),
			messageCount: 2,
			historyFingerprint: "old",
			lastActive: Date.now(),
		});

		const router = new AccountRouter("test-owner", path.join(root, "routing.json"));
		router.pin("chat-isolated", "work");
		const { runtime } = createTestRuntime({ default: {}, work: {} }, { router, sessionStore: store });

		const result = await runtime
			.stream(geminiModel, normalizeContext({ messages: [user("hello")] }), {
				sessionId: "chat-isolated",
				apiKey: MANAGED_AUTH_MARKER,
			})
			.stream.result();
		expect(result.stopReason).toBe("stop");
		expect(store.get("chat-isolated")?.accountId).toBe("work");
		const snapshot = await runtime.snapshot();
		expect(snapshot.processes[0]?.restored).toBe(false);
	});

	it("aggregates /usage across multiple accounts and handles partial failures", async () => {
		addAccount("work");
		addAccount("broken");
		writeOAuthToken("default");
		writeOAuthToken("work");
		writeOAuthToken("broken");

		const usageDefault = [
			"### Session Usage",
			"- **Session total:** 0",
			"",
			"### Quota Limits",
			"- **Gemini Models**",
			"  - **Five Hour Limit:** 60% remaining (resets Nov 24, 2026, 15:00 UTC)",
			"- **Claude and GPT models**",
			"  - **Five Hour Limit:** 80% remaining (resets Nov 24, 2026, 14:00 UTC)",
		].join("\n");
		const usageWork = [
			"### Session Usage",
			"- **Session total:** 0",
			"",
			"### Quota Limits",
			"- **Gemini Models**",
			"  - **Five Hour Limit:** 100% remaining (resets Nov 24, 2026, 16:00 UTC)",
			"- **Claude and GPT models**",
			"  - **Five Hour Limit:** 100% remaining (resets Nov 24, 2026, 16:00 UTC)",
		].join("\n");

		const router = new AccountRouter("test-owner", path.join(root, "routing.json"));
		router.pin("chat-q", "work");
		const { runtime } = createTestRuntime(
			{
				default: { usageReply: usageDefault },
				work: { usageReply: usageWork },
				broken: { scenario: "usage-unavailable" },
			},
			{ router },
		);

		const quota = await runtime.quota(MANAGED_AUTH_MARKER, undefined, { conversationId: "chat-q" });
		expect(quota.activeAccount).toBe("work");
		expect(quota.reported).toBe(2);
		expect(quota.total).toBe(3);
		expect(quota.groups[0]?.buckets[0]?.remainingFraction).toBe(0.8);
		expect(quota.groups[1]?.buckets[0]?.remainingFraction).toBe(0.9);
		expect(quota.accounts?.find((a) => a.accountId === "broken")?.ok).toBe(false);
	});
});
