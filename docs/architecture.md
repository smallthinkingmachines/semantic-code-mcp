# Architecture Overview

This document describes the internal architecture of semantic-code-mcp.

## System Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │           MCP Client                │
                                    │    (Claude Code, Cursor, etc.)      │
                                    └─────────────────┬───────────────────┘
                                                      │
                                                      │ stdio (JSON-RPC)
                                                      │
                                    ┌─────────────────▼───────────────────┐
                                    │         MCP Server (index.ts)       │
                                    │   - Tool registration               │
                                    │   - Request handling                │
                                    │   - Response formatting             │
                                    └─────────────────┬───────────────────┘
                                                      │
                          ┌───────────────────────────┼───────────────────────────┐
                          │                           │                           │
              ┌───────────▼───────────┐   ┌──────────▼──────────┐   ┌────────────▼──────────┐
              │   SemanticSearchTool  │   │     FileWatcher     │   │      VectorStore      │
              │ (tools/semantic-search)│   │    (watcher/)       │   │      (store/)         │
              │                       │   │                     │   │                       │
              │ - Input validation    │   │ - File monitoring   │   │ - LanceDB connection  │
              │ - Query orchestration │   │ - Change detection  │   │ - Vector search       │
              │ - Result formatting   │   │ - Incremental index │   │ - Full-text search    │
              └───────────┬───────────┘   └──────────┬──────────┘   └────────────▲──────────┘
                          │                          │                           │
                          │                          │                           │
              ┌───────────▼───────────┐              │                           │
              │     Hybrid Search     │              │                           │
              │      (search/)        │◄─────────────┘                           │
              │                       │                                          │
              │ - Vector similarity   │                                          │
              │ - Keyword boosting    │                                          │
              │ - Cross-encoder rerank│                                          │
              │ - Fallback to keyword │                                          │
              └───────────┬───────────┘                                          │
                          │                                                      │
              ┌───────────▼───────────┐                                          │
              │       Embedder        │                                          │
              │     (embedder/)       │                                          │
              │                       │                                          │
              │ - Model loading       │                                          │
              │ - Text embedding      │──────────────────────────────────────────┘
              │ - Batch processing    │
              └───────────────────────┘

              ┌───────────────────────┐
              │       Chunker         │
              │     (chunker/)        │
              │                       │
              │ - Tree-sitter parsing │
              │ - Semantic splitting  │
              │ - Edge extraction     │
              │ - Fallback chunking   │
              └───────────────────────┘

              ┌───────────────────────┐
              │    Context Graph      │
              │     (graph/)          │
              │                       │
              │ - SQLite graph store  │
              │ - BFS traversal       │
              │ - Session memory      │
              │ - Edge resolution     │
              └───────────────────────┘
```

## Component Details

### 1. MCP Server (`src/index.ts`)

The entry point that implements the Model Context Protocol:

- Registers `semantic_search`, `context_query`, `graph_annotate`, and `session_summary` tools
- Handles JSON-RPC communication over stdio
- Manages server lifecycle
- Conditionally initializes the context graph when `SEMANTIC_CODE_GRAPH_ENABLED=true`

### 2. SemanticSearchTool (`src/tools/semantic-search.ts`)

The main tool interface:

- Validates input using Zod schemas
- Coordinates lazy indexing on first search
- Manages the file watcher lifecycle
- Formats search results for MCP response

### 3. Chunker (`src/chunker/`)

AST-aware code splitting using tree-sitter:

**Flow:**
```
Source Code → Language Detection → Tree-sitter Parse → Extract Nodes → Split Large → Create Chunks
```

**Key Features:**
- Parses TypeScript, JavaScript, Python, Go, Rust
- Extracts semantic units (functions, classes, methods)
- Splits large chunks with overlap
- Falls back to line-based chunking for unsupported languages

**Design Decisions:**
- Chunk target size: ~1500 chars (before splitting)
- Overlap ratio: 15% for split chunks
- Minimum chunk size: 50 chars, 2 lines

### 4. Embedder (`src/embedder/`)

Local embedding generation using Transformers.js:

**Flow:**
```
Text → Prefix (search_document/search_query) → Tokenize → Model Inference → Normalize → Vector
```

**Key Features:**
- Uses nomic-ai/nomic-embed-text-v1.5 (768 dimensions)
- Singleton pipeline for efficiency
- Batch processing with error resilience
- Quantized models (q8 default) for memory efficiency

**Design Decisions:**
- Q8 quantization balances quality and performance
- Max 8192 tokens per input
- Batch size of 32 for optimal throughput

### 5. VectorStore (`src/store/`)

LanceDB-based vector database:

**Key Features:**
- Serverless embedded database
- Vector similarity search (cosine distance)
- Full-text search (FTS) with fallback
- Graceful shutdown with operation tracking

**Schema:**
```typescript
{
  id: string,           // Unique chunk identifier
  vector: number[768],  // Embedding vector
  filePath: string,     // Source file path
  content: string,      // Code content
  startLine: number,    // Start line (1-indexed)
  endLine: number,      // End line (1-indexed)
  name: string | null,  // Function/class name
  nodeType: string,     // AST node type
  signature: string | null,  // Function signature
  docstring: string | null,  // Associated docstring
  language: string,     // Programming language
  contentHash: string,  // MD5 hash for change detection
  indexedAt: number,    // Timestamp
}
```

### 6. Search (`src/search/`)

Hybrid search orchestration:

**Pipeline:**
```
Query → Embed → Vector Search → Keyword Boost → Rerank → Results
         │                                        │
         └──────── Fallback on Error ────────────┘
