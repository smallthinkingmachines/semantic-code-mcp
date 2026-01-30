/**
 * Embedding generator using @huggingface/transformers (Transformers.js v3).
 * Provides 768-dimensional embeddings optimized for code search.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { ModelLoadError, EmbeddingGenerationError } from '../errors.js';
import { detectDevice, type DeviceType } from '../utils/gpu.js';

// Configure transformers.js to use local cache
env.cacheDir = process.env.HOME
  ? `${process.env.HOME}/.cache/semantic-code-mcp/transformers`
  : '/tmp/.cache/semantic-code-mcp/transformers';

// Allow both local and remote models
env.allowLocalModels = true;
env.allowRemoteModels = true;

/**
 * Result from embedding generation.
 */
export interface EmbeddingResult {
  /** The embedding vector (768 dimensions for nomic-embed) */
  embedding: number[];
  /** Number of tokens used */
  tokenCount: number;
}

/**
 * Result from batch embedding with per-item error tracking.
 */
export interface BatchEmbeddingResult {
  /** Successfully generated embeddings */
  results: EmbeddingResult[];
  /** Indices of items that failed to embed */
  failedIndices: number[];
  /** Error messages for failed items (keyed by index) */
  errors: Map<number, string>;
  /** Total items processed */
  totalProcessed: number;
  /** Number of successful embeddings */
  successCount: number;
}

export interface EmbedderOptions {
  /** Model to use (default: nomic-ai/nomic-embed-text-v1.5) */
  model?: string;
  /** Maximum tokens per input (default: 8192) */
  maxTokens?: number;
  /** Batch size for processing (default: 32) */
  batchSize?: number;
  /** Data type for model weights (default: 'q8' for quantized) */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Device for inference (default: auto-detected) */
  device?: DeviceType;
  /** Progress callback */
  onProgress?: (message: string) => void;
}

// Use nomic-embed-text-v1.5 which has better code understanding
const DEFAULT_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_DTYPE = 'q8';

// Singleton pipeline instance
let pipelineInstance: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentModel: string | null = null;

/**
 * Initialize the embedding pipeline with modern transformers.js options
 */
async function getEmbeddingPipeline(
  model: string = DEFAULT_MODEL,
  dtype: 'fp32' | 'fp16' | 'q8' | 'q4' = DEFAULT_DTYPE,
  onProgress?: (message: string) => void
): Promise<FeatureExtractionPipeline> {
  // Return cached instance if same model
  if (pipelineInstance && currentModel === model) {
    return pipelineInstance;
  }

  // Wait for existing loading if in progress
  if (loadingPromise && currentModel === model) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    const { device, reason } = detectDevice();
    onProgress?.(`Loading embedding model: ${model}`);
    onProgress?.(`Device: ${device} (${reason})`);
    onProgress?.('This may take a moment on first run...');

    try {
      // Use modern pipeline options with device configuration
      const pipe = await pipeline('feature-extraction', model, {
        dtype, // Quantization level for performance/accuracy tradeoff
        device, // Device for inference (auto, cpu, or cuda)
      });

      onProgress?.('Embedding model loaded successfully');
      pipelineInstance = pipe;
      currentModel = model;
      return pipe;
    } catch (error) {
      // If GPU fails, try falling back to CPU
      const { device: configuredDevice } = detectDevice();
      if (configuredDevice !== 'cpu') {
        onProgress?.('GPU initialization failed, falling back to CPU...');
        try {
          const pipe = await pipeline('feature-extraction', model, {
            dtype,
            device: 'cpu',
          });
          onProgress?.('Embedding model loaded successfully (CPU fallback)');
          pipelineInstance = pipe;
          currentModel = model;
          return pipe;
        } catch (fallbackError) {
          // Fall through to original error
        }
      }

      loadingPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelLoadError(
        `Failed to load embedding model "${model}": ${message}`,
        error instanceof Error ? error : undefined
      );
    }
  })();

  return loadingPromise;
}

