/**
 * Tree-sitter language configurations for AST-aware code chunking.
 * Defines node types that represent semantic boundaries for each language.
 */

export interface LanguageConfig {
  /** File extensions this language handles */
  extensions: string[];
  /** Tree-sitter node types that define chunk boundaries */
  chunkNodeTypes: string[];
  /** Node types for extracting function/method names */
  nameNodeTypes: string[];
  /** Node types for docstrings/comments */
  docstringNodeTypes: string[];
}

export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    extensions: ['.ts', '.tsx'],
    chunkNodeTypes: [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
      'export_statement',
      'lexical_declaration', // const/let with arrow functions
      'variable_declaration',
    ],
    nameNodeTypes: ['identifier', 'property_identifier'],
    docstringNodeTypes: ['comment'],
  },
  javascript: {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    chunkNodeTypes: [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'export_statement',
      'lexical_declaration',
      'variable_declaration',
    ],
    nameNodeTypes: ['identifier', 'property_identifier'],
    docstringNodeTypes: ['comment'],
  },
  python: {
    extensions: ['.py', '.pyw'],
    chunkNodeTypes: [
      'function_definition',
      'class_definition',
      'decorated_definition',
    ],
    nameNodeTypes: ['identifier'],
    docstringNodeTypes: ['string', 'comment'], // Python uses string literals as docstrings
  },
  go: {
    extensions: ['.go'],
    chunkNodeTypes: [
      'function_declaration',
      'method_declaration',
      'type_declaration',
    ],
    nameNodeTypes: ['identifier', 'field_identifier'],
    docstringNodeTypes: ['comment'],
  },
  rust: {
    extensions: ['.rs'],
    chunkNodeTypes: [
      'function_item',
      'impl_item',
      'struct_item',
      'enum_item',
      'trait_item',
      'mod_item',
    ],
    nameNodeTypes: ['identifier'],
    docstringNodeTypes: ['line_comment', 'block_comment'],
  },
};

/**
 * Get language configuration by file extension
 */
export function getLanguageByExtension(ext: string): string | null {
  for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
    if (config.extensions.includes(ext.toLowerCase())) {
      return lang;
    }
  }
  return null;
}

/**
 * Get all supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return Object.values(LANGUAGE_CONFIGS).flatMap((config) => config.extensions);
}
