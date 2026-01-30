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
 * Result of CLI argument parsing.
 */
export interface CliParseResult {
  shouldExit: boolean;
  rootDir?: string;
  downloadModel?: boolean;
}

/**
 * Handle CLI arguments. Returns result with exit status and optional root directory.
 */
export function handleCliArgs(args: string[]): CliParseResult {
  if (args.includes('-v') || args.includes('--version')) {
    console.log(`semantic-code-mcp v${getVersion()}`);
    return { shouldExit: true };
  }

  if (args.includes('-h') || args.includes('--help')) {
    console.log(`semantic-code-mcp - MCP server for semantic code search

Usage: semantic-code-mcp [options] [directory]

Arguments:
  directory              Root directory to index (default: current directory)

Options:
  -v, --version          Show version
  -h, --help             Show help
  --download-model       Download embedding model and exit

Environment Variables:
  SEMANTIC_CODE_ROOT        Override root directory
  SEMANTIC_CODE_INDEX       Custom index location
  SEMANTIC_CODE_FORCE_GPU   Force CUDA GPU usage (set to "1")
  SEMANTIC_CODE_FORCE_CPU   Force CPU usage (set to "1")`);
    return { shouldExit: true };
  }

  if (args.includes('--download-model')) {
    return { shouldExit: true, downloadModel: true };
  }

  // Check for positional directory argument (not a flag)
  const positionalArgs = args.filter(arg => !arg.startsWith('-'));
  const rootDir = positionalArgs[0];

  return { shouldExit: false, rootDir };
}
