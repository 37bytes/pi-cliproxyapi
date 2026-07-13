// Disk cache for Discovery — stale-while-revalidate.
//
// The well-known/v1-models round-trip costs ~5s on every Pi startup (the proxy
// answers /.well-known/pi slowly), and Pi re-spawns the agent for every
// provider-feature probe, so that cost is paid constantly. We persist the last
// good Discovery and serve it instantly on boot, then revalidate over the
// network in the background.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "./config.ts";
import type { Discovery } from "./fetch-models.ts";
import { log } from "./log.ts";

export const DISCOVERY_CACHE_PATH = join(CONFIG_DIR, "discovery-cache.json");

interface CacheEnvelope {
	savedAt: number;
	discovery: Discovery;
}

export interface CachedDiscovery {
	discovery: Discovery;
	ageMs: number;
}

export function readDiscoveryCache(): CachedDiscovery | null {
	if (!existsSync(DISCOVERY_CACHE_PATH)) return null;
	try {
		const env = JSON.parse(
			readFileSync(DISCOVERY_CACHE_PATH, "utf8"),
		) as CacheEnvelope;
		if (
			!env ||
			typeof env.savedAt !== "number" ||
			!env.discovery ||
			!Array.isArray(env.discovery.builtinProviders) ||
			!Array.isArray(env.discovery.customPool)
		) {
			return null;
		}
		return { discovery: env.discovery, ageMs: Date.now() - env.savedAt };
	} catch (err) {
		log.warn("failed to read discovery cache:", (err as Error).message);
		return null;
	}
}

export function writeDiscoveryCache(discovery: Discovery): void {
	try {
		mkdirSync(dirname(DISCOVERY_CACHE_PATH), { recursive: true });
		const env: CacheEnvelope = { savedAt: Date.now(), discovery };
		writeFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(env), "utf8");
	} catch (err) {
		log.warn("failed to write discovery cache:", (err as Error).message);
	}
}
