# semantic-code-mcp

MCP server for semantic code search using AST-aware chunking and vector embeddings. Works with any AI coding tool that supports MCP (Claude Code, Cursor, Windsurf, Cline, etc.)

## The Problem

AI coding tools' context windows can only hold ~0.017% of a 3GB codebase at any time. Current search relies on grep/ripgrep, which requires knowing exact function names or text patterns. When users ask conceptual questions like "where is authentication handled?" or "find the payment error handling", grep fails because:

- It matches **text**, not **meaning**
- Returns thousands of false positives
- Misses relevant code with different naming conventions
- Consumes 5-10x more tokens reading irrelevant results

## The Solution

Semantic search finds code by meaning, not text. Using local embeddings and vector search, it can answer questions like "find authentication logic" without knowing that the file is named `IdentityManager.ts`.

## Features

- **Semantic search** - Find code by meaning, not just keywords
- **AST-aware chunking** - Tree-sitter based chunking for better semantic boundaries (+4.3 Recall@5 vs fixed-length)
- **Local embeddings** - ONNX Runtime with nomic-embed-code (768 dims, 8K context)
- **Hybrid search** - Vector similarity + BM25 keyword matching
- **Cross-encoder reranking** - Higher precision with transformer reranking
- **Incremental indexing** - MD5 hashing for change detection, only re-index modified files
- **File watching** - Live updates as you code
- **Lazy indexing** - Index builds on first search, not on startup
- **GPU support** - CUDA auto-detection for 10-50x faster indexing

## Installation

```bash
npm install semantic-code-mcp
# or
yarn add semantic-code-mcp
```

## Usage with Claude Code

Add to your Claude Code MCP configuration (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "semantic-code": {
      "command": "npx",
      "args": ["semantic-code-mcp"]
    }
  }
}
```

The server automatically uses your current working directory. To specify a different directory:

```json
{
  "mcpServers": {
    "semantic-code": {
      "command": "npx",
      "args": ["semantic-code-mcp", "/path/to/project"]
    }
  }
}
```

## Usage with Other MCP Clients

The server uses stdio transport. Start it with:

```bash
# Uses current directory
npx semantic-code-mcp

# Or specify a directory
npx semantic-code-mcp /path/to/project

# Or use environment variable
SEMANTIC_CODE_ROOT=/path/to/project npx semantic-code-mcp
```

## Tool: semantic_search

Search code semantically using natural language queries.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language query describing what you're looking for |
| `path` | string | No | Directory path to scope the search |
| `limit` | number | No | Maximum results (default: 10, max: 50) |
| `file_pattern` | string | No | Glob pattern to filter files (e.g., "*.ts", "**/*.py") |

### Example

```
semantic_search({
  query: "authentication middleware that validates JWT tokens",
  path: "src/",
  limit: 5
})
```

## Architecture

```
semantic_search tool (MCP Server)
├── Chunker (tree-sitter)     → AST-aware code splitting
├── Embedder (ONNX local)     → nomic-embed-code, 768 dims
├── Vector DB (LanceDB)       → Serverless, hybrid search
├── File Watcher (chokidar)   → Incremental updates
└── Hybrid Search             → BM25 + vector + reranking
```

## Supported Languages

- TypeScript / JavaScript (including TSX/JSX)
- Python
- Go
- Rust

Other languages fall back to line-based chunking.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIC_CODE_ROOT` | Root directory to index | Current working directory |
| `SEMANTIC_CODE_INDEX` | Custom index storage location | `.semantic-code/index/` |

### Indexing Options

When using the library programmatically, you can configure indexing behavior:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `batchSize` | number | 10 | Number of files to process in each batch |
| `maxFileSize` | number | 1MB | Maximum file size to index (larger files are skipped) |
| `maxChunksInMemory` | number | 500 | Chunks to accumulate before flushing to database |
| `ignorePatterns` | string[] | See below | Glob patterns for files/directories to ignore |

#### Memory Management

The `maxChunksInMemory` option controls memory usage during indexing:

- **Default (500)**: ~1.5MB of embedding data in memory at peak
- **Lower values**: Less memory, more database writes
- **Higher values**: More memory, fewer database writes

For very large codebases (100K+ files), consider lowering this value:

```typescript
await indexDirectory({
  rootDir: '/path/to/monorepo',
  store,
  maxChunksInMemory: 200,  // More frequent flushes for large repos
  batchSize: 5,            // Smaller file batches
});
```

#### Default Ignore Patterns

The following patterns are ignored by default:

```
**/node_modules/**
**/.git/**
**/dist/**
**/build/**
**/.next/**
**/coverage/**
**/__pycache__/**
**/venv/**
**/.venv/**
**/target/**          (Rust)
**/vendor/**          (Go)
**/*.min.js
**/*.bundle.js
**/*.map
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/.semantic-code/**
```

### Security

The server includes protection against common attack vectors:

- **SQL Injection**: All filter inputs are validated against a strict whitelist
- **Path Traversal**: Search paths are validated to stay within the root directory
- **Input Validation**: IDs and patterns are validated before database operations

Invalid inputs throw typed errors (`InvalidFilterError`, `PathTraversalError`, `InvalidIdError`) that can be caught and handled appropriately.

## Storage

- Index location: `.semantic-code/index/` (add to `.gitignore`)
- Model cache: `~/.cache/semantic-code-mcp/`
- Estimated size: 3GB codebase → ~1.5GB index (with float16)

## Documentation

- [Deployment Guide](./docs/deployment.md) - Production deployment, Docker, performance tuning
- [Troubleshooting Guide](./docs/troubleshooting.md) - Common issues and solutions
- [Architecture Overview](./docs/architecture.md) - Internal design and data flow

## Development

```bash
# Install dependencies
yarn install

# Build
yarn build

# Run in development
yarn dev

# Run tests
yarn test

# Run specific test suites
yarn test -- tests/integration/    # Integration tests
yarn test -- tests/edge-cases/     # Edge case tests
yarn test -- tests/performance/    # Performance benchmarks
```

## Project Structure

```
semantic-code-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── chunker/
│   │   ├── index.ts          # Main chunker logic
│   │   └── languages.ts      # Tree-sitter language configs
│   ├── embedder/
│   │   ├── index.ts          # ONNX embedding generation
│   │   └── model.ts          # Model download & loading
│   ├── store/
│   │   └── index.ts          # LanceDB integration
│   ├── search/
│   │   ├── index.ts          # Hybrid search orchestration
│   │   └── reranker.ts       # Cross-encoder reranking
│   ├── watcher/
│   │   └── index.ts          # File watcher + incremental indexing
│   └── tools/
│       └── semantic-search.ts # MCP tool definition
├── package.json
├── tsconfig.json
└── README.md
```
