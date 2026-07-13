// Models view — the three-panel picker, rewritten as a body-only hub view.
//
//   \u2502 providers      \u2502 assigned to <prov> \u2502
//   \u2502 list \u2026         \u251c\u2500 available pool \u2500\u2500\u2524
//   \u2502                \u2502 grouped by owned_by \u2502
//
// Bug fix vs. the old picker: navigation + activation index the pool through a
// SINGLE ordering (poolDisplayOrder = flatten(groupPoolByOwnedBy(poolFor))),
// the exact order the renderer iterates. The highlighted row therefore always
// maps to the model that gets toggled.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { buildCatalog } from "../ui-picker/catalog.ts";
import {
	apiCompatible,
	assignedIdsFor,
	attachModel,
	detachModel,
	filterModelIds,
	groupPoolByOwnedBy,
	poolFor,
} from "../ui-picker/mutate.ts";
import { collectProviders } from "../ui-picker/providers.ts";
import { confirmRemoveProvider } from "../ui-picker/prompt-confirm.ts";
import { promptNewProviderName } from "../ui-picker/prompt-name.ts";
import { pad } from "../ui-picker/render-text.ts";
import {
	renderEmpty,
	renderModelRow,
	renderNewProviderRow,
	renderPanelHeader,
	renderProviderRow,
	renderSubheader,
} from "../ui-picker/rows.ts";
import type {
	CatalogIndex,
	OverlayTui,
	PanelId,
	ProviderEntry,
	Theme,
} from "../ui-picker/types.ts";
import { clampScroll, takeSlice, visibleWidth } from "./shell.ts";
import type { HubView } from "./types.ts";

export interface ModelsViewDeps {
	tui: OverlayTui;
	theme: Theme;
	ctx: ExtensionCommandContext;
	cfg: ProxyConfig;
	getDiscovery: () => Discovery;
	/** Called whenever the user mutates the config (attach/detach/new/delete). */
	onChange?: () => void;
}

export interface ModelsView extends HubView {
	/** Rebuild catalog + provider list after a discovery refresh. */
	rebuild(): void;
}

