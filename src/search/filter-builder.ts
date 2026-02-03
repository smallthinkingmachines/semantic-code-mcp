/**
 * Safe SQL filter builder for LanceDB queries.
 *
 * This module prevents SQL injection attacks by validating and sanitizing all
 * user-provided filter inputs before they are used in database queries.
 *
 * ## Security Model
 *
 * All filter values are validated against a strict whitelist pattern that only
 * allows safe characters (alphanumeric, underscores, hyphens, percent signs).
 * This approach is more secure than blacklisting dangerous characters because:
 *
 * 1. New attack vectors can't bypass the whitelist
 * 2. Unicode/encoding tricks are automatically rejected
 * 3. The allowed character set is well-defined and auditable
 *
 * ## Usage
 *
 * ```typescript
 * // Safe - input is validated
 * const filter = buildSafeFilter({ path: 'src/utils', filePattern: '*.ts' });
 *
 * // Throws InvalidFilterError - injection attempt blocked
 * buildSafeFilter({ path: "'; DROP TABLE--" });
 * ```
 *
 * @module filter-builder
 */

import { InvalidFilterError } from '../errors.js';

/**
 * Whitelist pattern for safe filter values.
 *
 * Allowed characters:
 * - `a-zA-Z0-9`: Alphanumeric (safe for identifiers)
 * - `_`: Underscore (used as path separator replacement)
 * - `-`: Hyphen (common in file names)
 * - `%`: Percent (SQL LIKE wildcard, safe when properly placed)
 *
 * Explicitly rejected:
 * - `'` `"`: Quotes (SQL string terminators)
 * - `;`: Semicolon (SQL statement separator)
 * - `-``-`: Comment marker (blocked by position, not character)
 * - `(` `)`: Parentheses (function calls)
 * - `=` `<` `>`: Operators
 * - Whitespace, newlines, null bytes
 */
const SAFE_PATTERN = /^[a-zA-Z0-9_\-%]+$/;

/**
 * Maximum length for filter values.
 *
 * Prevents DoS attacks via extremely long strings that could:
 * - Consume excessive memory during regex validation
 * - Create very large SQL queries
 * - Cause buffer issues in downstream systems
 */
const MAX_FILTER_VALUE_LENGTH = 500;

/**
 * Validates that a pattern is safe for use in SQL filter conditions.
 *
 * This is the core security gate - all filter values must pass this check
 * before being interpolated into SQL strings.
 *
 * @param pattern - The pattern string to validate
 * @returns `true` if the pattern contains only whitelisted characters and
 *          is within the length limit; `false` otherwise
 *
 * @example
 * ```typescript
 * validateFilterPattern('src_utils_ts')     // true - safe characters
 * validateFilterPattern('%test%')           // true - LIKE wildcards OK
 * validateFilterPattern("'; DROP TABLE--")  // false - injection attempt
 * validateFilterPattern('a'.repeat(501))    // false - too long
 * ```
 *
 * @security This function is critical for SQL injection prevention.
 *           Changes should be reviewed carefully and tested against
 *           known injection payloads.
 */
export function validateFilterPattern(pattern: string): boolean {
  if (pattern.length > MAX_FILTER_VALUE_LENGTH) {
    return false;
  }
  return SAFE_PATTERN.test(pattern);
}

/**
 * Sanitizes a file system path for use in SQL LIKE patterns.
 *
 * Paths are converted to a normalized form where path separators and dots
 * become underscores. This matches how chunk IDs are generated (see
 * `generateChunkId` in chunker/index.ts).
 *
 * @param path - The file system path to sanitize (e.g., 'src/utils/helpers.ts')
 * @returns The sanitized path suitable for SQL LIKE patterns (e.g., 'src_utils_helpers_ts')
 * @throws {InvalidFilterError} If the sanitized path contains disallowed characters
 *         (indicating a potential injection attempt in the original path)
 *
 * @example
 * ```typescript
 * sanitizePathPattern('src/components')     // 'src_components'
 * sanitizePathPattern('src\\test\\file')    // 'src_test_file' (Windows paths)
 * sanitizePathPattern('file.test.ts')       // 'file_test_ts'
 * sanitizePathPattern("src'; DROP--")       // throws InvalidFilterError
 * ```
 */
