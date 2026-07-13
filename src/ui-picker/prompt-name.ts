// "+ new custom group" prompt overlay.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Input,
	matchesKey,
} from "@earendil-works/pi-tui";

import { withProviderPrefix } from "../compat.ts";
import { frame, frameInner } from "../ui-frame.ts";
import type { Theme } from "./types.ts";

export async function promptNewProviderName(
	ctx: ExtensionCommandContext,
	prefix: string | undefined,
): Promise<string | null> {
	const suggestion = withProviderPrefix(prefix, "group");
	return ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) =>
			buildNamePrompt(
				tui as unknown as { requestRender(): void },
				theme as unknown as Theme,
				suggestion,
				done,
			),
		{ overlay: true, overlayOptions: { width: 80, maxHeight: "40%" } },
	);
}

function buildNamePrompt(
	tui: { requestRender(): void },
	theme: Theme,
	suggestion: string,
	done: (v: string | null) => void,
): Component & { handleInput(data: string): void } {
	const input = new Input();
	if (suggestion) input.setValue(suggestion);
	input.focused = true;
	let error: string | null = null;

	input.onSubmit = (raw) => {
		const v = raw.trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(v)) {
			error = "letters / digits / dot / dash / underscore only";
			tui.requestRender();
			return;
		}
		done(v);
	};
	input.onEscape = () => done(null);

	return {
		render(width: number): string[] {
			const inner = frameInner(width);
			const hint = suggestion
				? `name shown in /model picker, e.g. ${suggestion}`
				: "letters / digits / dot / dash / underscore";
			const inputLines = input.render(inner - 4);
			const lines: string[] = [
				"",
				` ${theme.fg("dim", hint)}`,
				"",
				...inputLines.map((ln) => ` ${theme.fg("accent", `\u276f ${ln}`)}`),
				"",
				error ? ` ${theme.fg("error", `! ${error}`)}` : "",
			];
			return frame(theme, {
				width,
				title: " new custom group ",
				lines,
				footer: { hint: " enter = create  \u00b7  esc = cancel " },
			});
		},
		invalidate(): void {
			input.invalidate();
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
				done(null);
				return;
			}
			error = null;
			input.handleInput(data);
			tui.requestRender();
		},
	};
}
