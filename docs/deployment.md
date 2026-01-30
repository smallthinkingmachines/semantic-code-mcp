# Deployment Guide

This guide covers deploying semantic-code-mcp in production environments.

## System Requirements

### Minimum Requirements

- **Node.js**: 18.0.0 or higher
- **Memory**: 4GB RAM minimum (8GB recommended for large codebases)
- **Disk**: 2x the size of your codebase for index storage
- **CPU**: 2 cores minimum (4+ recommended for faster indexing)

### Recommended for Large Codebases (100K+ files)

- **Memory**: 16GB RAM
- **Disk**: SSD storage for index (significantly faster queries)
- **CPU**: 8+ cores for parallel indexing

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIC_CODE_ROOT` | Root directory to index | Current working directory |
| `SEMANTIC_CODE_INDEX` | Custom index storage location | `.semantic-code/index/` |
| `LOG_LEVEL` | Minimum log level (debug, info, warn, error) | `info` |
| `LOG_FORMAT` | Log format (text, json) | `text` |

## Installation Methods

### NPM Global Installation

```bash
npm install -g semantic-code-mcp

# Run from any project directory (uses cwd)
cd /path/to/project
semantic-code-mcp

# Or specify directory as argument
semantic-code-mcp /path/to/project

# Or use environment variable
SEMANTIC_CODE_ROOT=/path/to/project semantic-code-mcp
```

### NPX (No Installation)

```bash
# Uses current directory
cd /path/to/project
npx semantic-code-mcp

# Or specify directory as argument
npx semantic-code-mcp /path/to/project

# Or use environment variable
SEMANTIC_CODE_ROOT=/path/to/project npx semantic-code-mcp
```

### Docker Deployment

```dockerfile
FROM node:20-slim

WORKDIR /app

# Install semantic-code-mcp
RUN npm install -g semantic-code-mcp

# Create directory for code and index
RUN mkdir -p /code /index

# Set environment variables
ENV SEMANTIC_CODE_ROOT=/code
ENV SEMANTIC_CODE_INDEX=/index
ENV LOG_FORMAT=json
ENV LOG_LEVEL=info

# Mount points:
# - /code: Your codebase (read-only recommended)
# - /index: Index storage (read-write)

ENTRYPOINT ["semantic-code-mcp"]
```

Build and run:

```bash
# Build the image
docker build -t semantic-code-mcp .

# Run with mounted volumes
docker run -v /path/to/project:/code:ro \
           -v /path/to/index:/index \
           semantic-code-mcp
```

### Docker Compose

```yaml
version: '3.8'

services:
  semantic-code:
    image: semantic-code-mcp
    build: .
    volumes:
      - /path/to/project:/code:ro
      - semantic-code-index:/index
    environment:
      - SEMANTIC_CODE_ROOT=/code
      - SEMANTIC_CODE_INDEX=/index
      - LOG_FORMAT=json
      - LOG_LEVEL=info
    restart: unless-stopped

volumes:
  semantic-code-index:
```

## Claude Code Configuration

Add to `~/.claude/claude_desktop_config.json`:

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

The server automatically uses your current working directory. To specify a different directory or customize settings:

```json
{
  "mcpServers": {
    "semantic-code": {
      "command": "npx",
      "args": ["semantic-code-mcp", "/absolute/path/to/project"],
      "env": {
        "SEMANTIC_CODE_INDEX": "/absolute/path/to/index",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

## Performance Tuning

### For Large Codebases

When indexing codebases with 100K+ files:

1. **Increase flush threshold**: Lower `maxChunksInMemory` to reduce memory usage

```typescript
await indexDirectory({
  rootDir: '/path/to/monorepo',
  store,
  maxChunksInMemory: 200,  // Default is 500
  batchSize: 5,            // Default is 10
});
```

2. **Use SSD storage**: Index queries are I/O bound

3. **Exclude unnecessary files**: Add patterns to ignore

```typescript
const ignorePatterns = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.generated.*',
  '**/vendor/**',
];
```

### Memory Optimization

The server uses approximately:

- **Base**: ~500MB for model loading
- **Per 1000 chunks**: ~3MB of embedding data
- **Peak during indexing**: Base + (maxChunksInMemory * 3KB)

To reduce memory usage:

1. Lower `maxChunksInMemory` (trades memory for more database writes)
2. Process files in smaller batches
3. Use quantized embeddings (q8 is default, q4 uses less memory)

### Query Performance

For fastest query performance:

1. **Limit result count**: Use smaller `limit` values when possible
2. **Use filters**: Language and path filters reduce search space
3. **Disable reranking for speed**: Set `useReranking: false` for faster results

## Monitoring

### Log Output

All logs go to stderr (MCP protocol compatible). Example JSON log:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "info",
  "component": "search",
  "message": "Search complete",
  "data": {
    "resultCount": 10,
    "latencyMs": 45
  }
}
```

### Metrics

The server tracks internal metrics accessible via the `metrics` module:

- `filesIndexed`: Total files indexed
- `chunksCreated`: Total chunks created
- `queriesTotal`: Total search queries
- `queryLatencyMs`: Search latency samples
- `fallbacksTriggered`: Keyword fallback count
- `errorsCount`: Error count

## Security Considerations

1. **Read-only code access**: Mount codebase as read-only where possible
2. **Index isolation**: Store index in a separate directory
3. **Input validation**: All user inputs are validated against injection
4. **Path traversal protection**: Paths are validated to stay within root

## Backup and Recovery

### Backing Up the Index

The index is stored in LanceDB format under the index directory:

```bash
# Backup
tar -czf semantic-code-backup.tar.gz .semantic-code/index/

# Restore
tar -xzf semantic-code-backup.tar.gz
```

### Rebuilding the Index

If the index becomes corrupted:

```bash
# Remove the index directory
rm -rf .semantic-code/index/

# The index will rebuild on next search
```

## Troubleshooting

See [Troubleshooting Guide](./troubleshooting.md) for common issues and solutions.
