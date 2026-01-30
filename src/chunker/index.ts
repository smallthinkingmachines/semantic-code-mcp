/**
 * AST-aware code chunker using tree-sitter.
 * Splits code into semantic units (functions, classes, methods) for better embedding quality.
 */

import Parser from 'tree-sitter';
import path from 'path';
import {
  LANGUAGE_CONFIGS,
  getLanguageByExtension,
  type LanguageConfig,
} from './languages.js';

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

interface TreeSitterLanguageModule {
  default?: unknown;
  Language?: unknown;
}

// Cache for loaded tree-sitter languages
const languageCache = new Map<string, unknown>();

/**
 * Load tree-sitter language parser
 */
async function loadLanguage(lang: string): Promise<unknown> {
  if (languageCache.has(lang)) {
    return languageCache.get(lang);
  }

  let languageModule: TreeSitterLanguageModule;

  try {
    switch (lang) {
      case 'typescript':
        languageModule = (await import(
          'tree-sitter-typescript'
        )) as TreeSitterLanguageModule;
        // tree-sitter-typescript exports { typescript, tsx }
        const tsModule = languageModule as { typescript: unknown; tsx: unknown };
        languageCache.set('typescript', tsModule.typescript);
        languageCache.set('tsx', tsModule.tsx);
        return tsModule.typescript;
      case 'tsx':
        languageModule = (await import(
          'tree-sitter-typescript'
        )) as TreeSitterLanguageModule;
        const tsxModule = languageModule as {
          typescript: unknown;
          tsx: unknown;
        };
        languageCache.set('typescript', tsxModule.typescript);
        languageCache.set('tsx', tsxModule.tsx);
        return tsxModule.tsx;
      case 'javascript':
        languageModule = (await import(
          'tree-sitter-javascript'
        )) as TreeSitterLanguageModule;
        break;
      case 'python':
        languageModule = (await import(
          'tree-sitter-python'
        )) as TreeSitterLanguageModule;
        break;
      case 'go':
        languageModule = (await import(
          'tree-sitter-go'
        )) as TreeSitterLanguageModule;
        break;
      case 'rust':
        languageModule = (await import(
          'tree-sitter-rust'
        )) as TreeSitterLanguageModule;
        break;
      default:
        throw new Error(`Unsupported language: ${lang}`);
    }

    const language = languageModule.default ?? languageModule;
    languageCache.set(lang, language);
    return language;
  } catch (error) {
    throw new Error(
      `Failed to load tree-sitter language for ${lang}: ${error}`
    );
  }
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
 * Generate chunk ID from file path and position
 */
function generateChunkId(filePath: string, startLine: number): string {
  const normalized = filePath.replace(/[\\\/]/g, '_').replace(/\./g, '_');
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
 * Main chunking function - processes source code into semantic chunks
 */
export async function chunkCode(
  sourceCode: string,
  filePath: string
): Promise<CodeChunk[]> {
  const ext = path.extname(filePath);
  let lang = getLanguageByExtension(ext);

  if (!lang) {
    // Fall back to simple line-based chunking for unsupported languages
    return fallbackChunking(sourceCode, filePath);
  }

  // Handle TSX separately
  if (ext === '.tsx') {
    lang = 'tsx';
  }

  const config = LANGUAGE_CONFIGS[lang === 'tsx' ? 'typescript' : lang];
  if (!config) {
    return fallbackChunking(sourceCode, filePath);
  }

  try {
    const language = await loadLanguage(lang);
    const parser = new Parser();
    parser.setLanguage(language as Parser.Language);

    const tree = parser.parse(sourceCode);
    const chunks: CodeChunk[] = [];

    // Collect all semantic nodes
    const semanticNodes: Parser.SyntaxNode[] = [];
    collectSemanticNodes(tree.rootNode, config.chunkNodeTypes, semanticNodes);

    for (const node of semanticNodes) {
      const content = node.text;
      const startLine = node.startPosition.row + 1; // 1-indexed
      const endLine = node.endPosition.row + 1;
      const name = extractName(node, config);
      const signature = extractSignature(node, sourceCode);
      const docstring = extractDocstring(node, sourceCode, config);

      // Skip if too small
      if (isTooSmall(content)) continue;

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
            language: lang === 'tsx' ? 'typescript' : lang,
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
          language: lang === 'tsx' ? 'typescript' : lang,
        });
      }
    }

    // If we didn't find any semantic nodes, fall back to simple chunking
    if (chunks.length === 0) {
      return fallbackChunking(sourceCode, filePath);
    }

    return chunks;
  } catch (error) {
    console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
    return fallbackChunking(sourceCode, filePath);
  }
}

/**
 * Recursively collect nodes matching the chunk node types
 */
function collectSemanticNodes(
  node: Parser.SyntaxNode,
  nodeTypes: string[],
  result: Parser.SyntaxNode[]
): void {
  if (nodeTypes.includes(node.type)) {
    result.push(node);
    // Don't recurse into matched nodes to avoid duplication
    return;
  }

  for (const child of node.children) {
    collectSemanticNodes(child, nodeTypes, result);
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
 * Chunk multiple files concurrently
 */
export async function chunkFiles(
  files: Array<{ path: string; content: string }>
): Promise<CodeChunk[]> {
  const results = await Promise.all(
    files.map((file) => chunkCode(file.content, file.path))
  );
  return results.flat();
}
