import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIST_PAGE_LIMIT,
  encodeDateIdCursor,
  encodeFriendCursor,
  encodeMemberCursor,
  iterateIdBatches,
  MAX_LIST_PAGE_LIMIT,
  parseDateIdCursor,
  parseFriendCursor,
  parseListPageLimit,
  parseMemberCursor,
} from "../src/list-pagination";

describe("C4.4 list pagination cursors", () => {
  test("round-trips each versioned cursor kind", () => {
    const date = { at: "2026-10-09T01:02:03.456Z", id: "42" };
    expect(
      parseDateIdCursor("received", encodeDateIdCursor("received", date)),
    ).toEqual(date);
    expect(parseDateIdCursor("sent", encodeDateIdCursor("sent", date))).toEqual(
      date,
    );
    expect(
      parseDateIdCursor("groups", encodeDateIdCursor("groups", date)),
    ).toEqual(date);
    const friend = { name: "alice", id: "43" };
    expect(parseFriendCursor(encodeFriendCursor(friend))).toEqual(friend);
    const member = { roleOrder: 1 as const, joinedAt: date.at, id: "44" };
    expect(parseMemberCursor(encodeMemberCursor(member))).toEqual(member);
  });

  test("rejects cross-kind, malformed, unsafe, and extra cursor fields", () => {
    const date = { at: "2026-10-09T01:02:03.456Z", id: "42" };
    const malformed = [
      "",
      "%%%",
      Buffer.from("not-json").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "friends",
          name: "Alice",
          id: "42",
        }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "friends",
          name: "alice",
          id: "9223372036854775808",
        }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "friends",
          name: "alice",
          id: "42",
          extra: true,
        }),
      ).toString("base64url"),
    ];
    expect(() =>
      parseDateIdCursor("sent", encodeDateIdCursor("received", date)),
    ).toThrow("Invalid list pagination");
    for (const cursor of malformed)
      expect(() => parseFriendCursor(cursor)).toThrow(
        "Invalid list pagination",
      );
  });

  test("uses a conservative default and strictly rejects invalid limits", () => {
    expect(parseListPageLimit(undefined)).toBe(DEFAULT_LIST_PAGE_LIMIT);
    expect(parseListPageLimit(String(MAX_LIST_PAGE_LIMIT))).toBe(
      MAX_LIST_PAGE_LIMIT,
    );
    for (const limit of ["0", "101", "-1", "1.5", "01", "text"])
      expect(() => parseListPageLimit(limit)).toThrow(
        "Invalid list pagination",
      );
  });

  test("internal keyset batching reaches every member exactly once", async () => {
    const source = Array.from({ length: 451 }, (_, index) => String(index + 1));
    const visited: string[] = [];
    for await (const id of iterateIdBatches(async (afterId, limit) => {
      const start = afterId ? source.indexOf(afterId) + 1 : 0;
      return source.slice(start, start + limit);
    }, 200))
      visited.push(id);
    expect(visited).toEqual(source);
    expect(new Set(visited).size).toBe(source.length);
  });
});
