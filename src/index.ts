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

  // --- Context Graph (conditional) ---
  const { loadGraphConfig } = await import('./graph/config.js');
  const graphConfig = loadGraphConfig();

  let graphStore: import('./graph/index.js').GraphStore | null = null;
  let sessionManager: import('./graph/session.js').SessionManager | null = null;
  let contextQueryTool: import('./tools/context-query.js').ContextQueryTool | null = null;
  let graphAnnotateTool: import('./tools/graph-annotate.js').GraphAnnotateTool | null = null;
  let sessionSummaryTool: import('./tools/session-summary.js').SessionSummaryTool | null = null;

  if (graphConfig.enabled) {
    const { GraphStore } = await import('./graph/index.js');
    const { SessionManager } = await import('./graph/session.js');
    const { ContextQueryTool } = await import('./tools/context-query.js');
    const { GraphAnnotateTool } = await import('./tools/graph-annotate.js');
    const { SessionSummaryTool } = await import('./tools/session-summary.js');

    const graphDbPath = join(
      INDEX_DIR || join(ROOT_DIR, '.semantic-code', 'index'),
      'graph.db'
    );

    graphStore = new GraphStore(graphDbPath);
    const graphOk = graphStore.initialize();

    if (graphOk) {
      sessionManager = new SessionManager(graphConfig.sessionTtl);
      sessionManager.startCleanup();

      // Wire graph store into search tool for indexing integration
      searchTool.setGraphStore(graphStore);

      contextQueryTool = new ContextQueryTool(searchTool, graphStore, sessionManager, graphConfig);
      graphAnnotateTool = new GraphAnnotateTool(graphStore, sessionManager);
      sessionSummaryTool = new SessionSummaryTool(graphStore, sessionManager);

      console.error('[semantic-code-mcp] Context graph enabled');
    } else {
      graphStore = null;
      console.error('[semantic-code-mcp] Context graph initialization failed, continuing without graph');
    }
  }

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

  const _OutputSchema = z.object({
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

  // Register context graph tools (conditional on graph being enabled)
  if (contextQueryTool) {
    server.registerTool(
      'context_query',
      {
        title: 'Context-Aware Code Search',
        description: `Search code semantically and expand results with graph context.
Returns matching code plus structural neighbors (callers, callees, imports, inheritance).
Requires SEMANTIC_CODE_GRAPH_ENABLED=true.`,
        inputSchema: {
          query: z.string().min(1).describe('Natural language query'),
          path: z.string().optional().describe('Optional directory path to scope the search'),
          limit: z.number().int().min(1).max(50).default(10).describe('Max results (default: 10)'),
          file_pattern: z.string().optional().describe('Optional glob pattern to filter files'),
          depth: z.number().int().min(1).max(3).default(1).describe('Graph traversal depth (1-3, default: 1)'),
          edge_kinds: z.array(z.enum(['calls', 'imports', 'extends', 'implements', 'exports', 'agent_linked'])).optional().describe('Edge types to follow'),
          session_id: z.string().optional().describe('Session ID for tracking visited nodes'),
        },
      },
      async ({ query, path, limit, file_pattern, depth, edge_kinds, session_id }) => {
        const onProgress = (message: string) => {
          console.error(`[semantic-code-mcp] ${message}`);
        };

        try {
          const result = await contextQueryTool!.execute(
            { query, path, limit, file_pattern, depth, edge_kinds, session_id },
            onProgress
          );
          const formatted = contextQueryTool!.formatResults(result);
          return {
            content: [{ type: 'text', text: formatted }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[semantic-code-mcp] Error: ${errorMessage}`);
          return {
            content: [{ type: 'text', text: `Error executing context query: ${errorMessage}` }],
            isError: true,
          };
        }
      }
    );
  }

  if (graphAnnotateTool) {
    server.registerTool(
      'graph_annotate',
      {
        title: 'Annotate Graph Node',
        description: `Write notes on a code chunk and create agent_linked edges.
Use this to record reasoning about code relationships during exploration.
Requires SEMANTIC_CODE_GRAPH_ENABLED=true.`,
        inputSchema: {
          session_id: z.string().min(1).describe('Session ID'),
          node_id: z.string().min(1).describe('Chunk ID to annotate'),
          note: z.string().optional().describe('Note to attach'),
          link_to: z.array(z.string()).optional().describe('Chunk IDs to link to'),
          reasoning: z.string().optional().describe('Reasoning log entry'),
        },
      },
      async ({ session_id, node_id, note, link_to, reasoning }) => {
        try {
          const result = graphAnnotateTool!.execute({ session_id, node_id, note, link_to, reasoning });
          const formatted = graphAnnotateTool!.formatResults(result);
          return {
            content: [{ type: 'text', text: formatted }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `Error annotating: ${errorMessage}` }],
            isError: true,
          };
        }
      }
    );
  }

  if (sessionSummaryTool) {
    server.registerTool(
      'session_summary',
      {
        title: 'Session Summary',
        description: `Get the current state of an agent session.
Shows visited nodes, frontier, stale nodes, annotations, and reasoning log.
Requires SEMANTIC_CODE_GRAPH_ENABLED=true.`,
        inputSchema: {
          session_id: z.string().min(1).describe('Session ID to summarize'),
        },
      },
      async ({ session_id }) => {
        try {
          const result = sessionSummaryTool!.execute({ session_id });
          const formatted = sessionSummaryTool!.formatResults(result);
          return {
            content: [{ type: 'text', text: formatted }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `Error getting session summary: ${errorMessage}` }],
            isError: true,
          };
        }
      }
    );
  }

  // Cleanup on exit
  process.on('SIGINT', async () => {
    console.error('[semantic-code-mcp] Shutting down...');
    sessionManager?.close();
    graphStore?.close();
    await searchTool.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[semantic-code-mcp] Shutting down...');
    sessionManager?.close();
    graphStore?.close();
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
