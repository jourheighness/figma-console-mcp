/**
 * Tests for variables verbosity filtering and response formatting.
 *
 * Covers:
 * - estimateTokens: token size estimation
 * - generateSummary: summary format generation
 * - applyFilters: collection/name/mode filtering + verbosity levels
 */

import { estimateTokens, generateSummary, applyFilters } from '../src/core/figma-tools';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeVariable(overrides: Record<string, any> = {}) {
	return {
		id: 'VariableID:1:1',
		name: 'color/brand/primary',
		resolvedType: 'COLOR',
		valuesByMode: {
			'mode-light': { r: 0.2, g: 0.4, b: 1, a: 1 },
			'mode-dark': { r: 0.3, g: 0.5, b: 1, a: 1 },
		},
		variableCollectionId: 'VariableCollectionId:1:0',
		description: 'Primary brand color',
		remote: false,
		hiddenFromPublishing: false,
		codeSyntax: { WEB: '--color-brand-primary' },
		scopes: ['ALL_FILLS'],
		...overrides,
	};
}

function makeCollection(overrides: Record<string, any> = {}) {
	return {
		id: 'VariableCollectionId:1:0',
		name: 'Primitives',
		modes: [
			{ modeId: 'mode-light', name: 'Light' },
			{ modeId: 'mode-dark', name: 'Dark' },
		],
		variableIds: ['VariableID:1:1', 'VariableID:1:2'],
		...overrides,
	};
}

function makeDataset(varCount = 3) {
	const variables = Array.from({ length: varCount }, (_, i) =>
		makeVariable({
			id: `VariableID:1:${i}`,
			name: `color/brand/${['primary', 'secondary', 'tertiary', 'accent', 'muted'][i % 5]}`,
		})
	);
	return {
		fileKey: 'test-file',
		source: 'desktop_connection',
		timestamp: Date.now(),
		variables,
		variableCollections: [makeCollection()],
	};
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
	it('estimates ~1 token per 4 chars of JSON', () => {
		const data = { hello: 'world' }; // {"hello":"world"} = 17 chars → ceil(17/4) = 5
		expect(estimateTokens(data)).toBe(5);
	});

	it('scales with data size', () => {
		const small = makeDataset(1);
		const large = makeDataset(50);
		expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small));
	});
});

// ---------------------------------------------------------------------------
// generateSummary
// ---------------------------------------------------------------------------

