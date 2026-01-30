# Troubleshooting Guide

This guide covers common issues and their solutions when using semantic-code-mcp.

## Common Issues

### Index Problems

#### "Index is empty" Error

**Symptoms**: Search returns "Index is empty. Run indexing first."

**Causes**:
1. No supported files in the directory
2. All files are in ignored patterns
3. Index directory is different from expected

**Solutions**:

1. Check for supported files:
```bash
# List TypeScript files
find . -name "*.ts" | head -20

# Check if files are being ignored
ls -la .semantic-code/
```

2. Verify environment variables:
```bash
echo $SEMANTIC_CODE_ROOT
echo $SEMANTIC_CODE_INDEX
```

3. Force re-index by removing the index:
```bash
rm -rf .semantic-code/index/
```

#### Corrupted Index

**Symptoms**:
- Search crashes with database errors
- Inconsistent results
- LanceDB errors in logs

**Solution**:
```bash
# Remove and rebuild the index
rm -rf .semantic-code/index/
# Restart the server - index rebuilds automatically
```

#### Clearing the Index

The index can be safely cleared at any time. It will automatically rebuild on the next search.

**When to clear:**
- Index seems bloated or stale
- After major refactoring (file renames/moves outside editor)
- Switching between branches with very different file structures
- Any unexplained search issues

**How to clear:**
```bash
rm -rf .semantic-code/index/
# Index rebuilds automatically on next search
```

**What happens:**
- All indexed data is removed
- Next search triggers a full re-index
- No configuration is lost (only the vector data)

**Note:** You don't need to clear regularly. The index automatically:
- Skips unchanged files (via content hashing)
- Updates modified files (delete + re-insert)
- Removes deleted files (via file watcher)

Clearing is only needed for edge cases like files renamed outside the editor while the server wasn't running.

#### Index Not Updating

**Symptoms**: Changes to code aren't reflected in search results

**Causes**:
1. File watcher not running
2. File is in an ignored pattern
3. Content hash hasn't changed

**Solutions**:

1. Check if file is being tracked:
```bash
# File should be in a supported extension
file your-file.ts

# Check if it matches ignore patterns
# Default ignores: node_modules, dist, build, .git, etc.
```

2. Force re-index the specific file by modifying it slightly

### Model Loading Issues

#### Model Download Fails

**Symptoms**:
- "Failed to load embedding model" error
- Network timeout errors
- Stuck on "Loading embedding model..."

**Solutions**:

1. Check network connectivity:
```bash
curl -I https://huggingface.co
```

2. Clear the model cache:
```bash
rm -rf ~/.cache/semantic-code-mcp/transformers/
```

3. Check disk space (models are ~500MB):
```bash
df -h ~/.cache/
```

4. Set a custom cache directory:
```bash
export HF_HOME=/path/with/more/space/.cache/huggingface
```

#### Model Out of Memory

**Symptoms**:
- "JavaScript heap out of memory" error
- Process killed during model loading

**Solutions**:

1. Increase Node.js memory limit:
```bash
NODE_OPTIONS="--max-old-space-size=8192" npx semantic-code-mcp
```

2. Use quantized model (default is q8, which is already efficient)

### Search Issues

#### No Results Found

**Symptoms**: Search returns empty results for queries that should match

**Causes**:
1. Index is empty
2. Filter is too restrictive
3. Query doesn't match indexed content semantically

**Solutions**:

1. Check index status:
```typescript
// The response includes indexStats
{
  "indexStats": {
    "totalChunks": 0,  // Should be > 0
    "indexed": true
  }
}
```

2. Try without filters first:
```typescript
semantic_search({ query: "function" })  // Basic test
```

3. Check if content was indexed:
```bash
# Look for chunker logs
LOG_LEVEL=debug npx semantic-code-mcp
```

#### Poor Search Quality

**Symptoms**: Results don't seem relevant to the query

**Solutions**:

1. Use more specific queries:
```typescript
// Instead of:
semantic_search({ query: "auth" })

// Try:
semantic_search({ query: "user authentication with JWT tokens" })
```

2. Use filters to narrow scope:
```typescript
semantic_search({
  query: "authentication",
  path: "src/auth/",
  file_pattern: "*.ts"
})
```

3. Increase result limit and review:
```typescript
semantic_search({ query: "authentication", limit: 20 })
```

#### Search Timeout

