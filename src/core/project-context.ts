/**
 * Project Context Cache — Layer 1
 *
 * Disk-persistent cache that stores a compact "orientation snapshot" per Figma file.
 * Survives server restarts so repeated Claude Code sessions skip the initial
 * "what's in this file?" API calls.
 *
 * - TTL: 30 minutes (design files don't change that fast between sessions)
 * - Stale-while-revalidate: returns stale data immediately, refreshes in background
 * - Disk path: ~/.config/figma-console-mcp/context/{fileKey}.json
 * - Graceful degradation: disk write failures fall back to memory-only
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { FigmaAPI } from './figma-api.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'project-context' });

const CONTEXT_DIR = join(homedir(), '.config', 'figma-console-mcp', 'context');
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SCHEMA_VERSION = '1.2.0';
const MAX_NAMES = 50; // Cap component/set name lists

// ─── ProjectContext interface ──────────────────────────────────────────────

export interface ProjectContext {
	version: string;
	fileKey: string;
	fileName?: string;
	generatedAt: number;
	lastAccessedAt: number;

	pages: Array<{ id: string; name: string; topLevelFrameCount: number }>;

	components: {
		total: number;
		/** Component set names first, then standalone components (not in a set) */
		names: string[];
		/** Component key map: name → { key, nodeId } for imports and instantiation */
		keyMap: Record<string, { key: string; nodeId: string }>;
	};

	componentSets: {
		total: number;
		names: string[];
		/** Component set key map: name → { key, nodeId } for imports and instantiation */
		keyMap: Record<string, { key: string; nodeId: string }>;
	};

	variables: {
		totalVariables: number;
		collections: Array<{
			id: string;
			name: string;
			modeCount: number;
			variableCount: number;
		}>;
		typeBreakdown: Record<string, number>;
		/** Where variable data came from: 'local' | 'published' | 'both' | 'boundVariables' | 'none' */
		source: 'local' | 'published' | 'both' | 'boundVariables' | 'none';
		/** If variable endpoints failed, explains why (e.g. missing scope) */
		sourceError?: string;
	};

	styles: {
		colorCount: number;
		textCount: number;
		effectCount: number;
		gridCount: number;
	};

	summary: string;
}

// ─── ProjectContextCache class ─────────────────────────────────────────────

export class ProjectContextCache {
	/** In-memory mirror of disk cache to avoid repeated reads */
	private memory: Map<string, ProjectContext> = new Map();
	/** Track in-progress builds to avoid duplicate concurrent builds */
	private building: Map<string, Promise<ProjectContext>> = new Map();
	private dirEnsured = false;

	/**
	 * Get cached context for a file. Returns null if not cached at all.
	 * Implements stale-while-revalidate: returns stale data immediately and
	 * triggers a background refresh if TTL has expired.
	 */
	async get(fileKey: string, api?: FigmaAPI): Promise<ProjectContext | null> {
		// Try memory first
		let ctx = this.memory.get(fileKey) ?? null;

		// Try disk if not in memory
		if (!ctx) {
			ctx = await this.readFromDisk(fileKey);
			if (ctx) {
				this.memory.set(fileKey, ctx);
			}
		}

		if (!ctx) return null;

		// Update last accessed
		ctx.lastAccessedAt = Date.now();

		// Stale-while-revalidate: if expired, return stale + refresh in background
		if (Date.now() - ctx.generatedAt > TTL_MS && api) {
			logger.debug({ fileKey }, 'Context stale — triggering background refresh');
			this.build(fileKey, api).catch((err) => {
				logger.warn({ fileKey, error: err instanceof Error ? err.message : String(err) }, 'Background context refresh failed');
			});
		}

		return ctx;
	}

	/**
	 * Build (or rebuild) the context for a file from the Figma API.
	 * Deduplicates concurrent builds for the same file.
	 */
	async build(fileKey: string, api: FigmaAPI): Promise<ProjectContext> {
		// Deduplicate concurrent builds
		const existing = this.building.get(fileKey);
		if (existing) return existing;

		const promise = this.doBuild(fileKey, api);
		this.building.set(fileKey, promise);

		try {
			const result = await promise;
			return result;
		} finally {
			this.building.delete(fileKey);
		}
	}

	/**
	 * Invalidate the context for a specific file (both memory and disk).
	 */
	async invalidate(fileKey: string): Promise<void> {
		this.memory.delete(fileKey);
		try {
			const path = this.filePath(fileKey);
			if (existsSync(path)) {
				await unlink(path);
			}
		} catch {
			// Disk cleanup is best-effort
		}
		logger.debug({ fileKey }, 'Project context invalidated');
	}

