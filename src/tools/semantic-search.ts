/**
 * MCP tool definition for semantic code search.
 * Provides the semantic_search tool with Zod schema validation.
 */

import { z } from 'zod';
import * as path from 'path';
import { VectorStore } from '../store/index.js';
import { hybridSearch, formatSearchResults, type HybridSearchResult } from '../search/index.js';
import { indexDirectory, FileWatcher } from '../watcher/index.js';
import { PathTraversalError } from '../errors.js';

/**
 * Checks if a given path resolves to a location within the allowed root directory.
 *
 * This function prevents path traversal attacks where an attacker attempts to
 * access files outside the intended directory by using relative path components
 * like `../` or absolute paths.
 *
 * ## How it works
 *
 * 1. Resolves both paths to absolute form using `path.resolve()`
 * 2. Checks if the test path starts with the root path + separator
 * 3. Also allows the test path to equal the root exactly
 *
 * The separator check (`resolvedRoot + path.sep`) prevents false positives where
 * a sibling directory shares a prefix (e.g., `/home/user/project` vs `/home/user/project2`).
 *
 * ## Attack vectors prevented
 *
 * - **Relative traversal**: `../../../etc/passwd`
 * - **Absolute paths**: `/etc/passwd`, `/var/log/auth.log`
 * - **Mixed traversal**: `src/../../etc/passwd`
 * - **URL-encoded**: `..%2F..%2Fetc%2Fpasswd` (when decoded before calling)
 * - **Null byte injection**: `../etc/passwd\x00.txt` (handled by path.resolve)
 *
 * ## Platform considerations
 *
 * - Uses `path.sep` for cross-platform compatibility (/ on Unix, \ on Windows)
 * - `path.resolve()` normalizes separators and handles . and .. components
 * - Windows UNC paths and drive letters are handled correctly
 *
 * @param testPath - The path to validate (can be relative or absolute)
 * @param rootDir - The allowed root directory (should be an absolute path)
 * @returns `true` if testPath resolves to a location within rootDir; `false` otherwise
 *
 * @example
 * ```typescript
 * const root = '/home/user/project';
 *
 * // Safe paths - within root
 * isPathWithinRoot('src/utils', root)           // true
 * isPathWithinRoot('/home/user/project/src', root) // true
 * isPathWithinRoot('.', root)                   // true (equals root)
 *
 * // Unsafe paths - escape attempts
 * isPathWithinRoot('../../../etc/passwd', root) // false
 * isPathWithinRoot('/etc/passwd', root)         // false
 * isPathWithinRoot('src/../../other', root)     // false
 *
 * // Edge case - sibling directory
 * isPathWithinRoot('/home/user/project2', root) // false (not a prefix match)
 * ```
 *
 * @security This function is critical for preventing unauthorized file access.
 *           Always validate user-provided paths before using them in file operations.
 */
function isPathWithinRoot(testPath: string, rootDir: string): boolean {
  const resolvedPath = path.resolve(rootDir, testPath);
  const resolvedRoot = path.resolve(rootDir);

  // Ensure the resolved path starts with the root directory
  return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
}

/**
 * Validates that a search path is safe and within the allowed root directory.
 *
 * This function should be called on all user-provided paths before they are
 * used in search operations. It acts as a security gate to prevent directory
 * traversal attacks.
 *
 * @param searchPath - The path provided by the user (may be relative or absolute)
 * @param rootDir - The root directory that the search is scoped to
 * @throws {PathTraversalError} If the path resolves to a location outside the root directory.
 *         The error message includes the offending path for debugging/logging.
 *
 * @example
 * ```typescript
 * const root = '/home/user/project';
 *
 * // Safe - no error thrown
 * validateSearchPath('src/utils', root);
 * validateSearchPath('/home/user/project/lib', root);
 *
 * // Unsafe - throws PathTraversalError
 * validateSearchPath('../../../etc/passwd', root);
 * // Error: Path traversal detected: "../../../etc/passwd" is outside the allowed root directory
 * ```
 *
 * @security Call this function before any path is used in file system operations
 *           or passed to search filters. Failing to validate paths can lead to
 *           information disclosure or unauthorized data access.
 */
function validateSearchPath(searchPath: string, rootDir: string): void {
  if (!isPathWithinRoot(searchPath, rootDir)) {
    throw new PathTraversalError(
      `Path traversal detected: "${searchPath}" is outside the allowed root directory`
    );
  }
}

/**
 * Zod schema for semantic_search tool input
 */
export const SemanticSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural language query describing what you are looking for'),
  path: z
    .string()
    .optional()
    .describe('Optional directory path to scope the search'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (default: 10)'),
  file_pattern: z
    .string()
    .optional()
    .describe('Optional glob pattern to filter files (e.g., "*.ts", "**/*.py")'),
  use_reranking: z
    .boolean()
    .default(true)
    .describe('Use cross-encoder reranking for better precision (default: true)'),
  candidate_multiplier: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Candidate multiplier for reranking, 1-20 (default: 5)'),
});

export type SemanticSearchInput = z.infer<typeof SemanticSearchInputSchema>;

/** Input type before Zod parsing (with optional limit) */
export type SemanticSearchRawInput = z.input<typeof SemanticSearchInputSchema>;

/**
 * Tool output format
 */
export interface SemanticSearchOutput {
  results: Array<{
    file: string;
    startLine: number;
    endLine: number;
    name: string | null;
    nodeType: string;
    score: number;
    content: string;
    signature: string | null;
  }>;
  totalResults: number;
  query: string;
  indexStats: {
    totalChunks: number;
    indexed: boolean;
  };
}

