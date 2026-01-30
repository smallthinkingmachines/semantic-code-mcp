/**
 * Cross-encoder reranking for improved search precision.
 * Uses @huggingface/transformers (Transformers.js v3) for cross-encoder models.
 */

import {
  pipeline,
  env,
  type TextClassificationPipeline,
} from '@huggingface/transformers';
import type { SearchResult } from '../store/index.js';

// Reuse cache configuration
env.cacheDir = process.env.HOME
  ? `${process.env.HOME}/.cache/semantic-code-mcp/transformers`
  : '/tmp/.cache/semantic-code-mcp/transformers';

env.allowLocalModels = true;
env.allowRemoteModels = true;

export interface RerankerOptions {
  /** Model to use for reranking */
  model?: string;
  /** Data type for model weights */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Progress callback */
  onProgress?: (message: string) => void;
}

// Default cross-encoder model optimized for retrieval reranking
const DEFAULT_RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const DEFAULT_DTYPE = 'q8';

// Singleton pipeline instance
let rerankerPipeline: TextClassificationPipeline | null = null;
let rerankerLoadingPromise: Promise<TextClassificationPipeline> | null = null;
let currentRerankerModel: string | null = null;

/**
 * Initialize the reranker pipeline
 */
async function getRerankerPipeline(
  model: string = DEFAULT_RERANKER_MODEL,
  dtype: 'fp32' | 'fp16' | 'q8' | 'q4' = DEFAULT_DTYPE,
  onProgress?: (message: string) => void
): Promise<TextClassificationPipeline> {
  if (rerankerPipeline && currentRerankerModel === model) {
    return rerankerPipeline;
  }

  if (rerankerLoadingPromise && currentRerankerModel === model) {
    return rerankerLoadingPromise;
  }

  rerankerLoadingPromise = (async () => {
    onProgress?.(`Loading reranker model: ${model}`);

    try {
      const pipe = await pipeline('text-classification', model, {
        dtype,
      });
      onProgress?.('Reranker model loaded');
      rerankerPipeline = pipe;
      currentRerankerModel = model;
      return pipe;
    } catch (error) {
      rerankerLoadingPromise = null;
      throw new Error(`Failed to load reranker model: ${error}`);
    }
  })();

  return rerankerLoadingPromise;
}

/**
 * Rerank search results using cross-encoder scoring
 */
export async function rerank(
  query: string,
  results: SearchResult[],
  topK: number = 10,
  options: RerankerOptions = {}
): Promise<SearchResult[]> {
  const {
    model = DEFAULT_RERANKER_MODEL,
    dtype = DEFAULT_DTYPE,
    onProgress,
  } = options;

  if (results.length === 0) return [];
  if (results.length <= topK) {
    // Not enough results to rerank, return as-is
    return results;
  }

  try {
    const pipe = await getRerankerPipeline(model, dtype, onProgress);

    // Score each result against the query
    const scoredResults = await Promise.all(
      results.map(async (result) => {
        // Format for cross-encoder: query [SEP] document
        const text = `${query} [SEP] ${result.record.content.slice(0, 512)}`;

        try {
          const output = await pipe(text);
          // Get the relevance score
          const scores = output as Array<{ label: string; score: number }>;
          const relevanceScore = scores.find((s) => s.label === 'LABEL_1')?.score ?? 0;

          return {
            ...result,
            score: relevanceScore,
          };
        } catch {
          // On error, keep original score
          return result;
        }
      })
    );

    // Sort by reranked score and return top K
    return scoredResults
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } catch (error) {
    onProgress?.(`Reranking failed, using original scores: ${error}`);
    // Fall back to original ranking
    return results.slice(0, topK);
  }
}

/**
 * Simple keyword-based score boosting (no ML model required)
 */
export function boostKeywordMatches(
  query: string,
  results: SearchResult[]
): SearchResult[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  return results.map((result) => {
    const content = result.record.content.toLowerCase();
    const name = (result.record.name || '').toLowerCase();
    const signature = (result.record.signature || '').toLowerCase();

    let boost = 0;
    for (const keyword of keywords) {
      // Content match
      if (content.includes(keyword)) {
        boost += 0.1;
      }
      // Name match (higher weight)
      if (name.includes(keyword)) {
        boost += 0.2;
      }
      // Signature match
      if (signature.includes(keyword)) {
        boost += 0.15;
      }
      // Exact word match in name (highest weight)
      if (name.split(/\W+/).includes(keyword)) {
        boost += 0.25;
      }
    }

    return {
      ...result,
      score: Math.min(result.score + boost, 1.0),
    };
  });
}

/**
 * Preload the reranker model
 */
export async function preloadReranker(options: RerankerOptions = {}): Promise<void> {
  const {
    model = DEFAULT_RERANKER_MODEL,
    dtype = DEFAULT_DTYPE,
    onProgress,
  } = options;
  await getRerankerPipeline(model, dtype, onProgress);
}
