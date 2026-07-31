import { describe, expect, test } from "bun:test";
import { executeValidation } from "../../src/better-harness/opencode/validation-executor";

describe("validation-executor", () => {
  describe("executeValidation", () => {
    test("allows safe commands", () => {
      const result = executeValidation("ls -la", ".");
      expect(result.passed).toBe(true);
      expect(result.error).toBeNull();
    });

    test("blocks shell injection with semicolon", () => {
      const result = executeValidation("ls -la; rm -rf /", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with ampersand", () => {
      const result = executeValidation("ls -la && rm -rf /", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with pipe", () => {
      const result = executeValidation("ls -la | grep foo", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with dollar sign", () => {
      const result = executeValidation("echo $USER", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with backticks", () => {
      const result = executeValidation("echo `whoami`", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with parentheses", () => {
      const result = executeValidation("echo $(whoami)", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });

    test("blocks shell injection with path traversal", () => {
      const result = executeValidation("ls ../../", ".");
      expect(result.passed).toBe(false);
      expect(result.error).toBe("Command rejected: contains shell injection patterns");
    });
  });
});
