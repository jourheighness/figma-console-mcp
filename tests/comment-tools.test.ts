/**
 * Comment Tools Tests
 *
 * Unit tests for the unified figma_comments tool (action: get | post | delete).
 * Tests the registerCommentTools() function with a mock McpServer and FigmaAPI.
 */

import { registerCommentTools } from "../src/core/comment-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

/** Captures tool registrations from server.tool() calls */
interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn((...args: any[]) => {
			// server.tool() can be called with 4 or 5 args:
			// (name, desc, schema, handler) or (name, desc, schema, annotations, handler)
			const name = args[0];
			const description = args[1];
			const schema = args[2];
			const handler = typeof args[3] === "function" ? args[3] : args[4];
			tools[name] = { name, description, schema, handler };
		}),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getComments: jest.fn().mockResolvedValue({ comments: [] }),
		postComment: jest.fn().mockResolvedValue({
			id: "comment-123",
			message: "Test comment",
			created_at: "2025-01-15T10:00:00Z",
			user: { handle: "designer", img_url: "" },
			client_meta: null,
			order_id: "1",
		}),
		deleteComment: jest.fn().mockResolvedValue({}),
		...overrides,
	};
}

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/My-File";
const MOCK_FILE_KEY = "abc123";

// ============================================================================
// Tests
// ============================================================================

describe("Comment Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();

		registerCommentTools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
		);
	});

	it("registers a single figma_comments tool", () => {
		expect(server.tool).toHaveBeenCalledTimes(1);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figma_comments");
	});

	// -----------------------------------------------------------------------
	// action: get
	// -----------------------------------------------------------------------
	describe("action: get", () => {
		const sampleComments = [
			{
				id: "c1",
				message: "Looks good!",
				resolved_at: null,
				user: { handle: "alice" },
				created_at: "2025-01-15T10:00:00Z",
			},
			{
				id: "c2",
				message: "Fixed the spacing",
				resolved_at: "2025-01-16T12:00:00Z",
				user: { handle: "bob" },
				created_at: "2025-01-15T11:00:00Z",
			},
			{
				id: "c3",
				message: "Still needs work",
				resolved_at: null,
				user: { handle: "carol" },
				created_at: "2025-01-15T12:00:00Z",
			},
		];

		it("returns active comments by default (filters resolved)", async () => {
			mockApi.getComments.mockResolvedValue({ comments: sampleComments });

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: false });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(2);
			expect(data.comments.map((c: any) => c.id)).toEqual(["c1", "c3"]);
			expect(data.summary.total).toBe(3);
			expect(data.summary.active).toBe(2);
			expect(data.summary.resolved).toBe(1);
			expect(data.summary.returned).toBe(2);
		});

		it("includes resolved comments when requested", async () => {
			mockApi.getComments.mockResolvedValue({ comments: sampleComments });

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: true });

			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(3);
			expect(data.summary.returned).toBe(3);
		});

		it("passes as_md option to API", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_comments");
			await tool.handler({ action: "get", as_md: true, include_resolved: false });

			expect(mockApi.getComments).toHaveBeenCalledWith(MOCK_FILE_KEY, { as_md: true });
		});

		it("uses explicit fileUrl when provided", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_comments");
			await tool.handler({
				action: "get",
				fileUrl: "https://www.figma.com/design/xyz999/Other-File",
				as_md: false,
				include_resolved: false,
			});

			expect(mockApi.getComments).toHaveBeenCalledWith("xyz999", { as_md: false });
		});

		it("returns error when no URL available", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error on API failure", async () => {
			mockApi.getComments.mockRejectedValue(new Error("Figma API error (403): Forbidden"));

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_failed");
			expect(data.message).toContain("403");
		});
	});

	// -----------------------------------------------------------------------
	// action: post
	// -----------------------------------------------------------------------
	describe("action: post", () => {
		it("posts a basic comment", async () => {
			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "post", message: "Hello from MCP!" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Hello from MCP!",
				undefined,
				undefined,
			);
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.comment.id).toBe("comment-123");
		});

		it("posts a comment pinned to a node", async () => {
			const tool = server._getTool("figma_comments");
			await tool.handler({
				action: "post",
				message: "Check this component",
				node_id: "695:313",
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Check this component",
				{ node_id: "695:313", node_offset: { x: 0, y: 0 } },
				undefined,
			);
		});

		it("posts a comment pinned to a node with offset", async () => {
			const tool = server._getTool("figma_comments");
			await tool.handler({
				action: "post",
				message: "Here specifically",
				node_id: "695:313",
				x: 100,
				y: 200,
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"Here specifically",
				{ node_id: "695:313", node_offset: { x: 100, y: 200 } },
				undefined,
			);
		});

		it("posts a reply to an existing comment", async () => {
			const tool = server._getTool("figma_comments");
			await tool.handler({
				action: "post",
				message: "I agree!",
				reply_to_comment_id: "comment-456",
			});

			expect(mockApi.postComment).toHaveBeenCalledWith(
				MOCK_FILE_KEY,
				"I agree!",
				undefined,
				"comment-456",
			);
		});

		it("returns error when message is missing", async () => {
			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "post" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toContain("message is required");
		});

		it("returns error when no URL available", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "post", message: "test" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error on API failure", async () => {
			mockApi.postComment.mockRejectedValue(new Error("Figma API error (401): Unauthorized"));

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "post", message: "test" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("post_failed");
			expect(data.message).toContain("401");
		});
	});

	// -----------------------------------------------------------------------
	// action: delete
	// -----------------------------------------------------------------------
	describe("action: delete", () => {
		it("deletes a comment by ID", async () => {
			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "delete", comment_id: "comment-123" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.deleteComment).toHaveBeenCalledWith(MOCK_FILE_KEY, "comment-123");
			const data = JSON.parse(result.content[0].text);
			expect(data.success).toBe(true);
			expect(data.deleted_comment_id).toBe("comment-123");
		});

		it("returns error when comment_id is missing", async () => {
			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "delete" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toContain("comment_id is required");
		});

		it("returns error when no URL available", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => null,
			);

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "delete", comment_id: "comment-123" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns error when comment not found", async () => {
			mockApi.deleteComment.mockRejectedValue(new Error("Figma API error (404): Comment not found"));

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "delete", comment_id: "nonexistent" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("delete_failed");
			expect(data.message).toContain("404");
		});

		it("uses explicit fileUrl when provided", async () => {
			const tool = server._getTool("figma_comments");
			await tool.handler({
				action: "delete",
				fileUrl: "https://www.figma.com/design/xyz999/Other-File",
				comment_id: "comment-789",
			});

			expect(mockApi.deleteComment).toHaveBeenCalledWith("xyz999", "comment-789");
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe("edge cases", () => {
		it("returns error for invalid Figma URL", async () => {
			server = createMockServer();
			registerCommentTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: false });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});

		it("handles empty comments array", async () => {
			mockApi.getComments.mockResolvedValue({ comments: [] });

			const tool = server._getTool("figma_comments");
			const result = await tool.handler({ action: "get", as_md: false, include_resolved: false });

			const data = JSON.parse(result.content[0].text);
			expect(data.comments).toHaveLength(0);
			expect(data.summary.total).toBe(0);
			expect(data.summary.active).toBe(0);
			expect(data.summary.resolved).toBe(0);
		});
	});
});
