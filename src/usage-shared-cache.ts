// File-based shared cache for /api/usage — multiple Pi instances read the same
// file, and a file lock prevents thundering-herd fetches.
//
// Flow (per Pi instance):
//   1. readUsageCache() → { doc, ageMs } | null
//   2. if fresh (ageMs < TTL_MS) → use doc, no network
//   3. if stale or missing → tryAcquireLock()
//      a. lock acquired → fetchUsage(force) → writeUsageCache → releaseLock
//      b. lock NOT acquired (another instance fetching) → use stale doc or null
//
// Lock: O_EXCL create (atomic on POSIX). Contains pid + timestamp. Stale locks
// (older than LOCK_STALE_MS) are removed to recover from crashed processes.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./config.ts";
import type { UsageDocument } from "./fetch-usage.ts";
import { log } from "./log.ts";

export const USAGE_CACHE_PATH = join(CONFIG_DIR, "usage-cache.json");
export const USAGE_LOCK_PATH = join(CONFIG_DIR, "usage-cache.lock");

/** Minimum interval between network fetches, shared across all Pi instances. */
export const USAGE_CACHE_TTL_MS = 120_000; // 2 minutes
/** A lock file older than this is considered stale (process crashed). */
const LOCK_STALE_MS = 30_000;

interface CacheEnvelope {
	fetchedAt: number; // epoch ms
	doc: UsageDocument;
}

export interface CachedUsage {
	doc: UsageDocument;
	ageMs: number;
}

/** Read the shared cache file. Returns null if missing/corrupt. */
export function readUsageCache(): CachedUsage | null {
	if (!existsSync(USAGE_CACHE_PATH)) return null;
	try {
		const env = JSON.parse(
			readFileSync(USAGE_CACHE_PATH, "utf8"),
		) as CacheEnvelope;
		if (
			!env ||
			typeof env.fetchedAt !== "number" ||
			!env.doc ||
			!Array.isArray(env.doc.accounts)
		) {
			return null;
		}
		return { doc: env.doc, ageMs: Date.now() - env.fetchedAt };
	} catch (err) {
		log.warn("failed to read usage cache:", (err as Error).message);
		return null;
	}
}

/** Is the cached data fresh enough to skip a network fetch? */
export function isUsageFresh(ageMs: number): boolean {
	return ageMs < USAGE_CACHE_TTL_MS;
}

/** Write fresh usage data + timestamp to the shared cache file. */
export function writeUsageCache(doc: UsageDocument): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		const env: CacheEnvelope = { fetchedAt: Date.now(), doc };
		writeFileSync(USAGE_CACHE_PATH, JSON.stringify(env), "utf8");
	} catch (err) {
		log.warn("failed to write usage cache:", (err as Error).message);
	}
}

/**
 * Try to acquire an exclusive lock for fetching usage.
 * Returns the lock token if this instance should fetch, null if another is
 * already doing so. Stale locks (crashed process) are cleaned up automatically.
 * The token must be passed to {@link releaseUsageLock} so we only remove a
 * lock we still own.
 */
export function tryAcquireUsageLock(): string | null {
	const token = `${process.pid}@${Date.now()}`;
	// Clean up stale lock from a crashed process
	if (existsSync(USAGE_LOCK_PATH)) {
		try {
			const stat = statSync(USAGE_LOCK_PATH);
			if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				log.debug("removing stale usage lock");
				unlinkSync(USAGE_LOCK_PATH);
			} else {
				return null; // someone else holds a live lock
			}
		} catch {
			// stat/unlink race — treat as locked to be safe
			return null;
		}
	}
	// O_EXCL ("wx") — atomically creates only if the file does not exist
	try {
		writeFileSync(USAGE_LOCK_PATH, token, { flag: "wx" });
		return token;
	} catch {
		// race: another instance created the lock between our check and create
		return null;
	}
}

export function releaseUsageLock(ourToken: string): boolean {
	try {
		const content = readFileSync(USAGE_LOCK_PATH, "utf8").trim();
		// Only remove the lock if it still belongs to us. If another process
		// acquired it after our stale-cleanup, leave it alone.
		if (content === ourToken) {
			unlinkSync(USAGE_LOCK_PATH);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