**Symptoms**: Search takes too long or times out

**Solutions**:

1. Use filters to reduce search space
2. Reduce candidate multiplier:
```typescript
// In code, when using hybridSearch directly
hybridSearch(query, store, { candidateMultiplier: 3 })  // Default is 5
```

3. Disable reranking for faster results:
```typescript
hybridSearch(query, store, { useReranking: false })
```

### Performance Issues

#### Slow Indexing

**Symptoms**: Initial indexing takes very long

**Solutions**:

1. Add more files to ignore patterns:
```typescript
const ignorePatterns = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.min.js',
  '**/coverage/**',
  '**/__snapshots__/**',
];
```

2. Reduce batch size for more consistent progress:
```typescript
indexDirectory({ batchSize: 5 })  // Default is 10
```

3. Monitor progress:
```bash
LOG_LEVEL=info npx semantic-code-mcp
# Watch for "Processing batch X/Y" messages
```

#### High Memory Usage

**Symptoms**: Process uses excessive memory

**Solutions**:

1. Reduce chunks in memory:
```typescript
indexDirectory({ maxChunksInMemory: 200 })  // Default is 500
```

2. Process smaller file batches:
```typescript
indexDirectory({ batchSize: 5 })
```

3. Monitor memory:
```bash
# Watch Node.js memory usage
node --expose-gc -e "setInterval(() => console.log(process.memoryUsage()), 5000)"
```

### MCP Communication Issues

#### Server Not Responding

**Symptoms**: Claude Code can't connect to the server

**Solutions**:

1. Check if server starts correctly:
```bash
# Run directly to see errors
npx semantic-code-mcp /path/to/project
```

2. Verify configuration in `claude_desktop_config.json`:
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

3. Use absolute paths when specifying a directory argument

#### Wrong Directory Being Indexed

**Symptoms**: Server indexes the wrong directory or can't find your code

**Root directory priority**:
1. CLI argument: `npx semantic-code-mcp /path/to/project`
2. Environment variable: `SEMANTIC_CODE_ROOT`
3. Current working directory: `process.cwd()`

**Solutions**:

1. Check what directory is being used:
```bash
# Look for "Root directory:" in server output
npx semantic-code-mcp 2>&1 | head -5
```

2. For global MCP configs, always specify the directory:
```json
{
  "mcpServers": {
    "semantic-code": {
      "command": "npx",
      "args": ["semantic-code-mcp", "/absolute/path/to/project"]
    }
  }
}
```

3. If using Claude Code directly, run from your project directory:
```bash
cd /path/to/project
claude
# The MCP server will use /path/to/project as root
```

#### Protocol Errors

**Symptoms**: "Invalid JSON" or protocol-related errors

**Causes**: Something is writing to stdout (MCP uses stdout for communication)

**Solutions**:

1. Ensure all logging goes to stderr
2. Remove any `console.log` statements
3. Check for third-party libraries writing to stdout

### File System Issues

#### Permission Denied

**Symptoms**: Can't read files or write index

**Solutions**:

1. Check file permissions:
```bash
ls -la /path/to/project/
ls -la /path/to/project/.semantic-code/
```

2. Run with appropriate permissions

3. Use a different index location:
```bash
SEMANTIC_CODE_INDEX=/tmp/semantic-code-index npx semantic-code-mcp
```

#### Symlink Issues

**Symptoms**: Symlinked files not indexed or cause errors

**Solutions**:

1. Symlinks are followed by default
2. Circular symlinks may cause issues - add them to ignore patterns
3. Consider using absolute paths

## Diagnostic Commands

### Check Version

```bash
npx semantic-code-mcp --version
```

### Enable Debug Logging

```bash
LOG_LEVEL=debug npx semantic-code-mcp
```

### Check System Info

```bash
node -e "console.log({node: process.version, platform: process.platform, arch: process.arch})"
```

### Test Model Loading

```bash
# This will test if the model can be loaded
node -e "
const { pipeline } = require('@huggingface/transformers');
pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5').then(() => console.log('OK')).catch(console.error);
"
```

## Getting Help

If you're still having issues:

1. Check the [GitHub Issues](https://github.com/anthropics/claude-code/issues) for known problems
2. Enable debug logging and capture the output
3. Report issues with:
   - Node.js version
   - Operating system
   - Error messages
   - Steps to reproduce
