// Discovery:
//   1. GET <host>/.well-known/pi with User-Agent: pi-cliproxyapi/<ver>
//      → returns the server contract document (see PLAN.md).
//   2. On 404 / 5xx / non-JSON / network error → fall back to:
//      GET <endpoint>/v1/models with Authorization: Bearer <apiKey>
//      → classify locally via compat.ts.
//
// fetchDiscovery() returns a normalized in-memory model. Callers shouldn't
// know which path was used (except for logging).

import type { Api } from "./types.js"

import {
	classifyCustom,
	isExcluded,
	modelDefaults,
	normalizeSuggestedProvider,
	reasoningFromId,
} from "./compat.ts";
import { writeDiscoveryCache } from "./cache.ts";
import type { ProxyConfig } from "./config.ts";
import { log } from "./log.ts";

export const PLUGIN_USER_AGENT = "pi-cliproxyapi/0.3.3";
const REQUEST_TIMEOUT_MS = 5_000;

export interface DiscoveryModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	input: ("text" | "image")[];
}

export interface DiscoveryBuiltinProvider {
	/** "openai" or "anthropic" — name of the Pi built-in provider. */
	name: string;
	api: Api;
	/** Models from upstream that map to this built-in provider. */
	models: DiscoveryModelEntry[];
}

export interface DiscoveryCustomEntry extends DiscoveryModelEntry {
	api: Api;
	/** Suggested custom provider slug (e.g. "myproxy-glm"). */
	suggestedProvider: string;
	/** Raw upstream owned_by, for diagnostics. */
	ownedBy: string;
}

export interface Discovery {
	source: "well-known" | "v1-models";
	upstreamVersion: string | null;
	builtinProviders: DiscoveryBuiltinProvider[];
	customPool: DiscoveryCustomEntry[];
	serverDiscoveryExcludes: string[];
	/** Total ids seen before any filtering. */
	upstreamTotal: number;
}

interface RawUpstreamModel {
	id: string;
	owned_by: string;
}

// --------------------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(obj: Record<string, unknown>, key: string, fallback: string): string {
	const v = obj[key];
	return typeof v === "string" ? v : fallback;
}

function readNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
	const v = obj[key];
	return typeof v === "number" ? v : fallback;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function readCost(raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	if (!isRecord(raw)) return ZERO_COST;
	return {
		input: readNumber(raw, "input", 0),
		output: readNumber(raw, "output", 0),
		cacheRead: readNumber(raw, "cacheRead", 0),
		cacheWrite: readNumber(raw, "cacheWrite", 0),
	};
}

function readInput(raw: unknown): ("text" | "image")[] {
	if (!Array.isArray(raw)) return ["text"];
	const out: ("text" | "image")[] = [];
	for (const x of raw) {
		if (x === "text" || x === "image") out.push(x);
	}
	return out.length > 0 ? out : ["text"];
}

function readApi(raw: unknown, fallback: Api = "openai-responses"): Api {
	if (raw === "openai-responses" || raw === "openai-completions" || raw === "anthropic-messages") {
		return raw;
	}
	return fallback;
}

// --------------------------------------------------------------------------- HTTP

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

function discoveryUrl(endpoint: string): string {
	return new URL("/.well-known/pi", new URL(endpoint).origin).toString();
}

// --------------------------------------------------------------------------- well-known path

async function tryWellKnown(cfg: ProxyConfig): Promise<Discovery | null> {
	const url = discoveryUrl(cfg.proxy.endpoint);
	let resp: Response;
	try {
		resp = await fetchWithTimeout(url, {
			headers: { "User-Agent": PLUGIN_USER_AGENT, Accept: "application/json" },
		});
	} catch (err) {
		log.warn(
			"well-known fetch failed:",
			(err as Error).message,
			"— falling back to /v1/models",
		);
		return null;
	}
	if (!resp.ok) {
		log.warn(`well-known returned ${resp.status} — falling back to /v1/models`);
		return null;
	}
	let doc: unknown;
	try {
		doc = await resp.json();
	} catch {
		log.warn("well-known returned non-JSON — falling back to /v1/models");
		return null;
	}
	if (!isRecord(doc) || doc.schemaVersion !== 1) {
		log.warn("well-known schemaVersion != 1 — falling back to /v1/models");
		return null;
	}

	const builtin: DiscoveryBuiltinProvider[] = [];
	const bpRaw = isRecord(doc.builtinProviders) ? doc.builtinProviders : {};
	for (const [name, pRaw] of Object.entries(bpRaw)) {
		if (!isRecord(pRaw) || !Array.isArray(pRaw.models)) continue;
		const models: DiscoveryModelEntry[] = [];
		for (const mRaw of pRaw.models) {
			const m = isRecord(mRaw) ? mRaw : {};
			models.push({
				id: readString(m, "id", ""),
				name: readString(m, "name", readString(m, "id", "")),
				reasoning: typeof m.reasoning === "boolean" ? m.reasoning : reasoningFromId(readString(m, "id", "")),
				contextWindow: readNumber(m, "contextWindow", 200_000),
				maxTokens: readNumber(m, "maxTokens", 16_000),
				cost: readCost(m.cost),
				input: readInput(m.input),
			});
		}
		const api = readApi(pRaw.api);
		builtin.push({ name, api, models });
	}

	const rawPool = Array.isArray(doc.customModelPool) ? doc.customModelPool : [];
	const customPool: DiscoveryCustomEntry[] = [];
	for (const mRaw of rawPool) {
		const m = isRecord(mRaw) ? mRaw : {};
		customPool.push({
			id: readString(m, "id", ""),
			name: readString(m, "name", readString(m, "id", "")),
			reasoning: typeof m.reasoning === "boolean" ? m.reasoning : reasoningFromId(readString(m, "id", "")),
			contextWindow: readNumber(m, "contextWindow", 128_000),
			maxTokens: readNumber(m, "maxTokens", 16_000),
			cost: readCost(m.cost),
			input: readInput(m.input),
			api: readApi(m.api, "openai-completions"),
			suggestedProvider: normalizeSuggestedProvider(
				readString(m, "suggestedProviderName", "misc"),
				cfg.proxy.providerPrefix,
			),
			ownedBy: readString(m, "owned_by", ""),
		});
	}

	const upstream = isRecord(doc.upstream) ? doc.upstream : {};
	const counts = isRecord(doc.counts) ? doc.counts : {};

	return {
		source: "well-known",
		upstreamVersion: readString(upstream, "upstreamVersion", ""),
		builtinProviders: builtin,
		customPool,
		serverDiscoveryExcludes: Array.isArray(doc.discoveryExcludes)
			? doc.discoveryExcludes.filter((s: unknown): s is string => typeof s === "string")
			: [],
		upstreamTotal: readNumber(counts, "upstreamTotal", 0),
	};
}

