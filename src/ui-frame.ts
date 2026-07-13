// Shared frame renderer for every /cliproxy overlay.
//
// Geometry contract:
//   - frame() always returns lines that are EXACTLY `width` visible cells.
//   - top    = \u256d\u2500 <title> <fill> \u256e
//   - body i = \u2502 <line padded/truncated to width-2> \u2502
//   - footer = \u2570\u2500 <hint> <fill> [badge] \u256f       (if footer provided)
//     or       \u2570\u2500\u2500\u2500\u2026\u2500\u2500\u2500\u256f                          (otherwise)
//
// Callers stay simple:
//
//   return frame(theme, {
//     width,
//     title: " setup ",
//     lines: [
//       " hint goes here ",
//       "",
//       theme.fg("accent", "> input"),
//     ],
//     footer: { hint: "enter = save  \u00b7  esc = cancel" },
//   });
//
// Anything inside `lines` may already contain ANSI escapes; pad() is ANSI-aware
// (see render-text.ts). No caller should ever draw \u256d/\u256e/\u2502/\u2570/\u256f by hand again.

import { visibleWidth } from "@earendil-works/pi-tui";

import { pad } from "./ui-picker/render-text.ts";
import type { Theme } from "./ui-picker/types.ts";

export interface FrameFooter {
	/** Left-aligned hint text (dimmed). */
	hint?: string;
	/** Right-aligned focus/state badge (muted). */
	badge?: string;
}

export interface FrameOpts {
	width: number;
	title?: string;
	titleColor?: "accent" | "error" | "success" | "warning";
	lines: string[];
	footer?: FrameFooter;
}

const SIDE = "\u2502";
const TL = "\u256d";
const TR = "\u256e";
const BL = "\u2570";
const BR = "\u256f";
const HR = "\u2500";

export function frame(theme: Theme, opts: FrameOpts): string[] {
	const w = Math.max(4, opts.width);
	return [
		drawTop(theme, opts.title, opts.titleColor ?? "accent", w),
		...opts.lines.map((line) => drawBody(theme, line, w)),
		drawBottom(theme, opts.footer, w),
	];
}

function drawTop(
	theme: Theme,
	title: string | undefined,
	color: "accent" | "error" | "success" | "warning",
	width: number,
): string {
	// Layout: \u256d \u2500 <title> <fill> \u256e  \u2014 exactly `width` cells.
	// Fixed cells = 2 (\u256d\u2500) + 1 (\u256e) = 3. The rest is title + fill.
	const t = title ?? "";
	const titleVis = visibleWidth(t);
	const rest = Math.max(0, width - 3 - titleVis);
	const titleColoured = t ? theme.bold(theme.fg(color, t)) : "";
	const body = `${TL}${HR}${titleColoured}${HR.repeat(rest)}${TR}`;
	return theme.fg("borderAccent", body);
}

function drawBody(theme: Theme, content: string, width: number): string {
	// Layout: \u2502 <content padded to width-2> \u2502
	const inner = Math.max(0, width - 2);
	const side = theme.fg("borderAccent", SIDE);
	return `${side}${pad(content, inner)}${side}`;
}

function drawBottom(
	theme: Theme,
	footer: FrameFooter | undefined,
	width: number,
): string {
	const start = `${BL}${HR}`;
	const end = `${BR}`;
	const fixedCells = 3; // \u2570 + \u2500 + \u256f

	if (!footer || (!footer.hint && !footer.badge)) {
		const rest = Math.max(0, width - fixedCells);
		return theme.fg("borderAccent", `${start}${HR.repeat(rest)}${end}`);
	}

	const hint = footer.hint ?? "";
	const badge = footer.badge ?? "";
	const hintVis = visibleWidth(hint);
	const badgeVis = visibleWidth(badge);
	const rest = Math.max(0, width - fixedCells - hintVis - badgeVis);

	const left = theme.fg("dim", hint);
	const right = badge ? theme.fg("muted", badge) : "";
	const fill = HR.repeat(rest);

	return `${theme.fg("borderAccent", start)}${left}${theme.fg("borderAccent", fill)}${right}${theme.fg("borderAccent", end)}`;
}

/**
 * Convenience: number of usable content cells per body line for a given frame
 * width. Use this when laying out children that need to know their width.
 */
export function frameInner(width: number): number {
	return Math.max(0, width - 2);
}
