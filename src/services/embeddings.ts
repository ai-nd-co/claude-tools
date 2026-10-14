// Ollama embeddings service for semantic search
import PQueue from 'p-queue';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';
const EMBEDDING_DIMENSIONS = 768;

// Concurrency for parallel embedding requests
const DEFAULT_CONCURRENCY = 30;

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * Check if Ollama is available
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the embedding model is available
 */
export async function isEmbeddingModelAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) return false;

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    return models.some((m) => m.name.startsWith(EMBEDDING_MODEL));
  } catch {
    return false;
  }
}

/**
 * Generate embedding for text using Ollama
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.statusText}`);
  }

  const data = await response.json() as { embedding: number[] };
  return data.embedding;
}

/**
 * Generate embeddings for multiple texts concurrently using p-queue
 * Uses ~15 concurrent requests which provides ~9x speedup over sequential
 */
export async function generateEmbeddings(
  texts: string[],
  onProgress?: (completed: number, total: number) => void,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const queue = new PQueue({ concurrency });
  let completed = 0;

  // Create array to hold results in original order
  const results: number[][] = new Array(texts.length);

  // Queue all embedding requests
  const promises = texts.map((text, index) =>
    queue.add(async () => {
      const embedding = await generateEmbedding(text);
      results[index] = embedding;
      completed++;
      onProgress?.(completed, texts.length);
    })
  );

  await Promise.all(promises);
  return results;
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Get embedding dimensions
 */
export function getEmbeddingDimensions(): number {
  return EMBEDDING_DIMENSIONS;
}

/**
 * Get the embedding model name
 */
export function getEmbeddingModel(): string {
  return EMBEDDING_MODEL;
}
