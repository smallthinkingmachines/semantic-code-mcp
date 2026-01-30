#!/usr/bin/env node
/**
 * semantic-code-mcp - MCP server for semantic code search
 *
 * Provides AST-aware code chunking, vector embeddings, and hybrid search
 * for AI coding tools (Claude Code, Cursor, Windsurf, Cline, etc.)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SemanticSearchTool } from './tools/semantic-search.js';

// Get the root directory from environment or command line
const ROOT_DIR = process.env.SEMANTIC_CODE_ROOT || process.cwd();
const INDEX_DIR = process.env.SEMANTIC_CODE_INDEX;

// Create the semantic search tool handler
const searchTool = new SemanticSearchTool(ROOT_DIR, INDEX_DIR);

// Create MCP server using the new McpServer API
const server = new McpServer({
  name: 'semantic-code-mcp',
  version: '0.1.0',
});

// Define output schema for structured responses
const SearchResultSchema = z.object({
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  name: z.string().nullable(),
  nodeType: z.string(),
  score: z.number(),
  content: z.string(),
  signature: z.string().nullable(),
});

const OutputSchema = z.object({
  results: z.array(SearchResultSchema),
  totalResults: z.number(),
  query: z.string(),
});

// Register the semantic_search tool with input and output schemas
server.registerTool(
  'semantic_search',
  {
    title: 'Semantic Code Search',
    description: `Search code semantically using natural language queries.
Finds relevant code by understanding meaning, not just keywords.
Useful for finding implementations, usage patterns, or related code.
On first use, indexes the codebase (may take a moment for large projects).`,
    inputSchema: {
      query: z.string().min(1).describe('Natural language query describing what you are looking for'),
      path: z.string().optional().describe('Optional directory path to scope the search'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return (default: 10)'),
      file_pattern: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.ts", "**/*.py")'),
    },
    outputSchema: {
      results: z.array(SearchResultSchema).describe('Array of matching code chunks'),
      totalResults: z.number().describe('Number of results returned'),
      query: z.string().describe('The original search query'),
    },
  },
  async ({ query, path, limit, file_pattern }) => {
    // Log progress to stderr (not stdout which is for MCP protocol)
    const onProgress = (message: string) => {
      console.error(`[semantic-code-mcp] ${message}`);
    };

    try {
      const result = await searchTool.execute(
        { query, path, limit, file_pattern },
        onProgress
      );
      const formatted = searchTool.formatResults(result);

      // Return both text content and structured content
      const structuredOutput = {
        results: result.results,
        totalResults: result.totalResults,
        query: result.query,
      };

      return {
        content: [{ type: 'text', text: formatted }],
        structuredContent: structuredOutput,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[semantic-code-mcp] Error: ${errorMessage}`);

      return {
        content: [{ type: 'text', text: `Error executing semantic search: ${errorMessage}` }],
        isError: true,
      };
    }
  }
);

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('[semantic-code-mcp] Shutting down...');
  await searchTool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('[semantic-code-mcp] Shutting down...');
  await searchTool.close();
  process.exit(0);
});

// Start server
async function main() {
  console.error('[semantic-code-mcp] Starting server...');
  console.error(`[semantic-code-mcp] Root directory: ${ROOT_DIR}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[semantic-code-mcp] Server running on stdio');
}

main().catch((error) => {
  console.error('[semantic-code-mcp] Fatal error:', error);
  process.exit(1);
});
