/**
 * Team Library Cache
 *
 * Disk-persistent cache for team-wide library data from Figma's team endpoints.
 * Separate from ProjectContextCache because team libraries are team-scoped, not file-scoped.
 *
 * - TTL: 60 minutes (team libraries change less frequently than individual files)
 * - Stale-while-revalidate: returns stale data immediately, refreshes in background
 * - Disk path: ~/.config/figma-console-mcp/context/_team_{teamId}.json
 * - Auto-paginates team endpoints to collect the full catalog
 */

import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { FigmaAPI } from './figma-api.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'team-library' });

const CONTEXT_DIR = join(homedir(), '.config', 'figma-console-mcp', 'context');
const TTL_MS = 60 * 60 * 1000; // 60 minutes
const SCHEMA_VERSION = '1.0.0';

// ─── TeamLibrary interface ─────────────────────────────────────────────────

export interface TeamLibraryComponent {
	key: string;
	name: string;
	description: string;
	file_key: string;
	file_name?: string;
	containing_frame?: { name: string };
}

export interface TeamLibraryComponentSet {
	key: string;
	name: string;
	description: string;
	file_key: string;
	file_name?: string;
}

export interface TeamLibraryStyle {
	key: string;
	name: string;
	style_type: string;
	description: string;
	file_key: string;
	file_name?: string;
}

export interface TeamLibrary {
	version: string;
	teamId: string;
	generatedAt: number;

	components: TeamLibraryComponent[];
	componentSets: TeamLibraryComponentSet[];
	styles: TeamLibraryStyle[];

	summary: string;
}

// ─── TeamLibraryCache class ────────────────────────────────────────────────

export class TeamLibraryCache {
	private memory: Map<string, TeamLibrary> = new Map();
	private building: Map<string, Promise<TeamLibrary>> = new Map();
	private dirEnsured = false;

