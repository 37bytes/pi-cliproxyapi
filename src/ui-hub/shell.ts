// Shared TUI primitives for the /cliproxy hub.
//
// One home for the scroll math + chrome (tab bar, status header) that used to
// be copy-pasted across the picker, the read-only overlay, and the setup
// wizard. Everything here is pure and ANSI-aware.

import { visibleWidth } from "@earendil-works/pi-tui";

import { pad } from "../ui-picker/render-text.ts";
import type { Theme } from "../ui-picker/types.ts";

export interface TabSpec {
	id: string;
	label: string;
}

/**
 * Render the hub tab bar as a single `width`-cell line.
 *   Models  \u2502  Usage  \u2502  Diagnostics
 * The active tab is bold/accent; the rest are dimmed.
 */
export function tabBar(
	theme: Theme,
	tabs: TabSpec[],
	activeIdx: number,
	width: number,
): string {
	const sep = theme.fg("borderAccent", "\u2502");
	const cells = tabs.map((t, i) => {
		const label = `${i + 1} ${t.label}`;
		return i === activeIdx
			? theme.bold(theme.fg("accent", ` ${label} `))
			: theme.fg("dim", ` ${label} `);
	});
	return pad(` ${cells.join(sep)}`, width);
}

/**
 * Render a status header from labelled parts, joined with a dim gap and
 * clipped to `width`.
 */
export function statusHeader(
	theme: Theme,
	parts: string[],
	width: number,
): string {
	const joined = parts.join(theme.fg("dim", "   "));
	return pad(` ${joined}`, width);
}

/** A full-width horizontal rule used to divide chrome from the view body. */
export function ruleLine(theme: Theme, width: number): string {
	return theme.fg("borderAccent", "\u2500".repeat(Math.max(0, width)));
}

/**
 * Slice `lines` to exactly `count` rows starting at `scroll`, padding the tail
 * with empty strings so the caller always gets a fixed-height block.
 */
export function takeSlice(
	lines: string[],
	scroll: number,
	count: number,
): string[] {
	const s = lines.slice(scroll, scroll + count);
	while (s.length < count) s.push("");
	return s;
}

/**
 * Compute a scroll offset that keeps a cursor visible inside `visible` rows.
 *
 * Two cursor coords:
 *   - cursorTop: the highest line that must stay visible (often a group
 *     subheader pinned right above the cursor on a group's first row).
 *   - cursorBottom: the cursor row itself.
 *
 * `stickyCount` rows at the top (panel headers) are pinned and never scroll
 * out from under the cursor block. Returns a clamped offset that never leaves
 * a gap above nor pushes the cursor below the window.
 */
export function clampScroll(
	cursorTop: number,
	cursorBottom: number,
	prev: number,
	visible: number,
	total: number,
	stickyCount: number,
): number {
	if (total <= visible) return 0;
	const maxScroll = Math.max(0, total - visible);
	if (cursorBottom < stickyCount) return 0;
	let scroll = Math.max(0, Math.min(prev, maxScroll));
	const topRow = scroll + stickyCount;
	if (cursorTop < topRow) {
		scroll = Math.max(0, cursorTop - stickyCount);
	}
	const bottomRow = scroll + visible - 1;
	if (cursorBottom > bottomRow) {
		scroll = Math.min(maxScroll, cursorBottom - (visible - 1));
	}
	return scroll;
}

/**
 * Simple offset-based clamp for flat (un-sticky) lists like usage/diagnostics.
 * Returns an offset within [0, total-visible].
 */
export function clampOffset(
	offset: number,
	visible: number,
	total: number,
): number {
	const max = Math.max(0, total - visible);
	return Math.max(0, Math.min(offset, max));
}

/** Number of visible cells in a string (re-export for view code). */
export { visibleWidth };
