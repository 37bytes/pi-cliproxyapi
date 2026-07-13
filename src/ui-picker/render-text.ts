// Low-level text utilities. Everything here is pure and ANSI-aware.

import { visibleWidth } from "@earendil-works/pi-tui";

/** Pad a possibly-ANSI string to exactly `width` cells, truncating if needed. */
export function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w === width) return s;
	if (w < width) return s + " ".repeat(width - w);
	return truncateAnsi(s, width);
}

/**
 * Clip an ANSI-coloured string to `width` visible cells. SGR escapes pass
 * through; a final reset is appended so trailing colour state does not bleed.
 */
export function truncateAnsi(s: string, width: number): string {
	if (width <= 0) return "\x1b[0m";
	let out = "";
	let visible = 0;
	let i = 0;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === "\x1b" && s[i + 1] === "[") {
			const end = s.indexOf("m", i + 2);
			if (end >= 0) {
				out += s.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		const w = visibleWidth(ch);
		if (visible + w > width) break;
		out += ch;
		visible += w;
		i++;
	}
	return `${out}\x1b[0m`;
}
