import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ACCOUNT_LEASE_MS,
	AccountRouter,
	quotaCooldownKey,
} from "../src/acp/routing.js";

let root: string;
let file: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-routing-"));
	file = path.join(root, "routing.json");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("AccountRouter", () => {
	it("keeps conversations sticky while distributing new conversations to least-assigned accounts", () => {
		const now = 1_800_000_000_000;
		const a = new AccountRouter("owner-a", file);
		const b = new AccountRouter("owner-b", file);
		const accounts = ["default", "work", "personal"];

		expect(a.select("chat-1", accounts, new Set(), { preferred: "work", now })).toBe("work");
		// Sticky on repeat selection even if preferred changes.
		expect(a.select("chat-1", accounts, new Set(), { preferred: "personal", now: now + 10_000 })).toBe("work");
		// Second process picks least-assigned (default has 0, work has 1).
		expect(b.select("chat-2", accounts, new Set(), { preferred: "work", now: now + 10_000 })).toBe("default");
		// Third conversation picks personal (0 leases).
		expect(b.select("chat-3", accounts, new Set(), { now: now + 10_000 })).toBe("personal");
		// After lease expires, work is available again.
		expect(b.select("chat-4", accounts, new Set(), { preferred: "work", now: now + ACCOUNT_LEASE_MS + 20_000 })).toBe("work");
	});

	it("applies model-scoped quota cooldowns separately from account-scoped auth cooldowns", () => {
		const now = 1_800_000_000_000;
		const router = new AccountRouter("owner-a", file);
		const accounts = ["default", "work"];

		router.cooldownModel("default", "gemini-pro", now + 60_000, now);
		expect(router.select("chat-1", accounts, new Set(), { modelId: "gemini-pro", now })).toBe("work");
		// Different model on default is still eligible.
		expect(router.select("chat-2", accounts, new Set(), { modelId: "claude-sonnet", preferred: "default", now })).toBe("default");
		// Once cooldown expires, default is eligible again for gemini-pro.
		expect(router.select("chat-3", accounts, new Set(), { modelId: "gemini-pro", preferred: "default", now: now + 61_000 })).toBe("default");

		// Account-wide auth cooldown blocks every model on that account.
		router.cooldownAccount("default", now + 300_000, now + 61_000);
		expect(router.select("chat-2", accounts, new Set(), { modelId: "claude-sonnet", now: now + 62_000 })).toBe("work");
		expect(router.listCooldowns(now + 62_000)).toEqual({
			default: now + 300_000,
		});
		expect(quotaCooldownKey("default", "gemini-pro")).toBe("default::gemini-pro");
	});

	it("supports pin, renew, release, clearAccount, and corrupt routing file recovery", () => {
		const now = 1_800_000_000_000;
		const router = new AccountRouter("owner-a", file);

		router.pin("chat-1", "work", now);
		expect(router.getLease("chat-1", now)).toBe("work");
		router.renew(now + 60_000);
		expect(router.getLease("chat-1", now + ACCOUNT_LEASE_MS + 10_000)).toBe("work");

		router.cooldownModel("work", "gemini-pro", now + 999_999, now);
		router.cooldownAccount("work", now + 999_999, now);
		router.clearAccount("work");
		expect(router.getLease("chat-1", now)).toBeUndefined();
		expect(router.listCooldowns(now)).toEqual({});

		router.pin("chat-1", "default", now);
		router.release("chat-1");
		expect(router.getLease("chat-1", now)).toBeUndefined();

		fs.writeFileSync(file, "not-valid-json");
		expect(router.select("chat-1", ["default", "work"], new Set(), { now })).toBe("default");
	});
});
