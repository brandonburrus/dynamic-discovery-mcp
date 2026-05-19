/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: This file tests literal ${VAR} interpolation syntax — the strings are intentional. */
import { describe, expect, it } from "vitest";
import { MissingEnvVarsError, interpolateConfig } from "../../src/config/interpolate.js";

describe("interpolateConfig", () => {
  describe("simple substitution", () => {
    it("substitutes ${VAR} in a leaf string", () => {
      const result = interpolateConfig({ mcp: { foo: { command: "${BIN}" } } }, { BIN: "npx" });
      expect(result).toEqual({ mcp: { foo: { command: "npx" } } });
    });

    it("substitutes inside a partial string", () => {
      const result = interpolateConfig(
        { mcp: { x: { headers: { Authorization: "Bearer ${TOKEN}" } } } },
        { TOKEN: "abc123" },
      );
      expect(result).toEqual({
        mcp: { x: { headers: { Authorization: "Bearer abc123" } } },
      });
    });

    it("substitutes multiple references in the same string", () => {
      const result = interpolateConfig(
        { mcp: { x: { url: "${SCHEME}://${HOST}:${PORT}" } } },
        { SCHEME: "https", HOST: "api.example.com", PORT: "443" },
      );
      expect(result).toEqual({
        mcp: { x: { url: "https://api.example.com:443" } },
      });
    });

    it("substitutes in array elements", () => {
      const result = interpolateConfig(
        { mcp: { x: { args: ["-y", "${PKG}@${VERSION}"] } } },
        { PKG: "chrome-devtools-mcp", VERSION: "latest" },
      );
      expect(result).toEqual({
        mcp: { x: { args: ["-y", "chrome-devtools-mcp@latest"] } },
      });
    });

    it("substitutes in nested object values but not in keys", () => {
      const result = interpolateConfig(
        { mcp: { x: { env: { API_KEY: "${SECRET}" } } } },
        { SECRET: "xyz" },
      );
      expect(result).toEqual({ mcp: { x: { env: { API_KEY: "xyz" } } } });
    });

    it("treats a defined-but-empty value as the empty string when no default is given", () => {
      const result = interpolateConfig({ mcp: { x: { command: "[${EMPTY}]" } } }, { EMPTY: "" });
      expect(result).toEqual({ mcp: { x: { command: "[]" } } });
    });
  });

  describe("default values", () => {
    it("uses the default when the variable is undefined", () => {
      const result = interpolateConfig({ mcp: { x: { command: "${MISSING:-npx}" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "npx" } } });
    });

    it("uses the default when the variable is empty", () => {
      const result = interpolateConfig(
        { mcp: { x: { command: "${EMPTY:-fallback}" } } },
        { EMPTY: "" },
      );
      expect(result).toEqual({ mcp: { x: { command: "fallback" } } });
    });

    it("prefers the variable value over the default when both are present", () => {
      const result = interpolateConfig(
        { mcp: { x: { command: "${SET:-fallback}" } } },
        { SET: "actual" },
      );
      expect(result).toEqual({ mcp: { x: { command: "actual" } } });
    });

    it("allows defaults that contain colons (e.g. URLs)", () => {
      const result = interpolateConfig(
        { mcp: { x: { url: "${URL:-http://localhost:8080}" } } },
        {},
      );
      expect(result).toEqual({ mcp: { x: { url: "http://localhost:8080" } } });
    });

    it("allows empty defaults", () => {
      const result = interpolateConfig({ mcp: { x: { command: "[${MISSING:-}]" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "[]" } } });
    });

    it("allows defaults containing spaces", () => {
      const result = interpolateConfig({ mcp: { x: { command: "${MISSING:-hello world}" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "hello world" } } });
    });
  });

  describe("escape syntax", () => {
    it("treats $${VAR} as a literal ${VAR}", () => {
      const result = interpolateConfig(
        { mcp: { x: { command: "$${LITERAL}" } } },
        { LITERAL: "should-not-interpolate" },
      );
      expect(result).toEqual({ mcp: { x: { command: "${LITERAL}" } } });
    });

    it("treats $${VAR:-default} as a literal ${VAR:-default}", () => {
      const result = interpolateConfig({ mcp: { x: { command: "$${VAR:-default}" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "${VAR:-default}" } } });
    });

    it("supports mixing escaped and substituted references in one string", () => {
      const result = interpolateConfig(
        { mcp: { x: { command: "$${LITERAL} and ${REAL}" } } },
        { REAL: "interpolated", LITERAL: "ignored" },
      );
      expect(result).toEqual({
        mcp: { x: { command: "${LITERAL} and interpolated" } },
      });
    });
  });

  describe("missing variables", () => {
    it("throws MissingEnvVarsError when an undefined variable is referenced without a default", () => {
      expect(() => interpolateConfig({ mcp: { x: { command: "${MISSING}" } } }, {})).toThrow(
        MissingEnvVarsError,
      );
    });

    it("collects all missing variables into a single error message", () => {
      let error: unknown;
      try {
        interpolateConfig(
          {
            mcp: {
              x: { command: "${A}", args: ["${B}"], env: { K: "${C}" } },
            },
          },
          {},
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MissingEnvVarsError);
      const missing = (error as MissingEnvVarsError).missingVars;
      expect(missing).toEqual(["A", "B", "C"]);
    });

    it("deduplicates repeated missing variable names", () => {
      let error: unknown;
      try {
        interpolateConfig({ mcp: { x: { args: ["${SAME}", "${SAME}", "${OTHER}"] } } }, {});
      } catch (e) {
        error = e;
      }
      expect((error as MissingEnvVarsError).missingVars).toEqual(["OTHER", "SAME"]);
    });

    it("uses plural noun when more than one variable is missing", () => {
      let error: unknown;
      try {
        interpolateConfig({ mcp: { x: { args: ["${A}", "${B}"] } } }, {});
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toContain("variables");
    });

    it("uses singular noun when exactly one variable is missing", () => {
      let error: unknown;
      try {
        interpolateConfig({ mcp: { x: { command: "${ONLY}" } } }, {});
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toContain("variable: ONLY");
    });
  });

  describe("top-level passthrough", () => {
    it("does not interpolate the top-level $schema field", () => {
      const result = interpolateConfig(
        { $schema: "${SHOULD_NOT_RESOLVE}", mcp: { x: { command: "npx" } } },
        { SHOULD_NOT_RESOLVE: "evil" },
      );
      expect((result as { $schema: string }).$schema).toBe("${SHOULD_NOT_RESOLVE}");
    });

    it("does not interpolate the top-level env field", () => {
      const result = interpolateConfig(
        { env: "${MODE}", mcp: { x: { command: "npx" } } },
        { MODE: "enable" },
      );
      expect((result as { env: string }).env).toBe("${MODE}");
    });
  });

  describe("non-string values", () => {
    it("passes through numbers, booleans, and null unchanged", () => {
      const input = { mcp: { x: { command: "npx", flag: true, count: 3, nothing: null } } };
      const result = interpolateConfig(input, {});
      expect(result).toEqual(input);
    });
  });

  describe("malformed references", () => {
    it("leaves an unterminated ${ as a literal", () => {
      const result = interpolateConfig({ mcp: { x: { command: "abc ${UNCLOSED" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "abc ${UNCLOSED" } } });
    });

    it("leaves a lone $ as a literal", () => {
      const result = interpolateConfig({ mcp: { x: { command: "price: $5" } } }, {});
      expect(result).toEqual({ mcp: { x: { command: "price: $5" } } });
    });
  });
});
