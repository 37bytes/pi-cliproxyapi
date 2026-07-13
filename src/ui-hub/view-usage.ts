// Usage view — wraps renderUsage() in a scrollable hub tab with d/v toggles.
// The /api/usage document is fetched lazily the first time the tab is opened.

import { matchesKey } from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import { resolveConfigValue } from "../config.ts";
import {
	clearUsageCache,
	fetchUsage,
	type UsageDocument,
} from "../fetch-usage.ts";
import { pad } from "../ui-picker/render-text.ts";
import type { OverlayTui, Theme } from "../ui-picker/types.ts";
import { renderUsage } from "../ui-usage.ts";
import { clampOffset, takeSlice } from "./shell.ts";
import type { HubView } from "./types.ts";

export interface UsageViewDeps {
	tui: OverlayTui;
	theme: Theme;
	cfg: ProxyConfig;
}

export interface UsageView extends HubView {
	/** Drop the cache and refetch (called by the hub's global refresh). */
	reload(): void;
}

export function buildUsageView(deps: UsageViewDeps): UsageView {
	const { tui, theme, cfg } = deps;
	let status: "idle" | "loading" | "ready" | "error" = "idle";
	let doc: UsageDocument | null = null;
	let errMsg = "";
	let offset = 0;
	let showDisabled = false;
	let verbose = false;

	const load = (force: boolean): void => {
		status = "loading";
		tui.requestRender();
		const usageKey = resolveConfigValue(cfg.proxy.usageKey);
		void fetchUsage(cfg, usageKey, { force })
			.then((d) => {
				doc = d;
				status = "ready";
				offset = 0;
				tui.requestRender();
			})
			.catch((e: unknown) => {
				errMsg = (e as Error).message;
				status = "error";
				tui.requestRender();
			});
	};

	const lines = (): string[] => {
		if (status === "idle" || status === "loading")
			return [theme.fg("dim", "  loading usage\u2026")];
		if (status === "error")
			return [theme.fg("error", `  usage failed: ${errMsg}`)];
		if (!doc) return [theme.fg("dim", "  (no data)")];
		return renderUsage(doc, { showDisabled, verbose });
	};

	const render = (width: number, height: number): string[] => {
		const body = lines();
		offset = clampOffset(offset, height, body.length);
		return takeSlice(body, offset, height).map((ln) => pad(` ${ln}`, width));
	};

	const handleInput = (data: string): boolean => {
		if (matchesKey(data, "d")) {
			showDisabled = !showDisabled;
			offset = 0;
			return true;
		}
		if (matchesKey(data, "v")) {
			verbose = !verbose;
			offset = 0;
			return true;
		}
		const total = lines().length;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			offset = Math.max(0, offset - 1);
			return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			offset = Math.min(Math.max(0, total - 1), offset + 1);
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
			offset = Math.max(0, offset - 10);
			return true;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
			offset = Math.min(Math.max(0, total - 1), offset + 10);
			return true;
		}
		if (matchesKey(data, "home") || matchesKey(data, "g")) {
			offset = 0;
			return true;
		}
		if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			offset = Math.max(0, total - 1);
			return true;
		}
		return false;
	};

	const footerHint = (): string => {
		const d = showDisabled ? theme.fg("success", "[d disabled]") : "d disabled";
		const v = verbose ? theme.fg("success", "[v verbose]") : "v verbose";
		return ` \u2191\u2193 scroll \u00b7 ${d} \u00b7 ${v} `;
	};

	return {
		id: "usage",
		label: "Usage",
		render,
		handleInput,
		footerHint,
		onActivate: () => {
			if (status === "idle") load(false);
		},
		reload: () => {
			clearUsageCache();
			if (status !== "idle") load(true);
		},
	};
}
