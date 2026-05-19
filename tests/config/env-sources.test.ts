import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env-sources.js";

describe("loadEnv", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynmcp-env-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('mode "disable"', () => {
    it("returns an empty variable map and interpolationEnabled=false", () => {
      const result = loadEnv({ mode: "disable", processEnv: { FOO: "bar" }, cwd: tempDir });
      expect(result.interpolationEnabled).toBe(false);
      expect(result.variables).toEqual({});
    });

    it("rejects --env flag as incompatible", () => {
      expect(() => loadEnv({ mode: "disable", envFilePath: "/tmp/x.env", cwd: tempDir })).toThrow(
        /incompatible/,
      );
    });
  });

  describe('mode "process"', () => {
    it("returns only process.env values", () => {
      writeFileSync(join(tempDir, ".env"), "FROM_DOTENV=should-not-be-loaded\n");
      const result = loadEnv({
        mode: "process",
        processEnv: { FROM_PROCESS: "yes" },
        cwd: tempDir,
      });
      expect(result.interpolationEnabled).toBe(true);
      expect(result.variables).toEqual({ FROM_PROCESS: "yes" });
    });

    it("rejects --env flag as incompatible", () => {
      expect(() =>
        loadEnv({ mode: "process", envFilePath: join(tempDir, "x.env"), cwd: tempDir }),
      ).toThrow(/incompatible/);
    });

    it("filters out undefined process.env entries", () => {
      const result = loadEnv({
        mode: "process",
        processEnv: { DEFINED: "yes", UNDEFINED: undefined },
        cwd: tempDir,
      });
      expect(result.variables).toEqual({ DEFINED: "yes" });
    });
  });

  describe('mode "dotenv"', () => {
    it("loads variables from .env in cwd and ignores process.env", () => {
      writeFileSync(join(tempDir, ".env"), "FROM_DOTENV=value\n");
      const result = loadEnv({
        mode: "dotenv",
        processEnv: { FROM_PROCESS: "should-be-ignored" },
        cwd: tempDir,
      });
      expect(result.interpolationEnabled).toBe(true);
      expect(result.variables).toEqual({ FROM_DOTENV: "value" });
    });

    it("returns an empty map when .env is missing in cwd", () => {
      const result = loadEnv({
        mode: "dotenv",
        processEnv: { IGNORED: "yes" },
        cwd: tempDir,
      });
      expect(result.interpolationEnabled).toBe(true);
      expect(result.variables).toEqual({});
    });

    it("loads from a custom path when --env is provided", () => {
      const customPath = join(tempDir, "custom.env");
      writeFileSync(customPath, "CUSTOM=loaded\n");
      const result = loadEnv({
        mode: "dotenv",
        envFilePath: customPath,
        processEnv: {},
        cwd: tempDir,
      });
      expect(result.variables).toEqual({ CUSTOM: "loaded" });
    });

    it("throws when --env points to a missing file", () => {
      expect(() =>
        loadEnv({
          mode: "dotenv",
          envFilePath: join(tempDir, "does-not-exist.env"),
          processEnv: {},
          cwd: tempDir,
        }),
      ).toThrow(/\.env file not found/);
    });
  });

  describe('mode "enable"', () => {
    it("merges .env and process.env with .env winning on conflict", () => {
      writeFileSync(join(tempDir, ".env"), "OVERLAP=from-dotenv\nONLY_DOTENV=dotenv-only\n");
      const result = loadEnv({
        mode: "enable",
        processEnv: { OVERLAP: "from-process", ONLY_PROCESS: "process-only" },
        cwd: tempDir,
      });
      expect(result.interpolationEnabled).toBe(true);
      expect(result.variables).toEqual({
        OVERLAP: "from-dotenv",
        ONLY_DOTENV: "dotenv-only",
        ONLY_PROCESS: "process-only",
      });
    });

    it("falls back to process.env only when no .env file is present in cwd", () => {
      const result = loadEnv({
        mode: "enable",
        processEnv: { FROM_PROCESS: "ok" },
        cwd: tempDir,
      });
      expect(result.variables).toEqual({ FROM_PROCESS: "ok" });
    });

    it("uses the custom .env path when --env is provided", () => {
      writeFileSync(join(tempDir, ".env"), "DEFAULT=should-not-be-loaded\n");
      const customPath = join(tempDir, "custom.env");
      writeFileSync(customPath, "CUSTOM=loaded\n");
      const result = loadEnv({
        mode: "enable",
        envFilePath: customPath,
        processEnv: {},
        cwd: tempDir,
      });
      expect(result.variables).toEqual({ CUSTOM: "loaded" });
    });

    it("throws when --env points to a missing file", () => {
      expect(() =>
        loadEnv({
          mode: "enable",
          envFilePath: join(tempDir, "missing.env"),
          processEnv: {},
          cwd: tempDir,
        }),
      ).toThrow(/\.env file not found/);
    });
  });

  describe(".env parsing", () => {
    it("handles quoted values, comments, and empty lines", () => {
      writeFileSync(
        join(tempDir, ".env"),
        ["# comment", 'QUOTED="hello world"', "", "PLAIN=value", "# trailing comment"].join("\n"),
      );
      const result = loadEnv({ mode: "dotenv", processEnv: {}, cwd: tempDir });
      expect(result.variables).toEqual({ QUOTED: "hello world", PLAIN: "value" });
    });
  });
});
