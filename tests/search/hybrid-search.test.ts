/**
 * Tests for hybrid search functionality.
 */

import { MockVectorStore, createMockRecord } from '../mocks/store.mock.js';
import { mockEmbed, mockEmbedQuery } from '../mocks/embedder.mock.js';

// We test the filter builder directly since hybrid search requires model loading
import { buildSafeFilter } from '../../src/search/filter-builder.js';
import { InvalidFilterError } from '../../src/errors.js';
import { boostKeywordMatches } from '../../src/search/reranker.js';
import type { SearchResult } from '../../src/store/index.js';

describe('Hybrid Search', () => {
  describe('buildSafeFilter', () => {
    it('should return undefined for empty options', () => {
      expect(buildSafeFilter({})).toBeUndefined();
    });

    it('should build path filter', () => {
      const filter = buildSafeFilter({ path: 'src/components' });
      expect(filter).toBe("id LIKE 'src_components%'");
    });

    it('should build language filter for *.ts', () => {
      const filter = buildSafeFilter({ filePattern: '*.ts' });
      expect(filter).toBe("language = 'typescript'");
    });

    it('should build language filter for *.py', () => {
      const filter = buildSafeFilter({ filePattern: '*.py' });
      expect(filter).toBe("language = 'python'");
    });

    it('should build language filter for *.go', () => {
      const filter = buildSafeFilter({ filePattern: '*.go' });
      expect(filter).toBe("language = 'go'");
    });

    it('should build language filter for *.rs', () => {
      const filter = buildSafeFilter({ filePattern: '*.rs' });
      expect(filter).toBe("language = 'rust'");
    });

    it('should build language filter for *.js', () => {
      const filter = buildSafeFilter({ filePattern: '*.js' });
      expect(filter).toBe("language = 'javascript'");
    });

    it('should build complex pattern filter', () => {
      const filter = buildSafeFilter({ filePattern: '**/*.test.ts' });
      expect(filter).toContain('id LIKE');
      expect(filter).toContain('%_test_ts');
    });

    it('should combine multiple filters with AND', () => {
      const filter = buildSafeFilter({ path: 'src', filePattern: '*.ts' });
      expect(filter).toContain('AND');
      expect(filter).toContain("id LIKE 'src%'");
      expect(filter).toContain("language = 'typescript'");
    });

    it('should sanitize SQL injection in path', () => {
      // SQL injection attempts are now sanitized (unsafe chars replaced with _)
      const result = buildSafeFilter({ path: "'; DROP TABLE--" });
      expect(result).toBe("id LIKE '___DROP_TABLE--%'");
      // The inner value should only contain safe characters
      const innerValue = result?.match(/id LIKE '([^']+)'/)?.[1];
      expect(innerValue).toMatch(/^[a-zA-Z0-9_%-]+$/);
    });

    it('should sanitize SQL injection in file pattern', () => {
      // SQL injection attempts are now sanitized (unsafe chars replaced with _)
      const result = buildSafeFilter({ filePattern: "**/*'; DROP TABLE--" });
      // ** -> %, / -> _, * -> %, ' -> _, ; -> _, space -> _
      // buildFilePatternCondition adds leading % for suffix matching
      expect(result).toBe("id LIKE '%%_%___DROP_TABLE--'");
    });
  });

  describe('MockVectorStore', () => {
    let store: MockVectorStore;

    beforeEach(() => {
      store = new MockVectorStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it('should store and retrieve records', async () => {
      const record = createMockRecord({
        id: 'test_1',
        content: 'function test() {}',
      });

      await store.upsert([record]);

      expect(await store.count()).toBe(1);
    });

    it('should perform vector search', async () => {
      const record = createMockRecord({
        id: 'test_1',
        content: 'function test() {}',
        vector: mockEmbed('function test() {}').embedding,
      });

      await store.upsert([record]);

      const queryVector = mockEmbedQuery('test function').embedding;
      const results = await store.vectorSearch(queryVector, 10);

      expect(results.length).toBe(1);
      expect(results[0]?.record.id).toBe('test_1');
    });

    it('should filter by language', async () => {
      const tsRecord = createMockRecord({
        id: 'ts_1',
        language: 'typescript',
        vector: mockEmbed('ts code').embedding,
      });
      const pyRecord = createMockRecord({
        id: 'py_1',
        language: 'python',
        vector: mockEmbed('py code').embedding,
      });

      await store.upsert([tsRecord, pyRecord]);

      const queryVector = mockEmbedQuery('code').embedding;
      const results = await store.vectorSearch(
        queryVector,
        10,
        "language = 'typescript'"
      );

      expect(results.length).toBe(1);
      expect(results[0]?.record.language).toBe('typescript');
    });

    it('should delete records by file path', async () => {
      const record1 = createMockRecord({
        id: 'test_1',
        filePath: '/test/file1.ts',
      });
      const record2 = createMockRecord({
        id: 'test_2',
        filePath: '/test/file2.ts',
      });

      await store.upsert([record1, record2]);
      expect(await store.count()).toBe(2);

      await store.deleteByFilePath('/test/file1.ts');
      expect(await store.count()).toBe(1);

      const remaining = store.getAllRecords();
      expect(remaining[0]?.filePath).toBe('/test/file2.ts');
    });

    it('should check if store is empty', async () => {
      expect(await store.isEmpty()).toBe(true);

      await store.upsert([createMockRecord()]);
      expect(await store.isEmpty()).toBe(false);
    });

    it('should get indexed files', async () => {
      const record1 = createMockRecord({
        id: 'test_1',
        filePath: '/test/file1.ts',
        contentHash: 'hash1',
      });
      const record2 = createMockRecord({
        id: 'test_2',
        filePath: '/test/file2.ts',
        contentHash: 'hash2',
      });

      await store.upsert([record1, record2]);

      const files = await store.getIndexedFiles();
      expect(files.size).toBe(2);
      expect(files.get('/test/file1.ts')).toBe('hash1');
      expect(files.get('/test/file2.ts')).toBe('hash2');
    });

    it('should clear all records', async () => {
      await store.upsert([
        createMockRecord({ id: 'test_1' }),
        createMockRecord({ id: 'test_2' }),
      ]);

      expect(await store.count()).toBe(2);

      await store.clear();
      expect(await store.count()).toBe(0);
    });
  });

  describe('boostKeywordMatches', () => {
    it('should boost results with matching keywords', () => {
      const results: SearchResult[] = [
        {
          record: createMockRecord({
            id: 'test_1',
            content: 'function processUser() {}',
            name: 'processUser',
            signature: 'function processUser()',
          }),
          score: 0.5,
        },
        {
          record: createMockRecord({
            id: 'test_2',
            content: 'function doSomething() {}',
            name: 'doSomething',
            signature: 'function doSomething()',
          }),
          score: 0.5,
        },
      ];

      const boosted = boostKeywordMatches('process user', results);

      // The first result should have a higher score due to keyword matches
      expect(boosted[0]!.score).toBeGreaterThan(results[0]!.score);
      // The second result should have less or no boost
      expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score);
    });

    it('should give higher weight to name matches', () => {
      const results: SearchResult[] = [
        {
          record: createMockRecord({
            id: 'test_1',
            content: 'test content',
            name: 'searchFunction',
            signature: 'function searchFunction()',
          }),
          score: 0.5,
        },
        {
          record: createMockRecord({
            id: 'test_2',
            content: 'search in content only',
            name: 'otherFunction',
            signature: 'function otherFunction()',
          }),
          score: 0.5,
        },
      ];

      const boosted = boostKeywordMatches('search', results);

      // Name match should give higher boost than content match
      expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score);
    });

    it('should cap score at 1.0', () => {
      const results: SearchResult[] = [
        {
          record: createMockRecord({
            id: 'test_1',
            content: 'search search search search search',
            name: 'search',
            signature: 'search',
          }),
          score: 0.9,
        },
      ];

      const boosted = boostKeywordMatches('search', results);

      expect(boosted[0]!.score).toBeLessThanOrEqual(1.0);
    });

    it('should handle empty query', () => {
      const results: SearchResult[] = [
        {
          record: createMockRecord({ id: 'test_1' }),
          score: 0.5,
        },
      ];

      const boosted = boostKeywordMatches('', results);

      // Score should remain unchanged
      expect(boosted[0]!.score).toBe(0.5);
    });

    it('should handle empty results', () => {
      const boosted = boostKeywordMatches('search', []);
      expect(boosted).toEqual([]);
    });
  });
});
