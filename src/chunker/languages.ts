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
  /** Path to the WASM grammar file (relative to grammars directory) */
  wasmPath: string;
  /** Node types for function/method calls (for graph edge extraction) */
  callNodeTypes?: string[];
  /** Node types for import statements (for graph edge extraction) */
  importNodeTypes?: string[];
  /** Node types for extends/implements clauses (for graph edge extraction) */
  heritageNodeTypes?: string[];
}

export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    extensions: ['.ts'],
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
    wasmPath: 'tree-sitter-typescript.wasm',
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement'],
    heritageNodeTypes: ['extends_clause', 'implements_clause'],
  },
  tsx: {
    extensions: ['.tsx'],
    chunkNodeTypes: [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
      'export_statement',
      'lexical_declaration',
      'variable_declaration',
    ],
    nameNodeTypes: ['identifier', 'property_identifier'],
    docstringNodeTypes: ['comment'],
    wasmPath: 'tree-sitter-tsx.wasm',
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement'],
    heritageNodeTypes: ['extends_clause', 'implements_clause'],
  },
  javascript: {
    extensions: ['.js', '.mjs', '.cjs'],
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
    wasmPath: 'tree-sitter-javascript.wasm',
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement'],
    heritageNodeTypes: ['extends_clause'],
  },
  jsx: {
    extensions: ['.jsx'],
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
    wasmPath: 'tree-sitter-javascript.wasm',
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement'],
    heritageNodeTypes: ['extends_clause'],
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
    wasmPath: 'tree-sitter-python.wasm',
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement', 'import_from_statement'],
    heritageNodeTypes: ['argument_list'], // class Foo(Base): — base classes in argument_list
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
    wasmPath: 'tree-sitter-go.wasm',
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
    wasmPath: 'tree-sitter-rust.wasm',
  },
  java: {
    extensions: ['.java'],
    chunkNodeTypes: [
      'class_declaration',
      'method_declaration',
      'interface_declaration',
      'constructor_declaration',
      'enum_declaration',
      'record_declaration',
    ],
    nameNodeTypes: ['identifier'],
    docstringNodeTypes: ['block_comment', 'line_comment'],
    wasmPath: 'tree-sitter-java.wasm',
  },
  csharp: {
    extensions: ['.cs'],
    chunkNodeTypes: [
      'class_declaration',
      'method_declaration',
      'interface_declaration',
      'constructor_declaration',
      'struct_declaration',
      'property_declaration',
      'namespace_declaration',
    ],
    nameNodeTypes: ['identifier'],
    docstringNodeTypes: ['comment'],
    wasmPath: 'tree-sitter-c_sharp.wasm',
  },
  cpp: {
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h', '.hxx'],
    chunkNodeTypes: [
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'template_declaration',
      'namespace_definition',
    ],
    nameNodeTypes: ['identifier', 'field_identifier'],
    docstringNodeTypes: ['comment'],
    wasmPath: 'tree-sitter-cpp.wasm',
  },
  c: {
    extensions: ['.c'],
    chunkNodeTypes: [
      'function_definition',
      'struct_specifier',
      'enum_specifier',
      'declaration',
    ],
    nameNodeTypes: ['identifier', 'field_identifier'],
    docstringNodeTypes: ['comment'],
    wasmPath: 'tree-sitter-c.wasm',
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
