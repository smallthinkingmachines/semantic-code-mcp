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
      "args": ["semantic-code-mcp"],
      "env": {
        "SEMANTIC_CODE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

## Usage with Other MCP Clients

The server uses stdio transport. Start it with:

```bash
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

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `SEMANTIC_CODE_ROOT` | Root directory to index | Current working directory |
| `SEMANTIC_CODE_INDEX` | Custom index storage location | `.semantic-code/index/` |

## Storage

- Index location: `.semantic-code/index/` (add to `.gitignore`)
- Model cache: `~/.cache/semantic-code-mcp/`
- Estimated size: 3GB codebase → ~1.5GB index (with float16)

## Development

```bash
# Install dependencies
yarn install

# Build
yarn build

# Run in development
yarn dev
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

## License

MIT
