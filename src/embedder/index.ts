/**
 * Embedding generator using @huggingface/transformers (Transformers.js v3).
 * Provides 768-dimensional embeddings optimized for code search.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

// Configure transformers.js to use local cache
env.cacheDir = process.env.HOME
  ? `${process.env.HOME}/.cache/semantic-code-mcp/transformers`
  : '/tmp/.cache/semantic-code-mcp/transformers';

// Allow both local and remote models
env.allowLocalModels = true;
env.allowRemoteModels = true;

export interface EmbeddingResult {
  /** The embedding vector (768 dimensions for nomic-embed) */
  embedding: number[];
  /** Number of tokens used */
  tokenCount: number;
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
    onProgress?.(`Loading embedding model: ${model}`);
    onProgress?.('This may take a moment on first run...');

    try {
      // Use modern pipeline options
      const pipe = await pipeline('feature-extraction', model, {
        dtype, // Quantization level for performance/accuracy tradeoff
      });

      onProgress?.('Embedding model loaded successfully');
      pipelineInstance = pipe;
      currentModel = model;
      return pipe;
    } catch (error) {
      loadingPromise = null;
      throw new Error(`Failed to load embedding model: ${error}`);
    }
  })();

  return loadingPromise;
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

  const pipe = await getEmbeddingPipeline(model, dtype, onProgress);

  // Truncate text if too long (rough estimate: 1 token ≈ 4 chars)
  const maxChars = maxTokens * 4;
  const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;

  // Add search_document prefix for better retrieval (nomic model recommendation)
  const prefixedText = `search_document: ${truncatedText}`;

  const output = await pipe(prefixedText, {
    pooling: 'mean',
    normalize: true,
  });

  // Extract the embedding array from the tensor
  const embedding = Array.from(output.data as Float32Array);

  return {
    embedding,
    tokenCount: Math.ceil(truncatedText.length / 4),
  };
}

/**
 * Generate embedding for a search query
 */
export async function embedQuery(
  query: string,
  options: EmbedderOptions = {}
): Promise<EmbeddingResult> {
  const { model = DEFAULT_MODEL, dtype = DEFAULT_DTYPE, onProgress } = options;

  const pipe = await getEmbeddingPipeline(model, dtype, onProgress);

  // Add search_query prefix for queries (nomic model recommendation)
  const prefixedQuery = `search_query: ${query}`;

  const output = await pipe(prefixedQuery, {
    pooling: 'mean',
    normalize: true,
  });

  const embedding = Array.from(output.data as Float32Array);

  return {
    embedding,
    tokenCount: Math.ceil(query.length / 4),
  };
}

/**
 * Generate embeddings for multiple texts in batches
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

    // Process each item in the batch concurrently
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const maxChars = maxTokens * 4;
        const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
        const prefixedText = `search_document: ${truncatedText}`;

        const output = await pipe(prefixedText, {
          pooling: 'mean',
          normalize: true,
        });

        return {
          embedding: Array.from(output.data as Float32Array),
          tokenCount: Math.ceil(truncatedText.length / 4),
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
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