/**
 * Validate that an embedding is valid (non-empty, finite values)
 */
function validateEmbedding(embedding: number[]): void {
  if (embedding.length === 0) {
    throw new EmbeddingGenerationError('Embedding is empty');
  }
  for (let i = 0; i < embedding.length; i++) {
    const val = embedding[i];
    if (val === undefined || !Number.isFinite(val)) {
      throw new EmbeddingGenerationError(
        `Embedding contains invalid value at index ${i}: ${val}`
      );
    }
  }
}

/**
 * Generate embedding for a single text input (document)
 */
export async function embed(
  text: string,
  options: EmbedderOptions = {}
): Promise<EmbeddingResult> {
  const {
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    dtype = DEFAULT_DTYPE,
    onProgress,
  } = options;

  let pipe: FeatureExtractionPipeline;
  try {
    pipe = await getEmbeddingPipeline(model, dtype, onProgress);
  } catch (error) {
    if (error instanceof ModelLoadError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      `Failed to load embedding model: ${message}`,
      error instanceof Error ? error : undefined
    );
  }

  // Truncate text if too long (rough estimate: 1 token ≈ 4 chars)
  const maxChars = maxTokens * 4;
  const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;

  // Add search_document prefix for better retrieval (nomic model recommendation)
  const prefixedText = `search_document: ${truncatedText}`;

  try {
    const output = await pipe(prefixedText, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract the embedding array from the tensor
    const embedding = Array.from(output.data as Float32Array);

    // Validate the embedding
    validateEmbedding(embedding);

    return {
      embedding,
      tokenCount: Math.ceil(truncatedText.length / 4),
    };
  } catch (error) {
    if (error instanceof EmbeddingGenerationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbeddingGenerationError(
      `Failed to generate embedding: ${message}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate embedding for a search query
 */
export async function embedQuery(
  query: string,
  options: EmbedderOptions = {}
): Promise<EmbeddingResult> {
  const { model = DEFAULT_MODEL, dtype = DEFAULT_DTYPE, onProgress } = options;

  let pipe: FeatureExtractionPipeline;
  try {
    pipe = await getEmbeddingPipeline(model, dtype, onProgress);
  } catch (error) {
    if (error instanceof ModelLoadError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLoadError(
      `Failed to load embedding model: ${message}`,
      error instanceof Error ? error : undefined
    );
  }

  // Add search_query prefix for queries (nomic model recommendation)
  const prefixedQuery = `search_query: ${query}`;

  try {
    const output = await pipe(prefixedQuery, {
      pooling: 'mean',
      normalize: true,
    });

    const embedding = Array.from(output.data as Float32Array);

    // Validate the embedding
    validateEmbedding(embedding);

    return {
      embedding,
      tokenCount: Math.ceil(query.length / 4),
    };
  } catch (error) {
    if (error instanceof EmbeddingGenerationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbeddingGenerationError(
      `Failed to generate query embedding: ${message}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate embeddings for multiple texts in batches.
 *
 * Uses Promise.allSettled for resilient batch processing - individual item
 * failures don't prevent other items from being embedded.
 *
 * @param texts - Array of text content to embed
 * @param options - Embedder configuration options
 * @returns Array of embedding results (failed items have placeholder embeddings)
 *
 * @example
 * ```typescript
 * const results = await embedBatch(['code1', 'code2', 'code3']);
 * // Results array has same length as input
 * ```
 */
export async function embedBatch(
  texts: string[],
  options: EmbedderOptions = {}
): Promise<EmbeddingResult[]> {
  const {
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    batchSize = DEFAULT_BATCH_SIZE,
    dtype = DEFAULT_DTYPE,
    onProgress,
  } = options;

  const pipe = await getEmbeddingPipeline(model, dtype, onProgress);
  const results: EmbeddingResult[] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);

    onProgress?.(`Processing batch ${batchNum}/${totalBatches}`);

    // Process each item in the batch concurrently with error resilience
    const batchSettled = await Promise.allSettled(
      batch.map(async (text) => {
        const maxChars = maxTokens * 4;
        const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
        const prefixedText = `search_document: ${truncatedText}`;

        const output = await pipe(prefixedText, {
          pooling: 'mean',
          normalize: true,
        });

        const embedding = Array.from(output.data as Float32Array);
        validateEmbedding(embedding);

        return {
          embedding,
          tokenCount: Math.ceil(truncatedText.length / 4),
        };
      })
    );

    // Process settled results - use zero vector for failed items
    for (const result of batchSettled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // Log the error but continue with a zero vector
        // The caller can detect this by checking if all values are 0
        results.push({
          embedding: new Array(768).fill(0),
          tokenCount: 0,
        });
      }
    }
  }

  return results;
}

/**
 * Generate embeddings for multiple texts with detailed error tracking.
 *
 * Unlike `embedBatch`, this function returns detailed information about
 * which items failed and why, enabling better error handling.
 *
 * @param texts - Array of text content to embed
 * @param options - Embedder configuration options
 * @returns Batch result with success/failure details
 *
 * @example
 * ```typescript
 * const { results, failedIndices, errors } = await embedBatchWithErrors(texts);
 *
 * if (failedIndices.length > 0) {
 *   console.warn(`${failedIndices.length} items failed to embed`);
 *   for (const idx of failedIndices) {
 *     console.warn(`  Item ${idx}: ${errors.get(idx)}`);
 *   }
 * }
 * ```
 */
export async function embedBatchWithErrors(
  texts: string[],
  options: EmbedderOptions = {}
): Promise<BatchEmbeddingResult> {
  const {
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    batchSize = DEFAULT_BATCH_SIZE,
    dtype = DEFAULT_DTYPE,
    onProgress,
  } = options;

  const pipe = await getEmbeddingPipeline(model, dtype, onProgress);
  const results: EmbeddingResult[] = [];
  const failedIndices: number[] = [];
  const errors = new Map<number, string>();
  let globalIndex = 0;

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);

    onProgress?.(`Processing batch ${batchNum}/${totalBatches}`);

    // Process each item in the batch concurrently with error tracking
    const batchSettled = await Promise.allSettled(
      batch.map(async (text, localIndex) => {
        const maxChars = maxTokens * 4;
        const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
        const prefixedText = `search_document: ${truncatedText}`;

        const output = await pipe(prefixedText, {
          pooling: 'mean',
          normalize: true,
        });

        const embedding = Array.from(output.data as Float32Array);
        validateEmbedding(embedding);

        return {
          embedding,
          tokenCount: Math.ceil(truncatedText.length / 4),
          localIndex,
        };
      })
    );

    // Process settled results
    for (let j = 0; j < batchSettled.length; j++) {
      const result = batchSettled[j]!;
      const itemGlobalIndex = globalIndex + j;

      if (result.status === 'fulfilled') {
        results.push({
          embedding: result.value.embedding,
          tokenCount: result.value.tokenCount,
        });
      } else {
        // Track the failure
        failedIndices.push(itemGlobalIndex);
        const errorMessage = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        errors.set(itemGlobalIndex, errorMessage);

        // Add placeholder result
        results.push({
          embedding: new Array(768).fill(0),
          tokenCount: 0,
        });
      }
    }

    globalIndex += batch.length;
  }

  return {
    results,
    failedIndices,
    errors,
    totalProcessed: texts.length,
    successCount: texts.length - failedIndices.length,
  };
}

/**
 * Get the embedding dimension for the current model
 */
export function getEmbeddingDimension(): number {
  return 768; // nomic-embed-text dimension
}

/**
 * Preload the embedding model (useful for startup optimization)
 */
export async function preloadModel(options: EmbedderOptions = {}): Promise<void> {
  const { model = DEFAULT_MODEL, dtype = DEFAULT_DTYPE, onProgress } = options;
  await getEmbeddingPipeline(model, dtype, onProgress);
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
