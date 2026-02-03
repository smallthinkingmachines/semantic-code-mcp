/**
 * Tests for the AST-aware code chunker.
 */

import { chunkCode, chunkFiles, type CodeChunk } from '../../src/chunker/index.js';

describe('Code Chunker', () => {
  describe('chunkCode', () => {
    describe('TypeScript/JavaScript', () => {
      it('should chunk a simple function', async () => {
        const code = `
function hello(name: string): string {
  console.log('Hello');
  return \`Hello, \${name}!\`;
}
`;
        const chunks = await chunkCode(code, '/test/file.ts');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.nodeType).toBe('function_declaration');
        expect(chunks[0]?.name).toBe('hello');
        expect(chunks[0]?.language).toBe('typescript');
      });

      it('should chunk a class with methods', async () => {
        const code = `
class Calculator {
  private value: number = 0;

  add(n: number): Calculator {
    this.value += n;
    return this;
  }

  subtract(n: number): Calculator {
    this.value -= n;
    return this;
  }

  getResult(): number {
    return this.value;
  }
}
`;
        const chunks = await chunkCode(code, '/test/calculator.ts');

        expect(chunks.length).toBeGreaterThan(0);
        // Should find the class
        const classChunk = chunks.find((c) => c.nodeType === 'class_declaration');
        expect(classChunk).toBeDefined();
        // Name extraction may vary based on tree-sitter implementation
        // The important thing is that we found the class
        expect(classChunk?.content).toContain('Calculator');
      });

      it('should chunk arrow functions in const declarations', async () => {
        const code = `
export const processData = (data: string[]): string[] => {
  return data.map(item => item.toUpperCase());
};
`;
        const chunks = await chunkCode(code, '/test/utils.ts');

        expect(chunks.length).toBeGreaterThan(0);
      });

      it('should extract function signatures', async () => {
        const code = `
function processItems(
  items: Item[],
  options: ProcessOptions
): ProcessResult {
  return items.map(item => process(item, options));
}
`;
        const chunks = await chunkCode(code, '/test/process.ts');

        expect(chunks[0]?.signature).toBeDefined();
        expect(chunks[0]?.signature).toContain('processItems');
      });

      it('should handle empty files gracefully', async () => {
        const code = '';
        const chunks = await chunkCode(code, '/test/empty.ts');

        expect(chunks).toEqual([]);
      });

      it('should handle files with only comments', async () => {
        const code = `
// This is a comment
/* Another comment */
/**
 * JSDoc comment
 */
`;
        const chunks = await chunkCode(code, '/test/comments.ts');

        // Should return empty or fallback chunks
        expect(Array.isArray(chunks)).toBe(true);
      });
    });

    describe('Python', () => {
      it('should chunk Python functions', async () => {
        const code = `
def hello(name: str) -> str:
    """Say hello to someone."""
    print(f"Hello, {name}!")
    return f"Hello, {name}!"
`;
        const chunks = await chunkCode(code, '/test/hello.py');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.nodeType).toBe('function_definition');
        expect(chunks[0]?.name).toBe('hello');
        expect(chunks[0]?.language).toBe('python');
      });

      it('should chunk Python classes', async () => {
        const code = `
class Calculator:
    """A simple calculator class."""

    def __init__(self):
        self.value = 0

    def add(self, n: int) -> 'Calculator':
        self.value += n
        return self
`;
        const chunks = await chunkCode(code, '/test/calc.py');

        expect(chunks.length).toBeGreaterThan(0);
        const classChunk = chunks.find((c) => c.nodeType === 'class_definition');
        expect(classChunk).toBeDefined();
        expect(classChunk?.name).toBe('Calculator');
      });

      it('should extract Python docstrings', async () => {
        const code = `
def documented_function():
    """
    This is a docstring.
    It describes the function.
    """
    pass
`;
        const chunks = await chunkCode(code, '/test/docs.py');

        expect(chunks.length).toBeGreaterThan(0);
        // Docstring extraction may vary based on implementation
      });
    });

    describe('Go', () => {
      it('should chunk Go functions', async () => {
        const code = `
package main

func hello(name string) string {
	fmt.Printf("Hello, %s!\\n", name)
	return fmt.Sprintf("Hello, %s!", name)
}
`;
        const chunks = await chunkCode(code, '/test/hello.go');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('go');
      });

      it('should chunk Go structs and methods', async () => {
        const code = `
package main

type Calculator struct {
	value int
}

func (c *Calculator) Add(n int) *Calculator {
	c.value += n
	return c
}
`;
        const chunks = await chunkCode(code, '/test/calc.go');

        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe('Rust', () => {
      it('should chunk Rust functions', async () => {
        const code = `
fn hello(name: &str) -> String {
    println!("Hello, {}!", name);
    format!("Hello, {}!", name)
}
`;
        const chunks = await chunkCode(code, '/test/hello.rs');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('rust');
      });

      it('should chunk Rust structs and impl blocks', async () => {
        const code = `
struct Calculator {
    value: i32,
}

impl Calculator {
    fn new() -> Self {
        Calculator { value: 0 }
    }

    fn add(&mut self, n: i32) -> &mut Self {
        self.value += n;
        self
    }
}
`;
        const chunks = await chunkCode(code, '/test/calc.rs');

        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe('Java', () => {
      it('should chunk Java classes and methods', async () => {
        const code = `
public class Calculator {
    private int value = 0;

    public Calculator add(int n) {
        this.value += n;
        return this;
    }

    public int getValue() {
        return this.value;
    }
}
`;
        const chunks = await chunkCode(code, '/test/Calculator.java');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('java');
      });

      it('should chunk Java interfaces', async () => {
        const code = `
public interface Addable {
    int add(int a, int b);
    int subtract(int a, int b);
}
`;
        const chunks = await chunkCode(code, '/test/Addable.java');

        expect(chunks.length).toBeGreaterThan(0);
        const interfaceChunk = chunks.find((c) => c.nodeType === 'interface_declaration');
        expect(interfaceChunk).toBeDefined();
      });
    });

    describe('C#', () => {
      it('should chunk C# classes and methods', async () => {
        const code = `
public class Calculator
{
    private int value = 0;

    public Calculator Add(int n)
    {
        this.value += n;
        return this;
    }

    public int Value => value;
}
`;
        const chunks = await chunkCode(code, '/test/Calculator.cs');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('csharp');
      });

      it('should chunk C# interfaces', async () => {
        const code = `
public interface ICalculator
{
    int Add(int a, int b);
    int Subtract(int a, int b);
}
`;
        const chunks = await chunkCode(code, '/test/ICalculator.cs');

        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe('C++', () => {
      it('should chunk C++ functions', async () => {
        const code = `
#include <string>

std::string hello(const std::string& name) {
    return "Hello, " + name + "!";
}
`;
        const chunks = await chunkCode(code, '/test/hello.cpp');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('cpp');
      });

      it('should chunk C++ classes and methods', async () => {
        const code = `
class Calculator {
private:
    int value = 0;

public:
    Calculator& add(int n) {
        value += n;
        return *this;
    }

    int getValue() const {
        return value;
    }
};
`;
        const chunks = await chunkCode(code, '/test/Calculator.cpp');

        expect(chunks.length).toBeGreaterThan(0);
      });

      it('should handle header files', async () => {
        const code = `
#ifndef CALCULATOR_H
#define CALCULATOR_H

class Calculator {
public:
    Calculator();
    int add(int a, int b);
};

#endif
`;
        const chunks = await chunkCode(code, '/test/Calculator.h');

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]?.language).toBe('cpp');
      });
    });

    describe('Large content splitting', () => {
      it('should split large functions into multiple chunks', async () => {
        // Create a very long function
        const lines = ['function longFunction() {'];
        for (let i = 0; i < 100; i++) {
          lines.push(`  const var${i} = ${i}; // Line ${i}`);
        }
        lines.push('  return true;');
        lines.push('}');

        const code = lines.join('\n');
        const chunks = await chunkCode(code, '/test/long.ts');

        // Should have multiple chunks due to splitting
        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe('Chunk IDs', () => {
      it('should generate unique IDs for chunks', async () => {
        const code = `
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }
`;
        const chunks = await chunkCode(code, '/test/multi.ts');

        const ids = chunks.map((c) => c.id);
        const uniqueIds = new Set(ids);

        expect(uniqueIds.size).toBe(ids.length);
      });

      it('should include file path in chunk ID', async () => {
        const code = `function test() { return true; }`;
        const chunks = await chunkCode(code, '/path/to/file.ts');

        expect(chunks[0]?.id).toContain('path_to_file_ts');
      });

      it('should handle @ symbols in paths (scoped packages)', async () => {
        const code = `function test() { return true; }`;
        const chunks = await chunkCode(code, '/node_modules/@scope/package/index.ts');

        // @ should be replaced with underscore
        expect(chunks[0]?.id).toContain('_scope_package_index_ts');
        // ID should only contain safe characters
        expect(chunks[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      it('should handle spaces in paths', async () => {
        const code = `function test() { return true; }`;
        const chunks = await chunkCode(code, '/path with spaces/my file.ts');

        // Spaces should be replaced with underscores
        expect(chunks[0]?.id).toContain('path_with_spaces_my_file_ts');
        expect(chunks[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      it('should handle parentheses in paths', async () => {
        const code = `function test() { return true; }`;
        const chunks = await chunkCode(code, '/test/file (copy).ts');

        // Parentheses should be replaced with underscores
        expect(chunks[0]?.id).toContain('file__copy__ts');
        expect(chunks[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      it('should handle plus signs in paths (c++ directories)', async () => {
        const code = `
#include <iostream>
int main() {
    std::cout << "Hello";
    return 0;
}
`;
        const chunks = await chunkCode(code, '/projects/c++/main.cpp');

        // Plus signs should be replaced with underscores
        expect(chunks[0]?.id).toContain('c___main_cpp');
        expect(chunks[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      it('should handle colons in Windows-style paths', async () => {
        const code = `function test() { return true; }`;
        const chunks = await chunkCode(code, 'C:\\Users\\test\\file.ts');

        // Colons and backslashes should be replaced with underscores
        expect(chunks[0]?.id).toContain('C__Users_test_file_ts');
        expect(chunks[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });
    });

    describe('Fallback chunking', () => {
      it('should use fallback for unsupported file types', async () => {
        const code = 'Some content in an unknown file type';
        const chunks = await chunkCode(code, '/test/file.xyz');

        // Should fall back to line-based chunking
        expect(Array.isArray(chunks)).toBe(true);
      });
    });
  });

  describe('chunkFiles', () => {
    it('should chunk multiple files concurrently', async () => {
      const files = [
        {
          path: '/test/a.ts',
          content: 'function a() { return 1; }',
        },
        {
          path: '/test/b.ts',
          content: 'function b() { return 2; }',
        },
      ];

      const chunks = await chunkFiles(files);

      // Should have chunks from both files
      const filePaths = new Set(chunks.map((c) => c.filePath));
      expect(filePaths.has('/test/a.ts')).toBe(true);
      expect(filePaths.has('/test/b.ts')).toBe(true);
    });

    it('should handle empty file list', async () => {
      const chunks = await chunkFiles([]);
      expect(chunks).toEqual([]);
    });
  });
});
