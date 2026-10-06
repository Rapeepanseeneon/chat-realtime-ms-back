import { expect, test } from "bun:test";
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  encodePrivateHistoryCursor,
  MAX_HISTORY_PAGE_LIMIT,
  parseGroupHistoryBeforeId,
  parseHistoryPageLimit,
  parsePrivateHistoryCursor,
} from "../src/history-pagination";

test("private history cursor round-trips and rejects malformed payloads", () => {
  const value = {
    effectiveAt: "2026-10-06T01:02:03.456Z",
    id: "10",
  };
  expect(parsePrivateHistoryCursor(encodePrivateHistoryCursor(value))).toEqual(
    value,
  );
  for (const malformed of [
    "",
    "%%%",
    Buffer.from("not-json").toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, at: "bad", id: "10" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({ version: 1, at: value.effectiveAt, id: "0" }),
    ).toString("base64url"),
  ]) {
    expect(() => parsePrivateHistoryCursor(malformed)).toThrow(
      "Invalid history pagination",
    );
  }
});

test("history limits and numeric group cursors are strictly bounded", () => {
  expect(parseHistoryPageLimit(undefined)).toBe(DEFAULT_HISTORY_PAGE_LIMIT);
  expect(parseHistoryPageLimit(String(MAX_HISTORY_PAGE_LIMIT))).toBe(
    MAX_HISTORY_PAGE_LIMIT,
  );
  for (const value of ["0", "101", "1.5", "-1", "01", "text"]) {
    expect(() => parseHistoryPageLimit(value)).toThrow(
      "Invalid history pagination",
    );
  }
  expect(parseGroupHistoryBeforeId("10")).toBe("10");
  expect(parseGroupHistoryBeforeId(undefined)).toBeNull();
  for (const value of ["0", "-1", "1.5", "abc", "9223372036854775808"]) {
    expect(() => parseGroupHistoryBeforeId(value)).toThrow(
      "Invalid history pagination",
    );
  }
});
