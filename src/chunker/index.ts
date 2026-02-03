/**
 * AST-aware code chunker using web-tree-sitter (WASM).
 *
 * Splits code into semantic units (functions, classes, methods) for better
 * embedding quality. Uses web-tree-sitter for cross-platform parsing across
 * multiple languages without requiring native module compilation.
 *
 * Features:
 * - Semantic chunking at function/class/method boundaries
 * - Automatic splitting of large chunks with overlap
 * - Fallback to line-based chunking for unsupported languages
 * - BOM stripping for cross-platform compatibility
 * - Depth limiting to prevent stack overflow on pathological inputs
 * - WASM-based parsing for zero-install distribution
 *
 * @module chunker
 */

import type Parser from 'web-tree-sitter';
import path from 'path';
import {
  LANGUAGE_CONFIGS,
  getLanguageByExtension,
  type LanguageConfig,
} from './languages.js';
import { createParser } from './wasm-loader.js';
import { stripBOM } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chunker');

/**
 * Maximum recursion depth for AST traversal.
 * Prevents stack overflow on pathologically nested code.
 */
const MAX_RECURSION_DEPTH = 100;

export interface CodeChunk {
  /** Unique identifier for the chunk */
  id: string;
  /** Source file path */
  filePath: string;
  /** Code content */
  content: string;
  /** Start line number (1-indexed) */
  startLine: number;
  /** End line number (1-indexed) */
  endLine: number;
  /** Function/class/method name if available */
  name: string | null;
  /** Type of code unit (function, class, method, etc.) */
  nodeType: string;
  /** Function/method signature if available */
  signature: string | null;
  /** Associated docstring/comment if found */
  docstring: string | null;
  /** Programming language */
  language: string;
}


/**
 * Extract the name from an AST node
 */
function extractName(
  node: Parser.SyntaxNode,
  config: LanguageConfig
): string | null {
  // Try to find a name node in the immediate children
  for (const child of node.children) {
    if (config.nameNodeTypes.includes(child.type)) {
      return child.text;
    }
  }

  // For some node types, look deeper (e.g., lexical_declaration -> variable_declarator -> identifier)
  if (
    node.type === 'lexical_declaration' ||
    node.type === 'variable_declaration'
  ) {
    for (const child of node.children) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.children.find((c) =>
          config.nameNodeTypes.includes(c.type)
        );
        if (nameNode) return nameNode.text;
      }
    }
  }

  // For export statements, look for the declaration inside
  if (node.type === 'export_statement') {
    for (const child of node.children) {
      const name = extractName(child, config);
      if (name) return name;
    }
  }

  return null;
}

/**
 * Extract function signature (first line typically)
 */
function extractSignature(
  node: Parser.SyntaxNode,
  sourceCode: string
): string | null {
  const startLine = node.startPosition.row;
  const lines = sourceCode.split('\n');
  const firstLine = lines[startLine]?.trim();

  if (!firstLine) return null;

  // For multi-line signatures, find the opening brace/colon
  let signature = firstLine;
  let lineIdx = startLine + 1;
  while (
    lineIdx < lines.length &&
    !signature.includes('{') &&
    !signature.includes(':') &&
    lineIdx < startLine + 5
  ) {
    const nextLine = lines[lineIdx]?.trim();
    if (nextLine) {
      signature += ' ' + nextLine;
    }
    lineIdx++;
  }

  // Trim to just the signature (before body)
  const braceIdx = signature.indexOf('{');
  if (braceIdx > 0) {
    signature = signature.substring(0, braceIdx).trim();
  }

  return signature;
}

/**
 * Extract docstring/comment before a node
 */
function extractDocstring(
  node: Parser.SyntaxNode,
  sourceCode: string,
  config: LanguageConfig
): string | null {
  // Look for comment immediately before this node
  const prevSibling = node.previousSibling;
  if (prevSibling && config.docstringNodeTypes.includes(prevSibling.type)) {
    return prevSibling.text;
  }

  // For Python, docstring is the first child string in function/class body
  if (
    config === LANGUAGE_CONFIGS['python'] &&
    (node.type === 'function_definition' || node.type === 'class_definition')
  ) {
    const body = node.children.find((c) => c.type === 'block');
    if (body) {
      const firstChild = body.children.find(
        (c) => c.type === 'expression_statement'
      );
      if (firstChild) {
        const string = firstChild.children.find((c) => c.type === 'string');
        if (string) return string.text;
      }
    }
  }

  return null;
}

