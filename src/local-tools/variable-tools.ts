/**
 * Variable and collection mutation tools — variable_operation, batch_variables.
 * All operate via Desktop Bridge connector.
 */

import { z } from "zod";
import { createChildLogger } from "../core/logger.js";
import { sendProgress } from "../core/progress.js";
import type { LocalToolDeps } from "./types.js";

const logger = createChildLogger({ component: "variable-tools" });

export function registerVariableTools(deps: LocalToolDeps): void {
	const { server, getDesktopConnector, variablesCache } = deps;

	// Tool: Consolidated variable/collection mutation
	server.tool(
		"figma_variable_operation",
		`Perform a single variable or collection mutation. For bulk operations (10+ items), prefer figma_batch_variables instead (10-50x faster).

Actions:
- update_value: Update a variable's value in a specific mode. Requires: variableId, modeId, value.
- create: Create a new variable. Requires: name, collectionId, resolvedType. Optional: description, valuesByMode.
- create_collection: Create an empty collection. Requires: name. Optional: initialModeName, additionalModes.
- delete: Delete a variable (destructive). Requires: variableId.
- delete_collection: Delete a collection and ALL its variables (destructive). Requires: collectionId.
- rename: Rename a variable. Requires: variableId, newName.
- add_mode: Add a mode to a collection. Requires: collectionId, modeName.
- rename_mode: Rename a mode. Requires: collectionId, modeId, newName.

Requires Desktop Bridge plugin. Use figma_get_variables first to get IDs.`,
		{
			action: z.enum(["update_value", "create", "create_collection", "delete", "delete_collection", "rename", "add_mode", "rename_mode"])
				.describe("The variable operation to perform"),
			variableId: z.string().optional()
				.describe("Variable ID (for update_value, delete, rename). E.g. 'VariableID:123:456'"),
			collectionId: z.string().optional()
				.describe("Collection ID (for create, create_collection, delete_collection, add_mode, rename_mode)"),
			modeId: z.string().optional()
				.describe("Mode ID (for update_value, rename_mode)"),
			value: z.union([z.string(), z.number(), z.boolean()]).optional()
				.describe("Value for update_value. COLOR: hex '#FF0000', FLOAT: number, STRING: text, BOOLEAN: true/false"),
			name: z.string().optional()
				.describe("Name for create or create_collection"),
			newName: z.string().optional()
				.describe("New name for rename or rename_mode"),
			modeName: z.string().optional()
				.describe("Mode name for add_mode"),
			resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).optional()
				.describe("Variable type (create only)"),
			description: z.string().optional()
				.describe("Variable description (create only)"),
			valuesByMode: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
				.describe("Initial values by mode ID (create only). E.g. { '1:0': '#FF0000' }"),
			initialModeName: z.string().optional()
				.describe("Name for initial mode (create_collection only)"),
			additionalModes: z.array(z.string()).optional()
				.describe("Additional mode names (create_collection only)"),
		},
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		async ({ action, variableId, collectionId, modeId, value, name, newName, modeName, resolvedType, description, valuesByMode, initialModeName, additionalModes }) => {
			const errorResponse = (msg: string) => ({
				content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
				isError: true as const,
			});

			try {
				const connector = await getDesktopConnector();

				switch (action) {
					case "update_value": {
						if (!variableId || !modeId || value === undefined) return errorResponse("update_value requires variableId, modeId, and value");
						const result = await connector.updateVariable(variableId, modeId, value);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Variable "${result.variable.name}" updated successfully`,
									variable: result.variable,
								}),
							}],
						};
					}
					case "create": {
						if (!name || !collectionId || !resolvedType) return errorResponse("create requires name, collectionId, and resolvedType");
						const result = await connector.createVariable(name, collectionId, resolvedType, { description, valuesByMode });
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Variable "${name}" created successfully`,
									variable: result.variable,
								}),
							}],
						};
					}
					case "create_collection": {
						if (!name) return errorResponse("create_collection requires name");
						const result = await connector.createVariableCollection(name, { initialModeName, additionalModes });
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Collection "${name}" created successfully`,
									collection: result.collection,
								}),
							}],
						};
					}
					case "delete": {
						if (!variableId) return errorResponse("delete requires variableId");
						const result = await connector.deleteVariable(variableId);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Variable "${result.deleted.name}" deleted successfully`,
									deleted: result.deleted,
									warning: "This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
								}),
							}],
						};
					}
					case "delete_collection": {
						if (!collectionId) return errorResponse("delete_collection requires collectionId");
						const result = await connector.deleteVariableCollection(collectionId);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Collection "${result.deleted.name}" and ${result.deleted.variableCount} variables deleted successfully`,
									deleted: result.deleted,
									warning: "This action cannot be undone programmatically. Use Figma's Edit > Undo if needed.",
								}),
							}],
						};
					}
					case "rename": {
						if (!variableId || !newName) return errorResponse("rename requires variableId and newName");
						const result = await connector.renameVariable(variableId, newName);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Variable renamed from "${result.oldName}" to "${result.variable.name}"`,
									oldName: result.oldName,
									variable: result.variable,
								}),
							}],
						};
					}
					case "add_mode": {
						if (!collectionId || !modeName) return errorResponse("add_mode requires collectionId and modeName");
						const result = await connector.addMode(collectionId, modeName);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Mode "${modeName}" added to collection "${result.collection.name}"`,
									newMode: result.newMode,
									collection: result.collection,
								}),
							}],
						};
					}
					case "rename_mode": {
						if (!collectionId || !modeId || !newName) return errorResponse("rename_mode requires collectionId, modeId, and newName");
						const result = await connector.renameMode(collectionId, modeId, newName);
						variablesCache.clear();
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({
									success: true,
									message: `Mode renamed from "${result.oldName}" to "${newName}"`,
									oldName: result.oldName,
									collection: result.collection,
								}),
							}],
						};
					}
				}
			} catch (error) {
				logger.error({ error }, `Failed variable operation: ${action}`);
				return errorResponse(error instanceof Error ? error.message : String(error));
			}
		},
	);

	// Tool: Batch variable operations (create or update)
	server.tool(
		"figma_batch_variables",
		`Create, update, or set up complete variable structures — up to 50x faster than individual calls. Requires Desktop Bridge plugin.

Actions:
- create: Add variables to existing collection. Provide collectionId + variables array with name, resolvedType, optional valuesByMode (keyed by mode ID).
- update: Modify existing variable values. Provide updates array with variableId, modeId, value.
- setup: Create a complete token structure from scratch — collection, modes, and all variables in one atomic operation. Ideal for importing CSS custom properties or design tokens. Provide collectionName + modes + tokens array with values keyed by mode NAME.`,
		{
			action: z.enum(["create", "update", "setup"]).describe("Batch operation type"),
			collectionId: z.string().optional().describe("Collection ID (required for create)"),
			variables: z
				.array(
					z.object({
						name: z.string().describe("Variable name"),
						resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).describe("Variable type"),
						description: z.string().optional(),
						valuesByMode: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
							.describe("Values by mode ID. COLOR: hex '#FF0000'. Example: { '1:0': '#FF0000' }"),
					}),
				)
				.min(1).max(100).optional()
				.describe("Variables to create (for action='create', 1-100)"),
			updates: z
				.array(
					z.object({
						variableId: z.string().describe("Variable ID"),
						modeId: z.string().describe("Mode ID"),
						value: z.union([z.string(), z.number(), z.boolean()])
							.describe("New value. COLOR: hex. FLOAT: number. STRING: text. BOOLEAN: true/false."),
					}),
				)
				.min(1).max(100).optional()
				.describe("Updates to apply (for action='update', 1-100)"),
			collectionName: z.string().optional().describe("Name for the new collection (required for setup, e.g., 'Brand Tokens')"),
			modes: z.array(z.string()).min(1).max(4).optional().describe("Mode names for setup (first becomes default). Example: ['Light', 'Dark']"),
			tokens: z
				.array(
					z.object({
						name: z.string().describe("Token name (e.g., 'color/primary')"),
						resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).describe("Token type"),
						description: z.string().optional().describe("Optional description"),
						values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
							.describe("Values keyed by mode NAME (not ID). Example: { 'Light': '#FFFFFF', 'Dark': '#000000' }"),
					}),
				)
				.min(1).max(100).optional()
				.describe("Token definitions for setup (1-100)"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ action, collectionId, variables, updates, collectionName, modes, tokens }, extra) => {
			try {
				const connector = await getDesktopConnector();
				let script: string;
				let itemCount: number;

				if (action === "create") {
					if (!collectionId) throw new Error("collectionId is required for create");
					if (!variables || variables.length === 0) throw new Error("variables array is required for create");
					itemCount = variables.length;
					await sendProgress(extra, 0, 3, "Preparing batch create...");

					script = `
const results = [];
const collectionId = ${JSON.stringify(collectionId)};
const vars = ${JSON.stringify(variables)};
function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return { r: parseInt(hex.substring(0, 2), 16) / 255, g: parseInt(hex.substring(2, 4), 16) / 255, b: parseInt(hex.substring(4, 6), 16) / 255, a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1 };
}
const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
if (!collection) return { created: 0, failed: vars.length, results: vars.map(v => ({ success: false, name: v.name, error: 'Collection not found: ' + collectionId })) };
for (const v of vars) {
  try {
    const variable = figma.variables.createVariable(v.name, collection, v.resolvedType);
    if (v.description) variable.description = v.description;
    if (v.valuesByMode) { for (const [modeId, value] of Object.entries(v.valuesByMode)) { const processed = v.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value; variable.setValueForMode(modeId, processed); } }
    results.push({ success: true, name: v.name, id: variable.id });
  } catch (err) { results.push({ success: false, name: v.name, error: String(err) }); }
}
return { created: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };`;
				} else if (action === "update") {
					if (!updates || updates.length === 0) throw new Error("updates array is required for update");
					itemCount = updates.length;
					await sendProgress(extra, 0, 3, "Preparing batch update...");

					script = `
