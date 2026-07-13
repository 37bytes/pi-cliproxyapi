// Row renderers for left + right panels. Each function returns a string that
// is guaranteed to fit into `width` visible cells (via marquee on the focused
// row, and pad/truncate otherwise).
//
// The renderers also draw the cursor differently for the active panel
// (\u25b6 accent) vs an inactive panel where the cursor row is highlighted
// but more muted (\u00b7 dim) \u2014 this gives users a hint where focus is
// without losing track of selection across panels.

import { visibleWidth } from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import { pad, truncateAnsi } from "./render-text.ts";
import type { ModelEntry, ProviderEntry, Theme } from "./types.ts";

interface RowCtx {
	theme: Theme;
	width: number;
	isCursor: boolean;
	isFocused: boolean;
}

function cursorMark(
	theme: Theme,
	isCursor: boolean,
	isFocused: boolean,
): string {
	if (!isCursor) return "  ";
	if (isFocused) return theme.fg("accent", "\u25b6 ");
	return theme.fg("muted", "\u25b8 ");
}

function fitLine(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	if (w > width) return truncateAnsi(line, width);
	return pad(line, width);
}

// --------------------------------------------------------------------------- left panel rows

export function renderProviderRow(
	p: ProviderEntry,
	cfg: ProxyConfig,
	ctx: RowCtx,
): string {
	const { theme, width, isCursor, isFocused } = ctx;
	const mark = cursorMark(theme, isCursor, isFocused);
	const count =
		p.kind === "builtin"
			? (cfg.builtinProviders[p.name]?.models.length ?? 0)
			: (cfg.customProviders[p.name]?.models.length ?? 0);

	const tag =
		p.kind === "builtin" ? theme.fg("accent", "B") : theme.fg("warning", "C");
	const tagBracket = `${theme.fg("dim", "[")}${tag}${theme.fg("dim", "]")}`;

	const dot =
		count > 0 ? theme.fg("success", "\u25cf") : theme.fg("dim", "\u25cb");
	const countStr =
		count > 0
			? theme.fg("success", String(count).padStart(2))
			: theme.fg("dim", " 0");

	const name =
		isCursor && isFocused
			? theme.bold(theme.fg("accent", p.name))
			: isCursor
				? theme.bold(p.name)
				: p.name;
	const api = theme.fg("dim", p.api);

	const line = `${mark}${tagBracket} ${name}  ${dot}${countStr}  ${api}`;
	return fitLine(line, width);
}

export function renderNewProviderRow(
	theme: Theme,
	isCursor: boolean,
	isFocused: boolean,
	width: number,
): string {
	const mark = cursorMark(theme, isCursor, isFocused);
	const body =
		isCursor && isFocused
			? theme.bold(theme.fg("accent", "\uff0b  new custom group\u2026"))
			: theme.fg("accent", "\uff0b  new custom group\u2026");
	return pad(`${mark}${body}`, width);
}

// --------------------------------------------------------------------------- right panel rows

export function renderModelRow(
	id: string,
	m: ModelEntry | undefined,
	side: "assigned" | "pool",
	compatWarn: boolean,
	ctx: RowCtx,
): string {
	const { theme, width, isCursor, isFocused } = ctx;
	const mark = cursorMark(theme, isCursor, isFocused);

	const box =
		side === "assigned"
			? theme.fg("success", "\u2611")
			: theme.fg("dim", "\u2610");

	const warn = compatWarn ? ` ${theme.fg("warning", "\u26a0")}` : "";
	const idStr = isCursor && isFocused ? theme.fg("accent", id) : id;
	const reasoning = m?.reasoning ? ` ${theme.fg("accent", "\u2728")}` : "";
	const apiTag = m
		? theme.fg("muted", ` \u00b7 ${m.suggestedApi}`)
		: theme.fg("error", " \u00b7 not on proxy");

	const line = `${mark}${box}  ${idStr}${warn}${reasoning}${apiTag}`;
	return fitLine(line, width);
}

// --------------------------------------------------------------------------- panel subheaders

export function renderSubheader(
	theme: Theme,
	label: string,
	width: number,
): string {
	// Compact "── label ──" tag, not a full-width rule. We don't want it to
	// look like another panel frame.
	const tag = `${theme.fg("borderAccent", "\u2500\u2500")} ${theme.fg("warning", label)} ${theme.fg("borderAccent", "\u2500\u2500")}`;
	return pad(`  ${tag}`, width);
}

export function renderEmpty(
	theme: Theme,
	label: string,
	width: number,
): string {
	return pad(`  ${theme.fg("dim", label)}`, width);
}

/** Decorate a header line ("assigned to <name>") with focus emphasis. */
export function renderPanelHeader(
	theme: Theme,
	text: string,
	width: number,
	isFocused: boolean,
): string {
	const prefix = isFocused
		? theme.bold(theme.fg("accent", "\u275a "))
		: theme.fg("dim", "  ");
	return pad(`${prefix}${text}`, width);
}
