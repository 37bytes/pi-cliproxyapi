// Diagnostics view — connectivity, key resolution, and discovery shape.
// Built synchronously from the config + the discovery already fetched by the
// hub, plus a read-only conflict scan.

import { matchesKey } from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import { resolveConfigValue } from "../config.ts";
import { detectConflicts } from "../conflicts.ts";
import type { Discovery } from "../fetch-models.ts";
import { PLUGIN_USER_AGENT } from "../fetch-models.ts";
import { pad } from "../ui-picker/render-text.ts";
import type { Theme } from "../ui-picker/types.ts";
import { clampOffset, takeSlice } from "./shell.ts";
import type { HubView } from "./types.ts";

export interface DiagnosticsViewDeps {
	theme: Theme;
	cfg: ProxyConfig;
	getDiscovery: () => Discovery;
}

export function buildDiagnosticsView(deps: DiagnosticsViewDeps): HubView {
	const { theme, cfg } = deps;
	let offset = 0;

	const buildLines = (): string[] => {
		const d = deps.getDiscovery();
		const ok = (s: string) => theme.fg("success", s);
		const bad = (s: string) => theme.fg("error", s);
		const dim = (s: string) => theme.fg("dim", s);
		const lines: string[] = [];

		lines.push(
			`${dim("endpoint")}      ${cfg.proxy.endpoint || bad("(unset)")}`,
		);
		lines.push(
			`${dim("apiKey")}        ${resolveConfigValue(cfg.proxy.apiKey) ? ok("resolves") : bad("empty after resolution")}`,
		);
		lines.push(
			`${dim("usageKey")}      ${
				cfg.proxy.usageKey
					? resolveConfigValue(cfg.proxy.usageKey)
						? ok("resolves")
						: bad("set but empty")
					: dim("not configured")
			}`,
		);
		lines.push(`${dim("user-agent")}    ${PLUGIN_USER_AGENT}`);
		lines.push("");
		lines.push(`${dim("discovery")}     source=${d.source}`);
		lines.push(
			`${dim("upstream")}      v=${d.upstreamVersion ?? "(unknown)"} \u00b7 ${d.upstreamTotal} ids`,
		);
		const builtins =
			d.builtinProviders
				.map((p) => `${p.name}=${p.models.length}`)
				.join(", ") || dim("(none)");
		lines.push(`${dim("built-in")}      ${builtins}`);
		lines.push(`${dim("custom pool")}   ${d.customPool.length} models`);

		const conflicts = detectConflicts(cfg);
		lines.push("");
		if (conflicts.length === 0) {
			lines.push(`${dim("conflicts")}     ${ok("none")}`);
		} else {
			lines.push(`${dim("conflicts")}`);
			for (const c of conflicts)
				lines.push(`  ${theme.fg("warning", `[${c.kind}]`)} ${c.detail}`);
		}
		return lines;
	};

	const render = (width: number, height: number): string[] => {
		const body = buildLines();
		offset = clampOffset(offset, height, body.length);
		return takeSlice(body, offset, height).map((ln) => pad(` ${ln}`, width));
	};

	const handleInput = (data: string): boolean => {
		const total = buildLines().length;
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
		return false;
	};

	return {
		id: "diagnostics",
		label: "Diagnostics",
		render,
		handleInput,
		footerHint: () => " \u2191\u2193 scroll \u00b7 r refresh discovery ",
	};
}
