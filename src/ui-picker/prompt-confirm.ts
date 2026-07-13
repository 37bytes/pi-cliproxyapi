// Confirm-remove prompt overlay used when the user deletes a custom group.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
} from "@earendil-works/pi-tui";

import { frame } from "../ui-frame.ts";
import type { Theme } from "./types.ts";

export async function confirmRemoveProvider(
	ctx: ExtensionCommandContext,
	slug: string,
): Promise<boolean> {
	return ctx.ui.custom<boolean>(
		(_tui, theme, _kb, done) =>
			buildConfirmPrompt(
				theme as unknown as Theme,
				`Remove custom group \u201c${slug}\u201d?`,
				"All model assignments in this group will be discarded.",
				done,
			),
		{ overlay: true, overlayOptions: { width: 80, maxHeight: "40%" } },
	);
}

function buildConfirmPrompt(
	theme: Theme,
	title: string,
	body: string,
	done: (v: boolean) => void,
): Component & { handleInput(data: string): void } {
	return {
		render(width: number): string[] {
			return frame(theme, {
				width,
				title: " confirm ",
				titleColor: "error",
				lines: ["", ` ${theme.bold(title)}`, ` ${theme.fg("dim", body)}`, ""],
				footer: {
					hint: " y / enter = remove  \u00b7  n / esc = cancel ",
				},
			});
		},
		invalidate(): void {
			/* stateless */
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (
				kb.matches(data, "tui.select.cancel") ||
				matchesKey(data, "escape") ||
				matchesKey(data, "n") ||
				matchesKey(data, "q")
			) {
				done(false);
				return;
			}
			if (
				matchesKey(data, "y") ||
				matchesKey(data, "enter") ||
				matchesKey(data, "return")
			) {
				done(true);
				return;
			}
		},
	};
}
