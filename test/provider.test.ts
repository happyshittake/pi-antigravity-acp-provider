import { normalizeContext, type AuthEvent, type AuthPrompt, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, loadAccountsState, resolveAccountAcpDirectory } from "../src/acp/accounts.js";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model = FALLBACK_MODELS[0]!;

describe("native Pi provider", () => {
	it("passes transcript instructions through to the ACP prompt", async () => {
		const prompts: Array<Parameters<AntigravityAcpConnection["prompt"]>[0]> = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (request, signal) => {
				prompts.push(request);
				return prompt(request, signal);
			};
			return connection;
		});
		try {
			const { provider } = createAntigravityProvider(runtime);
			const stream = provider.streamSimple(model, normalizeContext({
				systemPrompt: "Follow native transcript instructions",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			}), { apiKey: "test-key" });
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(prompts[0]?.prompt[0]).toMatchObject({
				type: "resource",
				resource: { text: expect.stringContaining("Follow native transcript instructions") },
			});
		} finally {
			await runtime.close();
		}
	});

	it("routes tools added by a transcript delta through the MCP bridge", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const { provider } = createAntigravityProvider(runtime);
			const tools = [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }];
			const context = normalizeContext({ messages: [
				{ role: "system", content: "Base instructions", timestamp: 0 },
				{ role: "system", content: "", toolsAdded: tools, timestamp: 1 },
				{ role: "user", content: "use bridge", timestamp: 2 },
			] });
			const first = await provider.streamSimple(model, context, { apiKey: "test-key" }).result();
			const call = first.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing transcript tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });
			const second = await provider.streamSimple(model, normalizeContext({ messages: [
				...context.messages,
				first,
				{ role: "toolResult", toolCallId: call.id, toolName: "echo", content: [{ type: "text", text: "native result" }], isError: false, timestamp: 3 },
			] }), { apiKey: "test-key" }).result();
			expect(second.content).toEqual([{ type: "text", text: "native result" }]);
		} finally {
			await runtime.close();
		}
	});
});

describe("OAuth /login multi-account flow", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-provider-login-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("GEMINI_HOME", "");
		vi.stubEnv("GEMINI_API_KEY", "");
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	function createInteraction(responses: string[]): {
		interaction: ProviderAuthInteraction;
		prompts: AuthPrompt[];
		events: AuthEvent[];
	} {
		const prompts: AuthPrompt[] = [];
		const events: AuthEvent[] = [];
		const queue = [...responses];
		const controller = new AbortController();
		return {
			prompts,
			events,
			interaction: {
				signal: controller.signal,
				async prompt(prompt) {
					prompts.push(prompt);
					const next = queue.shift();
					if (next === undefined) throw new Error(`Unexpected prompt: ${prompt.type}`);
					return next;
				},
				notify(event) {
					events.push(event);
				},
			},
		};
	}

	it("signs straight into default on first login when no account is authenticated", async () => {
		const runtime = new AntigravityRuntime();
		const loginSpy = vi.spyOn(runtime, "loginGoogle").mockResolvedValue(undefined);
		const { provider } = createAntigravityProvider(runtime);
		const { interaction, prompts } = createInteraction([]);

		await provider.auth.oauth!.login(interaction);

		expect(prompts).toEqual([]);
		expect(loginSpy).toHaveBeenCalledWith(interaction.signal, expect.any(Function), expect.any(Object), "default");
		expect(loadAccountsState().accounts).toEqual([]);
	});

	it("offers account selection once signed in and registers a newly added account", async () => {
		const defaultDir = resolveAccountAcpDirectory("default");
		fs.mkdirSync(defaultDir, { recursive: true });
		fs.writeFileSync(path.join(defaultDir, "acp_token.json"), JSON.stringify({ refresh_token: "rt-default" }));

		const runtime = new AntigravityRuntime();
		const loginSpy = vi.spyOn(runtime, "loginGoogle").mockResolvedValue(undefined);
		const { provider } = createAntigravityProvider(runtime);
		const { interaction, prompts } = createInteraction(["__add_account__", "Work Team"]);

		await provider.auth.oauth!.login(interaction);

		expect(prompts[0]).toMatchObject({
			type: "select",
			options: [
				{ id: "__add_account__", label: "Add new account…" },
				{ id: "default", label: "default (signed in)" },
			],
		});
		expect(prompts[1]).toMatchObject({ type: "text" });
		expect(loginSpy).toHaveBeenCalledWith(interaction.signal, expect.any(Function), expect.any(Object), "work-team");
		expect(loadAccountsState().accounts).toEqual(["work-team"]);
	});

	it("re-authenticates an existing named account without prompting for a new label", async () => {
		addAccount("work");
		const runtime = new AntigravityRuntime();
		const loginSpy = vi.spyOn(runtime, "loginGoogle").mockResolvedValue(undefined);
		const { provider } = createAntigravityProvider(runtime);
		const { interaction, prompts } = createInteraction(["work"]);

		await provider.auth.oauth!.login(interaction);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({
			type: "select",
			options: [
				{ id: "__add_account__", label: "Add new account…" },
				{ id: "default", label: "default (not signed in)" },
				{ id: "work", label: "work (not signed in)" },
			],
		});
		expect(loginSpy).toHaveBeenCalledWith(interaction.signal, expect.any(Function), expect.any(Object), "work");
		expect(loadAccountsState().accounts).toEqual(["work"]);
	});

	it("does not persist a new account label when login fails", async () => {
		const defaultDir = resolveAccountAcpDirectory("default");
		fs.mkdirSync(defaultDir, { recursive: true });
		fs.writeFileSync(path.join(defaultDir, "acp_token.json"), JSON.stringify({ refresh_token: "rt-default" }));

		const runtime = new AntigravityRuntime();
		vi.spyOn(runtime, "loginGoogle").mockRejectedValue(new Error("OAuth cancelled"));
		const { provider } = createAntigravityProvider(runtime);
		const { interaction } = createInteraction(["__add_account__", "backup"]);

		await expect(provider.auth.oauth!.login(interaction)).rejects.toThrow("OAuth cancelled");
		expect(loadAccountsState().accounts).toEqual([]);
	});
});
