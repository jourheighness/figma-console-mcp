/**
 * Component and design system tools — find_components, instantiate_component,
 * component_property, arrange_component_set, combine_as_variants, get_library_components.
 */

import { z } from "zod";
import { jsonArray, jsonObject, coerceBool } from "../core/schema-coerce.js";
import { extractFileKey } from "../core/figma-api.js";
import { createChildLogger } from "../core/logger.js";
import type { LocalToolDeps } from "./types.js";

const logger = createChildLogger({ component: "component-tools" });

export function registerComponentTools(deps: LocalToolDeps): void {
	const { server, getFigmaAPI, getCurrentUrl, getDesktopConnector, projectContextCache, teamLibraryCache, designSystems, variablesCache } = deps;

	// Helper function to ensure design system cache is loaded (auto-loads if needed)
	const ensureDesignSystemCache = async (): Promise<{
		cacheEntry: any;
		fileKey: string;
		wasLoaded: boolean;
	}> => {
		const {
			DesignSystemManifestCache,
			createEmptyManifest,
			figmaColorToHex,
		} = await import("../core/design-system-manifest.js");

		const cache = DesignSystemManifestCache.getInstance();
		const currentUrl = getCurrentUrl();
		const fileKeyMatch = currentUrl?.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
		const fileKey = fileKeyMatch ? fileKeyMatch[2] : "unknown";

		// Check cache first
		let cacheEntry = cache.get(fileKey);
		if (cacheEntry) {
			return { cacheEntry, fileKey, wasLoaded: false };
		}

		// Need to extract fresh data - do this silently without returning an error
		logger.info({ fileKey }, "Auto-loading design system cache");
		const connector = await getDesktopConnector();
		const manifest = createEmptyManifest(fileKey);
		manifest.fileUrl = currentUrl || undefined;

		// Get variables (tokens)
		try {
			const variablesResult = await connector.getVariables(fileKey);
			if (variablesResult.success && variablesResult.data) {
				for (const collection of variablesResult.data.variableCollections ||
					[]) {
					manifest.collections.push({
						id: collection.id,
						name: collection.name,
						modes: collection.modes.map((m: any) => ({
							modeId: m.modeId,
							name: m.name,
						})),
						defaultModeId: collection.defaultModeId,
					});
				}
				for (const variable of variablesResult.data.variables || []) {
					const tokenName = variable.name;
					const defaultModeId = manifest.collections.find(
						(c: any) => c.id === variable.variableCollectionId,
					)?.defaultModeId;
					const defaultValue = defaultModeId
						? variable.valuesByMode?.[defaultModeId]
						: undefined;

					if (variable.resolvedType === "COLOR") {
						manifest.tokens.colors[tokenName] = {
							name: tokenName,
							value: figmaColorToHex(defaultValue),
							variableId: variable.id,
							scopes: variable.scopes,
						};
					} else if (variable.resolvedType === "FLOAT") {
						manifest.tokens.spacing[tokenName] = {
							name: tokenName,
							value: typeof defaultValue === "number" ? defaultValue : 0,
							variableId: variable.id,
						};
					}
				}
			}
		} catch (error) {
			logger.warn({ error }, "Could not fetch variables during auto-load");
		}

		// Get components
		let rawComponents:
			| { components: any[]; componentSets: any[] }
			| undefined;
		try {
			const componentsResult = await connector.getLocalComponents();
			if (componentsResult.success && componentsResult.data) {
				rawComponents = {
					components: componentsResult.data.components || [],
					componentSets: componentsResult.data.componentSets || [],
				};
				for (const comp of rawComponents.components) {
					manifest.components[comp.name] = {
						key: comp.key,
						nodeId: comp.nodeId,
						name: comp.name,
						description: comp.description || undefined,
						defaultSize: { width: comp.width, height: comp.height },
					};
				}
				for (const compSet of rawComponents.componentSets) {
					manifest.componentSets[compSet.name] = {
						key: compSet.key,
						nodeId: compSet.nodeId,
						name: compSet.name,
						description: compSet.description || undefined,
						variants:
							compSet.variants?.map((v: any) => ({
								key: v.key,
								nodeId: v.nodeId,
								name: v.name,
							})) || [],
						variantAxes:
							compSet.variantAxes?.map((a: any) => ({
								name: a.name,
								values: a.values,
							})) || [],
					};
				}
			}
		} catch (error) {
			logger.warn({ error }, "Could not fetch components during auto-load");
		}

		// Update summary
		manifest.summary = {
			totalTokens:
				Object.keys(manifest.tokens.colors).length +
				Object.keys(manifest.tokens.spacing).length,
			totalComponents: Object.keys(manifest.components).length,
			totalComponentSets: Object.keys(manifest.componentSets).length,
			colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
			spacingScale: Object.values(manifest.tokens.spacing)
				.map((s: any) => s.value)
				.sort((a: number, b: number) => a - b)
				.slice(0, 10),
			typographyScale: [],
			componentCategories: [],
		};

		// Cache the result
		cache.set(fileKey, manifest, rawComponents);
		cacheEntry = cache.get(fileKey);

		return { cacheEntry, fileKey, wasLoaded: true };
	};

	// Tool: Find Components (search, keys, or details — unified, includes overview)
	server.tool(
		"figma_find_components",
		`Find components and get a design system overview. Start with verbosity='overview' to see what's available, then drill down.

Verbosity levels:
- "overview": Compact design system summary — categories, token collections, component/token counts. Minimal tokens. Use this first.
- "keys" (default): Fast key+nodeId lookup from cache. Good for finding component keys before instantiation.
- "summary": Search with paginated results, descriptions, and categories from design system manifest.
- "details": Full component spec with properties, variants, tokens. Pass componentKey or componentName.`,
		{
			query: z.string().optional().default("").describe("Search query to match component names (case-insensitive)"),
			verbosity: z.enum(["overview", "keys", "summary", "details"]).optional().default("keys").describe("Response detail level"),
			componentKey: z.string().optional().describe("Component key for exact lookup (details verbosity)"),
			componentName: z.string().optional().describe("Component name for exact lookup (details verbosity)"),
			category: z.string().optional().describe("Filter by category (summary verbosity)"),
			scope: z.enum(["properties", "full"]).optional().default("properties").describe("Details scope: 'properties' (compact) or 'full' (complete spec)"),
			limit: z.coerce.number().optional().default(10).describe("Max results (summary verbosity, max 25)"),
			offset: z.coerce.number().optional().default(0).describe("Pagination offset (summary verbosity)"),
			fileUrl: z.string().optional().describe("Figma file URL (for keys lookup). Uses current if omitted."),
			includeVariants: coerceBool().optional().default(false).describe("Include individual variants in keys results"),
			forceRefresh: coerceBool().optional().default(false).describe("Force refresh cached data (overview verbosity only — extraction can take minutes for large files)"),
		},
		{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ query, verbosity, componentKey, componentName, category, scope, limit, offset, fileUrl, includeVariants, forceRefresh }) => {
			try {
				if (verbosity === "overview") {
					// Compact design system overview — categories, token summary, totals
					const {
						DesignSystemManifestCache,
						createEmptyManifest,
						figmaColorToHex,
						getCategories,
						getTokenSummary,
					} = await import("../core/design-system-manifest.js");

					const cache = DesignSystemManifestCache.getInstance();
					const currentUrl = getCurrentUrl();
					const fileKeyMatch = currentUrl?.match(
						/\/(file|design)\/([a-zA-Z0-9]+)/,
					);
					const fileKey = fileKeyMatch ? fileKeyMatch[2] : "unknown";

					// Check cache first
					let cacheEntry = cache.get(fileKey);
					if (cacheEntry && !forceRefresh) {
						const categories = getCategories(cacheEntry.manifest);
						const tokenSummary = getTokenSummary(cacheEntry.manifest);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											success: true,
											cached: true,
											cacheAge: Math.round(
												(Date.now() - cacheEntry.timestamp) / 1000,
											),
											fileKey,
											categories: categories.slice(0, 15),
											tokens: tokenSummary,
											totals: {
												components: cacheEntry.manifest.summary.totalComponents,
												componentSets:
													cacheEntry.manifest.summary.totalComponentSets,
												tokens: cacheEntry.manifest.summary.totalTokens,
											},
											hint: "Use figma_find_components with verbosity='keys' or 'summary' to find specific components. For token values, use figma_get_variables with format='summary'.",
										},
									),
								},
							],
						};
					}

					// Need to extract fresh data
					const connector = await getDesktopConnector();
					const manifest = createEmptyManifest(fileKey);
					manifest.fileUrl = currentUrl || undefined;

					// Get variables (tokens)
					try {
						const variablesResult = await connector.getVariables(fileKey);
						if (variablesResult.success && variablesResult.data) {
							for (const collection of variablesResult.data
								.variableCollections || []) {
								manifest.collections.push({
									id: collection.id,
									name: collection.name,
									modes: collection.modes.map((m: any) => ({
										modeId: m.modeId,
										name: m.name,
									})),
									defaultModeId: collection.defaultModeId,
								});
							}
							for (const variable of variablesResult.data.variables || []) {
								const tokenName = variable.name;
								const defaultModeId = manifest.collections.find(
									(c) => c.id === variable.variableCollectionId,
								)?.defaultModeId;
								const defaultValue = defaultModeId
									? variable.valuesByMode?.[defaultModeId]
									: undefined;

								if (variable.resolvedType === "COLOR") {
									manifest.tokens.colors[tokenName] = {
										name: tokenName,
										value: figmaColorToHex(defaultValue),
										variableId: variable.id,
										scopes: variable.scopes,
									};
								} else if (variable.resolvedType === "FLOAT") {
									manifest.tokens.spacing[tokenName] = {
										name: tokenName,
										value: typeof defaultValue === "number" ? defaultValue : 0,
										variableId: variable.id,
									};
								}
							}
						}
					} catch (error) {
						logger.warn({ error }, "Could not fetch variables");
					}

					// Get components (can be slow for large files)
					let rawComponents:
						| { components: any[]; componentSets: any[] }
						| undefined;
					try {
						const componentsResult = await connector.getLocalComponents();
						if (componentsResult.success && componentsResult.data) {
							rawComponents = {
								components: componentsResult.data.components || [],
								componentSets: componentsResult.data.componentSets || [],
							};
							for (const comp of rawComponents.components) {
								manifest.components[comp.name] = {
									key: comp.key,
									nodeId: comp.nodeId,
									name: comp.name,
									description: comp.description || undefined,
									defaultSize: { width: comp.width, height: comp.height },
								};
							}
							for (const compSet of rawComponents.componentSets) {
								manifest.componentSets[compSet.name] = {
									key: compSet.key,
									nodeId: compSet.nodeId,
									name: compSet.name,
									description: compSet.description || undefined,
									variants:
										compSet.variants?.map((v: any) => ({
											key: v.key,
											nodeId: v.nodeId,
											name: v.name,
										})) || [],
									variantAxes:
										compSet.variantAxes?.map((a: any) => ({
											name: a.name,
											values: a.values,
										})) || [],
								};
							}
						}
					} catch (error) {
						logger.warn({ error }, "Could not fetch components");
					}

					// Update summary
					manifest.summary = {
						totalTokens:
							Object.keys(manifest.tokens.colors).length +
							Object.keys(manifest.tokens.spacing).length,
						totalComponents: Object.keys(manifest.components).length,
						totalComponentSets: Object.keys(manifest.componentSets).length,
						colorPalette: Object.keys(manifest.tokens.colors).slice(0, 10),
						spacingScale: Object.values(manifest.tokens.spacing)
							.map((s) => s.value)
							.sort((a, b) => a - b)
							.slice(0, 10),
						typographyScale: [],
						componentCategories: [],
					};

					// Cache the result
					cache.set(fileKey, manifest, rawComponents);

					const categoriesList = getCategories(manifest);
					const tokenSummary = getTokenSummary(manifest);

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										success: true,
										cached: false,
										fileKey,
										categories: categoriesList.slice(0, 15),
										tokens: tokenSummary,
										totals: {
											components: manifest.summary.totalComponents,
											componentSets: manifest.summary.totalComponentSets,
											tokens: manifest.summary.totalTokens,
										},
										hint: "Use figma_find_components with verbosity='keys' or 'summary' to find specific components. For token values, use figma_get_variables with format='summary'.",
									},
								),
							},
						],
					};
				} else if (verbosity === "keys") {
					// Fast key lookup from project context cache
					const url = fileUrl || getCurrentUrl();
					if (!url) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No Figma file connected." }) }], isError: true };
					}
					const fk = extractFileKey(url);
					if (!fk) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Invalid URL: ${url}` }) }], isError: true };
					}
					const api = await getFigmaAPI();
					const ctx = await projectContextCache.get(fk, api) ?? await projectContextCache.build(fk, api);
					const pattern = (query || "").toLowerCase();
					const results: Array<{ name: string; key: string; nodeId: string; type: string }> = [];

					for (const [name, entry] of Object.entries(ctx.componentSets.keyMap)) {
						if (!pattern || name.toLowerCase().includes(pattern)) {
							results.push({ name, key: entry.key, nodeId: entry.nodeId, type: 'componentSet' });
						}
					}
					if (includeVariants || results.length === 0) {
						for (const [name, entry] of Object.entries(ctx.components.keyMap)) {
							if (!pattern || name.toLowerCase().includes(pattern)) {
								results.push({ name, key: entry.key, nodeId: entry.nodeId, type: 'component' });
							}
						}
					}

					return {
						content: [{ type: "text" as const, text: JSON.stringify({ fileKey: fk, pattern: query, matches: results.length, results: results.slice(0, 50) }) }],
					};
				} else if (verbosity === "summary") {
					// Search from design system manifest
					const { searchComponents } = await import("../core/design-system-manifest.js");
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Could not load design system data." }) }], isError: true };
					}
					const effectiveLimit = Math.min(limit || 10, 25);
					const results = searchComponents(cacheEntry.manifest, query || "", { category, limit: effectiveLimit, offset: offset || 0 });

					return {
						content: [{ type: "text" as const, text: JSON.stringify({ success: true, query: query || "(all)", results: results.results, pagination: { offset: offset || 0, limit: effectiveLimit, total: results.total, hasMore: results.hasMore } }) }],
					};
				} else {
					// Details — exact component lookup
					if (!componentKey && !componentName) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: "componentKey or componentName required for details verbosity" }) }], isError: true };
					}
					const { cacheEntry } = await ensureDesignSystemCache();
					if (!cacheEntry) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Could not load design system data." }) }], isError: true };
					}

					let component: any = null;
					let isComponentSet = false;

					for (const [name, compSet] of Object.entries(cacheEntry.manifest.componentSets) as [string, any][]) {
						if ((componentKey && compSet.key === componentKey) || (componentName && name === componentName)) {
							component = compSet; isComponentSet = true; break;
						}
					}
					if (!component) {
						for (const [name, comp] of Object.entries(cacheEntry.manifest.components) as [string, any][]) {
							if ((componentKey && comp.key === componentKey) || (componentName && name === componentName)) {
								component = comp; break;
							}
						}
					}

					if (!component) {
						return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Component not found: ${componentKey || componentName}` }) }], isError: true };
					}

					let responseData: any;
					if (scope === 'properties') {
						if (isComponentSet) {
							responseData = { success: true, type: 'componentSet', name: component.name, key: component.key, nodeId: component.nodeId, description: component.description, variantAxes: component.variantAxes, variants: component.variants?.map((v: any) => ({ name: v.name, key: v.key, properties: v.properties })), instantiation: { key: component.key } };
						} else {
							responseData = { success: true, type: 'component', name: component.name, key: component.key, nodeId: component.nodeId, description: component.description, properties: component.properties, defaultSize: component.defaultSize, instantiation: { key: component.key } };
						}
					} else {
						responseData = { success: true, type: isComponentSet ? "componentSet" : "component", component, instantiation: { key: component.key } };
					}

					return { content: [{ type: "text" as const, text: JSON.stringify(responseData) }] };
				}
			} catch (error) {
				logger.error({ error }, "Failed to find components");
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
			}
		},
	);

	// Tool: Instantiate Component
	server.tool(
		"figma_instantiate_component",
		`Create an instance of a component from the design system.

**CRITICAL: Always pass BOTH componentKey AND nodeId together!**
Search results return both identifiers. Pass both so the tool can automatically fall back to nodeId if the component isn't published to a library. Most local/unpublished components require nodeId.

**COMPONENT SET KEYS:** Both component keys AND componentSet keys work. When passing a componentSet key (from figma_get_library_components), the tool imports the set and picks a variant automatically. Use the \`variant\` param to select a specific variant (e.g., \`{ Type: "Elevated" }\`). Without \`variant\`, the default variant is used.

**IMPORTANT: Always re-search before instantiating!**
NodeIds are session-specific and may be stale from previous conversations. ALWAYS search for components at the start of each design session to get current, valid identifiers.

**OVERRIDE LIMITATIONS:**
The overrides param handles TEXT and BOOLEAN properties only. For INSTANCE_SWAP overrides, call figma_set_instance_properties after instantiation.

**VISUAL VALIDATION WORKFLOW:**
After instantiating components, use figma_screenshot to verify the result looks correct. Check placement, sizing, and visual balance.`,
		{
			componentKey: z
				.string()
				.optional()
				.describe(
					"The component key from search results. Pass this WITH nodeId for automatic fallback.",
				),
			nodeId: z
				.string()
				.optional()
				.describe(
					"The node ID from search results. ALWAYS pass this alongside componentKey - most local components need it.",
				),
			variant: z
				.record(z.string())
				.optional()
				.describe(
					"Variant properties to set (e.g., { Type: 'Simple', State: 'Active' })",
				),
			overrides: z
				.record(z.string(), z.union([z.string(), z.coerce.number(), coerceBool()]))
				.optional()
				.describe(
					"Property overrides (e.g., { 'Button Label': 'Click Me' })",
				),
			position: jsonObject(z.object({
					x: z.coerce.number(),
					y: z.coerce.number(),
				}))
				.optional()
				.describe("Position on canvas (default: 0, 0)"),
			parentId: z
				.string()
				.optional()
				.describe("Parent node ID to append the instance to"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({
			componentKey,
			nodeId,
			variant,
			overrides,
			position,
			parentId,
		}) => {
			try {
				if (!componentKey && !nodeId) {
					throw new Error("Either componentKey or nodeId is required");
				}
				const connector = await getDesktopConnector();
				const result = await connector.instantiateComponent(
					componentKey || "",
					{
						nodeId,
						position,
						overrides,
						variant,
						parentId,
					},
				);

				if (!result.success) {
					throw new Error(result.error || "Failed to instantiate component");
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									message: "Component instantiated successfully",
									instance: result.instance,
								},
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to instantiate component");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error:
										error instanceof Error ? error.message : String(error),
									message: "Failed to instantiate component",
									hint: "Make sure the component key is correct and the Desktop Bridge plugin is running",
								},
							),
						},
					],
					isError: true,
				};
			}
		},
	);

	// Tool: Component Property (list/add/edit/delete/set_description)
	server.tool(
		"figma_component_property",
		`Manage component properties and descriptions. Actions:
- list: List all properties on a component/instance. For INSTANCE nodes, returns overridable properties (text overrides, component properties, variant props) with current values. For COMPONENT/COMPONENT_SET nodes, returns property definitions.
- add: Add a new property (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT). Requires: type, defaultValue.
- edit: Update name/defaultValue/preferredValues. Requires: newValue object.
- delete: Remove a property (not VARIANT types). Destructive.
- set_description: Set description text on a component, component set, or style. Supports plain text and markdown.

Use the full property name with suffix for edit/delete (e.g. 'Show Icon#123:456'). Requires Desktop Bridge.`,
		{
			action: z.enum(["list", "add", "edit", "delete", "set_description"]).describe("Operation to perform"),
			nodeId: z.string().describe("Component or component set node ID"),
			propertyName: z.string().optional().describe("Property name (required for add/edit/delete, with suffix for edit/delete, e.g. 'Show Icon#123:456')"),
			type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]).optional()
				.describe("Property type (add only)"),
			defaultValue: z.union([z.string(), z.coerce.number(), coerceBool()]).optional()
				.describe("Default value (add only)"),
			newValue: jsonObject(z.object({
				name: z.string().optional().describe("New name for the property"),
				defaultValue: z.union([z.string(), z.coerce.number(), coerceBool()]).optional().describe("New default value"),
				preferredValues: z.array(z.object({
					type: z.enum(["COMPONENT", "COMPONENT_SET"]).describe("Type of preferred value"),
					key: z.string().describe("Component or component set key"),
				})).optional().describe("Preferred values (INSTANCE_SWAP only)"),
			})).optional().describe("Values to update (edit only)"),
			description: z.string().optional().describe("Plain text description (set_description only)"),
			descriptionMarkdown: z.string().optional().describe("Markdown description (set_description only)"),
		},
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		async ({ action, nodeId, propertyName, type, defaultValue, newValue, description, descriptionMarkdown }) => {
			const errorResponse = (msg: string) => ({
				content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
				isError: true as const,
			});

			try {
				const connector = await getDesktopConnector();

				switch (action) {
					case "list": {
						const listResult = await connector.executeCodeViaUI(`
							var node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
							if (!node) return { success: false, error: 'Node not found: ' + ${JSON.stringify(nodeId)} };
							var info = { type: node.type, name: node.name, properties: {} };

							if (node.type === 'INSTANCE') {
								// Instance: show overridable properties with current values
								if (node.componentProperties) {
									for (var key of Object.keys(node.componentProperties)) {
										var prop = node.componentProperties[key];
										info.properties[key] = { type: prop.type, value: prop.value };
										if (prop.preferredValues) info.properties[key].preferredValues = prop.preferredValues;
									}
								}
								// Also show text overrides by scanning text children
								var textOverrides = [];
								function scanText(n) {
									if (n.type === 'TEXT') textOverrides.push({ id: n.id, name: n.name, characters: n.characters });
									if (n.children) n.children.forEach(scanText);
								}
								scanText(node);
								if (textOverrides.length > 0) info.textNodes = textOverrides;
								// Main component info
								try {
									if (node.mainComponent) {
										info.mainComponent = { id: node.mainComponent.id, name: node.mainComponent.name };
										if (node.mainComponent.parent && node.mainComponent.parent.type === 'COMPONENT_SET') {
											info.componentSet = node.mainComponent.parent.name;
										}
									}
								} catch(e) {}
							} else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
								// Component: show property definitions
								if (node.componentPropertyDefinitions) {
									for (var key of Object.keys(node.componentPropertyDefinitions)) {
										var def = node.componentPropertyDefinitions[key];
										info.properties[key] = { type: def.type, defaultValue: def.defaultValue };
										if (def.variantOptions) info.properties[key].variantOptions = def.variantOptions;
										if (def.preferredValues) info.properties[key].preferredValues = def.preferredValues;
									}
								}
							} else {
								return { success: false, error: 'list works on INSTANCE, COMPONENT, or COMPONENT_SET nodes. Got: ' + node.type };
							}
							return { success: true, result: info };
						`);
						if (listResult.error) throw new Error(listResult.error);
						const lr = listResult.result || listResult;
						const data = lr.result || lr;
						return {
							content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
						};
					}
					case "add": {
						if (!propertyName) return errorResponse("add requires propertyName");
						if (!type || defaultValue === undefined) return errorResponse("add requires type and defaultValue");
						const result = await connector.addComponentProperty(nodeId, propertyName, type, defaultValue);
						if (!result.success) throw new Error(result.error || "Failed to add property");
						return {
							content: [{ type: "text" as const, text: JSON.stringify({
								success: true, message: "Component property added",
								propertyName: result.propertyName,
								hint: "The property name includes a unique suffix. Use the full name for editing/deleting.",
							}) }],
						};
					}
					case "edit": {
						if (!propertyName) return errorResponse("edit requires propertyName");
						if (!newValue) return errorResponse("edit requires newValue object");
						const result = await connector.editComponentProperty(nodeId, propertyName, newValue);
						if (!result.success) throw new Error(result.error || "Failed to edit property");
						return {
							content: [{ type: "text" as const, text: JSON.stringify({
								success: true, message: "Component property updated",
								propertyName: result.propertyName,
							}) }],
						};
					}
					case "delete": {
						if (!propertyName) return errorResponse("delete requires propertyName");
						const result = await connector.deleteComponentProperty(nodeId, propertyName);
						if (!result.success) throw new Error(result.error || "Failed to delete property");
						return {
							content: [{ type: "text" as const, text: JSON.stringify({
								success: true, message: "Component property deleted",
							}) }],
						};
					}
					case "set_description": {
						if (!description && !descriptionMarkdown) return errorResponse("set_description requires description or descriptionMarkdown");
						const result = await connector.setNodeDescription(
							nodeId,
							description || "",
							descriptionMarkdown,
						);
						if (!result.success) throw new Error(result.error || "Failed to set description");
						return {
							content: [{ type: "text" as const, text: JSON.stringify({
								success: true, message: "Description set successfully",
								node: result.node,
							}) }],
						};
					}
				}
			} catch (error) {
				logger.error({ error }, `Failed component property operation: ${action}`);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({
						error: error instanceof Error ? error.message : String(error),
						hint: action === "add" ? "Cannot add properties to variant components. Add to the parent component set instead."
							: action === "delete" ? "Cannot delete VARIANT properties. Only BOOLEAN, TEXT, and INSTANCE_SWAP can be deleted."
							: action === "set_description" ? "Make sure the node supports descriptions (components, component sets, styles)"
							: undefined,
					}) }],
					isError: true,
				};
			}
		},
	);

	// Tool: Arrange Component Set (Professional Layout with Native Visualization)
	server.tool(
		"figma_arrange_component_set",
		`Organize a component set with Figma's native purple dashed visualization. Use after creating variants, adding states (hover/disabled/pressed), or when component sets need cleanup.

Recreates the set using figma.combineAsVariants() for proper Figma integration, applies purple dashed border styling, and arranges variants in a labeled grid (columns = last property like State, rows = other properties like Type+Size). Creates a white container with title, row/column labels, and the component set.`,
		{
			componentSetId: z
				.string()
				.optional()
				.describe(
					"Node ID of the component set to arrange. If not provided, will look for a selected component set.",
				),
			componentSetName: z
				.string()
				.optional()
				.describe(
					"Name of the component set to find. Used if componentSetId not provided.",
				),
			options: z
				.object({
					gap: z
						.number()
						.optional()
						.default(24)
						.describe("Gap between grid cells in pixels (default: 24)"),
					cellPadding: z
						.number()
						.optional()
						.default(20)
						.describe(
							"Padding inside each cell around the variant (default: 20)",
						),
					columnProperty: z
						.string()
						.optional()
						.describe(
							"Property to use for columns (default: auto-detect last property, usually 'State')",
						),
				})
				.optional()
				.describe("Layout options"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async ({ componentSetId, componentSetName, options }) => {
			try {
				const connector = await getDesktopConnector();

				// Build the code to execute in Figma
				const code = `
// ============================================================================
// COMPONENT SET ARRANGEMENT WITH PROPER LABELS AND CONTAINER
// Creates: White container frame → Row labels (left) → Column headers (top) → Component set (center)
// Uses auto-layout for proper alignment of labels with grid cells
// ============================================================================

// Configuration
const config = ${JSON.stringify(options || {})};
const gap = config.gap ?? 24;
const cellPadding = config.cellPadding ?? 20;
const columnProperty = config.columnProperty || null;

// Layout constants
const LABEL_FONT_SIZE = 12;
const LABEL_COLOR = { r: 0.4, g: 0.4, b: 0.4 };  // Gray text
const TITLE_FONT_SIZE = 24;
const TITLE_COLOR = { r: 0.1, g: 0.1, b: 0.1 };  // Dark text
const CONTAINER_PADDING = 40;
const LABEL_GAP = 16;  // Gap between labels and component set
const COLUMN_HEADER_HEIGHT = 32;

// Find the component set
let componentSet = null;
const csId = ${JSON.stringify(componentSetId || null)};
const csName = ${JSON.stringify(componentSetName || null)};

if (csId) {
	componentSet = await figma.getNodeByIdAsync(csId);
} else if (csName) {
	const allNodes = figma.currentPage.findAll(n => n.type === "COMPONENT_SET" && n.name === csName);
	componentSet = allNodes[0];
} else {
	const selection = figma.currentPage.selection;
	componentSet = selection.find(n => n.type === "COMPONENT_SET");
}

if (!componentSet || componentSet.type !== "COMPONENT_SET") {
	return { error: "Component set not found. Provide componentSetId, componentSetName, or select a component set." };
}

const page = figma.currentPage;
const csOriginalX = componentSet.x;
const csOriginalY = componentSet.y;
const csOriginalName = componentSet.name;

// Get all variant components
const variants = componentSet.children.filter(n => n.type === "COMPONENT");
if (variants.length === 0) {
	return { error: "No variants found in component set" };
}

// Parse variant properties from names
const parseVariantName = (name) => {
	const props = {};
	const parts = name.split(", ");
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key && value) {
			props[key.trim()] = value.trim();
		}
	}
	return props;
};

// Collect all properties and their unique values (preserving order)
const propertyValues = {};
const propertyOrder = [];
for (const variant of variants) {
	const props = parseVariantName(variant.name);
	for (const [key, value] of Object.entries(props)) {
		if (!propertyValues[key]) {
			propertyValues[key] = new Set();
			propertyOrder.push(key);
		}
		propertyValues[key].add(value);
	}
}
for (const key of Object.keys(propertyValues)) {
	propertyValues[key] = Array.from(propertyValues[key]);
}

// Determine grid structure: columns = last property (usually State), rows = other properties
const columnProp = columnProperty || propertyOrder[propertyOrder.length - 1];
const columnValues = propertyValues[columnProp] || [];
const rowProps = propertyOrder.filter(p => p !== columnProp);

// Generate all row combinations
const generateRowCombinations = (props, values) => {
	if (props.length === 0) return [{}];
	if (props.length === 1) {
		return values[props[0]].map(v => ({ [props[0]]: v }));
	}
	const result = [];
	const firstProp = props[0];
	const restProps = props.slice(1);
	const restCombos = generateRowCombinations(restProps, values);
	for (const value of values[firstProp]) {
		for (const combo of restCombos) {
			result.push({ [firstProp]: value, ...combo });
		}
	}
	return result;
};
const rowCombinations = generateRowCombinations(rowProps, propertyValues);

const totalCols = columnValues.length;
const totalRows = rowCombinations.length;

// Calculate max variant dimensions
let maxVariantWidth = 0;
let maxVariantHeight = 0;
for (const v of variants) {
	if (v.width > maxVariantWidth) maxVariantWidth = v.width;
	if (v.height > maxVariantHeight) maxVariantHeight = v.height;
}

// Calculate cell dimensions (each cell in the grid)
const cellWidth = Math.ceil(maxVariantWidth + cellPadding);
const cellHeight = Math.ceil(maxVariantHeight + cellPadding);

// Calculate component set dimensions
const edgePadding = 24;  // Padding inside component set
const csWidth = (totalCols * cellWidth) + ((totalCols - 1) * gap) + (edgePadding * 2);
const csHeight = (totalRows * cellHeight) + ((totalRows - 1) * gap) + (edgePadding * 2);

// ============================================================================
// STEP 1: Remove old labels and container frames from previous arrangements
// ============================================================================
const oldElements = page.children.filter(n =>
	(n.type === "TEXT" && (n.name.startsWith("Row: ") || n.name.startsWith("Col: "))) ||
	(n.type === "FRAME" && (n.name === "Component Container" || n.name === "Row Labels" || n.name === "Column Headers"))
);
for (const el of oldElements) {
	el.remove();
}

// ============================================================================
// STEP 2: Clone variants and recreate component set with native visualization
// ============================================================================
const clonedVariants = [];
for (const variant of variants) {
	const clone = variant.clone();
	page.appendChild(clone);
	clonedVariants.push(clone);
}

// Delete the old component set
componentSet.remove();

// Recreate using figma.combineAsVariants() for native purple dashed frame
const newComponentSet = figma.combineAsVariants(clonedVariants, page);
newComponentSet.name = csOriginalName;

// Apply purple dashed border (Figma's native component set styling)
newComponentSet.strokes = [{
	type: 'SOLID',
	color: { r: 151/255, g: 71/255, b: 255/255 }  // Figma's purple: #9747FF
}];
newComponentSet.dashPattern = [10, 5];
newComponentSet.strokeWeight = 1;
newComponentSet.strokeAlign = "INSIDE";

// ============================================================================
// STEP 3: Arrange variants in grid pattern inside component set
// ============================================================================
const newVariants = newComponentSet.children.filter(n => n.type === "COMPONENT");

for (const variant of newVariants) {
	const props = parseVariantName(variant.name);
	const colValue = props[columnProp];
	const colIdx = columnValues.indexOf(colValue);

	// Find matching row
	let rowIdx = -1;
	for (let i = 0; i < rowCombinations.length; i++) {
		const combo = rowCombinations[i];
		let match = true;
		for (const [key, value] of Object.entries(combo)) {
			if (props[key] !== value) {
				match = false;
				break;
			}
		}
		if (match) {
			rowIdx = i;
			break;
		}
	}

	if (colIdx >= 0 && rowIdx >= 0) {
		// Calculate cell position
		const cellX = edgePadding + colIdx * (cellWidth + gap);
		const cellY = edgePadding + rowIdx * (cellHeight + gap);

		// Center variant within cell
		const variantX = Math.round(cellX + (cellWidth - variant.width) / 2);
		const variantY = Math.round(cellY + (cellHeight - variant.height) / 2);

		variant.x = variantX;
		variant.y = variantY;
	}
}

// Resize component set to fit grid
newComponentSet.resize(csWidth, csHeight);

// ============================================================================
// STEP 4: Create white container frame with proper structure
// ============================================================================

// Load font for labels
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });

// Create the main container frame (white background)
const containerFrame = figma.createFrame();
containerFrame.name = "Component Container";
containerFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];  // White
containerFrame.cornerRadius = 8;
containerFrame.layoutMode = 'VERTICAL';
containerFrame.primaryAxisSizingMode = 'AUTO';
containerFrame.counterAxisSizingMode = 'AUTO';
containerFrame.paddingTop = CONTAINER_PADDING;
containerFrame.paddingRight = CONTAINER_PADDING;
containerFrame.paddingBottom = CONTAINER_PADDING;
containerFrame.paddingLeft = CONTAINER_PADDING;
containerFrame.itemSpacing = 24;

// Add title
const titleText = figma.createText();
titleText.name = "Title";
titleText.characters = csOriginalName;
titleText.fontSize = TITLE_FONT_SIZE;
titleText.fontName = { family: "Inter", style: "Semi Bold" };
titleText.fills = [{ type: 'SOLID', color: TITLE_COLOR }];
// Append to parent FIRST, then set layoutSizing
containerFrame.appendChild(titleText);
titleText.layoutSizingHorizontal = 'HUG';
titleText.layoutSizingVertical = 'HUG';

// Create content row (horizontal: row labels + grid column)
const contentRow = figma.createFrame();
contentRow.name = "Content Row";
contentRow.fills = [];  // Transparent
contentRow.layoutMode = 'HORIZONTAL';
contentRow.primaryAxisSizingMode = 'AUTO';
contentRow.counterAxisSizingMode = 'AUTO';
contentRow.itemSpacing = LABEL_GAP;
contentRow.counterAxisAlignItems = 'MIN';  // Align to top
containerFrame.appendChild(contentRow);

// ============================================================================
// STEP 5: Create row labels column (left side)
// ============================================================================
const rowLabelsFrame = figma.createFrame();
rowLabelsFrame.name = "Row Labels";
rowLabelsFrame.fills = [];  // Transparent
rowLabelsFrame.layoutMode = 'VERTICAL';
rowLabelsFrame.primaryAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisSizingMode = 'AUTO';
rowLabelsFrame.counterAxisAlignItems = 'MAX';  // Right-align text
rowLabelsFrame.itemSpacing = 0;  // No spacing - we'll use fixed heights

// Add spacer for column headers alignment
const rowLabelSpacer = figma.createFrame();
rowLabelSpacer.name = "Spacer";
rowLabelSpacer.fills = [];
rowLabelSpacer.resize(10, COLUMN_HEADER_HEIGHT + gap + edgePadding);
rowLabelsFrame.appendChild(rowLabelSpacer);
rowLabelSpacer.layoutSizingVertical = 'FIXED';

// Create row labels
for (let i = 0; i < rowCombinations.length; i++) {
	const combo = rowCombinations[i];
	const labelText = rowProps.map(p => combo[p]).join(" / ");
	const isLastRow = (i === rowCombinations.length - 1);

	const rowLabelContainer = figma.createFrame();
	rowLabelContainer.name = "Row: " + labelText;
	rowLabelContainer.fills = [];
	rowLabelContainer.layoutMode = 'VERTICAL';
	rowLabelContainer.primaryAxisSizingMode = 'FIXED';
	rowLabelContainer.primaryAxisAlignItems = 'CENTER';
	rowLabelContainer.counterAxisAlignItems = 'MAX';

	rowLabelContainer.resize(10, cellHeight);

	const label = figma.createText();
	label.characters = labelText;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'RIGHT';
	rowLabelContainer.appendChild(label);

	rowLabelsFrame.appendChild(rowLabelContainer);
	rowLabelContainer.layoutSizingHorizontal = 'HUG';
	rowLabelContainer.layoutSizingVertical = 'FIXED';

	if (!isLastRow) {
		const gapSpacer = figma.createFrame();
		gapSpacer.name = "Row Gap";
		gapSpacer.fills = [];
		gapSpacer.resize(1, gap);
		rowLabelsFrame.appendChild(gapSpacer);
		gapSpacer.layoutSizingHorizontal = 'FIXED';
		gapSpacer.layoutSizingVertical = 'FIXED';
	}
}

contentRow.appendChild(rowLabelsFrame);

// ============================================================================
// STEP 6: Create grid column (column headers + component set)
// ============================================================================
const gridColumn = figma.createFrame();
gridColumn.name = "Grid Column";
gridColumn.fills = [];  // Transparent
gridColumn.layoutMode = 'VERTICAL';
gridColumn.primaryAxisSizingMode = 'AUTO';
gridColumn.counterAxisSizingMode = 'AUTO';
gridColumn.itemSpacing = gap;

// Create column headers row
const columnHeadersRow = figma.createFrame();
columnHeadersRow.name = "Column Headers";
columnHeadersRow.fills = [];
columnHeadersRow.layoutMode = 'HORIZONTAL';
columnHeadersRow.resize(csWidth, COLUMN_HEADER_HEIGHT);
columnHeadersRow.itemSpacing = 0;
columnHeadersRow.paddingLeft = edgePadding;
columnHeadersRow.paddingRight = edgePadding;

// Create column header labels
for (let i = 0; i < columnValues.length; i++) {
	const colValue = columnValues[i];
	const isLastCol = (i === columnValues.length - 1);

	const colHeaderContainer = figma.createFrame();
	colHeaderContainer.name = "Col: " + colValue;
	colHeaderContainer.fills = [];
	colHeaderContainer.layoutMode = 'HORIZONTAL';
	colHeaderContainer.primaryAxisAlignItems = 'CENTER';
	colHeaderContainer.counterAxisAlignItems = 'MAX';

	const colWidth = isLastCol ? cellWidth : cellWidth + gap;
	colHeaderContainer.resize(colWidth, COLUMN_HEADER_HEIGHT);
	if (!isLastCol) {
		colHeaderContainer.paddingRight = gap;
	}

	const label = figma.createText();
	label.characters = colValue;
	label.fontSize = LABEL_FONT_SIZE;
	label.fontName = { family: "Inter", style: "Regular" };
	label.fills = [{ type: 'SOLID', color: LABEL_COLOR }];
	label.textAlignHorizontal = 'CENTER';
	colHeaderContainer.appendChild(label);

	columnHeadersRow.appendChild(colHeaderContainer);
	colHeaderContainer.layoutSizingHorizontal = 'FIXED';
	colHeaderContainer.layoutSizingVertical = 'FILL';
}

gridColumn.appendChild(columnHeadersRow);
columnHeadersRow.layoutSizingHorizontal = 'FIXED';
columnHeadersRow.layoutSizingVertical = 'FIXED';

// Create a wrapper frame to hold the component set
const componentSetWrapper = figma.createFrame();
componentSetWrapper.name = "Component Set Wrapper";
componentSetWrapper.fills = [];
componentSetWrapper.resize(csWidth, csHeight);

// Move component set inside wrapper
componentSetWrapper.appendChild(newComponentSet);
newComponentSet.x = 0;
newComponentSet.y = 0;

gridColumn.appendChild(componentSetWrapper);
componentSetWrapper.layoutSizingHorizontal = 'FIXED';
componentSetWrapper.layoutSizingVertical = 'FIXED';

contentRow.appendChild(gridColumn);

// Position container at original location
containerFrame.x = csOriginalX - CONTAINER_PADDING - 120;
containerFrame.y = csOriginalY - CONTAINER_PADDING - TITLE_FONT_SIZE - 24 - COLUMN_HEADER_HEIGHT - gap;

// Select and zoom to show result
figma.currentPage.selection = [containerFrame];
figma.viewport.scrollAndZoomIntoView([containerFrame]);

return {
	success: true,
	message: "Component set arranged with proper container, labels, and alignment",
	containerId: containerFrame.id,
	componentSetId: newComponentSet.id,
	componentSetName: newComponentSet.name,
	grid: {
		rows: totalRows,
		columns: totalCols,
		cellWidth: cellWidth,
		cellHeight: cellHeight,
		gap: gap,
		columnProperty: columnProp,
		columnValues: columnValues,
		rowProperties: rowProps,
		rowLabels: rowCombinations.map(combo => rowProps.map(p => combo[p]).join(" / "))
	},
	componentSetSize: { width: csWidth, height: csHeight },
	variantCount: newVariants.length,
	structure: {
		container: "White frame with title, row labels, column headers, and component set",
		rowLabels: "Vertically aligned with each row's center",
		columnHeaders: "Horizontally aligned with each column's center"
	}
};
`;

				const result = await connector.executeCodeViaUI(code, 25000);

				if (!result.success) {
					throw new Error(result.error || "Failed to arrange component set");
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									...result.result,
									hint: result.result?.success
										? "Component set arranged in a white container frame with properly aligned row and column labels. The purple dashed border is visible. Use figma_screenshot to validate the layout."
										: undefined,
								},
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Failed to arrange component set");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error:
										error instanceof Error ? error.message : String(error),
									hint: "Make sure the Desktop Bridge plugin is running and a component set exists.",
								},
							),
						},
					],
					isError: true,
				};
			}
		},
	);

	// Tool: Search team design system library by name (instant, from cache)
	const dsNames = [...designSystems.keys()];
	const dsDescription = dsNames.length > 0
		? `Search a published design system library for components, component sets, and styles by name. Returns matching items with keys for instantiation. Instant lookup from cache — no API call.\n\nConfigured design systems: ${dsNames.map(n => `"${n}"`).join(', ')}. Use the designSystem parameter to target a specific one${dsNames.length === 1 ? ' (defaults to the only configured system)' : ''}.`
		: "Search a published design system library for components, component sets, and styles by name. Returns matching items with keys for instantiation. Instant lookup from cache — no API call. Requires FIGMA_DESIGN_SYSTEMS env var.";

	server.tool(
		"figma_get_library_components",
		dsDescription,
		{
			namePattern: z
				.string()
				.describe("Search pattern to match names (case-insensitive substring match). E.g. 'Button', 'Color/Primary', 'Heading'."),
			type: z
				.enum(["component", "componentSet", "style", "all"])
				.optional()
				.default("all")
				.describe("Filter by type: 'component', 'componentSet', 'style', or 'all' (default)."),
			designSystem: z
				.string()
				.optional()
				.describe(`Name of the design system to search.${dsNames.length > 0 ? ` Available: ${dsNames.map(n => `"${n}"`).join(', ')}.` : ''}`),
			teamId: z
				.string()
				.optional()
				.describe("Override with a raw team ID (bypasses named design systems)."),
		},
		{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async ({ namePattern, type, designSystem: dsName, teamId: overrideTeamId }) => {
			try {
				// Resolve target team IDs: explicit teamId > named designSystem > all configured
				let targetEntries: Array<{ name: string; teamId: string }>;

				if (overrideTeamId) {
					targetEntries = [{ name: 'override', teamId: overrideTeamId }];
				} else if (dsName) {
					const tid = designSystems.get(dsName);
					if (!tid) {
						const available = dsNames.length > 0 ? ` Available: ${dsNames.map(n => `"${n}"`).join(', ')}.` : '';
						return {
							content: [{
								type: "text" as const,
								text: JSON.stringify({ error: `Design system "${dsName}" not found.${available}` }),
							}],
							isError: true,
						};
					}
					targetEntries = [{ name: dsName, teamId: tid }];
				} else {
					// Search all configured design systems
					targetEntries = [...designSystems.entries()].map(([name, teamId]) => ({ name, teamId }));
				}

				if (targetEntries.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								error: "No design systems configured. Set FIGMA_DESIGN_SYSTEMS env var as JSON, e.g. '{\"my-ds\": \"12345\"}'. " +
									"Find team IDs in the URL: https://www.figma.com/files/team/{TEAM_ID}/...",
							}),
						}],
						isError: true,
					};
				}

				const api = await getFigmaAPI();
				const allResults: Array<{ name: string; teamId: string; matches: any[] }> = [];

				for (const entry of targetEntries) {
					let lib = await teamLibraryCache.get(entry.teamId, api);
					if (!lib) {
						lib = await teamLibraryCache.build(entry.teamId, api);
					}

					const matches = teamLibraryCache.search(entry.teamId, namePattern, type as any);
					allResults.push({ ...entry, matches });
				}

				// Single design system: flat response
				if (allResults.length === 1) {
					const { name, teamId: tid, matches } = allResults[0];
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								designSystem: name,
								teamId: tid,
								pattern: namePattern,
								type,
								matches: matches.length,
								results: matches.slice(0, 50),
								...(matches.length > 50 && { truncated: true, totalMatches: matches.length }),
							}),
						}],
					};
				}

				// Multiple design systems: nested response
				return {
					content: [{
						type: "text" as const,
						text: JSON.stringify({
							pattern: namePattern,
							type,
							designSystems: allResults.map(({ name, teamId: tid, matches }) => ({
								designSystem: name,
								teamId: tid,
								matches: matches.length,
								results: matches.slice(0, 50),
								...(matches.length > 50 && { truncated: true, totalMatches: matches.length }),
							})),
						}),
					}],
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
		},
	);

	// Tool: Combine Components as Variants
	server.tool(
		"figma_combine_as_variants",
		`Combine individual COMPONENT nodes into a COMPONENT_SET (variant group). This is the Figma equivalent of "Combine as Variants" from the right-click menu.

Each component MUST have a name following the variant naming convention: "Property1=Value1, Property2=Value2" (e.g. "Size=Small, State=Default"). Figma parses these names to create the variant properties.

Steps:
1. Create individual COMPONENT nodes with figma_create_nodes (use nodeType: "COMPONENT")
2. Name each component with variant property syntax (e.g. "Size=Small, State=Default")
3. Call this tool with all component IDs to combine them into a COMPONENT_SET

The resulting COMPONENT_SET gets Figma's native purple dashed border and proper variant property definitions.`,
		{
			componentIds: jsonArray(z.array(z.string().describe("Node ID of a COMPONENT to include"))).describe("Array of COMPONENT node IDs to combine. Must be ≥ 2 components."),
			name: z.string().optional().describe("Name for the component set (default: derived from first component name, stripping variant suffixes)"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async ({ componentIds, name }) => {
			try {
				const connector = await getDesktopConnector();

				if (componentIds.length < 2) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ error: "Need at least 2 components to combine as variants.", hint: "Create multiple COMPONENT nodes first with figma_create_nodes, then combine them." }) }],
						isError: true,
					};
				}

				const idsJson = JSON.stringify(componentIds);
				const nameJson = name ? JSON.stringify(name) : "null";

				const code = `
var ids = ${idsJson};
var setName = ${nameJson};
var components = [];
for (var i = 0; i < ids.length; i++) {
	var node = await figma.getNodeByIdAsync(ids[i]);
	if (!node) return { error: 'Node not found: ' + ids[i] };
	if (node.type !== 'COMPONENT') return { error: 'Node ' + ids[i] + ' is type ' + node.type + ', expected COMPONENT' };
	components.push(node);
}

// All components must share the same parent
var parent = components[0].parent;
var componentSet = figma.combineAsVariants(components, parent);

if (setName) {
	componentSet.name = setName;
}

// Apply Figma's native purple dashed border
componentSet.strokes = [{
	type: 'SOLID',
	color: { r: 151/255, g: 71/255, b: 255/255 }
}];
componentSet.dashPattern = [10, 5];
componentSet.strokeWeight = 1;
componentSet.strokeAlign = "INSIDE";

// Collect variant info
var variantNames = [];
for (var v = 0; v < componentSet.children.length; v++) {
	if (componentSet.children[v].type === 'COMPONENT') {
		variantNames.push(componentSet.children[v].name);
	}
}

return {
	success: true,
	id: componentSet.id,
	name: componentSet.name,
	variantCount: variantNames.length,
	variants: variantNames
};`;

				const raw = await connector.executeCodeViaUI(code, 10000);
				// executeCodeViaUI wraps in { success, result } envelope
				const result = raw.result ?? raw;

				if (result.error) {
					throw new Error(result.error);
				}

				const variants: string[] = result.variants ?? [];
				const lines = [`Combined ${result.variantCount ?? variants.length} components into COMPONENT_SET "${result.name}" (${result.id})`];
				for (const v of variants) {
					lines.push(`  ${v}`);
				}
				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (error) {
				logger.error({ error }, "Failed to combine as variants");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({
						error: error instanceof Error ? error.message : String(error),
						hint: "Ensure all IDs are COMPONENT nodes (not FRAME/INSTANCE). Each component name should follow variant syntax: 'Property=Value, Property=Value'.",
					}) }],
					isError: true,
				};
			}
		},
	);

}
