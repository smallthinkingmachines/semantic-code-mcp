/**
 * Version and CLI utilities for semantic-code-mcp.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Get the package version from package.json.
 */
export function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
  return pkg.version;
}

/**
 * Handle CLI arguments. Returns true if the process should exit.
 */
export function handleCliArgs(args: string[]): boolean {
  if (args.includes('-v') || args.includes('--version')) {
    console.log(`semantic-code-mcp v${getVersion()}`);
    return true;
  }

  if (args.includes('-h') || args.includes('--help')) {
    console.log(`semantic-code-mcp - MCP server for semantic code search

Usage: semantic-code-mcp [options]

Options:
  -v, --version    Show version
  -h, --help       Show help

Environment Variables:
  SEMANTIC_CODE_ROOT        Root directory to index (default: current directory)
  SEMANTIC_CODE_INDEX       Custom index location
  SEMANTIC_CODE_FORCE_GPU   Force CUDA GPU usage (set to "1")
  SEMANTIC_CODE_FORCE_CPU   Force CPU usage (set to "1")`);
    return true;
  }

  return false;
}
