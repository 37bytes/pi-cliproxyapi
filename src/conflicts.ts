// Conflicts: read-only scan of Pi's own ~/.pi/models.json and ~/.pi/auth.json
// to warn when an extension-registered provider collides with a user-edited
// entry that Pi merges on top. We never write to these files.
//
// Both files are entirely optional (users might never touch them). Missing or
// malformed → no warnings.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProxyConfig } from "./config.ts";

export interface ConflictWarning {
	kind: "models.json" | "auth.json";
	provider: string;
	detail: string;
}

const MODELS_JSON = join(homedir(), ".pi", "models.json");
const AUTH_JSON = join(homedir(), ".pi", "auth.json");

function safeRead(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function detectConflicts(cfg: ProxyConfig): ConflictWarning[] {
	const out: ConflictWarning[] = [];
	const providersInCfg = new Set<string>([
		...Object.keys(cfg.builtinProviders),
		...Object.keys(cfg.customProviders),
	]);

	const models = safeRead(MODELS_JSON);
	if (models && typeof models === "object") {
		for (const name of Object.keys(models as Record<string, unknown>)) {
			if (providersInCfg.has(name)) {
				out.push({
					kind: "models.json",
					provider: name,
					detail: `provider "${name}" has user overrides in ~/.pi/models.json which Pi merges on top of our registration`,
				});
			}
		}
	}

	const auth = safeRead(AUTH_JSON);
	if (auth && typeof auth === "object") {
		for (const name of Object.keys(auth as Record<string, unknown>)) {
			if (providersInCfg.has(name)) {
				out.push({
					kind: "auth.json",
					provider: name,
					detail: `provider "${name}" has user-set credentials in ~/.pi/auth.json which take priority over our apiKey`,
				});
			}
		}
	}

	return out;
}