describe('generateSummary', () => {
	it('includes overview counts', () => {
		const data = makeDataset(3);
		const summary = generateSummary(data);
		expect(summary.overview.total_variables).toBe(3);
		expect(summary.overview.total_collections).toBe(1);
	});

	it('groups variables by type', () => {
		const data = makeDataset(2);
		const summary = generateSummary(data);
		expect(summary.variables_by_type).toEqual({ COLOR: 2 });
	});

	it('lists all variable names', () => {
		const data = makeDataset(2);
		const summary = generateSummary(data);
		expect(summary.variable_names).toHaveLength(2);
		expect(summary.variable_names[0]).toMatch(/^color\/brand\//);
	});

	it('includes collection metadata with modes', () => {
		const data = makeDataset(1);
		const summary = generateSummary(data);
		expect(summary.collections[0].name).toBe('Primitives');
		expect(summary.collections[0].modes).toHaveLength(2);
	});

	it('is much smaller than full data', () => {
		const data = makeDataset(50);
		const summaryTokens = estimateTokens(generateSummary(data));
		const fullTokens = estimateTokens(data);
		expect(summaryTokens).toBeLessThan(fullTokens * 0.5);
	});
});

// ---------------------------------------------------------------------------
// applyFilters — collection/name/mode filtering
// ---------------------------------------------------------------------------

describe('applyFilters — filtering', () => {
	it('filters by collection name (case-insensitive)', () => {
		const data = {
			variables: [
				makeVariable({ variableCollectionId: 'col-1' }),
				makeVariable({ id: 'VariableID:2:1', variableCollectionId: 'col-2' }),
			],
			variableCollections: [
				makeCollection({ id: 'col-1', name: 'Primitives' }),
				makeCollection({ id: 'col-2', name: 'Semantic' }),
			],
		};

		const result = applyFilters(data, { collection: 'primitives' }, 'full');
		expect(result.variables).toHaveLength(1);
		expect(result.variables[0].variableCollectionId).toBe('col-1');
		expect(result.variableCollections).toHaveLength(1);
	});

	it('filters by name pattern (regex)', () => {
		const data = {
			variables: [
				makeVariable({ name: 'color/brand/primary' }),
				makeVariable({ id: 'v2', name: 'spacing/base' }),
			],
			variableCollections: [makeCollection()],
		};

		const result = applyFilters(data, { namePattern: '^color' }, 'full');
		expect(result.variables).toHaveLength(1);
		expect(result.variables[0].name).toBe('color/brand/primary');
	});

	it('falls back to substring match on invalid regex', () => {
		const data = {
			variables: [
				makeVariable({ name: 'brand**primary' }),
				makeVariable({ id: 'v2', name: 'spacing/base' }),
			],
			variableCollections: [makeCollection()],
		};

		// "brand**" is invalid regex (nothing to repeat) but valid substring of "brand**primary"
		const result = applyFilters(data, { namePattern: 'brand**' }, 'full');
		expect(result.variables).toHaveLength(1);
		expect(result.variables[0].name).toBe('brand**primary');
	});

	it('filters by mode name', () => {
		const data = {
			variables: [
				makeVariable({
					valuesByMode: { 'mode-light': { r: 1, g: 0, b: 0, a: 1 } },
				}),
			],
			variableCollections: [makeCollection()],
		};

		const result = applyFilters(data, { mode: 'Light' }, 'full');
		expect(result.variables).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// applyFilters — verbosity levels
// ---------------------------------------------------------------------------

describe('applyFilters — verbosity', () => {
	const data = makeDataset(3);

	it('inventory: returns only id, name, resolvedType, collectionId, modeCount', () => {
		const result = applyFilters(data, {}, 'inventory');
		const v = result.variables[0];

		expect(v).toHaveProperty('id');
		expect(v).toHaveProperty('name');
		expect(v).toHaveProperty('resolvedType');
		expect(v).toHaveProperty('variableCollectionId');
		expect(v).toHaveProperty('modeCount', 2);
		// Should NOT have full fields
		expect(v).not.toHaveProperty('valuesByMode');
		expect(v).not.toHaveProperty('description');
		expect(v).not.toHaveProperty('scopes');
		expect(v).not.toHaveProperty('codeSyntax');
	});

	it('summary: returns core fields + modeNames, no valuesByMode', () => {
		const result = applyFilters(data, {}, 'summary');
		const v = result.variables[0];

		expect(v).toHaveProperty('id');
		expect(v).toHaveProperty('name');
		expect(v).toHaveProperty('resolvedType');
		expect(v).toHaveProperty('modeNames');
		expect(v.modeNames).toEqual(['Light', 'Dark']);
		expect(v).not.toHaveProperty('valuesByMode');
		expect(v).not.toHaveProperty('description');
		expect(v).not.toHaveProperty('codeSyntax');
	});

	it('standard: keeps valuesByMode + description + scopes, drops internal fields', () => {
		const result = applyFilters(data, {}, 'standard');
		const v = result.variables[0];

		expect(v).toHaveProperty('valuesByMode');
		expect(v).toHaveProperty('description');
		expect(v).toHaveProperty('scopes');
		expect(v).toHaveProperty('modeMetadata');
		// Should not have internal fields stripped by standard
		expect(v).not.toHaveProperty('codeSyntax');
		expect(v).not.toHaveProperty('remote');
		expect(v).not.toHaveProperty('hiddenFromPublishing');
	});

	it('full: returns all fields untouched', () => {
		const result = applyFilters(data, {}, 'full');
		const v = result.variables[0];

		expect(v).toHaveProperty('valuesByMode');
		expect(v).toHaveProperty('description');
		expect(v).toHaveProperty('codeSyntax');
		expect(v).toHaveProperty('remote');
		expect(v).toHaveProperty('scopes');
	});

	it('inventory is significantly smaller than full', () => {
		const bigData = makeDataset(50);
		const inventory = applyFilters(bigData, {}, 'inventory');
		const full = applyFilters(bigData, {}, 'full');

		const inventorySize = estimateTokens(inventory);
		const fullSize = estimateTokens(full);
		expect(inventorySize).toBeLessThan(fullSize * 0.5);
	});

	it('summary is smaller than standard', () => {
		const bigData = makeDataset(50);
		const summary = applyFilters(bigData, {}, 'summary');
		const standard = applyFilters(bigData, {}, 'standard');

		expect(estimateTokens(summary)).toBeLessThan(estimateTokens(standard));
	});
});

// ---------------------------------------------------------------------------
// applyFilters — verbosity + mode filter interaction
// ---------------------------------------------------------------------------

describe('applyFilters — standard verbosity with mode filter', () => {
	it('filters valuesByMode to single mode when mode specified', () => {
		const data = makeDataset(1);
		const result = applyFilters(data, { mode: 'Light' }, 'standard');
		const v = result.variables[0];

		expect(v.valuesByMode).toBeDefined();
		// Should only have the Light mode
		const modeKeys = Object.keys(v.valuesByMode);
		expect(modeKeys).toHaveLength(1);
		expect(v.selectedMode).toEqual({
			modeId: 'mode-light',
			modeName: 'Light',
		});
	});
});