/**
 * Generate chunk ID from file path and position.
 *
 * Normalizes file paths to create IDs that match the allowed pattern
 * `/^[a-zA-Z0-9_-]+$/` used by the store's ID validation.
 *
 * Characters replaced:
 * - `/` and `\` (path separators) → `_`
 * - `.` (dots) → `_`
 * - `@`, spaces, parentheses, `+`, `:`, and any other non-alphanumeric
 *   characters (except `-` and `_`) → `_`
 *
 * This handles paths like:
 * - `@scope/package/file.ts` → `_scope_package_file_ts`
 * - `path with spaces/file.ts` → `path_with_spaces_file_ts`
 * - `file (copy).ts` → `file__copy__ts`
 * - `c++/main.cpp` → `c___main_cpp`
 */
function generateChunkId(filePath: string, startLine: number): string {
  const normalized = filePath
    .replace(/[\\/]/g, '_')         // path separators
    .replace(/\./g, '_')            // dots
    .replace(/[^a-zA-Z0-9_-]/g, '_'); // any remaining unsafe chars
  return `${normalized}_L${startLine}`;
}

/**
 * Check if node content is too small to be a meaningful chunk
 */
function isTooSmall(content: string): boolean {
  const MIN_CHARS = 50;
  const MIN_LINES = 2;
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  return content.length < MIN_CHARS || lines.length < MIN_LINES;
}

/**
 * Check if node content is too large and needs splitting
 */
function isTooLarge(content: string): boolean {
  const MAX_CHARS = 2000; // ~1000-1500 tokens target, with buffer
  return content.length > MAX_CHARS;
}

/**
 * Split large content into overlapping chunks
 */
function splitLargeContent(
  content: string,
  startLine: number,
  targetSize: number = 1500,
  overlapRatio: number = 0.15
): Array<{ content: string; startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const chunks: Array<{ content: string; startLine: number; endLine: number }> =
    [];

  const linesPerChunk = Math.ceil(
    targetSize / (content.length / lines.length)
  );
  const overlap = Math.floor(linesPerChunk * overlapRatio);

  let currentStart = 0;
  while (currentStart < lines.length) {
    const currentEnd = Math.min(currentStart + linesPerChunk, lines.length);
    const chunkLines = lines.slice(currentStart, currentEnd);

    chunks.push({
      content: chunkLines.join('\n'),
      startLine: startLine + currentStart,
      endLine: startLine + currentEnd - 1,
    });

    currentStart = currentEnd - overlap;
    if (currentStart >= lines.length - overlap) break;
  }

  return chunks;
}

/**
 * Main chunking function - processes source code into semantic chunks.
 *
 * Parses source code using tree-sitter and extracts semantic units
 * (functions, classes, methods) as individual chunks. Large chunks
 * are automatically split with overlap for better embedding quality.
 *
 * @param sourceCode - The source code content to chunk
 * @param filePath - The file path (used for language detection and IDs)
 * @returns Array of code chunks with metadata
 *
 * @example
 * ```typescript
 * const chunks = await chunkCode(fileContent, '/project/src/auth.ts');
 * for (const chunk of chunks) {
 *   console.log(`${chunk.name}: ${chunk.startLine}-${chunk.endLine}`);
 * }
 * ```
 */
