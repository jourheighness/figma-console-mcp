/**
 * Session Cache — Layer 3
 *
 * Provides in-memory, session-scoped caching for Figma REST API calls.
 * - TTL: 2 minutes (read-only data doesn't change frequently within a session)
 * - Max entries: 50 (LRU eviction when full)
 * - Request coalescing: concurrent identical requests share one in-flight fetch
 *
 * CachedFigmaAPI extends FigmaAPI, overriding read-only methods with caching.
 * Write methods (postComment, deleteComment) pass through uncached.
 */

import { FigmaAPI, type FigmaAPIConfig } from './figma-api.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'session-cache' });

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_MAX_ENTRIES = 50;

interface CacheEntry {
	data: any;
	timestamp: number;
}

export class SessionCache {
	private cache: Map<string, CacheEntry> = new Map();
	private inflight: Map<string, Promise<any>> = new Map();
	private ttlMs: number;
	private maxEntries: number;
	private hits = 0;
	private misses = 0;

	constructor(options?: { ttlMs?: number; maxEntries?: number }) {
		this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
		this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	/**
	 * Get a cached value or execute the fetcher, with request coalescing.
	 */
	async cachedCall<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
		// Check cache first
		const existing = this.cache.get(key);
		if (existing && Date.now() - existing.timestamp < this.ttlMs) {
			this.hits++;
			// Move to end for LRU ordering (Map preserves insertion order)
			this.cache.delete(key);
			this.cache.set(key, existing);
			logger.debug({ key, hits: this.hits }, 'Session cache hit');
			return existing.data as T;
		}

		this.misses++;

		// Request coalescing — if an identical request is already in flight, share it
		const inflightPromise = this.inflight.get(key);
		if (inflightPromise) {
			logger.debug({ key }, 'Coalescing with in-flight request');
			return inflightPromise as Promise<T>;
		}

		// Execute the fetch and cache the result
		const promise = fetcher()
			.then((data) => {
				this.evictIfNeeded();
				this.cache.set(key, { data, timestamp: Date.now() });
				this.inflight.delete(key);
				return data;
			})
			.catch((err) => {
				this.inflight.delete(key);
				throw err;
			});

		this.inflight.set(key, promise);
		return promise as Promise<T>;
	}

	/**
	 * Invalidate all cache entries for a specific file key.
	 */
	invalidateFile(fileKey: string): void {
		let count = 0;
		for (const key of this.cache.keys()) {
			if (key.includes(`:${fileKey}:`)) {
				this.cache.delete(key);
				count++;
			}
		}
		if (count > 0) {
			logger.debug({ fileKey, evicted: count }, 'Invalidated session cache entries for file');
		}
	}

	/**
	 * Clear all cached data.
	 */
	clear(): void {
		this.cache.clear();
		this.inflight.clear();
		this.hits = 0;
		this.misses = 0;
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): { size: number; hits: number; misses: number; inflightCount: number } {
		return {
			size: this.cache.size,
			hits: this.hits,
			misses: this.misses,
			inflightCount: this.inflight.size,
		};
	}

	/**
	 * Evict the oldest entry if at capacity (LRU — Map iteration order = insertion order).
	 */
	private evictIfNeeded(): void {
		while (this.cache.size >= this.maxEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
				logger.debug({ evictedKey: oldestKey }, 'LRU eviction');
			} else {
				break;
			}
		}
	}
}

// ─── Deterministic cache key helpers ───────────────────────────────────────

/**
 * Build a deterministic cache key from method name, file key, and optional parameters.
 * Sorts param keys to avoid key divergence from insertion order.
 */
function cacheKey(method: string, fileKey: string, params?: Record<string, any>): string {
	if (!params || Object.keys(params).length === 0) {
		return `${method}:${fileKey}`;
	}
	const sortedParts = Object.keys(params)
		.sort()
		.filter((k) => params[k] !== undefined)
		.map((k) => {
			const v = params[k];
			return `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`;
		});
	return `${method}:${fileKey}:${sortedParts.join('&')}`;
}

// ─── CachedFigmaAPI ────────────────────────────────────────────────────────