export function buildModelsView(deps: ModelsViewDeps): ModelsView {
	const { tui, theme, ctx, cfg } = deps;
	const onChange = deps.onChange ?? ((): void => {});

	let catalog: CatalogIndex = buildCatalog(deps.getDiscovery());
	let providers: ProviderEntry[] = collectProviders(cfg, catalog);

	let focus: PanelId = "providers";
	let providerCursor = 0;
	let assignedCursor = 0;
	let poolCursor = 0;
	let providerScroll = 0;
	let assignedScroll = 0;
	let poolScroll = 0;

	let filter = "";
	let filterEditing = false;

	const selectedProvider = (): ProviderEntry | null => {
		if (providers.length === 0) return null;
		const idx = Math.max(0, Math.min(providerCursor, providers.length - 1));
		return providers[idx] ?? null;
	};

	// ----- pool ordering (single source of truth) ---------------------------
	const poolGroups = (
		prov: ProviderEntry,
	): Array<{ label: string; ids: string[] }> => {
		const ids = filterModelIds(poolFor(cfg, prov, catalog), catalog, filter);
		return groupPoolByOwnedBy(ids, catalog);
	};
	const poolOrder = (prov: ProviderEntry): string[] =>
		poolGroups(prov).flatMap((g) => g.ids);

	const refresh = (): void => {
		providers = collectProviders(cfg, catalog);
		const maxProv = Math.max(0, providers.length); // +1 "new" row
		if (providerCursor > maxProv) providerCursor = maxProv;
		const prov = selectedProvider();
		if (prov) {
			const aLen = assignedIdsFor(cfg, prov).length;
			const pLen = poolOrder(prov).length;
			if (assignedCursor >= aLen) assignedCursor = Math.max(0, aLen - 1);
			if (poolCursor >= pLen) poolCursor = Math.max(0, pLen - 1);
		}
	};

	const rebuild = (): void => {
		catalog = buildCatalog(deps.getDiscovery());
		refresh();
	};

	// ----- navigation -------------------------------------------------------
	const onTab = (back: boolean): void => {
		const order: PanelId[] = ["providers", "assigned", "pool"];
		const i = order.indexOf(focus);
		focus = back
			? order[(i - 1 + order.length) % order.length]!
			: order[(i + 1) % order.length]!;
	};

	const moveCursor = (delta: number): void => {
		if (focus === "providers") {
			const total = providers.length + 1; // +1 "new" row
			providerCursor = Math.max(0, Math.min(providerCursor + delta, total - 1));
			return;
		}
		const prov = selectedProvider();
		if (!prov) return;
		if (focus === "assigned") {
			const total = assignedIdsFor(cfg, prov).length;
			if (total === 0) return;
			assignedCursor = Math.max(0, Math.min(assignedCursor + delta, total - 1));
			return;
		}
		const total = poolOrder(prov).length;
		if (total === 0) return;
		poolCursor = Math.max(0, Math.min(poolCursor + delta, total - 1));
	};

	const onActivate = async (): Promise<void> => {
		if (focus === "providers") {
			if (providerCursor === providers.length) {
				const name = await promptNewProviderName(ctx, cfg.proxy.providerPrefix);
				if (name && !cfg.customProviders[name]) {
					cfg.customProviders[name] = { api: "openai-completions", models: [] };
					onChange();
					refresh();
					providerCursor = providers.findIndex(
						(p) => p.kind === "custom" && p.name === name,
					);
					if (providerCursor < 0) providerCursor = providers.length - 1;
					focus = "pool";
				}
				tui.requestRender();
				return;
			}
			focus = "pool";
			return;
		}
		const prov = selectedProvider();
		if (!prov) return;
		if (focus === "assigned") {
			const id = assignedIdsFor(cfg, prov)[assignedCursor];
			if (!id) return;
			detachModel(cfg, prov, id);
			onChange();
			refresh();
			return;
		}
		const id = poolOrder(prov)[poolCursor];
		if (!id) return;
		const m = catalog.byId.get(id);
		if (!m) return;
		attachModel(cfg, prov, m);
		onChange();
		refresh();
	};

	const onDelete = async (): Promise<void> => {
		if (focus !== "providers") return;
		const prov = selectedProvider();
		if (!prov || prov.kind !== "custom") return;
		const ok = await confirmRemoveProvider(ctx, prov.name);
		if (!ok) {
			tui.requestRender();
			return;
		}
		delete cfg.customProviders[prov.name];
		onChange();
		refresh();
		if (providerCursor >= providers.length)
			providerCursor = Math.max(0, providers.length - 1);
		tui.requestRender();
	};

	// ----- render -----------------------------------------------------------
	const render = (width: number, height: number): string[] =>
		renderBody(width, height);

	function renderBody(width: number, height: number): string[] {
		const inner = Math.max(70, width);
		const leftW = Math.min(56, Math.max(34, Math.floor(inner * 0.4)));
		const rightW = inner - leftW - 1; // -1 for the vertical splitter
		const bodyH = Math.max(8, height);
		const upperH = Math.max(5, Math.floor((bodyH - 1) / 2));
		const lowerH = bodyH - upperH;

		const prov = selectedProvider();

		let leftCursorLine = 0;
		let leftCursorTop = 0;
		let assignedCursorLine = 0;
		let assignedCursorTop = 0;
		let poolCursorLine = 0;
		let poolCursorTop = 0;

		// LEFT — providers
		const leftLines: string[] = [];
		leftLines.push(panelHeaderBar(" providers ", leftW, focus === "providers"));
		for (let i = 0; i < providers.length; i++) {
			const p = providers[i]!;
			const isCursor = focus === "providers" && i === providerCursor;
			if (isCursor) {
				leftCursorLine = leftLines.length;
				leftCursorTop = leftCursorLine;
			}
			leftLines.push(
				renderProviderRow(p, cfg, {
					theme,
					width: leftW,
					isCursor,
					isFocused: focus === "providers",
				}),
			);
		}
		{
			const isCursor =
				focus === "providers" && providerCursor === providers.length;
			if (isCursor) {
				leftCursorLine = leftLines.length;
				leftCursorTop = leftCursorLine;
			}
			leftLines.push(
				renderNewProviderRow(theme, isCursor, focus === "providers", leftW),
			);
		}

		// RIGHT TOP — assigned
		const assignedLines: string[] = [];
		const assignedHeader = prov
			? `assigned to ${theme.bold(prov.name)}  ${theme.fg("dim", `\u00b7 ${prov.api}`)}`
			: theme.fg("dim", "no provider selected");
		assignedLines.push(
			panelHeaderBar(" assigned ", rightW, focus === "assigned"),
		);
		assignedLines.push(
			renderPanelHeader(theme, assignedHeader, rightW, focus === "assigned"),
		);
		if (prov) {
			const ids = assignedIdsFor(cfg, prov);
			if (ids.length === 0)
				assignedLines.push(
					renderEmpty(theme, "(nothing assigned yet)", rightW),
				);
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]!;
				const m = catalog.byId.get(id);
				const isCursor = focus === "assigned" && i === assignedCursor;
				if (isCursor) {
					assignedCursorLine = assignedLines.length;
					assignedCursorTop = assignedCursorLine;
				}
				const compatWarn = m ? !apiCompatible(prov.api, m.suggestedApi) : false;
				assignedLines.push(
					renderModelRow(id, m, "assigned", compatWarn, {
						theme,
						width: rightW,
						isCursor,
						isFocused: focus === "assigned",
					}),
				);
			}
		}

		// RIGHT BOTTOM — pool, grouped by ownedBy
		const poolLines: string[] = [];
		poolLines.push(poolHeaderBar(rightW, focus === "pool"));
		if (prov) {
			const groups = poolGroups(prov);
			const flatCount = groups.reduce((n, g) => n + g.ids.length, 0);
			if (flatCount === 0) {
				poolLines.push(
					renderEmpty(
						theme,
						filter ? `(no matches for "${filter}")` : "(no models available)",
						rightW,
					),
				);
			} else {
				let cursorIdx = 0;
				for (const grp of groups) {
					const groupHeaderLine = poolLines.length;
					poolLines.push(renderSubheader(theme, grp.label, rightW));
					for (let gi = 0; gi < grp.ids.length; gi++) {
						const id = grp.ids[gi]!;
						const m = catalog.byId.get(id);
						const isCursor = focus === "pool" && cursorIdx === poolCursor;
						if (isCursor) {
							poolCursorLine = poolLines.length;
							poolCursorTop = gi === 0 ? groupHeaderLine : poolCursorLine;
						}
						const compatWarn = m
							? !apiCompatible(prov.api, m.suggestedApi)
							: false;
						poolLines.push(
							renderModelRow(id, m, "pool", compatWarn, {
								theme,
								width: rightW,
								isCursor,
								isFocused: focus === "pool",
							}),
						);
						cursorIdx++;
					}
				}
			}
		}

		// scroll
		const poolUsableH = Math.max(1, lowerH - 1); // -1 horizontal divider
		const leftScroll = clampScroll(
			leftCursorTop,
			leftCursorLine,
			providerScroll,
			bodyH,
			leftLines.length,
			1,
		);
		const aScroll = clampScroll(
			focus === "assigned" ? assignedCursorTop : 0,
			focus === "assigned" ? assignedCursorLine : 0,
			assignedScroll,
			upperH,
			assignedLines.length,
			2,
		);
		const pScroll = clampScroll(
			focus === "pool" ? poolCursorTop : 0,
			focus === "pool" ? poolCursorLine : 0,
			poolScroll,
			poolUsableH,
			poolLines.length,
			1,
		);
		providerScroll = leftScroll;
		assignedScroll = aScroll;
		poolScroll = pScroll;

		const leftSlice = takeSlice(leftLines, leftScroll, bodyH);
		const aSlice = takeSlice(assignedLines, aScroll, upperH);
		const pSlice = takeSlice(poolLines, pScroll, lowerH);

		const vsplit = theme.fg("borderAccent", "\u2502");
		const out: string[] = [];
		for (let i = 0; i < bodyH; i++) {
			const l = pad(leftSlice[i] ?? "", leftW);
			const rRaw = i < upperH ? aSlice[i]! : pSlice[i - upperH]!;
			const r = pad(rRaw, rightW);
			out.push(`${l}${vsplit}${r}`);
		}
		const divIdx = upperH;
		if (divIdx > 0 && divIdx < bodyH) {
			const left = pad(leftSlice[divIdx] ?? "", leftW);
			const horiz = theme.fg("borderAccent", "\u2500".repeat(rightW));
			out[divIdx] = `${left}${vsplit}${horiz}`;
		}
		return out;
	}

	function panelHeaderBar(
		label: string,
		width: number,
		isFocused: boolean,
	): string {
		const bar = isFocused
			? theme.bold(theme.fg("accent", label))
			: theme.fg("muted", label);
		const fill = theme.fg(
			"borderAccent",
			"\u2500".repeat(Math.max(0, width - visibleWidth(label) - 1)),
		);
		return pad(`${bar}${fill}`, width);
	}

	function poolHeaderBar(width: number, isFocused: boolean): string {
		const label = " available pool ";
		const bar = isFocused
			? theme.bold(theme.fg("accent", label))
			: theme.fg("muted", label);
		let filterChip = "";
		if (filterEditing) {
			filterChip = `${theme.fg("dim", " /")}${theme.fg("accent", filter)}${theme.fg("accent", "\u2588")} `;
		} else if (filter) {
			filterChip = `${theme.fg("dim", " /")}${theme.fg("warning", filter)} `;
		}
		const used = visibleWidth(label) + visibleWidth(filterChip);
		const fill = theme.fg(
			"borderAccent",
			"\u2500".repeat(Math.max(0, width - used - 1)),
		);
		return pad(`${bar}${filterChip}${fill}`, width);
	}

	// ----- input ------------------------------------------------------------
	function handleInput(data: string): boolean | Promise<boolean> {
		// Filter editing captures text first.
		if (filterEditing) {
			if (matchesKey(data, "escape")) {
				filter = "";
				filterEditing = false;
				poolCursor = 0;
				return true;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				filterEditing = false;
				return true;
			}
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
				filter = filter.slice(0, -1);
				poolCursor = 0;
				return true;
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				filter += data;
				poolCursor = 0;
				return true;
			}
			return true; // swallow everything while editing
		}

		if (matchesKey(data, "tab")) {
			onTab(false);
			return true;
		}
		if (matchesKey(data, "shift+tab")) {
			onTab(true);
			return true;
		}
		if (matchesKey(data, "/")) {
			focus = "pool";
			filterEditing = true;
			return true;
		}
		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space")
		) {
			return onActivate().then(() => true);
		}
		if (
			focus === "providers" &&
			(matchesKey(data, "d") ||
				matchesKey(data, "delete") ||
				matchesKey(data, "backspace"))
		) {
			return onDelete().then(() => true);
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			moveCursor(-1);
			return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			moveCursor(1);
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
			moveCursor(-8);
			return true;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
			moveCursor(8);
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			focus = "providers";
			return true;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			if (focus === "providers") focus = "assigned";
			else if (focus === "assigned") focus = "pool";
			return true;
		}
		return false;
	}

	function footerHint(): string {
		if (filterEditing)
			return " type to filter \u00b7 \u21b5 apply \u00b7 esc clear ";
		return " tab \u2194 panel \u00b7 \u2191\u2193 nav \u00b7 \u21b5 move \u00b7 / filter \u00b7 d remove group ";
	}

	return {
		id: "models",
		label: "Models",
		render,
		handleInput,
		footerHint,
		rebuild,
	};
}
