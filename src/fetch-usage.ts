// /api/usage client.
//
// GET <host>/api/usage with X-Plugin-Key. Returns the parsed document, with a
// small in-memory TTL cache. Caller passes `force: true` to bypass the cache.

import type { ProxyConfig } from "./config.ts";
import { PLUGIN_USER_AGENT } from "./fetch-models.ts";
import { log } from "./log.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export interface UsageGroup {
	id: string;
	label: string;
	remainingFraction: number;
	resetTime: string | null;
	models?: string[];
}

export interface UsageAccount {
	provider: string;
	account: string;
	authIndex: string;
	label: string;
	status: string;
	disabled: boolean;
	unavailable: boolean;
	success: number;
	failed: number;
	lastRequestAt: string | null;
	supported: boolean;
	error?: string;
	groups?: UsageGroup[];
}

export interface UsageDocument {
	schemaVersion: number;
	generatedAt: string;
	accounts: UsageAccount[];
	unsupportedProviders: string[];
}

interface CacheEntry {
	fetchedAt: number;
	doc: UsageDocument;
}

let cache: CacheEntry | null = null;

export function clearUsageCache(): void {
	cache = null;
}

export async function fetchUsage(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	opts: { force?: boolean } = {},
): Promise<UsageDocument> {
	if (
		!opts.force &&
		cache &&
		Date.now() - cache.fetchedAt < cfg.usageCacheTtlMs
	) {
		return cache.doc;
	}
	if (!resolvedUsageKey) {
		throw new Error(
			"usage key not configured; set proxy.usageKey in config and rerun",
		);
	}
	const url = new URL(
		"/api/usage",
		new URL(cfg.proxy.endpoint).origin,
	).toString();
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	let resp: Response;
	try {
		resp = await fetch(url, {
			headers: {
				"X-Plugin-Key": resolvedUsageKey,
				Accept: "application/json",
				"User-Agent": PLUGIN_USER_AGENT,
			},
			signal: ctrl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	if (!resp.ok) {
		throw new Error(`/api/usage returned ${resp.status}`);
	}
	const body = (await resp.json()) as UsageDocument;
	if (!body || body.schemaVersion !== 1 || !Array.isArray(body.accounts)) {
		throw new Error("/api/usage returned unexpected payload shape");
	}
	cache = { fetchedAt: Date.now(), doc: body };
	log.debug("usage fetched, accounts:", body.accounts.length);
	return body;
}
