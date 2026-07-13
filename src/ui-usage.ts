// Renders /api/usage as multi-line ANSI text for the hub Usage tab.
//
// Lines are wrapped pre-render so they never reflow inside the overlay box —
// long errors get truncated with an ellipsis on the same line. Progress bars
// are colored by remaining capacity: green ≥40%, yellow 15–40%, red <15%.

import type { UsageAccount, UsageDocument, UsageGroup } from "./fetch-usage.ts";

// 256-color palette codes (truecolor and 256color terminals both render).
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	accent: "\x1b[38;5;111m", // soft blue
	muted: "\x1b[38;5;245m",
	dim2: "\x1b[38;5;240m",
	green: "\x1b[38;5;114m",
	yellow: "\x1b[38;5;179m",
	red: "\x1b[38;5;167m",
	greenBg: "\x1b[48;5;22m",
	yellowBg: "\x1b[48;5;94m",
	redBg: "\x1b[48;5;52m",
};

const BAR_WIDTH = 18;
const MAX_LABEL_WIDTH = 28;

export interface RenderUsageOptions {
	/** Include accounts with `disabled` flag in the output. */
	showDisabled?: boolean;
	/** Print the raw backend error string on a second line (instead of just the short [err 401] marker). */
	verbose?: boolean;
}

export function renderUsage(
	doc: UsageDocument,
	opts: RenderUsageOptions = {},
): string[] {
	const lines: string[] = [];
	const byProvider = new Map<string, UsageAccount[]>();
	let hiddenDisabled = 0;
	for (const a of doc.accounts) {
		if (!opts.showDisabled && a.disabled) {
			hiddenDisabled++;
			continue;
		}
		const arr = byProvider.get(a.provider) ?? [];
		arr.push(a);
		byProvider.set(a.provider, arr);
	}

	lines.push(`${C.dim}generated ${doc.generatedAt}${C.reset}`);
	if (doc.unsupportedProviders.length > 0) {
		lines.push(
			`${C.dim}providers without quota lookup:${C.reset} ${doc.unsupportedProviders.join(", ")}`,
		);
	}
	if (hiddenDisabled > 0) {
		lines.push(
			`${C.dim}hidden disabled accounts:${C.reset} ${hiddenDisabled} ${C.dim2}(press d to show)${C.reset}`,
		);
	}

	for (const [provider, accounts] of Array.from(byProvider.entries()).sort()) {
		lines.push("");
		lines.push(`${C.bold}${C.accent}▌ ${provider}${C.reset}`);
		for (const a of accounts) {
			lines.push(formatAccountHeader(a));
			if (!a.supported) {
				lines.push(`    ${C.dim2}(provider not quota-aware)${C.reset}`);
				continue;
			}
			if (a.error) {
				if (opts.verbose) {
					for (const ln of wrapText(a.error, 88)) {
						lines.push(`    ${C.red}${ln}${C.reset}`);
					}
				}
				continue;
			}
			const groups = a.groups ?? [];
			if (groups.length === 0) {
				lines.push(`    ${C.dim2}(no active quota windows)${C.reset}`);
				continue;
			}
			for (const g of groups) lines.push(formatGroup(g));
		}
	}

	// Legend at the bottom — distinguishes the per-account status icons
	// (left of label) from the success/fail request counters (right of label).
	lines.push("");
	lines.push(
		`${C.dim}legend:${C.reset}  ` +
			`${ICON_OK_DOT} ok   ` +
			`${ICON_WARN} error/unavailable   ` +
			`${ICON_DISABLED} disabled   ` +
			`${C.green}✓N${C.reset}/${C.red}✗N${C.reset} request counters   ` +
			`${C.dim}v = verbose, d = show disabled${C.reset}`,
	);
	return lines;
}

function wrapText(s: string, max: number): string[] {
	if (s.length <= max) return [s];
	const out: string[] = [];
	let rest = s;
	while (rest.length > max) {
		let cut = rest.lastIndexOf(" ", max);
		if (cut < max * 0.6) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\s+/, "");
	}
	if (rest) out.push(rest);
	return out;
}

function formatAccountHeader(a: UsageAccount): string {
	const status = accountStatus(a);
	const counters = `${C.green}✓${a.success}${C.reset} ${C.red}✗${a.failed}${C.reset}`;
	const label = truncate(a.label, 36);
	return `  ${status} ${C.bold}${label}${C.reset}  ${counters}`;
}

// Status icons — distinct from the ✓/✗ request counters so the user
// can tell account-level state (left) from per-request totals (right).
const ICON_OK_DOT = `${C.green}●${C.reset}`;
const ICON_WARN = `${C.yellow}⚠${C.reset}`;
const ICON_DISABLED = `${C.dim2}⊘${C.reset}`;

function accountStatus(a: UsageAccount): string {
	if (a.disabled) return ICON_DISABLED;
	if (a.unavailable || a.error || (a.status && a.status !== "active")) {
		return ICON_WARN;
	}
	return ICON_OK_DOT;
}

function formatGroup(g: UsageGroup): string {
	const f = clamp(g.remainingFraction);
	const pct = Math.round(f * 100);
	const bar = renderBar(f);
	const reset = g.resetTime
		? `  ${C.dim}reset ${humanizeReset(g.resetTime)}${C.reset}`
		: "";
	const label = truncate(g.label, MAX_LABEL_WIDTH).padEnd(MAX_LABEL_WIDTH, " ");
	return `    ${bar} ${formatPct(pct, f)}  ${label}${reset}`;
}

function renderBar(fraction: number): string {
	const f = clamp(fraction);
	const filled = Math.round(f * BAR_WIDTH);
	const color = colorForFraction(f);
	const dimColor = C.dim2;
	const full = "█".repeat(filled);
	const empty = "░".repeat(BAR_WIDTH - filled);
	return `${dimColor}[${color}${full}${dimColor}${empty}]${C.reset}`;
}

function formatPct(pct: number, fraction: number): string {
	const color = colorForFraction(fraction);
	return `${color}${String(pct).padStart(3)}%${C.reset}`;
}

function colorForFraction(f: number): string {
	if (f >= 0.4) return C.green;
	if (f >= 0.15) return C.yellow;
	return C.red;
}

function humanizeReset(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	const ms = t - Date.now();
	if (ms <= 0) return "now";
	const min = Math.round(ms / 60_000);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 48) return `${hr}h`;
	const d = Math.round(hr / 24);
	return `${d}d`;
}

function clamp(f: number): number {
	return Math.max(0, Math.min(1, f));
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
