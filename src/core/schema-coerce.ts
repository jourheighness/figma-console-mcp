/**
 * Zod schema coercion helpers for MCP client compatibility.
 *
 * The MCP tool-calling interface passes all parameter values as XML text.
 * Some clients don't coerce values to their JSON Schema types before sending,
 * so numbers arrive as "100" (string) and arrays as "[{...}]" (JSON string).
 *
 * These helpers make Zod schemas accept string-encoded values gracefully.
 */

import { z } from "zod";

/**
 * Wrap a z.array() schema to accept JSON-string input.
 * Place .min()/.max() on the inner array; .optional()/.describe() on the result.
 *
 * @example
 *   jsonArray(z.array(z.object({ id: z.string() })).min(1).max(25))
 *     .optional()
 *     .describe("Operations to execute")
 */
export function jsonArray<T extends z.ZodArray<any, any>>(
	arraySchema: T,
): z.ZodEffects<T, z.output<T>, unknown> {
	return z.preprocess((v) => {
		if (typeof v === "string") {
			try {
				return JSON.parse(v);
			} catch {
				return v; // let Zod produce the validation error
			}
		}
		return v;
	}, arraySchema);
}

/**
 * Wrap a z.object() schema to accept JSON-string input.
 * For top-level object params that clients may serialize as strings.
 */
export function jsonObject<T extends z.ZodObject<any, any>>(
	objectSchema: T,
): z.ZodEffects<T, z.output<T>, unknown> {
	return z.preprocess((v) => {
		if (typeof v === "string") {
			try {
				return JSON.parse(v);
			} catch {
				return v;
			}
		}
		return v;
	}, objectSchema);
}

/**
 * Boolean schema that accepts string-encoded values ("true"/"false").
 *
 * z.coerce.boolean() is NOT safe — it uses Boolean() which treats any
 * non-empty string (including "false") as true. This helper only converts
 * the exact strings "true" and "false", passing everything else through
 * for normal Zod validation.
 *
 * @example
 *   coerceBool().optional().default(false).describe("Enable feature")
 */
export function coerceBool(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
	return z.preprocess((v) => {
		if (v === "true") return true;
		if (v === "false") return false;
		return v;
	}, z.boolean());
}

/**
 * Wrap a z.record() schema to accept JSON-string input and coerce
 * inner "true"/"false" string values to booleans.
 * For record params where values may be strings or booleans.
 */
export function jsonRecord<T extends z.ZodTypeAny>(
	valueSchema: T,
): z.ZodEffects<z.ZodRecord<z.ZodString, T>, Record<string, z.output<T>>, unknown> {
	return z.preprocess((v) => {
		if (typeof v === "string") {
			try {
				v = JSON.parse(v);
			} catch {
				return v;
			}
		}
		// Coerce "true"/"false" string values inside the record
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				if (val === "true") out[k] = true;
				else if (val === "false") out[k] = false;
				else out[k] = val;
			}
			return out;
		}
		return v;
	}, z.record(z.string(), valueSchema));
}
