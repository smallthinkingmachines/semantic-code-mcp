/**
 * Hybrid search orchestration combining vector similarity, keyword matching, and reranking.
 */

import type { VectorStore, SearchResult } from '../store/index.js';
import { embedQuery } from '../embedder/index.js';
import { rerank, boostKeywordMatches } from './reranker.js';

export interface SearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Optional file path filter (glob pattern) */
  filePattern?: string;
  /** Optional directory scope */
  path?: string;
  /** Whether to use cross-encoder reranking */
  useReranking?: boolean;
  /** Number of candidates for vector search before reranking */
  candidateMultiplier?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
}

export interface HybridSearchResult extends SearchResult {
  /** Combined score from multiple signals */
  combinedScore: number;
  /** Vector similarity score */
  vectorScore: number;
  /** Keyword match score */
  keywordScore: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_MULTIPLIER = 5;

/**
 * Build a LanceDB filter string from search options
 */
function buildFilter(options: SearchOptions): string | undefined {
  const conditions: string[] = [];

  if (options.path) {
    // Filter by directory path prefix
    const pathPrefix = options.path.replace(/'/g, "''");
    conditions.push(`filePath LIKE '${pathPrefix}%'`);
  }

  if (options.filePattern) {
    // Convert glob pattern to SQL LIKE pattern
    // This is a simplified conversion
    const likePattern = options.filePattern
      .replace(/\*\*/g, '%')
      .replace(/\*/g, '%')
      .replace(/\?/g, '_')
      .replace(/'/g, "''");
    conditions.push(`filePath LIKE '%${likePattern}'`);
  }

  return conditions.length > 0 ? conditions.join(' AND ') : undefined;
}

/**
 * Perform hybrid search combining vector similarity and keyword matching
 */
export async function hybridSearch(
  query: string,
  store: VectorStore,
  options: SearchOptions = {}
): Promise<HybridSearchResult[]> {
  const {
    limit = DEFAULT_LIMIT,
    useReranking = true,
    candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER,
    onProgress,
  } = options;

  // Check if store is empty
  const isEmpty = await store.isEmpty();
  if (isEmpty) {
    onProgress?.('Index is empty. Run indexing first.');
    return [];
  }

  // Step 1: Generate query embedding
  onProgress?.('Generating query embedding...');
  const { embedding: queryVector } = await embedQuery(query, { onProgress });

  // Step 2: Vector similarity search (get more candidates for reranking)
  const candidateCount = useReranking ? limit * candidateMultiplier : limit;
  const filter = buildFilter(options);

  onProgress?.(`Searching for ${candidateCount} candidates...`);
  const vectorResults = await store.vectorSearch(queryVector, candidateCount, filter);

  if (vectorResults.length === 0) {
    onProgress?.('No matching results found');
    return [];
  }

  // Step 3: Apply keyword boosting
  onProgress?.('Applying keyword matching...');
  const boostedResults = boostKeywordMatches(query, vectorResults);

  // Step 4: Optional cross-encoder reranking
  let finalResults: SearchResult[];
  if (useReranking && boostedResults.length > limit) {
    onProgress?.('Reranking results...');
    try {
      finalResults = await rerank(query, boostedResults, limit, { onProgress });
    } catch (error) {
      onProgress?.(`Reranking failed: ${error}`);
      // Fall back to boosted results without reranking
      finalResults = boostedResults.slice(0, limit);
    }
  } else {
    finalResults = boostedResults.slice(0, limit);
  }

  // Convert to HybridSearchResult
  return finalResults.map((result, index) => {
    const originalVector = vectorResults.find((r) => r.record.id === result.record.id);
    const boosted = boostedResults.find((r) => r.record.id === result.record.id);

    return {
      ...result,
      combinedScore: result.score,
      vectorScore: originalVector?.score ?? 0,
      keywordScore: boosted ? boosted.score - (originalVector?.score ?? 0) : 0,
    };
  });
}

/**
 * Simple vector-only search (faster, for when speed is priority)
 */
export async function vectorOnlySearch(
  query: string,
  store: VectorStore,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = DEFAULT_LIMIT, onProgress } = options;

  // Generate query embedding
  onProgress?.('Generating query embedding...');
  const { embedding: queryVector } = await embedQuery(query, { onProgress });

  // Vector search
  const filter = buildFilter(options);
  onProgress?.(`Searching...`);
  const results = await store.vectorSearch(queryVector, limit, filter);

  return results;
}

/**
 * Format search results for display
 */
export function formatSearchResults(results: HybridSearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  return results
    .map((result, index) => {
      const { record, combinedScore } = result;
      const name = record.name || 'anonymous';
      const location = `${record.filePath}:${record.startLine}-${record.endLine}`;
      const scoreStr = (combinedScore * 100).toFixed(1);

      let output = `${index + 1}. [${scoreStr}%] ${name} (${record.nodeType})\n`;
      output += `   ${location}\n`;

      if (record.signature) {
        output += `   Signature: ${record.signature.slice(0, 80)}${record.signature.length > 80 ? '...' : ''}\n`;
      }

      // Show a snippet of the content
      const snippet = record.content
        .split('\n')
        .slice(0, 3)
        .join('\n')
        .slice(0, 150);
      output += `   ${snippet}${record.content.length > 150 ? '...' : ''}\n`;

      return output;
    })
    .join('\n');
}

export { rerank, boostKeywordMatches } from './reranker.js';
