import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	TranscriptContext,
	Model,
	Provider,
	ProviderAuthInteraction,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
	addAccount,
	buildAccountEnv,
	DEFAULT_ACCOUNT_ID,
	listAccountIds,
	listAuthenticatedAccountIds,
	normalizeAccountLabel,
	resolveAccountAcpDirectory,
} from "./acp/accounts.js";
import { hasAntigravityAuth, inspectAntigravityAuth } from "./acp/antigravity.js";
import { FALLBACK_MODELS, modelForAcpStream, projectModels, PROVIDER_ID, restoreModels } from "./models.js";
import { AntigravityRuntime, MANAGED_AUTH_MARKER } from "./runtime.js";

export interface AntigravityProviderBundle {
	provider: Provider<"antigravity-acp">;
	runtime: AntigravityRuntime;
}

export function createAntigravityProvider(runtime = new AntigravityRuntime()): AntigravityProviderBundle {
	let models = [...FALLBACK_MODELS];
	const provider: Provider<"antigravity-acp"> = {
		id: PROVIDER_ID,
		name: "Google Antigravity (ACP)",
		auth: {
			oauth: {
				name: "Google Antigravity (ACP)",
				loginLabel: "Sign in with Google",
				async login(interaction) {
					const accountId = await selectLoginAccount(interaction);
					interaction.notify({
						type: "progress",
						message:
							accountId === DEFAULT_ACCOUNT_ID
								? "Starting Antigravity Google login…"
								: `Starting Antigravity Google login (${accountId})…`,
					});
					await runtime.loginGoogle(
						interaction.signal,
						(message) => interaction.notify({ type: "progress", message }),
						{
							showAuthorizationUrl(url, instructions) {
								interaction.notify({
									type: "info",
									message: instructions,
									links: [{ url, label: "Google authorization" }],
								});
							},
							promptForCallback: (signal) =>
								interaction.prompt({
									type: "manual_code",
									message: "Paste the final localhost callback URL (or authorization code):",
									placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
									signal,
								}),
						},
						accountId,
					);
					if (accountId !== DEFAULT_ACCOUNT_ID) addAccount(accountId);
					return {
						type: "oauth",
						// Pi needs a durable credential record so the provider stays visible;
						// the actual OAuth tokens remain owned by Google Antigravity.
						refresh: MANAGED_AUTH_MARKER,
						access: MANAGED_AUTH_MARKER,
						expires: Number.MAX_SAFE_INTEGER,
					};
				},
				async refresh(credential) {
					return credential;
				},
				async toAuth() {
					return { apiKey: MANAGED_AUTH_MARKER };
				},
			},
			apiKey: {
				name: "Antigravity Gemini API key",
				async login(interaction) {
					const key = await interaction.prompt({
						type: "secret",
						message: "Gemini API key",
						placeholder: "AIza…",
					});
					if (!key.trim()) throw new Error("Gemini API key is required");
					interaction.notify({ type: "progress", message: "Verifying Gemini API key…" });
					await runtime.verifyApiKey(key.trim(), interaction.signal, (message) =>
						interaction.notify({ type: "progress", message }),
					);
					return { type: "api_key", key: key.trim() };
				},
				async check({ ctx, credential }) {
					if (credential?.key) return { type: "api_key", source: "Pi auth store" };
					if (await ctx.env("GEMINI_API_KEY")) return { type: "api_key", source: "GEMINI_API_KEY" };
					if (hasAntigravityAuth() || listAuthenticatedAccountIds().length > 0) {
						return { type: "api_key", source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
				async resolve({ ctx, credential }) {
					const key = credential?.key ?? (await ctx.env("GEMINI_API_KEY"));
					if (key) {
						return {
							auth: { apiKey: key },
							source: credential?.key ? "Pi auth store" : "GEMINI_API_KEY",
						};
					}
					if (hasAntigravityAuth() || listAuthenticatedAccountIds().length > 0) {
						return { auth: { apiKey: MANAGED_AUTH_MARKER }, source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
			},
		},
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			if (!context.allowNetwork) {
				// Restore the last discovered catalog before Pi resolves startup model
				// patterns, so models outside the offline fallback stay selectable.
				const restored = restoreModels(context.stored?.models ?? []);
				if (restored.length === 0) return;
				await context.publish({
					update: () => {
						models = restored;
					},
				});
				return;
			}
			const key =
				context.credential?.type === "api_key"
					? context.credential.key
					: context.credential?.type === "oauth"
						? MANAGED_AUTH_MARKER
						: undefined;
			let discovered;
			try {
				discovered = projectModels(await runtime.discoverModels(key, context.signal));
			} catch {
				// Startup refresh must not hide the conservative offline catalog when
				// authentication is absent, expired, or temporarily unavailable.
				return;
			}
			if (discovered.length === 0) return;
			await context.publish({
				persist: { models: discovered, checkedAt: Date.now() },
				update: () => {
					models = discovered;
				},
			});
		},
		stream(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
		streamSimple(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
	};
	return { provider, runtime };
}

const ADD_ACCOUNT_OPTION_ID = "__add_account__";

async function selectLoginAccount(interaction: ProviderAuthInteraction): Promise<string> {
	const accountIds = listAccountIds();
	const statuses = accountIds.map((id) => {
		const health = inspectAntigravityAuth(resolveAccountAcpDirectory(id), buildAccountEnv(id));
		return {
			id,
			authed: health.status === "oauth-refreshable" || health.status === "api-key-env",
		};
	});
	// First-time sign-in goes straight to the default profile without an extra prompt.
	if (statuses.length === 1 && !statuses[0]!.authed) {
		return DEFAULT_ACCOUNT_ID;
	}
	const choice = await interaction.prompt({
		type: "select",
		message: "Choose Antigravity account to sign in",
		options: [
			{ id: ADD_ACCOUNT_OPTION_ID, label: "Add new account…" },
			...statuses.map(({ id, authed }) => ({
				id,
				label: `${id} (${authed ? "signed in" : "not signed in"})`,
			})),
		],
	});
	if (choice === ADD_ACCOUNT_OPTION_ID) {
		const raw = await interaction.prompt({
			type: "text",
			message: "Account label (e.g. work, personal)",
			placeholder: "work",
		});
		return normalizeAccountLabel(raw);
	}
	if (!accountIds.includes(choice)) {
		throw new Error(`Unknown Antigravity account '${choice}'.`);
	}
	return choice;
}

function stream(
	runtime: AntigravityRuntime,
	model: Model<"antigravity-acp">,
	context: TranscriptContext,
	options: ApiStreamOptions<"antigravity-acp"> | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	return runtime.stream(model, context, options as SimpleStreamOptions | undefined).stream;
}

export const ANTIGRAVITY_ACP_API = "antigravity-acp" satisfies Api;