/**
 * Semantic search tool handler
 */
export class SemanticSearchTool {
  private store: VectorStore;
  private watcher: FileWatcher | null = null;
  private rootDir: string;
  private indexed = false;
  private indexingPromise: Promise<void> | null = null;

  constructor(rootDir: string, indexDir?: string) {
    this.rootDir = path.resolve(rootDir);
    const storeDir = indexDir || path.join(this.rootDir, '.semantic-code', 'index');
    this.store = new VectorStore({ indexDir: storeDir });
  }

  /**
   * Get tool definition for MCP
   */
  getToolDefinition() {
    return {
      name: 'semantic_search',
      description: `Search code semantically using natural language queries.
Finds relevant code by understanding meaning, not just keywords.
Useful for finding implementations, usage patterns, or related code.
On first use, indexes the codebase (may take a moment for large projects).`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query describing what you are looking for',
          },
          path: {
            type: 'string',
            description: 'Optional directory path to scope the search',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
            default: 10,
          },
          file_pattern: {
            type: 'string',
            description: 'Optional glob pattern to filter files (e.g., "*.ts", "**/*.py")',
          },
          use_reranking: {
            type: 'boolean',
            description: 'Use cross-encoder reranking for better precision (default: true)',
            default: true,
          },
          candidate_multiplier: {
            type: 'number',
            description: 'Candidate multiplier for reranking, 1-20 (default: 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    };
  }

  /**
   * Ensure index is built (lazy indexing)
   */
  private async ensureIndexed(onProgress?: (message: string) => void): Promise<void> {
    if (this.indexed) return;

    // Avoid concurrent indexing
    if (this.indexingPromise) {
      await this.indexingPromise;
      return;
    }

    await this.store.initialize();

    // Check if index has data
    const isEmpty = await this.store.isEmpty();
    if (!isEmpty) {
      this.indexed = true;
      return;
    }

    // Build index
    this.indexingPromise = (async () => {
      onProgress?.('Building semantic index (first-time setup)...');

      await indexDirectory({
        rootDir: this.rootDir,
        store: this.store,
        onProgress,
      });

      this.indexed = true;
      this.indexingPromise = null;
    })();

    await this.indexingPromise;
  }

  /**
   * Execute semantic search
   */
  async execute(
    input: SemanticSearchRawInput,
    onProgress?: (message: string) => void
  ): Promise<SemanticSearchOutput> {
    // Validate input and apply defaults
    const validated = SemanticSearchInputSchema.parse(input);

    // Ensure index is built
    await this.ensureIndexed(onProgress);

    // Resolve search path
    let searchPath: string | undefined;
    if (validated.path) {
      searchPath = path.isAbsolute(validated.path)
        ? validated.path
        : path.join(this.rootDir, validated.path);

      // Validate that the path is within the root directory
      validateSearchPath(searchPath, this.rootDir);
    }

    // Perform hybrid search
    const results = await hybridSearch(validated.query, this.store, {
      limit: validated.limit,
      path: searchPath,
      filePattern: validated.file_pattern,
      useReranking: validated.use_reranking,
      candidateMultiplier: validated.candidate_multiplier,
      onProgress,
    });

    // Get index stats
    const totalChunks = await this.store.count();

    return {
      results: results.map((r) => ({
        file: r.record.filePath,
        startLine: r.record.startLine,
        endLine: r.record.endLine,
        name: r.record.name,
        nodeType: r.record.nodeType,
        score: Math.round(r.combinedScore * 100) / 100,
        content: r.record.content,
        signature: r.record.signature,
      })),
      totalResults: results.length,
      query: validated.query,
      indexStats: {
        totalChunks,
        indexed: this.indexed,
      },
    };
  }

  /**
   * Format results for display
   */
  formatResults(output: SemanticSearchOutput): string {
    if (output.results.length === 0) {
      return `No results found for query: "${output.query}"`;
    }

    let formatted = `Found ${output.totalResults} results for: "${output.query}"\n\n`;

    for (let i = 0; i < output.results.length; i++) {
      const r = output.results[i];
      if (!r) continue;

      const name = r.name || 'anonymous';
      const location = `${r.file}:${r.startLine}-${r.endLine}`;
      const scoreStr = (r.score * 100).toFixed(0);

      formatted += `${i + 1}. [${scoreStr}%] ${name} (${r.nodeType})\n`;
      formatted += `   Location: ${location}\n`;

      if (r.signature) {
        const sig = r.signature.length > 80 ? r.signature.slice(0, 77) + '...' : r.signature;
        formatted += `   Signature: ${sig}\n`;
      }

      // Show snippet
      const snippet = r.content.split('\n').slice(0, 5).join('\n');
      formatted += `   ---\n`;
      formatted += snippet
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n');
      formatted += '\n\n';
    }

    return formatted;
  }

  /**
   * Start file watcher for live updates
   */
  startWatcher(onProgress?: (message: string) => void): void {
    if (this.watcher?.isRunning()) return;

    this.watcher = new FileWatcher({
      rootDir: this.rootDir,
      store: this.store,
      onProgress,
    });
    this.watcher.start();
  }

  /**
   * Stop file watcher
   */
  async stopWatcher(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Force re-index
   */
  async reindex(onProgress?: (message: string) => void): Promise<void> {
    await this.store.clear();
    this.indexed = false;
    await this.ensureIndexed(onProgress);
  }

  /**
   * Close resources
   */
  async close(): Promise<void> {
    await this.stopWatcher();
    await this.store.close();
  }
}