const results = [];
const updates = ${JSON.stringify(updates)};
function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return { r: parseInt(hex.substring(0, 2), 16) / 255, g: parseInt(hex.substring(2, 4), 16) / 255, b: parseInt(hex.substring(4, 6), 16) / 255, a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1 };
}
for (const u of updates) {
  try {
    const variable = await figma.variables.getVariableByIdAsync(u.variableId);
    if (!variable) throw new Error('Variable not found: ' + u.variableId);
    const isColor = variable.resolvedType === 'COLOR';
    const processed = isColor && typeof u.value === 'string' ? hexToRgba(u.value) : u.value;
    variable.setValueForMode(u.modeId, processed);
    results.push({ success: true, variableId: u.variableId, name: variable.name });
  } catch (err) { results.push({ success: false, variableId: u.variableId, error: String(err) }); }
}
return { updated: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };`;
				} else {
					// action === "setup" — create collection + modes + variables atomically
					if (!collectionName) throw new Error("collectionName is required for setup");
					if (!modes || modes.length === 0) throw new Error("modes array is required for setup");
					if (!tokens || tokens.length === 0) throw new Error("tokens array is required for setup");
					itemCount = tokens.length;
					await sendProgress(extra, 0, 3, "Preparing design token structure...");

					script = `
const collectionName = ${JSON.stringify(collectionName)};
const modeNames = ${JSON.stringify(modes)};
const tokenDefs = ${JSON.stringify(tokens)};