// --------------------------------------------------------------------------- /v1/models path

async function fetchRawModels(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<RawUpstreamModel[]> {
	const url = new URL(
		"/v1/models",
		new URL(cfg.proxy.endpoint).origin,
	).toString();
	const resp = await fetchWithTimeout(url, {
		headers: {
			Authorization: `Bearer ${resolvedKey}`,
			Accept: "application/json",
			"User-Agent": PLUGIN_USER_AGENT,
		},
	});
	if (!resp.ok) {
		throw new Error(`/v1/models returned ${resp.status}`);
	}
	const json: unknown = await resp.json();
	const body = isRecord(json) ? json : {};
	const data = Array.isArray(body.data) ? body.data : [];
	return data
		.filter((m): m is Record<string, unknown> => isRecord(m))
		.map((m) => ({
			id: readString(m, "id", ""),
			owned_by: readString(m, "owned_by", ""),
		}))
		.filter((m) => m.id);
}

/** Return type of modelDefaults() — kept explicit per ts-no-return-type. */
type ModelDefaultsResult = {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

function classifyLocally(raw: RawUpstreamModel[], cfg: ProxyConfig): Discovery {
	const excludes = cfg.discoveryExcludes;
	const builtinByName = new Map<string, DiscoveryBuiltinProvider>();
	const customPool: DiscoveryCustomEntry[] = [];
	let upstreamTotal = 0;

	for (const m of raw) {
		upstreamTotal++;
		if (isExcluded(m.id, excludes)) continue;

		if (m.owned_by === "openai") {
			const entry = modelDefaults(m.id);
			pushBuiltin(builtinByName, "openai", "openai-responses", entryToDiscovery(entry));
			continue;
		}
		if (m.owned_by === "anthropic") {
			const entry = modelDefaults(m.id);
			pushBuiltin(builtinByName, "anthropic", "anthropic-messages", entryToDiscovery(entry));
			continue;
		}
		const { slug, api } = classifyCustom(m.owned_by, cfg.proxy.providerPrefix);
		const base = modelDefaults(m.id);
		customPool.push({
			id: m.id,
			name: base.name ?? m.id,
			reasoning: base.reasoning ?? false,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
			cost: base.cost,
			input: ["text"],
			api,
			suggestedProvider: slug,
			ownedBy: m.owned_by,
		});
	}

	return {
		source: "v1-models",
		upstreamVersion: null,
		builtinProviders: Array.from(builtinByName.values()),
		customPool,
		serverDiscoveryExcludes: [],
		upstreamTotal,
	};
}

function pushBuiltin(
	map: Map<string, DiscoveryBuiltinProvider>,
	name: string,
	api: Api,
	entry: DiscoveryModelEntry,
): void {
	let p = map.get(name);
	if (!p) {
		p = { name, api, models: [] };
		map.set(name, p);
	}
	p.models.push(entry);
}

function entryToDiscovery(base: ModelDefaultsResult): DiscoveryModelEntry {
	return {
		id: base.id,
		name: base.name ?? base.id,
		reasoning: base.reasoning ?? false,
		contextWindow: base.contextWindow ?? 128_000,
		maxTokens: base.maxTokens ?? 16_000,
		cost: base.cost ?? ZERO_COST,
		input: ["text"],
	};
}

// --------------------------------------------------------------------------- public

export async function fetchDiscovery(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<Discovery> {
	try {
		const wellKnown = await tryWellKnown(cfg);
		if (wellKnown) {
			writeDiscoveryCache(wellKnown);
			return wellKnown;
		}
	} catch {
		/* fall through to /v1/models */
	}
	const raw = await fetchRawModels(cfg, resolvedKey);
	const d = classifyLocally(raw, cfg);
	log.info(
		`discovery via /v1/models: ${d.builtinProviders.length} builtin, ${d.customPool.length} custom`,
	);
	return d;
}

/** Convenience: flat set of all upstream ids (after server-applied excludes). */
export function discoveryToIdSet(d: Discovery): Set<string> {
	const ids = new Set<string>();
	for (const p of d.builtinProviders) {
		for (const m of p.models) ids.add(m.id);
	}
	for (const m of d.customPool) ids.add(m.id);
	return ids;
}