export async function chunkCode(
  sourceCode: string,
  filePath: string
): Promise<CodeChunk[]> {
  // Strip BOM if present (common in files from Windows editors)
  const cleanedSource = stripBOM(sourceCode);

  const ext = path.extname(filePath);
  const lang = getLanguageByExtension(ext);

  if (!lang) {
    // Fall back to simple line-based chunking for unsupported languages
    log.debug('Unsupported language, using fallback chunking', { filePath, ext });
    return fallbackChunking(cleanedSource, filePath);
  }

  const config = LANGUAGE_CONFIGS[lang];
  if (!config) {
    return fallbackChunking(cleanedSource, filePath);
  }

  let parser: Parser | null = null;
  let tree: Parser.Tree | null = null;

  try {
    // Create parser with the language's WASM grammar
    parser = await createParser(config.wasmPath);
    tree = parser.parse(cleanedSource);
    const chunks: CodeChunk[] = [];

    // Collect all semantic nodes with depth limiting
    const semanticNodes: Parser.SyntaxNode[] = [];
    collectSemanticNodes(tree.rootNode, config.chunkNodeTypes, semanticNodes, 0);

    for (const node of semanticNodes) {
      const content = node.text;
      const startLine = node.startPosition.row + 1; // 1-indexed
      const endLine = node.endPosition.row + 1;
      const name = extractName(node, config);
      const signature = extractSignature(node, cleanedSource);
      const docstring = extractDocstring(node, cleanedSource, config);

      // Skip if too small
      if (isTooSmall(content)) continue;

      // Normalize language name for output (tsx -> typescript)
      const outputLang = lang === 'tsx' ? 'typescript' : lang === 'jsx' ? 'javascript' : lang;

      // Split if too large
      if (isTooLarge(content)) {
        const subChunks = splitLargeContent(content, startLine);
        for (let i = 0; i < subChunks.length; i++) {
          const sub = subChunks[i];
          if (!sub) continue;
          chunks.push({
            id: generateChunkId(filePath, sub.startLine) + `_p${i}`,
            filePath,
            content: sub.content,
            startLine: sub.startLine,
            endLine: sub.endLine,
            name: name ? `${name} (part ${i + 1})` : null,
            nodeType: node.type,
            signature: i === 0 ? signature : null,
            docstring: i === 0 ? docstring : null,
            language: outputLang,
          });
        }
      } else {
        chunks.push({
          id: generateChunkId(filePath, startLine),
          filePath,
          content,
          startLine,
          endLine,
          name,
          nodeType: node.type,
          signature,
          docstring,
          language: outputLang,
        });
      }
    }

    // If we didn't find any semantic nodes, fall back to simple chunking
    if (chunks.length === 0) {
      log.debug('No semantic nodes found, using fallback chunking', { filePath });
      return fallbackChunking(cleanedSource, filePath);
    }

    log.debug('Chunking complete', { filePath, chunkCount: chunks.length });
    return chunks;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn('Tree-sitter parsing failed, using fallback', {
      filePath,
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    return fallbackChunking(cleanedSource, filePath);
  } finally {
    // IMPORTANT: Free WASM memory by deleting the tree
    if (tree) {
      tree.delete();
    }
    // Note: Parser instances are lightweight and don't need explicit cleanup
    // as long as the tree is deleted
  }
}

/**
 * Recursively collect nodes matching the chunk node types.
 *
 * Includes depth limiting to prevent stack overflow on pathologically
 * nested code structures.
 *
 * @param node - The current AST node
 * @param nodeTypes - Node types to match
 * @param result - Array to collect matching nodes
 * @param depth - Current recursion depth
 *
 * @internal
 */
function collectSemanticNodes(
  node: Parser.SyntaxNode,
  nodeTypes: string[],
  result: Parser.SyntaxNode[],
  depth: number = 0
): void {
  // Depth limit to prevent stack overflow on deeply nested code
  if (depth >= MAX_RECURSION_DEPTH) {
    log.warn('Max recursion depth reached during AST traversal', {
      depth,
      nodeType: node.type,
      startLine: node.startPosition.row + 1,
    });
    return;
  }

  if (nodeTypes.includes(node.type)) {
    result.push(node);
    // Don't recurse into matched nodes to avoid duplication
    return;
  }

  for (const child of node.children) {
    collectSemanticNodes(child, nodeTypes, result, depth + 1);
  }
}

/**
 * Fallback chunking for unsupported languages or when tree-sitter fails
 */
function fallbackChunking(sourceCode: string, filePath: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = sourceCode.split('\n');
  const targetLines = 50; // ~75-100 lines per chunk
  const overlap = 5;

  let currentStart = 0;
  let partIndex = 0;

  while (currentStart < lines.length) {
    const currentEnd = Math.min(currentStart + targetLines, lines.length);
    const chunkLines = lines.slice(currentStart, currentEnd);
    const content = chunkLines.join('\n');

    if (content.trim().length > 0) {
      chunks.push({
        id: generateChunkId(filePath, currentStart + 1) + `_fallback${partIndex}`,
        filePath,
        content,
        startLine: currentStart + 1,
        endLine: currentEnd,
        name: null,
        nodeType: 'fallback_chunk',
        signature: null,
        docstring: null,
        language: path.extname(filePath).slice(1) || 'unknown',
      });
      partIndex++;
    }

    currentStart = currentEnd - overlap;
    if (currentStart >= lines.length - overlap) break;
  }

  return chunks;
}

/**
 * Chunk multiple files concurrently.
 *
 * Processes multiple files in parallel for improved performance.
 * Individual file failures are logged but don't prevent other files
 * from being processed.
 *
 * @param files - Array of file paths and their contents
 * @returns Array of all code chunks from all files
 *
 * @example
 * ```typescript
 * const files = [
 *   { path: '/project/src/auth.ts', content: authCode },
 *   { path: '/project/src/api.ts', content: apiCode },
 * ];
 * const chunks = await chunkFiles(files);
 * ```
 */
export async function chunkFiles(
  files: Array<{ path: string; content: string }>
): Promise<CodeChunk[]> {
  const results = await Promise.allSettled(
    files.map((file) => chunkCode(file.content, file.path))
  );

  const chunks: CodeChunk[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      chunks.push(...result.value);
    } else {
      const file = files[i];
      log.error('Failed to chunk file', {
        filePath: file?.path,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return chunks;
}