```

**Components:**
- **Hybrid Search**: Combines vector + keyword matching
- **Keyword Search**: Fallback for embedding failures
- **Reranker**: Cross-encoder for precision
- **Filter Builder**: SQL WHERE clause generation

**Design Decisions:**
- Candidate multiplier of 5x for reranking
- Keyword boost weights: name=3, signature=2, content=1
- Automatic fallback to keyword search on embedding failure

### 7. FileWatcher (`src/watcher/`)

Incremental indexing:

**Flow:**
```
File Change → Debounce (1s) → Read Content → Check Hash → Chunk → Embed → Upsert
```

**Key Features:**
- Uses chokidar for cross-platform file watching
- MD5 hashing for change detection
- Debouncing to avoid excessive re-indexing
- Graceful shutdown with pending operation tracking

### 8. Context Graph (`src/graph/`)

Opt-in structural awareness layer using SQLite (better-sqlite3):

**Components:**
- **GraphStore** (`index.ts`): SQLite-backed store for nodes and edges with BFS traversal
- **Extractor** (`extractor.ts`): Resolves raw edges (symbol names) to concrete graph edges (chunk IDs)
- **SessionManager** (`session.ts`): In-memory session state with TTL-based cleanup
- **Config** (`config.ts`): Environment variable parsing for graph settings

**Edge Types:**
- `calls` — function/method call relationships
- `imports` — import/require dependencies
- `extends` — class inheritance
- `implements` — interface implementation
- `exports` — module exports
- `agent_linked` — agent-created links via `graph_annotate`

**Schema (SQLite):**
```
graph_nodes: id, file_path, symbol_name, kind, start_line, end_line, updated_at, stale
graph_edges: source_id, target_id, edge_type, weight, metadata
graph_meta:  key, value
```

**Design Decisions:**
- SQLite for graph traversal (BFS < 1ms), separate from LanceDB for vectors
- In-memory sessions (ephemeral by design, tied to agent tasks not codebase)
- Graceful degradation: graph failure never breaks semantic search
- ID validation via shared `utils/validation.ts` for defense-in-depth

## Data Flow

### Indexing Flow

```
1. Scan directory for supported files
2. For each file:
   a. Check if hash changed (skip if unchanged)
   b. Read content
   c. Parse with tree-sitter
   d. Extract semantic chunks
   e. Generate embeddings
   f. Store in LanceDB
3. Create FTS index
```

### Search Flow

```
1. Receive query
2. Ensure index exists (lazy init)
3. Generate query embedding
4. Vector similarity search (get 5x candidates)
5. Apply keyword boosting
6. Cross-encoder reranking (top k)
7. Format and return results
```

### Error Handling Flow

```
Embedding Error?
  ├── Yes → Fallback to keyword search
  └── No → Continue

Reranking Error?
  ├── Yes → Use boosted results without reranking
  └── No → Continue

Store Error?
  ├── Transient → Retry
  └── Fatal → Propagate error
```

## Security Architecture

### Input Validation

```
User Input → Schema Validation → Pattern Validation → Safe Operation
                    │                    │
                    └── Zod Schemas      └── Regex patterns for:
                                              - SQL injection prevention
                                              - Path traversal prevention
                                              - ID validation
```

### Protected Operations

1. **Path Traversal**: All paths validated to stay within root
2. **SQL Injection**: IDs and filters validated before SQL use
3. **Resource Exhaustion**: Depth limits, size limits, operation tracking

## Observability

### Logging (`src/utils/logger.ts`)

- Structured logging (JSON or text format)
- Component-based prefixing
- All output to stderr (MCP compatible)
- Configurable log levels

### Metrics (`src/utils/metrics.ts`)

Tracked metrics:
- Indexing: files, chunks, duration, errors
- Search: queries, latency (p50/p99), fallback rate

## Extension Points

### Adding a New Language

1. Add tree-sitter grammar to dependencies
2. Add language config in `src/chunker/languages.ts`
3. Add language loading case in `loadLanguage()`

### Adding a Search Strategy

1. Implement new search function in `src/search/`
2. Export from `src/search/index.ts`
3. Integrate into tool handler if needed

### Adding Metrics

1. Add fields to `IndexingMetrics` or `SearchMetrics`
2. Add `record*` method to `MetricsCollector`
3. Update `getSummary()` computation