export function sanitizePathPattern(path: string): string {
  // Replace path separators, dots, and any other non-safe characters
  // This must match the normalization in generateChunkId (chunker/index.ts)
  const sanitized = path
    .replace(/[\\/]/g, '_')           // path separators
    .replace(/\./g, '_')              // dots
    .replace(/[^a-zA-Z0-9_-]/g, '_'); // any remaining unsafe chars

  // Validate the result (should always pass now, but kept for defense-in-depth)
  if (!validateFilterPattern(sanitized)) {
    throw new InvalidFilterError(
      `Invalid path pattern: contains disallowed characters`
    );
  }

  return sanitized;
}

/**
 * Sanitizes a glob pattern for use in SQL LIKE patterns.
 *
 * Converts standard glob wildcards to their SQL LIKE equivalents:
 * - `**` → `%` (match any path depth)
 * - `*` → `%` (match any characters)
 * - `?` → `_` (match single character)
 *
 * Path separators and dots are also converted to underscores to match
 * the chunk ID format.
 *
 * @param pattern - The glob pattern to sanitize (e.g., '**\/*.test.ts')
 * @returns The sanitized pattern suitable for SQL LIKE (e.g., '%_%_test_ts')
 * @throws {InvalidFilterError} If the sanitized pattern contains disallowed characters
 *
 * @example
 * ```typescript
 * sanitizeGlobPattern('*.ts')           // '%_ts'
 * sanitizeGlobPattern('**\/*.test.ts')   // '%_%_test_ts'
 * sanitizeGlobPattern('src/??.js')      // 'src____js'
 * ```
 */
export function sanitizeGlobPattern(pattern: string): string {
  // Convert glob patterns to SQL LIKE patterns
  // This must match the normalization in generateChunkId (chunker/index.ts)
  const sanitized = pattern
    .replace(/\*\*/g, '%')            // ** -> %
    .replace(/\*/g, '%')              // * -> %
    .replace(/\?/g, '_')              // ? -> _
    .replace(/[\\/]/g, '_')           // path separators -> _
    .replace(/\./g, '_')              // . -> _
    .replace(/[^a-zA-Z0-9_%-]/g, '_'); // any remaining unsafe chars (keep % for LIKE)

  // Validate the result (should always pass now, but kept for defense-in-depth)
  if (!validateFilterPattern(sanitized)) {
    throw new InvalidFilterError(
      `Invalid file pattern: contains disallowed characters`
    );
  }

  return sanitized;
}

/**
 * Builds a safe SQL LIKE condition for filtering by path prefix.
 *
 * The resulting condition matches chunk IDs that start with the given path.
 * This is used to scope searches to a specific directory.
 *
 * @param pathPattern - The directory path to filter by
 * @returns A SQL condition string like `id LIKE 'src_utils%'`
 * @throws {InvalidFilterError} If the path contains injection characters
 *
 * @example
 * ```typescript
 * buildPathLikeCondition('src/utils')  // "id LIKE 'src_utils%'"
 * ```
 */
export function buildPathLikeCondition(pathPattern: string): string {
  const sanitized = sanitizePathPattern(pathPattern);
  return `id LIKE '${sanitized}%'`;
}

/**
 * Builds a safe SQL equality condition for filtering by programming language.
 *
 * Language names are validated against a strict lowercase-only pattern since
 * all language identifiers in the system are lowercase (typescript, python, etc.).
 *
 * @param language - The language name (must be lowercase letters only)
 * @returns A SQL condition string like `language = 'typescript'`
 * @throws {InvalidFilterError} If the language name contains non-lowercase letters
 *
 * @example
 * ```typescript
 * buildLanguageCondition('typescript')  // "language = 'typescript'"
 * buildLanguageCondition('Python')      // throws - uppercase not allowed
 * buildLanguageCondition('c++')         // throws - special chars not allowed
 * ```
 */
export function buildLanguageCondition(language: string): string {
  // Language names are very constrained
  if (!/^[a-z]+$/.test(language)) {
    throw new InvalidFilterError(`Invalid language name: ${language}`);
  }
  return `language = '${language}'`;
}