function hexToRgba(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16) / 255,
    g: parseInt(hex.substring(2, 4), 16) / 255,
    b: parseInt(hex.substring(4, 6), 16) / 255,
    a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1
  };
}

// Step 1: Create collection
const collection = figma.variables.createVariableCollection(collectionName);
const modeMap = {};

// Step 2: Set up modes - first mode uses the default mode that was auto-created
const defaultModeId = collection.modes[0].modeId;
collection.renameMode(defaultModeId, modeNames[0]);
modeMap[modeNames[0]] = defaultModeId;

for (let i = 1; i < modeNames.length; i++) {
  const newModeId = collection.addMode(modeNames[i]);
  modeMap[modeNames[i]] = newModeId;
}

// Step 3: Create all variables with values
const results = [];
for (const t of tokenDefs) {
  try {
    const variable = figma.variables.createVariable(t.name, collection, t.resolvedType);
    if (t.description) variable.description = t.description;
    for (const [modeName, value] of Object.entries(t.values)) {
      const modeId = modeMap[modeName];
      if (!modeId) { results.push({ success: false, name: t.name, error: 'Unknown mode: ' + modeName }); continue; }
      const processed = t.resolvedType === 'COLOR' && typeof value === 'string' ? hexToRgba(value) : value;
      variable.setValueForMode(modeId, processed);
    }
    results.push({ success: true, name: t.name, id: variable.id });
  } catch (err) {
    results.push({ success: false, name: t.name, error: String(err) });
  }
}

return {
  collectionId: collection.id,
  collectionName: collectionName,
  modes: modeMap,
  created: results.filter(r => r.success).length,
  failed: results.filter(r => !r.success).length,
  results
};`;
				}

				const timeout = action === "setup"
					? Math.max(10000, itemCount * 200 + (modes?.length ?? 0) * 500)
					: Math.max(5000, itemCount * 200);
				const progressLabel = action === "create" ? "variables" : action === "update" ? "updates" : "tokens";
				await sendProgress(extra, 1, 3, `Executing in Figma (${itemCount} ${progressLabel})...`);
				const result = await connector.executeCodeViaUI(script, Math.min(timeout, 30000));

				if (result.error) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: result.error, message: `Batch ${action} failed` }) }],
						isError: true,
					};
				}

				variablesCache.clear();
				await sendProgress(extra, 3, 3, `Batch ${action} complete`);

				if (action === "setup") {
					return {
						content: [{ type: "text", text: JSON.stringify({
							success: true,
							message: `Created collection "${collectionName}" with ${modes!.length} mode(s) and ${result.result?.created ?? 0} tokens`,
							...result.result,
						}) }],
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ success: true, message: `Batch ${action}: ${JSON.stringify(result.result)}`, ...result.result }) }],
				};
			} catch (error) {
				logger.error({ error }, `Failed to batch ${action} variables`);
				return {
					content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
		},
	);
}
