/**
 * MCP Context Resources — Layer 2
 *
 * Exposes Figma project context as MCP resources via figma:// URIs.
 * Clients that support resource auto-loading can pre-populate orientation
 * data without tool calls.
 *
 * Resources:
 *   figma://context/current           — context for the currently-open file
 *   figma://context/{fileKey}          — full context for a specific file
 *   figma://context/{fileKey}/components — component inventory subsection
 *   figma://context/{fileKey}/tokens    — variable collections subsection
 *   figma://context/{fileKey}/styles    — style summary subsection
 */

import { writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaAPI } from './figma-api.js';
import { extractFileKey } from './figma-api.js';
import type { ProjectContextCache, ProjectContext } from './project-context.js';
import { createChildLogger } from './logger.js';

const DIAG_DIR = join(homedir(), '.config', 'figma-console-mcp', 'context');
const DIAG_PATH = join(DIAG_DIR, '_read-diagnostic.json');

const logger = createChildLogger({ component: 'context-resources' });

/**
 * Strip heavy keyMap fields from a ProjectContext for resource serialization.
 * The keyMaps are stored in the cache for tool lookups, but are too large
 * (100KB+) to include in auto-loaded resource responses.
 */
function compactContext(ctx: ProjectContext): any {
	return {
		...ctx,
		components: {
			total: ctx.components.total,
			names: ctx.components.names,
			keysAvailable: Object.keys(ctx.components.keyMap).length,
		},
		componentSets: {
			total: ctx.componentSets.total,
			names: ctx.componentSets.names,
			keysAvailable: Object.keys(ctx.componentSets.keyMap).length,
		},
	};
}

/**
 * Register all figma://context/* resources on the MCP server.
 */