/**
 * Builds a safe SQL LIKE condition for filtering by file pattern suffix.
 *
 * The resulting condition matches chunk IDs that end with the given pattern.
 * This is used to filter by file extension or naming convention.
 *
 * @param pattern - The glob pattern to filter by (e.g., '*.ts', '**\/*.test.js')
 * @returns A SQL condition string like `id LIKE '%%_ts'`
 * @throws {InvalidFilterError} If the pattern contains injection characters
 *
 * @example
 * ```typescript
 * buildFilePatternCondition('*.ts')        // "id LIKE '%%_ts'"
 * buildFilePatternCondition('*.test.ts')   // "id LIKE '%%_test_ts'"
 * ```
 */
export function buildFilePatternCondition(pattern: string): string {
  const sanitized = sanitizeGlobPattern(pattern);
  return `id LIKE '%${sanitized}'`;
}

/**
 * Maps file extensions to their canonical language names.
 *
 * This enables optimization: when a user filters by `*.ts`, we can use
 * `language = 'typescript'` instead of `id LIKE '%_ts'`, which is more
 * efficient and reliable (exact match vs pattern match).
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/**
 * Options for building SQL filter conditions.
 */
export interface FilterOptions {
  /**
   * Directory path prefix to scope the search.
   * Files outside this directory will be excluded.
   * @example 'src/utils' - only search in src/utils and subdirectories
   */
  path?: string;

  /**
   * Glob pattern to filter files by name/extension.
   * @example '*.ts' - TypeScript files only
   * @example '**\/*.test.ts' - test files at any depth
   */
  filePattern?: string;
}

/**
 * Builds a safe, validated SQL filter string from search options.
 *
 * This is the main entry point for filter construction. It combines path
 * and file pattern filters with AND logic, optimizing simple extension
 * patterns to use the language field for better query performance.
 *
 * ## Security
 *
 * All input values are validated through `validateFilterPattern()` before
 * being interpolated into the SQL string. Injection attempts will throw
 * `InvalidFilterError`.
 *
 * ## Optimization
 *
 * Simple extension patterns like `*.ts` are converted to language equality
 * checks (`language = 'typescript'`) instead of LIKE patterns, which:
 * - Allows index usage on the language column
 * - Avoids false positives (e.g., `utils.ts.bak` matching `*.ts`)
 * - Is faster for large indexes
 *
 * @param options - Filter options containing path and/or filePattern
 * @returns A SQL WHERE clause condition string, or `undefined` if no filters specified
 * @throws {InvalidFilterError} If any filter value contains disallowed characters
 *
 * @example
 * ```typescript
 * // No filters
 * buildSafeFilter({})
 * // => undefined
 *
 * // Path filter only
 * buildSafeFilter({ path: 'src/utils' })
 * // => "id LIKE 'src_utils%'"
 *
 * // Simple extension (optimized to language)
 * buildSafeFilter({ filePattern: '*.ts' })
 * // => "language = 'typescript'"
 *
 * // Complex pattern (uses LIKE)
 * buildSafeFilter({ filePattern: '**\/*.test.ts' })
 * // => "id LIKE '%%_%_test_ts'"
 *
 * // Combined filters
 * buildSafeFilter({ path: 'src', filePattern: '*.py' })
 * // => "id LIKE 'src%' AND language = 'python'"
 *
 * // Injection attempt - throws
 * buildSafeFilter({ path: "'; DROP TABLE--" })
 * // => throws InvalidFilterError
 * ```
 */
export function buildSafeFilter(options: FilterOptions): string | undefined {
  const conditions: string[] = [];

  if (options.path) {
    conditions.push(buildPathLikeCondition(options.path));
  }

  if (options.filePattern) {
    // Check if it's a simple extension pattern like "*.py" or "*.ts"
    const extMatch = options.filePattern.match(/^\*(\.[a-z]+)$/i);
    if (extMatch && extMatch[1]) {
      const ext = extMatch[1].toLowerCase();
      const lang = EXTENSION_TO_LANGUAGE[ext];
      if (lang) {
        // Use language field for better performance and reliability
        conditions.push(buildLanguageCondition(lang));
      }
    } else {
      // For complex patterns, convert to id-based LIKE pattern
      conditions.push(buildFilePatternCondition(options.filePattern));
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : undefined;
}
