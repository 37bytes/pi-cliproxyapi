/**
 * pi-cliproxyapi — Pi extension that manages model providers through a single
 * CliProxyAPI endpoint with one corporate key.
 *
 * On factory boot we:
 *   1. load ~/.config/pi-cliproxyapi/config.json (defaults if missing)
 *   2. fetch discovery (well-known → fall back to /v1/models)
 *   3. call pi.registerProvider for each enabled built-in + custom provider
 *   4. register slash commands /cliproxy and /cliproxy-setup
 *      (refresh, usage, and diagnostics are tabs/actions inside the hub)
 *   5. register status-line quota segment (shared file cache, see usage-shared-cache)
 *
 * All discovery + apply errors are logged but never abort extension load —
 * a missing/broken proxy must not prevent Pi from starting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyAll } from "./src/apply.ts";
import { readDiscoveryCache } from "./src/cache.ts";
import { registerCommands } from "./src/commands.ts";
import { loadConfig, resolveConfigValue } from "./src/config.ts";
import { detectConflicts } from "./src/conflicts.ts";
import { fetchDiscovery } from "./src/fetch-models.ts";
import type { ProxyConfig } from "./src/config.ts";
import type { UsageDocument } from "./src/fetch-usage.ts";
import { fetchUsage } from "./src/fetch-usage.ts";
import { log } from "./src/log.ts";
import {
	isUsageFresh,
	readUsageCache,
	releaseUsageLock,
	tryAcquireUsageLock,
	writeUsageCache,
} from "./src/usage-shared-cache.ts";
import { renderQuotaSegment } from "./src/status-quota.ts";

/** Status-line key. The leading "0" makes it sort before alphabetic keys so
 * the quota segment appears first on the footer's extension-status line. */
const QUOTA_STATUS_KEY = "0quota";
/** Minimum gap between network fetches triggered by turn_end, even if the
 * shared file cache is stale (prevents burst fetches during rapid turns). */
const TURN_FETCH_DEBOUNCE_MS = 5_000;

/**
 * Fetch usage data through the shared file cache: if the on-disk cache is
 * fresh (within TTL), return it without any network call; otherwise acquire
 * a cross-process lock and fetch at most once. Returns the best available
 * doc (possibly stale) or null on failure.
 */
async function loadUsageCached(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	opts: { readOnly?: boolean } = {},
): Promise<UsageDocument | null> {
	const cached = readUsageCache();
	if (cached && isUsageFresh(cached.ageMs)) return cached.doc;
	// readOnly mode (debounce path): never fetch, serve stale cache if available.
	if (opts.readOnly) return cached?.doc ?? null;
	// Stale or missing — try to become the fetcher.
	const token = tryAcquireUsageLock();
	if (!token) {
		// Another instance is fetching; serve stale data if we have it.
		return cached?.doc ?? null;
	}
	try {
		const doc = await fetchUsage(cfg, resolvedUsageKey, { force: true });
		writeUsageCache(doc);
		return doc;
	} catch (e) {
		log.debug("usage fetch failed in shared cache:", (e as Error).message);
		return cached?.doc ?? null;
	} finally {
		releaseUsageLock(token);
	}
}

/** Update the quota status segment for the current model. No-op if the model
 * has no quota windows (e.g. a custom provider) or if usage is unavailable. */
async function refreshQuotaStatus(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	ui: {
		theme: {
			fg(color: "success" | "warning" | "error" | "dim", text: string): string;
		};
		setStatus(key: string, text: string | undefined): void;
	},
	model: { provider: string } | undefined,
	opts: { readOnly?: boolean } = {},
): Promise<void> {
	if (!model) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	if (!resolvedUsageKey) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const doc = await loadUsageCached(cfg, resolvedUsageKey, opts);
	if (!doc) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const rendered = renderQuotaSegment(doc, model.provider, ui.theme);
	ui.setStatus(QUOTA_STATUS_KEY, rendered ?? undefined);
}

export default async function cliproxyapi(pi: ExtensionAPI): Promise<void> {
	registerCommands(pi);

	const cfg = loadConfig();
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(
			"apiKey is empty after resolution — skipping initial apply. Run /cliproxy-setup to configure.",
		);
		return;
	}

	// Conflict scan is read-only and cheap; do it once at startup.
	const conflicts = detectConflicts(cfg);
	for (const c of conflicts) log.warn(`conflict (${c.kind}): ${c.detail}`);

	try {
		const cached = readDiscoveryCache();
		if (cached) {
			// Serve the last good discovery instantly so Pi startup never blocks on
			// the ~5s proxy round-trip, then revalidate over the network in the
			// background (applyAll is idempotent — it just re-registers providers).
			log.info(
				`discovery from cache (age ${Math.round(cached.ageMs / 1000)}s): ${cached.discovery.builtinProviders.length} builtin, ${cached.discovery.customPool.length} custom`,
			);
			await applyAll(pi, cfg, cached.discovery);
			void (async () => {
				try {
					const fresh = await fetchDiscovery(cfg, resolvedKey);
					await applyAll(pi, cfg, fresh);
					log.debug("discovery revalidated from network");
				} catch (e) {
					log.warn(
						"background discovery revalidate failed:",
						(e as Error).message,
					);
				}
			})();
		} else {
			const discovery = await fetchDiscovery(cfg, resolvedKey);
			await applyAll(pi, cfg, discovery);
		}
	} catch (err) {
		log.error("initial apply failed:", (err as Error).message);
		// Commands stay registered; user can open /cliproxy and press r to refresh.
	}

	if (cfg.refreshIntervalMinutes > 0) {
		const ms = cfg.refreshIntervalMinutes * 60_000;
		setInterval(() => {
			void (async () => {
				try {
					const c = loadConfig();
					const k = resolveConfigValue(c.proxy.apiKey);
					if (!k) return;
					const d = await fetchDiscovery(c, k);
					await applyAll(pi, c, d);
					log.debug("background refresh ok");
				} catch (e) {
					log.warn("background refresh failed:", (e as Error).message);
				}
			})();
		}, ms);
		log.info(`background refresh every ${cfg.refreshIntervalMinutes}m`);
	}

	// -------- status-line quota segment
	//
	// The segment is context-aware: it shows 5h/7d windows for the current
	// model's provider only (anthropic→claude, openai→codex, custom→hidden).
	// The shared file cache ensures multiple Pi instances don't fetch more than
	// once every 2 minutes.
	const resolvedUsageKey = resolveConfigValue(cfg.proxy.usageKey);
	if (resolvedUsageKey) {
		let lastTurnFetchMs = 0;

		// session_start: render immediately from cache (no fetch needed if fresh).
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
		});

		// model_select: re-render for the new provider. Read from cache so the
		// segment updates instantly on model switch without a network round-trip.
		pi.on("model_select", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
		});

		// turn_end: after an LLM response the quota has changed. Trigger a fetch
		// (if the shared cache is stale) but debounce to avoid burst-fetching on
		// rapid consecutive turns.
		pi.on("turn_end", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const now = Date.now();
			if (now - lastTurnFetchMs < TURN_FETCH_DEBOUNCE_MS) {
				// Within debounce window — re-render from cache only (no fetch), so
				// rapid consecutive turns never trigger burst /api/usage calls.
				await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model, {
					readOnly: true,
				});
				return;
			}
			lastTurnFetchMs = now;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
		});
	} else {
		log.debug("usageKey not configured — quota status segment disabled");
	}
}
