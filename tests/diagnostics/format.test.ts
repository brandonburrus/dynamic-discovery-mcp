import { describe, expect, it } from "vitest";
import { humanizeDuration, renderTable, truncate } from "../../src/diagnostics/format.js";

describe("renderTable", () => {
  it("renders headers + rows with right-padded columns and two-space gaps", () => {
    const out = renderTable(
      ["NAME", "AGE"],
      [
        ["alice", "30"],
        ["bob", "100"],
      ],
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("NAME   AGE");
    expect(lines[1]).toBe("alice  30");
    expect(lines[2]).toBe("bob    100");
  });

  it("derives column widths from the longest cell in each column (headers included)", () => {
    const out = renderTable(
      ["A", "B"],
      [
        ["short", "x"],
        ["longgggg", "y"],
      ],
    );
    const lines = out.split("\n");
    // Column A width = max('A', 'short', 'longgggg') = 8
    expect(lines[0]).toBe("A         B");
    expect(lines[1]).toBe("short     x");
    expect(lines[2]).toBe("longgggg  y");
  });

  it("does not pad the final column (no trailing whitespace)", () => {
    const out = renderTable(["A"], [["hello"]]);
    expect(out.split("\n").every(line => !line.endsWith(" "))).toBe(true);
  });

  it("handles empty row list (headers only)", () => {
    expect(renderTable(["A", "B"], [])).toBe("A  B");
  });
});

describe("truncate", () => {
  it("returns the input unchanged when shorter than max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the input unchanged when exactly max length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when longer than max", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
    expect(truncate("hello world", 8).length).toBe(8);
  });

  it("hard-clips without ellipsis when max <= 3", () => {
    expect(truncate("hello", 3)).toBe("hel");
    expect(truncate("hello", 1)).toBe("h");
    expect(truncate("hello", 0)).toBe("");
  });
});

describe("humanizeDuration", () => {
  it("returns 'expired' for negative durations", () => {
    expect(humanizeDuration(-1)).toBe("expired");
    expect(humanizeDuration(-3600)).toBe("expired");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(humanizeDuration(0)).toBe("0s");
    expect(humanizeDuration(45)).toBe("45s");
    expect(humanizeDuration(59)).toBe("59s");
  });

  it("formats sub-hour durations in minutes", () => {
    expect(humanizeDuration(60)).toBe("1m");
    expect(humanizeDuration(120)).toBe("2m");
    expect(humanizeDuration(3599)).toBe("59m");
  });

  it("formats sub-day durations in hours, with minutes only when non-zero", () => {
    expect(humanizeDuration(3600)).toBe("1h");
    expect(humanizeDuration(3660)).toBe("1h 1m");
    expect(humanizeDuration(7200)).toBe("2h");
    expect(humanizeDuration(2 * 3600 + 30 * 60)).toBe("2h 30m");
  });

  it("formats multi-day durations in days, with hours only when non-zero", () => {
    expect(humanizeDuration(86400)).toBe("1d");
    expect(humanizeDuration(86400 + 3600)).toBe("1d 1h");
    expect(humanizeDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(humanizeDuration(7 * 86400)).toBe("7d");
  });
});
