// Tiny logger that prefixes all messages with the extension tag.
// Uses console.* directly — pi pipes stdout/stderr into its log sink.
//
// While an interactive overlay is open, console output corrupts the TUI (it
// prints over the box and forces a redraw below it — stacking headers). The
// overlay code wraps its lifetime in setLogQuiet(true) to mute us; user-facing
// results are surfaced inside the overlay instead.

const TAG = "[pi-cliproxyapi]";

let quiet = false;

/** Mute/unmute all console output (used around interactive overlays). */
export function setLogQuiet(v: boolean): void {
	quiet = v;
}

export const log = {
	info(...args: unknown[]): void {
		if (!quiet) console.log(TAG, ...args);
	},
	warn(...args: unknown[]): void {
		if (!quiet) console.warn(TAG, ...args);
	},
	error(...args: unknown[]): void {
		if (!quiet) console.error(TAG, ...args);
	},
	debug(...args: unknown[]): void {
		if (!quiet && process.env.PI_CLIPROXYAPI_DEBUG)
			console.log(TAG, "[debug]", ...args);
	},
};
