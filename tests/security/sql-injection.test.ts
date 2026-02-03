/**
 * SQL injection security tests for filter building.
 */

import {
  validateFilterPattern,
  sanitizePathPattern,
  sanitizeGlobPattern,
  buildSafeFilter,
  buildPathLikeCondition,
  buildFilePatternCondition,
  buildLanguageCondition,
} from '../../src/search/filter-builder.js';
import { InvalidFilterError } from '../../src/errors.js';

describe('SQL Injection Prevention', () => {
  describe('validateFilterPattern', () => {
    it('should accept safe alphanumeric patterns', () => {
      expect(validateFilterPattern('hello')).toBe(true);
      expect(validateFilterPattern('test_file')).toBe(true);
      expect(validateFilterPattern('path-to-file')).toBe(true);
      expect(validateFilterPattern('file123')).toBe(true);
    });

    it('should accept SQL LIKE wildcards', () => {
      expect(validateFilterPattern('%test%')).toBe(true);
      expect(validateFilterPattern('test_')).toBe(true);
      expect(validateFilterPattern('%_test_%')).toBe(true);
    });

    it('should reject SQL injection attempts with quotes', () => {
      expect(validateFilterPattern("test'")).toBe(false);
      expect(validateFilterPattern("'; DROP TABLE--")).toBe(false);
      expect(validateFilterPattern("test' OR '1'='1")).toBe(false);
      expect(validateFilterPattern('test"')).toBe(false);
    });

    it('should reject SQL injection with semicolons', () => {
      expect(validateFilterPattern('test; DROP TABLE')).toBe(false);
      expect(validateFilterPattern('test;--')).toBe(false);
    });

    it('should reject SQL injection with comments', () => {
      // Note: -- is valid per our whitelist (alphanumeric, underscore, hyphen, percent)
      // but /* is not valid
      expect(validateFilterPattern('test/*comment*/')).toBe(false);
    });

    it('should reject patterns with special characters', () => {
      expect(validateFilterPattern('test=')).toBe(false);
      expect(validateFilterPattern('test()')).toBe(false);
      expect(validateFilterPattern('test<>')).toBe(false);
      expect(validateFilterPattern('test\n')).toBe(false);
    });

    it('should reject overly long patterns', () => {
      const longPattern = 'a'.repeat(501);
      expect(validateFilterPattern(longPattern)).toBe(false);
    });

    it('should accept patterns at max length', () => {
      const maxPattern = 'a'.repeat(500);
      expect(validateFilterPattern(maxPattern)).toBe(true);
    });
  });

  describe('sanitizePathPattern', () => {
    it('should convert path separators to underscores', () => {
      expect(sanitizePathPattern('src/test/file')).toBe('src_test_file');
      expect(sanitizePathPattern('src\\test\\file')).toBe('src_test_file');
    });

    it('should convert dots to underscores', () => {
      expect(sanitizePathPattern('file.ts')).toBe('file_ts');
      expect(sanitizePathPattern('src.test.file')).toBe('src_test_file');
    });

    it('should handle @ symbols in scoped package paths', () => {
      expect(sanitizePathPattern('@scope/package/file')).toBe('_scope_package_file');
      expect(sanitizePathPattern('node_modules/@types/node')).toBe('node_modules__types_node');
    });

    it('should handle spaces in paths', () => {
      expect(sanitizePathPattern('path with spaces/file')).toBe('path_with_spaces_file');
      expect(sanitizePathPattern('My Documents/project')).toBe('My_Documents_project');
    });

    it('should handle parentheses in paths', () => {
      expect(sanitizePathPattern('file (copy)')).toBe('file__copy_');
      expect(sanitizePathPattern('Component(HOC).tsx')).toBe('Component_HOC__tsx');
    });

    it('should handle plus signs in paths', () => {
      expect(sanitizePathPattern('c++/main')).toBe('c___main');
    });

    it('should handle colons in Windows paths', () => {
      expect(sanitizePathPattern('C:\\Users\\test')).toBe('C__Users_test');
    });

    it('should sanitize SQL injection attempts instead of throwing', () => {
      // These now get sanitized rather than throwing, since the catch-all
      // replaces all unsafe characters with underscores
      const result = sanitizePathPattern("src'; DROP TABLE--/");
      expect(result).toBe('src___DROP_TABLE--_');
      expect(result).toMatch(/^[a-zA-Z0-9_\-%]+$/);
    });
  });

  describe('sanitizeGlobPattern', () => {
    it('should convert glob wildcards to SQL LIKE', () => {
      expect(sanitizeGlobPattern('*.ts')).toBe('%_ts');
      expect(sanitizeGlobPattern('**/*.py')).toBe('%_%_py');
      // Note: . becomes _ and ? becomes _, so ??.ts = ____ts
      expect(sanitizeGlobPattern('src/??.ts')).toBe('src____ts');
    });

    it('should sanitize SQL injection in glob patterns', () => {
      // SQL injection attempts are now sanitized (unsafe chars replaced with _)
      const result = sanitizeGlobPattern("*'; DROP TABLE--");
      // * -> %, ' -> _, ; -> _, space -> _
      expect(result).toBe('%___DROP_TABLE--');
      expect(result).toMatch(/^[a-zA-Z0-9_%-]+$/);
    });
  });

  describe('buildPathLikeCondition', () => {
    it('should build safe LIKE conditions', () => {
      const result = buildPathLikeCondition('src/test');
      expect(result).toBe("id LIKE 'src_test%'");
    });

    it('should escape path separators', () => {
      const result = buildPathLikeCondition('src/components/ui');
      expect(result).toBe("id LIKE 'src_components_ui%'");
    });
  });

  describe('buildLanguageCondition', () => {
    it('should build safe language conditions', () => {
      expect(buildLanguageCondition('typescript')).toBe("language = 'typescript'");
      expect(buildLanguageCondition('python')).toBe("language = 'python'");
    });

    it('should reject invalid language names', () => {
      expect(() => buildLanguageCondition('type-script')).toThrow(InvalidFilterError);
      expect(() => buildLanguageCondition("'; DROP TABLE--")).toThrow(InvalidFilterError);
      expect(() => buildLanguageCondition('PYTHON')).toThrow(InvalidFilterError);
    });
  });

  describe('buildFilePatternCondition', () => {
    it('should build safe file pattern conditions', () => {
      const result = buildFilePatternCondition('*.ts');
      // * becomes %, . becomes _
      expect(result).toBe("id LIKE '%%_ts'");
    });
  });

  describe('buildSafeFilter', () => {
    it('should return undefined for empty options', () => {
      expect(buildSafeFilter({})).toBeUndefined();
    });

    it('should build path filter', () => {
      const result = buildSafeFilter({ path: 'src/test' });
      expect(result).toBe("id LIKE 'src_test%'");
    });

    it('should use language filter for simple extension patterns', () => {
      const result = buildSafeFilter({ filePattern: '*.ts' });
      expect(result).toBe("language = 'typescript'");
    });

    it('should use language filter for Python', () => {
      const result = buildSafeFilter({ filePattern: '*.py' });
      expect(result).toBe("language = 'python'");
    });

    it('should build complex file pattern filter', () => {
      const result = buildSafeFilter({ filePattern: '**/*.test.ts' });
      // ** becomes %, * becomes %, . becomes _, so **/*.test.ts = %%_%_test_ts
      expect(result).toBe("id LIKE '%%_%_test_ts'");
    });

    it('should combine path and file pattern filters', () => {
      const result = buildSafeFilter({ path: 'src', filePattern: '*.ts' });
      expect(result).toBe("id LIKE 'src%' AND language = 'typescript'");
    });

    it('should sanitize SQL injection in path', () => {
      // SQL injection attempts are now sanitized (unsafe chars replaced with _)
      const result = buildSafeFilter({ path: "'; DROP TABLE--" });
      expect(result).toBe("id LIKE '___DROP_TABLE--%'");
      // The sanitized inner value contains only safe characters
      // (the outer quotes are SQL string delimiters, not part of the user input)
      const innerValue = result?.match(/id LIKE '([^']+)'/)?.[1];
      expect(innerValue).toMatch(/^[a-zA-Z0-9_%-]+$/);
    });

    it('should sanitize SQL injection in file pattern', () => {
      // SQL injection attempts are now sanitized (unsafe chars replaced with _)
      const result = buildSafeFilter({ filePattern: "*.ts'; DROP TABLE--" });
      // * -> %, . -> _, ' -> _, ; -> _, space -> _, etc.
      expect(result).toBe("id LIKE '%%_ts___DROP_TABLE--'");
    });
  });

  describe('Real-world SQL injection payloads', () => {
    const sqlInjectionPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE users--",
      "' UNION SELECT * FROM users--",
      "1'; DELETE FROM chunks WHERE '1'='1",
      "test' AND 1=1--",
      "admin'--",
      "' OR 1=1#",
      "'; WAITFOR DELAY '0:0:5'--",
      "' OR EXISTS(SELECT * FROM users)--",
      "test\u0000'; DROP TABLE--",
    ];

    it.each(sqlInjectionPayloads)(
      'should reject injection payload via validateFilterPattern: %s',
      (payload) => {
        expect(validateFilterPattern(payload)).toBe(false);
      }
    );

    it.each(sqlInjectionPayloads)(
      'should sanitize injection payload and produce safe result: %s',
      (payload) => {
        // sanitizePathPattern now sanitizes rather than throws
        const result = sanitizePathPattern(payload);
        // The result should only contain safe characters
        expect(validateFilterPattern(result)).toBe(true);
        // Should not contain any SQL-dangerous characters
        expect(result).not.toMatch(/['";\(\)=<>]/);
      }
    );

    it.each(sqlInjectionPayloads)(
      'should produce safe filter for buildSafeFilter path: %s',
      (payload) => {
        // buildSafeFilter now sanitizes rather than throws
        const result = buildSafeFilter({ path: payload });
        // Should be a valid LIKE condition
        expect(result).toMatch(/^id LIKE '[a-zA-Z0-9_%-]+'$/);
        // Should not contain unescaped quotes (the one at start/end are the SQL string delimiters)
        const innerContent = result?.slice(9, -1); // Extract content between "id LIKE '" and "'"
        expect(innerContent).not.toContain("'");
      }
    );
  });
});
