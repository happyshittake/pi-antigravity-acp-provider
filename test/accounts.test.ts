import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	addAccount,
	buildAccountEnv,
	DEFAULT_ACCOUNT_ID,
	listAccountIds,
	listAuthenticatedAccountIds,
	loadAccountsState,
	normalizeAccountLabel,
	removeAccount,
	resolveAccountAcpDirectory,
	resolveAccountGeminiHome,
	resolveAccountsPath,
	setPreferredAccount,
} from "../src/acp/accounts.js";
import { FORCE_FILE_STORAGE_ENV } from "../src/acp/credential-storage.js";

let root: string;
let home: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-accounts-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agent");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
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

describe("accounts registry and isolation", () => {
	it("normalizes valid labels and rejects reserved or unsafe names", () => {
		expect(normalizeAccountLabel("  Work_01 ")).toBe("work-01");
		expect(normalizeAccountLabel("a")).toBe("a");
		expect(() => normalizeAccountLabel("default")).toThrow();
		expect(() => normalizeAccountLabel("DEFAULT")).toThrow();
		expect(() => normalizeAccountLabel("auto")).toThrow();
		expect(() => normalizeAccountLabel("   ")).toThrow();
		expect(() => normalizeAccountLabel("...")).toThrow();
		expect(() => normalizeAccountLabel("../escape")).toThrow();
	});

	it("manages accounts.json atomically and recovers from corrupt JSON", () => {
		const file = resolveAccountsPath();
		expect(loadAccountsState(file)).toEqual({ accounts: [] });
		expect(listAccountIds(file)).toEqual([DEFAULT_ACCOUNT_ID]);

		expect(addAccount("Work", file)).toBe("work");
		expect(addAccount("personal", file)).toBe("personal");
		expect(addAccount("work", file)).toBe("work");
		expect(listAccountIds(file)).toEqual(["default", "work", "personal"]);

		setPreferredAccount("work", file);
		expect(loadAccountsState(file)).toEqual({ accounts: ["work", "personal"], preferred: "work" });

		removeAccount("work", file);
		expect(loadAccountsState(file)).toEqual({ accounts: ["personal"] });
		expect(() => removeAccount("default", file)).toThrow();

		fs.writeFileSync(file, "{corrupt json");
		expect(loadAccountsState(file)).toEqual({ accounts: [] });
	});

	it("isolates named accounts with GEMINI_HOME, forced file storage, and stripped GEMINI_API_KEY", () => {
		const baseEnv: NodeJS.ProcessEnv = {
			HOME: home,
			GEMINI_HOME: path.join(root, "ambient-gemini"),
			GEMINI_API_KEY: "AIza-ambient-key",
			PATH: "/usr/bin",
		};

		expect(resolveAccountGeminiHome(DEFAULT_ACCOUNT_ID, baseEnv)).toBeUndefined();
		expect(resolveAccountAcpDirectory(DEFAULT_ACCOUNT_ID, baseEnv)).toBe(
			path.join(root, "ambient-gemini", "antigravity-acp"),
		);
		expect(buildAccountEnv(DEFAULT_ACCOUNT_ID, baseEnv)).toEqual(baseEnv);

		const workHome = resolveAccountGeminiHome("work", baseEnv);
		expect(workHome).toBe(path.join(agentDir, "antigravity-acp-provider", "accounts", "work"));
		expect(resolveAccountAcpDirectory("work", baseEnv)).toBe(path.join(workHome!, "antigravity-acp"));

		const workEnv = buildAccountEnv("work", baseEnv);
		expect(workEnv.GEMINI_HOME).toBe(workHome);
		expect(workEnv[FORCE_FILE_STORAGE_ENV]).toBe("1");
		expect(workEnv.GEMINI_API_KEY).toBeUndefined();
		expect(baseEnv.GEMINI_API_KEY).toBe("AIza-ambient-key");
	});

	it("lists only authenticated accounts across default and named stores", () => {
		const file = resolveAccountsPath();
		addAccount("work", file);
		addAccount("spare", file);

		const env: NodeJS.ProcessEnv = { HOME: home };
		expect(listAuthenticatedAccountIds(file, env)).toEqual([]);

		const workAcp = resolveAccountAcpDirectory("work", env);
		fs.mkdirSync(workAcp, { recursive: true });
		fs.writeFileSync(path.join(workAcp, "acp_token.json"), JSON.stringify({ refresh_token: "rt-work" }));
		expect(listAuthenticatedAccountIds(file, env)).toEqual(["work"]);

		const defaultAcp = resolveAccountAcpDirectory(DEFAULT_ACCOUNT_ID, env);
		fs.mkdirSync(defaultAcp, { recursive: true });
		fs.writeFileSync(path.join(defaultAcp, "acp_token.json"), JSON.stringify({ refresh_token: "rt-default" }));
		expect(listAuthenticatedAccountIds(file, env)).toEqual(["default", "work"]);
	});
});
