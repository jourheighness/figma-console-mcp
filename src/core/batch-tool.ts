/**
 * Figma Batch Tool
 * Executes multiple Figma tools in a single MCP request.
 * Each operation runs independently — if one fails, others still succeed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "batch-tool" });

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_OPERATIONS = 10;

interface OperationResult {
	id: string;
	tool: string;
	success: boolean;
	result?: unknown;
	error?: string;
	durationMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Operation timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export function registerBatchTool(server: McpServer): void {
	server.tool(
		"figma_batch",
		"Execute multiple Figma tools in a single batch request. Each operation runs independently — if one fails, others still succeed. Use this to efficiently gather multiple pieces of data (file structure, variables, styles, components) in one call instead of separate requests.",
		{
			operations: z
				.array(
					z.object({
						tool: z
							.string()
							.describe(
								"Name of the Figma tool to call (e.g., 'figma_get_file_data', 'figma_get_variables')",
							),
						args: z
							.record(z.any())
							.optional()
							.default({})
							.describe("Arguments to pass to the tool"),
						id: z
							.string()
							.optional()
							.describe(
								"Optional identifier to label this operation in the results",
							),
					}),
				)
				.min(1)
				.max(MAX_OPERATIONS)
				.describe("Array of tool operations to execute (1-10)"),
			parallel: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"Execute operations in parallel (default) or sequentially",
				),
			verbose: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return full sub-tool responses (true) or compact result summaries (false). Default: false"),
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async ({ operations, parallel, verbose }) => {
			const registeredTools = (server as any)._registeredTools as Record<
				string,
				any
			>;

			// Validate all operations upfront
			for (const op of operations) {
				if (op.tool === "figma_batch") {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: figma_batch cannot call itself recursively.",
							},
						],
						isError: true,
					};
				}
				if (!registeredTools[op.tool]) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Unknown tool "${op.tool}". Use a valid registered tool name.`,
							},
						],
						isError: true,
					};
				}
			}

			async function executeOperation(
				op: (typeof operations)[number],
				index: number,
			): Promise<OperationResult> {
				const id = op.id || `op_${index}`;
				const start = Date.now();

				try {
					const tool = registeredTools[op.tool];

					// Validate args against the tool's input schema
					let parsedArgs = op.args;
					if (tool.inputSchema) {
						parsedArgs = await tool.inputSchema.parseAsync(op.args);
					}

					// Execute the tool handler with timeout
					const result = await withTimeout(
						Promise.resolve(tool.handler(parsedArgs, {})),
						OPERATION_TIMEOUT_MS,
					);

					return {
						id,
						tool: op.tool,
						success: !result.isError,
						result: result.content,
						durationMs: Date.now() - start,
					};
				} catch (err: any) {
					logger.error(
						`Batch operation ${id} (${op.tool}) failed: ${err.message}`,
					);
					return {
						id,
						tool: op.tool,
						success: false,
						error: err.message || String(err),
						durationMs: Date.now() - start,
					};
				}
			}

			let results: OperationResult[];
			if (parallel) {
				results = await Promise.all(
					operations.map((op, i) => executeOperation(op, i)),
				);
			} else {
				results = [];
				for (let i = 0; i < operations.length; i++) {
					results.push(await executeOperation(operations[i], i));
				}
			}

			const succeeded = results.filter((r) => r.success).length;
			const failed = results.length - succeeded;

			const summary = `Batch complete: ${succeeded}/${results.length} succeeded${failed > 0 ? `, ${failed} failed` : ""}`;

			// When verbose=false, compact successful sub-tool results to key fields only
			const outputResults = verbose
				? results
				: results.map((r) => {
					if (!r.success || !r.result) return r;
					try {
						// Parse sub-tool response content to extract summary fields
						const content = Array.isArray(r.result) ? r.result : [r.result];
						const textContent = content.find((c: any) => c.type === "text");
						if (!textContent?.text) return r;
						const parsed = JSON.parse(textContent.text);
						// Extract only top-level summary/key fields
						const compactKeys = ["summary", "id", "name", "count", "success", "componentName", "parityScore", "ai_instruction", "error"];
						const compact: Record<string, unknown> = {};
						for (const key of compactKeys) {
							if (key in parsed) compact[key] = parsed[key];
						}
						// If no recognized keys found, keep original
						if (Object.keys(compact).length === 0) return r;
						return { ...r, result: [{ type: "text", text: JSON.stringify(compact) }] };
					} catch {
						return r;
					}
				});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ summary, results: outputResults }),
					},
				],
			};
		},
	);

	logger.info("Registered figma_batch tool");
}
