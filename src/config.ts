// ~/.config/pi-cliproxyapi/config.json — load, validate, persist.
//
// Schema:
//
//   {
//     "proxy": {
//       "endpoint": "https://your-proxy.example.com/v1",
//       "apiKey":   "!cat ~/.config/pi-cliproxyapi/key",
//       "providerPrefix": "myproxy",
//       "usageKey": "!cat ~/.config/pi-cliproxyapi/usage-key"
//     },
//     "builtinProviders": {
//       "openai":    { "enabled": true,  "apiOverride": null, "models": ["gpt-5.2"] },
//       "anthropic": { "enabled": true,                       "models": ["claude-opus-4-7"] }
//     },
//     "customProviders": {
//       "myproxy-glm": {
//         "api": "openai-completions",
//         "models": [{ "id": "glm-4.7", "name": "GLM 4.7", "contextWindow": 128000, "maxTokens": 16000, "reasoning": true }]
//       }
//     },
//     "discoveryExcludes": ["*:*"],
//     "overrides": {},
//     "refreshIntervalMinutes": 0,
//     "usageCacheTtlMs": 30000
//   }

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Api } from "./types.js"

import { log } from "./log.ts";

export const CONFIG_DIR = join(homedir(), ".config", "pi-cliproxyapi");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface BuiltinProviderConfig {
	enabled: boolean;
	apiOverride?: Api | null;
	models: string[];
}

export interface CustomProviderModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface CustomProviderConfig {
	api: Api;
	models: CustomProviderModelConfig[];
}

export interface ProxyConfig {
	proxy: {
		endpoint: string;
		apiKey: string;
		usageKey?: string;
		/** Prefix used for default custom-provider slugs, e.g. `myproxy` -> `myproxy-glm`. */
		providerPrefix?: string;
	};
	builtinProviders: Record<string, BuiltinProviderConfig>;
	customProviders: Record<string, CustomProviderConfig>;
	discoveryExcludes: string[];
	overrides: Record<string, Partial<CustomProviderModelConfig>>;
	refreshIntervalMinutes: number;
	usageCacheTtlMs: number;
}

const DEFAULT_CONFIG: ProxyConfig = {
	proxy: {
		endpoint: "",
		apiKey: "",
	},
	builtinProviders: {},
	customProviders: {},
	discoveryExcludes: ["*:*"],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 30_000,
};

export function loadConfig(): ProxyConfig {
	if (!existsSync(CONFIG_PATH)) {
		log.info("config not found, using defaults at", CONFIG_PATH);
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return normalizeConfig(raw);
	} catch (err) {
		log.error("failed to read config:", err, "— using defaults");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(cfg: ProxyConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
	log.info("config saved to", CONFIG_PATH);
}

function normalizeConfig(raw: unknown): ProxyConfig {
	if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_CONFIG);
	const r = raw as Record<string, unknown>;
	const merged = structuredClone(DEFAULT_CONFIG);
	const proxyBlock =
		(r.proxy as Record<string, unknown> | undefined) ??
		{};
	merged.proxy.endpoint =
		typeof proxyBlock.endpoint === "string"
			? proxyBlock.endpoint
			: merged.proxy.endpoint;
	merged.proxy.apiKey =
		typeof proxyBlock.apiKey === "string" ? proxyBlock.apiKey : "";
	if (typeof proxyBlock.usageKey === "string")
		merged.proxy.usageKey = proxyBlock.usageKey;
	if (
		typeof proxyBlock.providerPrefix === "string" &&
		proxyBlock.providerPrefix.trim()
	) {
		merged.proxy.providerPrefix = proxyBlock.providerPrefix.trim();
	}

	if (r.builtinProviders && typeof r.builtinProviders === "object") {
		merged.builtinProviders = r.builtinProviders as Record<
			string,
			BuiltinProviderConfig
		>;
	}
	if (r.customProviders && typeof r.customProviders === "object") {
		merged.customProviders = r.customProviders as Record<
			string,
			CustomProviderConfig
		>;
	}
	if (Array.isArray(r.discoveryExcludes)) {
		merged.discoveryExcludes = r.discoveryExcludes.filter(
			(x): x is string => typeof x === "string",
		);
	}
	if (r.overrides && typeof r.overrides === "object") {
		merged.overrides = r.overrides as Record<
			string,
			Partial<CustomProviderModelConfig>
		>;
	}
	if (typeof r.refreshIntervalMinutes === "number")
		merged.refreshIntervalMinutes = r.refreshIntervalMinutes;
	if (typeof r.usageCacheTtlMs === "number")
		merged.usageCacheTtlMs = r.usageCacheTtlMs;
	return merged;
}

/**
 * resolveConfigValue — same semantics Pi uses for apiKey:
 *   "!cmd ..."     → run command, take stdout, trim
 *   "$ENV_VAR"     → read process.env[ENV_VAR]
 *   any other str  → return as-is
 * Empty / undefined → "".
 *
 * We re-implement it locally rather than reach into pi internals; resolution
 * happens once at apply time so the resolved key can be passed to
 * pi.registerProvider verbatim.
 */
export function resolveConfigValue(raw: string | undefined | null): string {
	if (!raw) return "";
	const v = raw.trim();
	if (v.startsWith("!")) {
		try {
			return execSync(v.slice(1), {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (err) {
			// Don't dump stack traces for the common "file not found" case — just say what didn't resolve.
			const msg =
				(err as { stderr?: Buffer | string })?.stderr?.toString?.()?.trim() ??
				(err as Error).message;
			log.warn(`failed to resolve "!" config value (${v}): ${msg}`);
			return "";
		}
	}
	if (v.startsWith("$")) {
		return process.env[v.slice(1)] ?? "";
	}
	return v;
}