export function registerContextResources(
	server: McpServer,
	contextCache: ProjectContextCache,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
): void {
	// ── Static resource: figma://context/current ─────────────────────────
	server.registerResource(
		'figma-context-current',
		'figma://context/current',
		{
			description: 'Project context for the currently-open Figma file. Provides a compact orientation snapshot including pages, components, variables, and styles.',
			mimeType: 'application/json',
		},
		async (_uri) => {
			const url = getCurrentUrl();
			if (!url) {
				return {
					contents: [{
						uri: 'figma://context/current',
						mimeType: 'application/json',
						text: JSON.stringify({ error: 'No Figma file currently connected. Open a file in Figma with the Desktop Bridge plugin.' }),
					}],
				};
			}

			const fileKey = extractFileKey(url);
			if (!fileKey) {
				return {
					contents: [{
						uri: 'figma://context/current',
						mimeType: 'application/json',
						text: JSON.stringify({ error: `Could not extract file key from URL: ${url}` }),
					}],
				};
			}

			const ctx = await getOrBuildContext(fileKey, contextCache, getFigmaAPI);
			return {
				contents: [{
					uri: 'figma://context/current',
					mimeType: 'application/json',
					text: JSON.stringify(compactContext(ctx), null, 2),
				}],
			};
		},
	);

	// ── Template resource: figma://context/{fileKey} ─────────────────────
	server.registerResource(
		'figma-context-file',
		new ResourceTemplate('figma://context/{fileKey}', { list: listCallback(contextCache) }),
		{
			description: 'Full project context for a specific Figma file by file key.',
			mimeType: 'application/json',
		},
		async (_uri, variables) => {
			const fileKey = String(variables.fileKey);
			const ctx = await getOrBuildContext(fileKey, contextCache, getFigmaAPI);
			return {
				contents: [{
					uri: `figma://context/${fileKey}`,
					mimeType: 'application/json',
					text: JSON.stringify(compactContext(ctx), null, 2),
				}],
			};
		},
	);

	// ── Template resource: figma://context/{fileKey}/components ──────────
	server.registerResource(
		'figma-context-components',
		new ResourceTemplate('figma://context/{fileKey}/components', { list: listCallback(contextCache) }),
		{
			description: 'Component inventory for a Figma file: names, counts, and component sets. Use figma_get_component_keys to look up specific component keys for imports/instantiation.',
			mimeType: 'application/json',
		},
		async (_uri, variables) => {
			const fileKey = String(variables.fileKey);
			const ctx = await getOrBuildContext(fileKey, contextCache, getFigmaAPI);
			const compact = compactContext(ctx);
			const subsection = {
				fileKey: ctx.fileKey,
				fileName: ctx.fileName,
				components: compact.components,
				componentSets: compact.componentSets,
			};
			return {
				contents: [{
					uri: `figma://context/${fileKey}/components`,
					mimeType: 'application/json',
					text: JSON.stringify(subsection, null, 2),
				}],
			};
		},
	);

	// ── Template resource: figma://context/{fileKey}/tokens ──────────────
	server.registerResource(
		'figma-context-tokens',
		new ResourceTemplate('figma://context/{fileKey}/tokens', { list: listCallback(contextCache) }),
		{
			description: 'Variable/token collections for a Figma file: collection names, modes, type breakdown.',
			mimeType: 'application/json',
		},
		async (_uri, variables) => {
			const fileKey = String(variables.fileKey);
			const ctx = await getOrBuildContext(fileKey, contextCache, getFigmaAPI);
			const subsection = {
				fileKey: ctx.fileKey,
				fileName: ctx.fileName,
				variables: ctx.variables,
			};
			return {
				contents: [{
					uri: `figma://context/${fileKey}/tokens`,
					mimeType: 'application/json',
					text: JSON.stringify(subsection, null, 2),
				}],
			};
		},
	);

	// ── Template resource: figma://context/{fileKey}/styles ──────────────
	server.registerResource(
		'figma-context-styles',
		new ResourceTemplate('figma://context/{fileKey}/styles', { list: listCallback(contextCache) }),
		{
			description: 'Style summary for a Figma file: color, text, effect, and grid style counts.',
			mimeType: 'application/json',
		},
		async (_uri, variables) => {
			const fileKey = String(variables.fileKey);
			const ctx = await getOrBuildContext(fileKey, contextCache, getFigmaAPI);
			const subsection = {
				fileKey: ctx.fileKey,
				fileName: ctx.fileName,
				styles: ctx.styles,
			};
			return {
				contents: [{
					uri: `figma://context/${fileKey}/styles`,
					mimeType: 'application/json',
					text: JSON.stringify(subsection, null, 2),
				}],
			};
		},
	);

	logger.info('Registered figma://context/* MCP resources');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Get context from cache, or build on-demand if cold.
 */
async function getOrBuildContext(
	fileKey: string,
	cache: ProjectContextCache,
	getFigmaAPI: () => Promise<FigmaAPI>,
): Promise<ProjectContext> {
	const diag: Record<string, any> = {
		timestamp: new Date().toISOString(),
		fileKey,
		step: 'start',
	};

	try {
		diag.step = 'getFigmaAPI';
		const api = await getFigmaAPI();
		diag.step = 'cache.get';
		const cached = await cache.get(fileKey, api);

		if (cached) {
			diag.step = 'cache-hit';
			diag.source = 'cache';
			diag.componentCount = cached.components?.total;
			diag.variableCount = cached.variables?.totalVariables;
			diag.styleCount = (cached.styles?.colorCount ?? 0) + (cached.styles?.textCount ?? 0) + (cached.styles?.effectCount ?? 0) + (cached.styles?.gridCount ?? 0);
			return cached;
		}

		// Cold start — build on demand
		diag.step = 'building';
		logger.info({ fileKey }, 'Building context on first resource access');
		const ctx = await cache.build(fileKey, api);
		diag.step = 'built';
		diag.source = 'fresh-build';
		diag.componentCount = ctx.components?.total;
		diag.componentSetCount = ctx.componentSets?.total;
		diag.variableCount = ctx.variables?.totalVariables;
		diag.collectionCount = ctx.variables?.collections?.length;
		diag.styleCount = (ctx.styles?.colorCount ?? 0) + (ctx.styles?.textCount ?? 0) + (ctx.styles?.effectCount ?? 0) + (ctx.styles?.gridCount ?? 0);
		diag.styleBreakdown = ctx.styles;
		return ctx;
	} catch (err) {
		diag.step = 'error';
		diag.error = err instanceof Error ? err.message : String(err);
		diag.stack = err instanceof Error ? err.stack : undefined;
		throw err;
	} finally {
		// Always write diagnostic
		await mkdir(DIAG_DIR, { recursive: true }).catch(() => {});
		await writeFile(DIAG_PATH, JSON.stringify(diag, null, 2), 'utf-8').catch(() => {});
	}
}

/**
 * Create a list callback for template resources that enumerates cached files.
 */
function listCallback(cache: ProjectContextCache) {
	return async () => {
		const files = await cache.listCachedFiles();
		return {
			resources: files.map((f) => ({
				uri: `figma://context/${f.fileKey}`,
				name: f.fileName ?? f.fileKey,
			})),
		};
	};
}
