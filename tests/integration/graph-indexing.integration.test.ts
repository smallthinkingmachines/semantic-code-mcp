/**
 * Integration test: full pipeline chunk → graph nodes + edges.
 *
 * Tests chunkCodeWithEdges and resolveEdges together.
 */

import { chunkCodeWithEdges } from '../../src/chunker/index.js';
import { resolveEdges } from '../../src/graph/extractor.js';
import { GraphStore } from '../../src/graph/index.js';
import type { NodeKind } from '../../src/graph/types.js';

describe('Graph Indexing Integration', () => {
  it('should extract chunks and edges from TypeScript code', async () => {
    const code = `
import { readFile } from 'fs';

export function processData(input: string): string {
  const result = transform(input);
  return result;
}

function transform(data: string): string {
  return data.toUpperCase();
}

class DataProcessor {
  process(input: string): string {
    return processData(input);
  }
}
`;

    const result = await chunkCodeWithEdges(code, '/test/processor.ts');

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.rawEdges.length).toBeGreaterThan(0);

    // Should have extracted some edges (calls, imports, or exports)
    // Note: import statements at top level may not be inside semantic nodes,
    // so edges are extracted from the chunks that contain them
    expect(result.rawEdges.length).toBeGreaterThan(0);
  });

  it('should resolve edges within the same file', async () => {
    // Functions must be large enough to pass isTooSmall filter (>50 chars, >2 lines)
    const code = `
function helper(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const result = upper.replace(/\\s+/g, '-');
  return result;
}

function main(data: string): string {
  const processed = helper(data);
  const validated = processed.length > 0 ? processed : 'empty';
  console.log('Result:', validated);
  return validated;
}
`;

    const result = await chunkCodeWithEdges(code, '/test/app.ts');

    // Build symbol index from chunks
    const symbolIndex = new Map<string, Array<{ id: string; filePath: string }>>();
    for (const chunk of result.chunks) {
      if (chunk.name) {
        // Strip part suffixes like " (part 1)"
        const cleanName = chunk.name.replace(/ \(part \d+\)$/, '');
        const existing = symbolIndex.get(cleanName) || [];
        existing.push({ id: chunk.id, filePath: chunk.filePath });
        symbolIndex.set(cleanName, existing);
      }
    }

    const resolved = resolveEdges(result.rawEdges, symbolIndex);

    // Should have resolved the helper() call from main
    const callEdges = resolved.filter((e) => e.edgeType === 'calls');
    expect(callEdges.length).toBeGreaterThan(0);
    // Verify the main -> helper edge exists
    const helperCall = callEdges.find(
      (e) => e.edgeType === 'calls' && e.metadata?.includes('helper')
        || symbolIndex.get('helper')?.some((s) => s.id === e.targetId)
    );
    expect(helperCall).toBeDefined();
  });

  it('should store graph data in SQLite', async () => {
    const store = new GraphStore(':memory:');
    store.initialize();

    const code = `
export class UserService {
  async findUser(id: string): Promise<User> {
    return await this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
}
`;

    const result = await chunkCodeWithEdges(code, '/test/user-service.ts');
    const now = Date.now();

    // Convert chunks to graph nodes
    const nodes = result.chunks.map((chunk) => ({
      id: chunk.id,
      filePath: chunk.filePath,
      symbolName: chunk.name,
      kind: 'function' as NodeKind,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      updatedAt: now,
      stale: false,
    }));

    store.upsertNodes(nodes);
    const counts = store.getCounts();
    expect(counts.nodes).toBeGreaterThan(0);

    store.close();
  });

  it('should handle Python code', async () => {
    const code = `
import os
from pathlib import Path

def process_file(path: str) -> str:
    content = read_content(path)
    return transform(content)

def read_content(path: str) -> str:
    with open(path) as f:
        return f.read()

class FileProcessor:
    def __init__(self, root: str):
        self.root = root

    def run(self):
        for f in os.listdir(self.root):
            result = process_file(f)
            print(result)
`;

    const result = await chunkCodeWithEdges(code, '/test/processor.py');

    expect(result.chunks.length).toBeGreaterThan(0);
    // Python edge extraction — should find calls and/or imports
    expect(result.rawEdges.length).toBeGreaterThan(0);
  });

  it('should return empty edges for unsupported languages', async () => {
    const code = 'Just some plain text content that is long enough to be chunked into a piece.';

    const result = await chunkCodeWithEdges(code, '/test/readme.txt');
    expect(result.rawEdges).toHaveLength(0);
  });
});
