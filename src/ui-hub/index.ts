// Public entry for the /cliproxy hub overlay.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { ProxyConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { setLogQuiet } from "../log.ts";
import type { OverlayTui, Theme } from "../ui-picker/types.ts";
import { buildHub } from "./hub.ts";

export async function runHub(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cfg: ProxyConfig,
	discovery: Discovery,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("interactive UI required for /cliproxy", "warning");
		return;
	}
	// The hub mutates a draft; callers persist via the in-hub save action.
	const draft: ProxyConfig = structuredClone(cfg);
	// Mute console logging while the overlay is open: any stdout write prints
	// over the box and shifts it down by exactly one line. Results are shown
	// inside the hub (status flash) instead.
	setLogQuiet(true);
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) =>
				buildHub({
					pi,
					ctx,
					tui: tui as unknown as OverlayTui,
					theme: theme as unknown as Theme,
					cfg: draft,
					discovery,
					done,
				}),
			{
				overlay: true,
				overlayOptions: { width: 170, maxHeight: "94%" },
			},
		);
	} finally {
		setLogQuiet(false);
	}
}