/**
 * Extends FigmaAPI with transparent session caching on all read-only methods.
 * Write methods (postComment, deleteComment) pass through to the parent.
 */
export class CachedFigmaAPI extends FigmaAPI {
	private sessionCache: SessionCache;

	constructor(config: FigmaAPIConfig, sessionCache: SessionCache) {
		super(config);
		this.sessionCache = sessionCache;
	}

	// ── Read-only overrides ──────────────────────────────────────────────

	override async getFile(
		fileKey: string,
		options?: {
			version?: string;
			ids?: string[];
			depth?: number;
			geometry?: 'paths' | 'screen';
			plugin_data?: string;
			branch_data?: boolean;
		},
	): Promise<any> {
		const key = cacheKey('getFile', fileKey, options as Record<string, any>);
		return this.sessionCache.cachedCall(key, () => super.getFile(fileKey, options));
	}

	override async getNodes(
		fileKey: string,
		nodeIds: string[],
		options?: {
			version?: string;
			depth?: number;
			geometry?: 'paths' | 'screen';
			plugin_data?: string;
		},
	): Promise<any> {
		const key = cacheKey('getNodes', fileKey, {
			ids: nodeIds,
			...(options as Record<string, any>),
		});
		return this.sessionCache.cachedCall(key, () => super.getNodes(fileKey, nodeIds, options));
	}

	override async getComponents(fileKey: string): Promise<any> {
		const key = cacheKey('getComponents', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getComponents(fileKey));
	}

	override async getComponentSets(fileKey: string): Promise<any> {
		const key = cacheKey('getComponentSets', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getComponentSets(fileKey));
	}

	override async getStyles(fileKey: string): Promise<any> {
		const key = cacheKey('getStyles', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getStyles(fileKey));
	}

	override async getLocalVariables(fileKey: string): Promise<any> {
		const key = cacheKey('getLocalVariables', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getLocalVariables(fileKey));
	}

	override async getPublishedVariables(fileKey: string): Promise<any> {
		const key = cacheKey('getPublishedVariables', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getPublishedVariables(fileKey));
	}

	override async getAllVariables(fileKey: string): Promise<{
		local: any;
		published: any;
		localError?: string;
		publishedError?: string;
	}> {
		const key = cacheKey('getAllVariables', fileKey);
		return this.sessionCache.cachedCall(key, () => super.getAllVariables(fileKey));
	}

	override async getComments(
		fileKey: string,
		options?: { as_md?: boolean },
	): Promise<any> {
		const key = cacheKey('getComments', fileKey, options as Record<string, any>);
		return this.sessionCache.cachedCall(key, () => super.getComments(fileKey, options));
	}

	override async getImages(
		fileKey: string,
		nodeIds: string | string[],
		options?: {
			scale?: number;
			format?: 'png' | 'jpg' | 'svg' | 'pdf';
			svg_outline_text?: boolean;
			svg_include_id?: boolean;
			svg_include_node_id?: boolean;
			svg_simplify_stroke?: boolean;
			contents_only?: boolean;
		},
	): Promise<{ images: Record<string, string | null> }> {
		const ids = Array.isArray(nodeIds) ? nodeIds.join(',') : nodeIds;
		const key = cacheKey('getImages', fileKey, {
			ids,
			...(options as Record<string, any>),
		});
		return this.sessionCache.cachedCall(key, () => super.getImages(fileKey, nodeIds, options));
	}

	override async getComponentData(fileKey: string, nodeId: string): Promise<any> {
		const key = cacheKey('getComponentData', fileKey, { nodeId });
		return this.sessionCache.cachedCall(key, () => super.getComponentData(fileKey, nodeId));
	}

	override async searchComponents(fileKey: string, searchTerm: string): Promise<any[]> {
		const key = cacheKey('searchComponents', fileKey, { q: searchTerm });
		return this.sessionCache.cachedCall(key, () => super.searchComponents(fileKey, searchTerm));
	}

	// ── Write methods — NOT overridden, pass through to parent ───────────
	// postComment, deleteComment, getBranchKey all pass through.
	// getBranchKey could be cached but involves write-like branch resolution logic.
}
