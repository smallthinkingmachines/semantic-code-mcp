/**
 * Tests for edge resolution: symbol matching, ambiguity handling.
 */

import { resolveEdges } from '../../src/graph/extractor.js';
import type { RawEdge } from '../../src/graph/types.js';

describe('resolveEdges', () => {
  it('should resolve same-file edges with weight 1.0', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'file_ts_L1',
        sourceFilePath: '/test/file.ts',
        targetSymbol: 'helper',
        edgeType: 'calls',
      },
    ];

    const symbolIndex = new Map([
      ['helper', [{ id: 'file_ts_L20', filePath: '/test/file.ts' }]],
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.sourceId).toBe('file_ts_L1');
    expect(resolved[0]!.targetId).toBe('file_ts_L20');
    expect(resolved[0]!.weight).toBe(1.0);
    expect(resolved[0]!.edgeType).toBe('calls');
  });

  it('should resolve cross-file edges with weight 0.8', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'externalFn',
        edgeType: 'calls',
      },
    ];

    const symbolIndex = new Map([
      ['externalFn', [{ id: 'b_ts_L5', filePath: '/test/b.ts' }]],
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.weight).toBe(0.8);
  });

  it('should prefer same-file matches for ambiguous symbols', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'process',
        edgeType: 'calls',
      },
    ];

    const symbolIndex = new Map([
      [
        'process',
        [
          { id: 'b_ts_L10', filePath: '/test/b.ts' },
          { id: 'a_ts_L50', filePath: '/test/a.ts' }, // Same file
        ],
      ],
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.targetId).toBe('a_ts_L50'); // Same file preferred
    expect(resolved[0]!.weight).toBe(1.0);
  });

  it('should drop unresolvable edges', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'nonexistent',
        edgeType: 'calls',
      },
    ];

    const symbolIndex = new Map<string, Array<{ id: string; filePath: string }>>();

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(0);
  });

  it('should not create self-referencing edges', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'selfRef',
        edgeType: 'calls',
      },
    ];

    const symbolIndex = new Map([
      ['selfRef', [{ id: 'a_ts_L1', filePath: '/test/a.ts' }]], // Same chunk
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(0);
  });

  it('should handle multiple edges', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'foo',
        edgeType: 'calls',
      },
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'bar',
        edgeType: 'imports',
        modulePath: './utils',
      },
    ];

    const symbolIndex = new Map([
      ['foo', [{ id: 'a_ts_L20', filePath: '/test/a.ts' }]],
      ['bar', [{ id: 'utils_ts_L1', filePath: '/test/utils.ts' }]],
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.edgeType).toBe('calls');
    expect(resolved[1]!.edgeType).toBe('imports');
  });

  it('should include module path in metadata for imports', () => {
    const rawEdges: RawEdge[] = [
      {
        sourceChunkId: 'a_ts_L1',
        sourceFilePath: '/test/a.ts',
        targetSymbol: 'utils',
        edgeType: 'imports',
        modulePath: './utils/index',
      },
    ];

    const symbolIndex = new Map([
      ['utils', [{ id: 'utils_ts_L1', filePath: '/test/utils.ts' }]],
    ]);

    const resolved = resolveEdges(rawEdges, symbolIndex);
    expect(resolved[0]!.metadata).toBe('./utils/index');
  });

  it('should handle empty inputs', () => {
    const resolved = resolveEdges([], new Map());
    expect(resolved).toHaveLength(0);
  });
});
