#!/usr/bin/env node
/**
 * semantic-code-mcp - MCP server for semantic code search
 *
 * Provides AST-aware code chunking, vector embeddings, and hybrid search
 * for AI coding tools (Claude Code, Cursor, Windsurf, Cline, etc.)
 */

// Handle CLI args early, before loading heavy dependencies
import { handleCliArgs } from './utils/version.js';
const cliResult = handleCliArgs(process.argv.slice(2));

// Handle --download-model flag (exits after downloading)
if (cliResult.downloadModel) {
  const { preloadModel } = await import('./embedder/index.js');
  const { env } = await import('@huggingface/transformers');
  console.log('[semantic-code-mcp] Downloading embedding model...');
  try {
    await preloadModel({
      onProgress: (message: string) => console.log(`[semantic-code-mcp] ${message}`),
    });
    console.log(`[semantic-code-mcp] Model downloaded successfully to ${env.cacheDir}`);
    // Use setTimeout to allow ONNX runtime cleanup before exit
    setTimeout(() => process.exit(0), 100);
  } catch (error) {
    console.error('[semantic-code-mcp] Failed to download model:', error);
    process.exit(1);
  }
} else if (cliResult.shouldExit) {
  process.exit(0);
} else {
  // Only start the MCP server if not handling special flags
  startServer();
}

async function startServer() {
  const { existsSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { SemanticSearchTool } = await import('./tools/semantic-search.js');
  const { getDeviceInfo } = await import('./utils/gpu.js');

  // Priority: CLI arg > env var > cwd
  const ROOT_DIR = cliResult.rootDir || process.env.SEMANTIC_CODE_ROOT || process.cwd();

  /**
   * Check if .semantic-code/ exists but is not in .gitignore, and warn the user.
   */
  function checkGitignoreForIndex(rootDir: string): void {
    const indexDir = join(rootDir, '.semantic-code');
    const gitignorePath = join(rootDir, '.gitignore');

    // Only warn if .semantic-code/ directory exists
    if (!existsSync(indexDir)) {
      return;
    }

    // Check if .gitignore exists and contains .semantic-code
    if (existsSync(gitignorePath)) {
      try {
        const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
        // Check for common patterns that would ignore .semantic-code
        const patterns = ['.semantic-code', '.semantic-code/', '.semantic-code/**'];
        const isIgnored = patterns.some(pattern =>
          gitignoreContent.split('\n').some(line => {
            const trimmed = line.trim();
            return trimmed === pattern || trimmed === `/${pattern}`;
          })
        );
        if (isIgnored) {
          return; // Already in .gitignore
        }
      } catch {
        // If we can't read .gitignore, continue to warn
      }
    }

    console.error('[semantic-code-mcp] Warning: .semantic-code/ directory exists but is not in .gitignore');
    console.error('[semantic-code-mcp] Add ".semantic-code/" to your .gitignore to avoid committing the index');
  }

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
        use_reranking: z.boolean().default(true).describe('Use cross-encoder reranking for better precision (default: true)'),
        candidate_multiplier: z.number().int().min(1).max(20).default(5).describe('Candidate multiplier for reranking, 1-20 (default: 5)'),
      },
      outputSchema: {
        results: z.array(SearchResultSchema).describe('Array of matching code chunks'),
        totalResults: z.number().describe('Number of results returned'),
        query: z.string().describe('The original search query'),
      },
    },
    async ({ query, path, limit, file_pattern, use_reranking, candidate_multiplier }) => {
      // Log progress to stderr (not stdout which is for MCP protocol)
      const onProgress = (message: string) => {
        console.error(`[semantic-code-mcp] ${message}`);
      };

      try {
        const result = await searchTool.execute(
          { query, path, limit, file_pattern, use_reranking, candidate_multiplier },
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

  console.error('[semantic-code-mcp] Starting server...');
  console.error(`[semantic-code-mcp] Root directory: ${ROOT_DIR}`);
  console.error(`[semantic-code-mcp] ${getDeviceInfo()}`);

  // Warn if .semantic-code/ exists but not in .gitignore
  checkGitignoreForIndex(ROOT_DIR);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[semantic-code-mcp] Server running on stdio');
}