	/**
	 * Get cached team library. Returns null if not cached.
	 * Implements stale-while-revalidate.
	 */
	async get(teamId: string, api?: FigmaAPI): Promise<TeamLibrary | null> {
		let lib = this.memory.get(teamId) ?? null;

		if (!lib) {
			lib = await this.readFromDisk(teamId);
			if (lib) {
				this.memory.set(teamId, lib);
			}
		}

		if (!lib) return null;

		// Stale-while-revalidate
		if (Date.now() - lib.generatedAt > TTL_MS && api) {
			logger.debug({ teamId }, 'Team library stale — triggering background refresh');
			this.build(teamId, api).catch((err) => {
				logger.warn({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Background team library refresh failed');
			});
		}

		return lib;
	}

	/**
	 * Build (or rebuild) the team library from the Figma API.
	 * Deduplicates concurrent builds for the same team.
	 */
	async build(teamId: string, api: FigmaAPI): Promise<TeamLibrary> {
		const existing = this.building.get(teamId);
		if (existing) return existing;

		const promise = this.doBuild(teamId, api);
		this.building.set(teamId, promise);

		try {
			return await promise;
		} finally {
			this.building.delete(teamId);
		}
	}

	/**
	 * Invalidate team library cache (memory + disk).
	 */
	async invalidate(teamId: string): Promise<void> {
		this.memory.delete(teamId);
		try {
			const path = this.filePath(teamId);
			if (existsSync(path)) {
				await unlink(path);
			}
		} catch {
			// Best-effort
		}
		logger.debug({ teamId }, 'Team library cache invalidated');
	}

	/**
	 * Invalidate ALL team library caches.
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
		logger.debug('All team library caches invalidated');
	}

	/**
	 * Search the cached team library by name pattern.
	 */
	search(
		teamId: string,
		namePattern: string,
		type: 'component' | 'componentSet' | 'style' | 'all' = 'all',
	): Array<{ name: string; key: string; description: string; type: string; file_key: string; file_name?: string; usage?: string }> {
		const lib = this.memory.get(teamId);
		if (!lib) return [];

		const pattern = namePattern.toLowerCase();
		const results: Array<{ name: string; key: string; description: string; type: string; file_key: string; file_name?: string; usage?: string }> = [];

		if (type === 'all' || type === 'componentSet') {
			for (const cs of lib.componentSets) {
				if (cs.name.toLowerCase().includes(pattern)) {
					results.push({
						name: cs.name,
						key: cs.key,
						description: cs.description,
						type: 'componentSet',
						file_key: cs.file_key,
						file_name: cs.file_name,
						usage: 'Pass key as componentKey to figma_instantiate_component. Use variant param to pick a specific variant, or omit for default.',
					});
				}
			}
		}

		if (type === 'all' || type === 'component') {
			for (const c of lib.components) {
				if (c.name.toLowerCase().includes(pattern)) {
					results.push({
						name: c.name,
						key: c.key,
						description: c.description,
						type: 'component',
						file_key: c.file_key,
						file_name: c.file_name,
						...(c.containing_frame && { containing_frame: c.containing_frame.name }),
					});
				}
			}
		}

		if (type === 'all' || type === 'style') {
			for (const s of lib.styles) {
				if (s.name.toLowerCase().includes(pattern)) {
					results.push({
						name: s.name,
						key: s.key,
						description: s.description,
						type: `style:${s.style_type}`,
						file_key: s.file_key,
						file_name: s.file_name,
					});
				}
			}
		}

		return results;
	}

	/**
	 * Get a compact summary of the team library for resource serialization.
	 */
	getCompactSummary(teamId: string): any | null {
		const lib = this.memory.get(teamId);
		if (!lib) return null;

		// Group styles by type
		const stylesByType: Record<string, number> = {};
		for (const s of lib.styles) {
			stylesByType[s.style_type] = (stylesByType[s.style_type] ?? 0) + 1;
		}

		// Group components/sets by source file
		const sourceFiles = new Set<string>();
		for (const c of lib.components) sourceFiles.add(c.file_name ?? c.file_key);
		for (const cs of lib.componentSets) sourceFiles.add(cs.file_name ?? cs.file_key);
		for (const s of lib.styles) sourceFiles.add(s.file_name ?? s.file_key);

		return {
			teamId: lib.teamId,
			generatedAt: lib.generatedAt,
			components: {
				total: lib.components.length,
				names: lib.components.slice(0, 50).map(c => c.name),
			},
			componentSets: {
				total: lib.componentSets.length,
				names: lib.componentSets.slice(0, 50).map(cs => cs.name),
			},
			styles: {
				total: lib.styles.length,
				byType: stylesByType,
				names: lib.styles.slice(0, 30).map(s => s.name),
			},
			sourceFiles: [...sourceFiles].slice(0, 20),
			summary: lib.summary,
			hint: 'Use figma_get_library_components to search by name and get component keys for instantiation.',
		};
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private async doBuild(teamId: string, api: FigmaAPI): Promise<TeamLibrary> {
		logger.info({ teamId }, 'Building team library cache');
		const start = Date.now();

		// Fetch all 3 team endpoints in parallel, each auto-paginated
		const [components, componentSets, styles] = await Promise.all([
			api.fetchAllPages((cursor) =>
				api.getTeamComponents(teamId, { page_size: 1000, ...(cursor !== undefined && { after: cursor }) }),
			).catch((err) => {
				logger.warn({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Failed to fetch team components');
				return [] as any[];
			}),
			api.fetchAllPages((cursor) =>
				api.getTeamComponentSets(teamId, { page_size: 1000, ...(cursor !== undefined && { after: cursor }) }),
			).catch((err) => {
				logger.warn({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Failed to fetch team component sets');
				return [] as any[];
			}),
			api.fetchAllPages((cursor) =>
				api.getTeamStyles(teamId, { page_size: 1000, ...(cursor !== undefined && { after: cursor }) }),
			).catch((err) => {
				logger.warn({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Failed to fetch team styles');
				return [] as any[];
			}),
		]);

		// Map to our compact interface
		const mappedComponents: TeamLibraryComponent[] = components.map((c: any) => ({
			key: c.key,
			name: c.name ?? '',
			description: c.description ?? '',
			file_key: c.file_key ?? '',
			file_name: c.containing_frame?.file_name ?? c.file_name,
			...(c.containing_frame?.name && { containing_frame: { name: c.containing_frame.name } }),
		}));

		const mappedSets: TeamLibraryComponentSet[] = componentSets.map((cs: any) => ({
			key: cs.key,
			name: cs.name ?? '',
			description: cs.description ?? '',
			file_key: cs.file_key ?? '',
			file_name: cs.containing_frame?.file_name ?? cs.file_name,
		}));

		const mappedStyles: TeamLibraryStyle[] = styles.map((s: any) => ({
			key: s.key,
			name: s.name ?? '',
			style_type: s.style_type ?? 'UNKNOWN',
			description: s.description ?? '',
			file_key: s.file_key ?? '',
			file_name: s.file_name,
		}));

		// Build summary
		const parts: string[] = [`Team ${teamId}`];
		if (mappedComponents.length > 0) parts.push(`${mappedComponents.length} components`);
		if (mappedSets.length > 0) parts.push(`${mappedSets.length} component sets`);
		if (mappedStyles.length > 0) parts.push(`${mappedStyles.length} styles`);
		const summary = `Library: ${parts.join(', ')}.`;

		const lib: TeamLibrary = {
			version: SCHEMA_VERSION,
			teamId,
			generatedAt: Date.now(),
			components: mappedComponents,
			componentSets: mappedSets,
			styles: mappedStyles,
			summary,
		};

		// Don't persist empty results (likely auth error)
		const isEmpty = mappedComponents.length === 0 && mappedSets.length === 0 && mappedStyles.length === 0;
		if (isEmpty) {
			logger.warn({ teamId }, 'Team library build produced empty result — not caching');
			return lib;
		}

		this.memory.set(teamId, lib);
		await this.writeToDisk(teamId, lib);

		const elapsed = Date.now() - start;
		logger.info({
			teamId,
			elapsed,
			components: mappedComponents.length,
			componentSets: mappedSets.length,
			styles: mappedStyles.length,
		}, 'Team library cache built');

		return lib;
	}

	private filePath(teamId: string): string {
		const safe = teamId.replace(/[^a-zA-Z0-9_-]/g, '_');
		return join(CONTEXT_DIR, `_team_${safe}.json`);
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

	private async readFromDisk(teamId: string): Promise<TeamLibrary | null> {
		try {
			const raw = await readFile(this.filePath(teamId), 'utf-8');
			const data = JSON.parse(raw) as TeamLibrary;
			if (data.version !== SCHEMA_VERSION) return null;
			return data;
		} catch {
			return null;
		}
	}

	private async writeToDisk(teamId: string, lib: TeamLibrary): Promise<void> {
		await this.ensureDir();
		try {
			await writeFile(this.filePath(teamId), JSON.stringify(lib, null, 2), 'utf-8');
		} catch (err) {
			logger.warn({ teamId, error: err instanceof Error ? err.message : String(err) }, 'Failed to write team library to disk');
		}
	}
}