	/**
	 * Force-rebuild: invalidate then rebuild. Use when the cached data is known-bad
	 * (e.g. built with an invalid token, or after token scope changes).
	 */
	async forceRebuild(fileKey: string, api: FigmaAPI): Promise<ProjectContext> {
		await this.invalidate(fileKey);
		return this.build(fileKey, api);
	}

	/**
	 * Invalidate ALL cached contexts (memory + disk).
	 */
	async invalidateAll(): Promise<void> {
		const keys = [...this.memory.keys()];
		this.memory.clear();
		for (const key of keys) {
			try {
				const path = this.filePath(key);
				if (existsSync(path)) {
					await unlink(path);
				}
			} catch {
				// Best-effort
			}
		}
		logger.debug('All project contexts invalidated');
	}

	/**
	 * List all cached file contexts (from disk).
	 */
	async listCachedFiles(): Promise<Array<{ fileKey: string; fileName?: string; generatedAt: number }>> {
		await this.ensureDir();
		try {
			const files = await readdir(CONTEXT_DIR);
			const results: Array<{ fileKey: string; fileName?: string; generatedAt: number }> = [];
			for (const file of files) {
				if (!file.endsWith('.json')) continue;
				const fileKey = file.replace('.json', '');
				const ctx = this.memory.get(fileKey) ?? (await this.readFromDisk(fileKey));
				if (ctx) {
					results.push({
						fileKey: ctx.fileKey,
						fileName: ctx.fileName,
						generatedAt: ctx.generatedAt,
					});
				}
			}
			return results;
		} catch {
			return [];
		}
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private async doBuild(fileKey: string, api: FigmaAPI): Promise<ProjectContext> {
		logger.info({ fileKey }, 'Building project context');
		const start = Date.now();

		// Three parallel calls:
		// 1. getFile WITHOUT depth — complete components/componentSets/styles metadata maps
		// 2. getFile WITH depth=2 — lightweight page structure for topLevelFrameCount
		// 3. getAllVariables — tries BOTH local + published endpoints with graceful 403 handling
		//    (requires file_variables:read scope; may fail on non-Enterprise or missing scope)
		const [metadataResult, pagesResult, variablesResult] = await Promise.allSettled([
			api.getFile(fileKey),
			api.getFile(fileKey, { depth: 2 }),
			api.getAllVariables(fileKey),
		]);

		// ── Diagnostic dump to disk (temporary — read via Claude Code) ──
		const diagPath = join(homedir(), '.config', 'figma-console-mcp', 'context', '_build-diagnostic.json');
		const diag: Record<string, any> = {
			fileKey,
			timestamp: new Date().toISOString(),
			metadataResult: metadataResult.status,
			pagesResult: pagesResult.status,
			variablesResult: variablesResult.status,
		};

		if (metadataResult.status === 'rejected') {
			diag.metadataError = String(metadataResult.reason);
			logger.warn({ fileKey, error: diag.metadataError }, 'getFile (metadata) failed during context build');
		} else {
			const m = metadataResult.value;
			diag.metadata = {
				hasComponents: !!m?.components,
				componentCount: Object.keys(m?.components ?? {}).length,
				hasComponentSets: !!m?.componentSets,
				componentSetCount: Object.keys(m?.componentSets ?? {}).length,
				hasStyles: !!m?.styles,
				styleCount: Object.keys(m?.styles ?? {}).length,
				sampleStyleKeys: Object.values(m?.styles ?? {}).slice(0, 3).map((s: any) => ({
					name: s.name, styleType: s.styleType, style_type: s.style_type,
				})),
				sampleComponentKeys: Object.values(m?.components ?? {}).slice(0, 3).map((c: any) => ({
					name: c.name, componentSetId: c.componentSetId,
				})),
			};
		}

		if (pagesResult.status === 'rejected') {
			diag.pagesError = String(pagesResult.reason);
			logger.warn({ fileKey, error: diag.pagesError }, 'getFile (pages) failed during context build');
		}

		if (variablesResult.status === 'rejected') {
			diag.variablesError = String(variablesResult.reason);
			logger.warn({ fileKey, error: diag.variablesError }, 'getAllVariables failed during context build');
		} else {
			const allVars = variablesResult.value;
			const localData = allVars.local;
			const publishedData = allVars.published;
			diag.variables = {
				localError: allVars.localError,
				publishedError: allVars.publishedError,
				hasLocal: !allVars.localError,
				hasPublished: !allVars.publishedError,
				localCollectionCount: Object.keys(localData?.variableCollections ?? localData?.meta?.variableCollections ?? {}).length,
				localVariableCount: Object.keys(localData?.variables ?? localData?.meta?.variables ?? {}).length,
				publishedVariableCount: Object.keys(publishedData?.variables ?? publishedData?.meta?.variables ?? {}).length,
			};
		}

		await this.ensureDir();
		writeFile(diagPath, JSON.stringify(diag, null, 2), 'utf-8').catch(() => {});

		// ── Parse file data ──
		const pages: ProjectContext['pages'] = [];
		let fileName: string | undefined;

		// Use pagesResult (depth=2) for page structure + topLevelFrameCount
		const pagesFile = pagesResult.status === 'fulfilled' ? pagesResult.value : null;
		// Use metadataResult (no depth) for complete components/componentSets/styles maps
		const metadataFile = metadataResult.status === 'fulfilled' ? metadataResult.value : null;

		// Prefer metadataFile for fileName, fall back to pagesFile
		fileName = metadataFile?.name ?? pagesFile?.name;

		// Pages from the depth=2 call (has children for frame count)
		const docChildren = pagesFile?.document?.children ?? metadataFile?.document?.children ?? [];
		for (const page of docChildren) {
			pages.push({
				id: page.id,
				name: page.name,
				topLevelFrameCount: (page.children?.length ?? 0),
			});
		}

		// Components, componentSets, styles from the full (no-depth) call
		const fileComponents: Record<string, any> = metadataFile?.components ?? {};
		const fileComponentSets: Record<string, any> = metadataFile?.componentSets ?? {};
		const fileStyles: Record<string, any> = metadataFile?.styles ?? {};

		// ── Parse components ──
		const allComponents = Object.values(fileComponents) as any[];
		const allComponentEntries = Object.entries(fileComponents) as [string, any][];

		// Component names: prefer component SET names (compact, useful for orientation)
		// over individual variant names (verbose, e.g. "Type=Primary, Size=SM, State=Default").
		// Fall back to deduplicated base names from components if no sets exist.
		const allComponentSets = Object.values(fileComponentSets) as any[];
		const allComponentSetEntries = Object.entries(fileComponentSets) as [string, any][];
		const componentSetNames = allComponentSets
			.map((cs: any) => cs.name as string)
			.filter(Boolean)
			.sort()
			.slice(0, MAX_NAMES);

		// Build component set key map: name → { key, nodeId }
		const componentSetKeyMap: Record<string, { key: string; nodeId: string }> = {};
		for (const [nodeId, cs] of allComponentSetEntries) {
			if (cs.name && cs.key) {
				componentSetKeyMap[cs.name] = { key: cs.key, nodeId };
			}
		}

		// Build component key map: name → { key, nodeId }
		// For components in a set, use the set name as prefix for disambiguation
		const componentKeyMap: Record<string, { key: string; nodeId: string }> = {};
		for (const [nodeId, comp] of allComponentEntries) {
			if (comp.name && comp.key) {
				componentKeyMap[comp.name] = { key: comp.key, nodeId };
			}
		}

		// For the components.names list, show component set names first (most useful
		// for orientation), then standalone components not in any set.
		// Standalone names are deduplicated and grouped by base name (before " / ").
		const setNameSet = new Set(componentSetNames);
		const standaloneNames = allComponents
			.filter((c: any) => !c.componentSetId)
			.map((c: any) => c.name as string)
			.filter(Boolean);
		// Deduplicate by base name (e.g. "Icon / Arrow / Down" → "Icon / Arrow")
		// to avoid filling the list with 700+ icon variants
		const standaloneBaseNames = new Set<string>();
		for (const name of standaloneNames) {
			const parts = name.split(' / ');
			// Use first two segments as the base name for grouping
			const base = parts.length > 2 ? `${parts[0]} / ${parts[1]}` : name;
			if (!setNameSet.has(base)) {
				standaloneBaseNames.add(base);
			}
		}
		const componentNames = [
			...componentSetNames,
			...[...standaloneBaseNames].sort(),
		].slice(0, MAX_NAMES);

		// ── Parse styles ──
		// The getFile response may use "styleType" or "style_type" depending on API version.
		// Check both to be safe.
		const allStyles = Object.values(fileStyles) as any[];
		const styleCounts = { colorCount: 0, textCount: 0, effectCount: 0, gridCount: 0 };
		for (const style of allStyles) {
			const st = style.styleType ?? style.style_type;
			switch (st) {
				case 'FILL':
					styleCounts.colorCount++;
					break;
				case 'TEXT':
					styleCounts.textCount++;
					break;
				case 'EFFECT':
					styleCounts.effectCount++;
					break;
				case 'GRID':
					styleCounts.gridCount++;
					break;
			}
		}
		// Log unrecognized style types if any styles aren't being counted
		const countedTotal = styleCounts.colorCount + styleCounts.textCount + styleCounts.effectCount + styleCounts.gridCount;
		if (allStyles.length > 0 && countedTotal < allStyles.length) {
			const typeSet = new Set(allStyles.map((s: any) => s.styleType ?? s.style_type ?? 'undefined'));
			logger.debug({ fileKey, styleTypes: [...typeSet], total: allStyles.length, counted: countedTotal }, 'Some styles have unrecognized types');
		}

		// ── Parse variables (multi-source fallback) ──
		let totalVariables = 0;
		const collections: ProjectContext['variables']['collections'] = [];
		const typeBreakdown: Record<string, number> = {};
		let variableSource: ProjectContext['variables']['source'] = 'none';
		let variableSourceError: string | undefined;

		if (variablesResult.status === 'fulfilled') {
			const allVars = variablesResult.value;
			const localData = allVars.local;
			const publishedData = allVars.published;

			// Determine which sources succeeded
			const hasLocal = !allVars.localError;
			const hasPublished = !allVars.publishedError;

			// Extract collections + variables from local (primary) or published (fallback)
			const varCollections = localData?.variableCollections ?? localData?.meta?.variableCollections ?? {};
			const variables = localData?.variables ?? localData?.meta?.variables ?? {};
			const publishedVars = publishedData?.variables ?? publishedData?.meta?.variables ?? {};

			const localCount = Object.keys(variables).length;
			const publishedCount = Object.keys(publishedVars).length;

			if (hasLocal && localCount > 0) {
				// Primary: local variables (full definitions with collections, modes, types)
				variableSource = hasPublished && publishedCount > 0 ? 'both' : 'local';
				totalVariables = localCount;

				for (const [id, coll] of Object.entries(varCollections) as [string, any][]) {
					collections.push({
						id,
						name: coll.name,
						modeCount: coll.modes?.length ?? 0,
						variableCount: coll.variableIds?.length ?? 0,
					});
				}

				for (const v of Object.values(variables) as any[]) {
					const t = v.resolvedType ?? 'UNKNOWN';
					typeBreakdown[t] = (typeBreakdown[t] ?? 0) + 1;
				}
			} else if (hasPublished && publishedCount > 0) {
				// Fallback: published variables (may lack collection detail but has names + types)
				variableSource = 'published';
				totalVariables = publishedCount;
				variableSourceError = allVars.localError;

				for (const v of Object.values(publishedVars) as any[]) {
					const t = v.resolvedType ?? 'UNKNOWN';
					typeBreakdown[t] = (typeBreakdown[t] ?? 0) + 1;
				}

				logger.info({ fileKey, publishedCount, localError: allVars.localError }, 'Using published variables as fallback (local endpoint failed)');
			} else {
				// Both endpoints failed — record the errors for the boundVariables fallback below
				variableSourceError = [allVars.localError, allVars.publishedError].filter(Boolean).join(' | ');
			}
		} else {
			variableSourceError = variablesResult.status === 'rejected'
				? (variablesResult.reason instanceof Error ? variablesResult.reason.message : String(variablesResult.reason))
				: 'Unknown error';
		}

		// ── Fallback: extract boundVariables from file tree ──
		// When both variable endpoints fail (missing scope, non-Enterprise), we can still
		// report which variable IDs are referenced in the design by walking boundVariables
		// on nodes. This gives the AI a count + property breakdown even without definitions.
		if (variableSource === 'none' && totalVariables === 0) {
			const fileTree = pagesResult.status === 'fulfilled' ? pagesResult.value : metadataFile;
			if (fileTree?.document) {
				const boundVarIds = new Set<string>();
				const boundPropertyCounts: Record<string, number> = {};

				function walkBoundVariables(node: any): void {
					if (node.boundVariables) {
						for (const [prop, binding] of Object.entries(node.boundVariables)) {
							if (Array.isArray(binding)) {
								for (const b of binding) {
									if ((b as any).id) {
										boundVarIds.add((b as any).id);
										boundPropertyCounts[prop] = (boundPropertyCounts[prop] ?? 0) + 1;
									}
								}
							} else if (binding && typeof binding === 'object' && (binding as any).id) {
								boundVarIds.add((binding as any).id);
								boundPropertyCounts[prop] = (boundPropertyCounts[prop] ?? 0) + 1;
							}
						}
					}
					if (node.children) {
						for (const child of node.children) {
							walkBoundVariables(child);
						}
					}
				}

				walkBoundVariables(fileTree.document);

				if (boundVarIds.size > 0) {
					variableSource = 'boundVariables';
					totalVariables = boundVarIds.size;
					// Map bound property names to approximate types
					for (const [prop, count] of Object.entries(boundPropertyCounts)) {
						typeBreakdown[prop] = count;
					}
					logger.info(
						{ fileKey, uniqueVarIds: boundVarIds.size, properties: Object.keys(boundPropertyCounts) },
						'Extracted variable references from boundVariables (variable endpoints unavailable)',
					);
				}
			}

			if (variableSource === 'none') {
				logger.warn(
					{ fileKey, error: variableSourceError },
					'No variable data available. To fix: regenerate your Figma access token with the file_variables:read scope, or ensure Enterprise plan.',
				);
			}
		}

		// ── Build summary ──
		const summaryParts: string[] = [];
		if (fileName) summaryParts.push(`"${fileName}"`);
		summaryParts.push(`${pages.length} page${pages.length !== 1 ? 's' : ''}`);
		if (allComponents.length > 0) summaryParts.push(`${allComponents.length} components`);
		if (allComponentSets.length > 0) summaryParts.push(`${allComponentSets.length} component sets`);
		if (totalVariables > 0) {
			const varDetail = variableSource === 'boundVariables'
				? `${totalVariables} variable references (from boundVariables — full definitions unavailable)`
				: `${totalVariables} variables in ${collections.length} collection${collections.length !== 1 ? 's' : ''}`;
			summaryParts.push(varDetail);
		}
		const totalStyles = allStyles.length;
		if (totalStyles > 0) summaryParts.push(`${totalStyles} styles`);
		if (variableSourceError && variableSource !== 'local' && variableSource !== 'both') {
			summaryParts.push(`[variable source: ${variableSource}, fix: add file_variables:read scope to token]`);
		}
		const summary = `Figma file ${summaryParts.join(', ')}.`;

		const ctx: ProjectContext = {
			version: SCHEMA_VERSION,
			fileKey,
			fileName,
			generatedAt: Date.now(),
			lastAccessedAt: Date.now(),
			pages,
			components: {
				total: allComponents.length,
				names: componentNames,
				keyMap: componentKeyMap,
			},
			componentSets: {
				total: allComponentSets.length,
				names: componentSetNames,
				keyMap: componentSetKeyMap,
			},
			variables: {
				totalVariables,
				collections,
				typeBreakdown,
				source: variableSource,
				...(variableSourceError && { sourceError: variableSourceError }),
			},
			styles: styleCounts,
			summary,
		};

		// Don't persist an empty context caused by total API failure —
		// it would be served as stale data and mask the real problem.
		const isEmpty = pages.length === 0 && allComponents.length === 0 && allStyles.length === 0;
		if (isEmpty) {
			logger.warn({ fileKey }, 'Context build produced empty result (all API calls likely failed) — not caching');
			return ctx;
		}

		// Persist to memory + disk
		this.memory.set(fileKey, ctx);
		await this.writeToDisk(fileKey, ctx);

		const elapsed = Date.now() - start;
		logger.info({ fileKey, elapsed, pages: pages.length, components: allComponents.length, variables: totalVariables }, 'Project context built');

		return ctx;
	}

	private filePath(fileKey: string): string {
		// Sanitize fileKey to prevent path traversal
		const safe = fileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
		return join(CONTEXT_DIR, `${safe}.json`);
	}

	private async ensureDir(): Promise<void> {
		if (this.dirEnsured) return;
		try {
			await mkdir(CONTEXT_DIR, { recursive: true });
			this.dirEnsured = true;
		} catch {
			// Best-effort
		}
	}

	private async readFromDisk(fileKey: string): Promise<ProjectContext | null> {
		try {
			const raw = await readFile(this.filePath(fileKey), 'utf-8');
			const data = JSON.parse(raw) as ProjectContext;
			if (data.version !== SCHEMA_VERSION) return null; // schema mismatch, rebuild
			return data;
		} catch {
			return null;
		}
	}

	private async writeToDisk(fileKey: string, ctx: ProjectContext): Promise<void> {
		await this.ensureDir();
		try {
			await writeFile(this.filePath(fileKey), JSON.stringify(ctx, null, 2), 'utf-8');
		} catch (err) {
			logger.warn({ fileKey, error: err instanceof Error ? err.message : String(err) }, 'Failed to write context to disk (memory-only fallback)');
		}
	}
}
