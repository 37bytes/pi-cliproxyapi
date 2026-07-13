// First-run setup wizard: collects endpoint + apiKey + providerPrefix + (optional) usageKey
// and writes them to ~/.config/pi-cliproxyapi/config.json.
//
// All three fields support the same "!cmd" / "$ENV" / literal semantics as
// the rest of the config (see resolveConfigValue). For convenience the wizard
// also accepts a bare path starting with ~/ or / and wraps it into "!cat <path>".

import { existsSync } from "node:fs";
import { homedir } from "node:os";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Input,
	matchesKey,
} from "@earendil-works/pi-tui";

import {
	CONFIG_PATH,
	loadConfig,
	resolveConfigValue,
	saveConfig,
} from "./config.ts";
import { frame, frameInner } from "./ui-frame.ts";

interface Theme {
	fg(name: string, s: string): string;
	bold(s: string): string;
}

interface WizardStep {
	label: string;
	hint: string;
	required: boolean;
	initialValue?: string;
	validate?: (raw: string) => string | null;
}

const STEPS: WizardStep[] = [
	{
		label: "endpoint",
		hint: "OpenAI-style base URL of your CliProxyAPI deployment, must include /v1",
		required: true,
		validate: (raw) => {
			try {
				const u = new URL(raw);
				if (!u.pathname.endsWith("/v1")) return "must end with /v1";
				return null;
			} catch {
				return "not a valid URL";
			}
		},
	},
	{
		label: "apiKey",
		hint: "CliProxyAPI bearer key. Accepts literal, $ENV_VAR, !cmd, or ~/path",
		required: true,
	},
	{
		label: "providerPrefix",
		hint: "Prefix for your custom provider names. Suggested groups become <prefix>-glm, <prefix>-gemini, etc. Use any short slug (letters/digits/dashes).",
		required: true,
		validate: (raw) =>
			/^[a-z0-9][a-z0-9-]*$/i.test(raw) ? null : "letters/digits/dashes only",
	},
	{
		label: "usageKey",
		hint: "Optional X-Plugin-Key for /api/usage. Leave blank to skip the Usage tab",
		required: false,
	},
];

/**
 * Run the interactive setup wizard if no usable config exists.
 * Returns true when config was just saved (caller should reapply).
 */
export async function runSetupIfNeeded(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const cfg = loadConfig();
	const hasEndpoint = Boolean(cfg.proxy.endpoint);
	const hasResolvedKey = Boolean(resolveConfigValue(cfg.proxy.apiKey));
	if (hasEndpoint && hasResolvedKey) return false;
	if (!ctx.hasUI) return false;
	return runSetup(ctx, /*forceAll=*/ true);
}

/** Force-show the wizard from /cliproxy-setup regardless of current config. */
export async function runSetup(
	ctx: ExtensionCommandContext,
	forceAll = false,
): Promise<boolean> {
	const existing = loadConfig();
	const values: Record<string, string> = {
		endpoint: existing.proxy.endpoint ?? "",
		apiKey: existing.proxy.apiKey ?? "",
		providerPrefix: existing.proxy.providerPrefix ?? "",
		usageKey: existing.proxy.usageKey ?? "",
	};

	let cancelled = false;
	for (const step of STEPS) {
		const prefill = forceAll
			? (values[step.label] ?? step.initialValue ?? "")
			: (values[step.label] ?? "");
		if (!forceAll && prefill) {
			continue;
		}
		const result = await promptStep(
			ctx,
			step,
			prefill || step.initialValue || "",
		);
		if (result === undefined) {
			cancelled = true;
			break;
		}
		const trimmed = result.trim();
		if (!trimmed) {
			if (step.required) {
				ctx.ui.notify(`${step.label} is required \u2014 aborted`, "warning");
				cancelled = true;
				break;
			}
			values[step.label] = "";
			continue;
		}
		values[step.label] =
			step.label === "providerPrefix" || step.label === "endpoint"
				? trimmed
				: normalizeValue(trimmed);
	}

	if (cancelled) return false;

	const next = { ...existing };
	next.proxy = {
		...existing.proxy,
		endpoint: values.endpoint ?? "",
		apiKey: values.apiKey ?? "",
		providerPrefix: values.providerPrefix ?? "",
	};
	if (values.usageKey) next.proxy.usageKey = values.usageKey;
	else delete next.proxy.usageKey;

	saveConfig(next);
	ctx.ui.notify(`saved to ${CONFIG_PATH}`, "info");
	return true;
}

function normalizeValue(raw: string): string {
	if (raw.startsWith("!") || raw.startsWith("$")) return raw;
	if (raw.startsWith("~/")) {
		const expanded = raw.replace(/^~/, homedir());
		return existsSync(expanded) ? `!cat ${raw}` : raw;
	}
	if (raw.startsWith("/")) {
		return existsSync(raw) ? `!cat ${raw}` : raw;
	}
	return raw;
}

// --------------------------------------------------------------------------- step prompt

async function promptStep(
	ctx: ExtensionCommandContext,
	step: WizardStep,
	prefill: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) =>
			buildStepOverlay(
				tui as unknown as {
					requestRender(): void;
					rows?: number;
					cols?: number;
				},
				theme as unknown as Theme,
				step,
				prefill,
				done,
			),
		{ overlay: true, overlayOptions: { width: 100, maxHeight: "60%" } },
	);
}

function buildStepOverlay(
	tui: { requestRender(): void; rows?: number; cols?: number },
	theme: Theme,
	step: WizardStep,
	prefill: string,
	done: (v: string | undefined) => void,
): Component & { handleInput(data: string): void } {
	const input = new Input();
	input.setValue(prefill);
	input.focused = true;
	let error: string | null = null;

	const submit = (raw: string): void => {
		if (!raw && !step.required) {
			done("");
			return;
		}
		if (!raw && step.required) {
			error = "required field";
			tui.requestRender();
			return;
		}
		if (step.validate) {
			const trimmed = raw.trim();
			if (trimmed && !trimmed.startsWith("!") && !trimmed.startsWith("$")) {
				const err = step.validate(trimmed);
				if (err) {
					error = err;
					tui.requestRender();
					return;
				}
			}
		}
		done(raw);
	};

	input.onSubmit = submit;
	input.onEscape = () => done(undefined);

	return {
		render(width: number): string[] {
			const inner = frameInner(width);
			const inputLines = input.render(inner - 4);
			const lines: string[] = [
				"",
				` ${theme.fg("dim", step.hint)}`,
				"",
				...inputLines.map((ln) => ` ${theme.fg("accent", `\u276f ${ln}`)}`),
				"",
				error
					? ` ${theme.fg("error", `! ${error}`)}`
					: ` ${theme.fg("dim", "enter = save  \u00b7  esc = cancel")}`,
			];
			return frame(theme, {
				width,
				title: ` setup: ${step.label} `,
				lines,
				footer: { hint: " enter = save  \u00b7  esc = cancel " },
			});
		},
		invalidate(): void {
			input.invalidate();
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
				done(undefined);
				return;
			}
			error = null;
			input.handleInput(data);
			tui.requestRender();
		},
	};
}
