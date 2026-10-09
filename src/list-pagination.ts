export const DEFAULT_LIST_PAGE_LIMIT = 50;
export const MAX_LIST_PAGE_LIMIT = 100;
export const GROUP_MEMBER_BATCH_SIZE = 200;

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const POSITIVE_ID = /^[1-9]\d{0,18}$/;

export class InvalidListPaginationError extends Error {
  constructor() {
    super("Invalid list pagination.");
    this.name = "InvalidListPaginationError";
  }
}

export type DateIdCursor = { at: string; id: string };
export type FriendCursor = { name: string; id: string };
export type MemberCursor = {
  roleOrder: 0 | 1;
  joinedAt: string;
  id: string;
};

const parseId = (value: unknown) => {
  if (typeof value !== "string" || !POSITIVE_ID.test(value))
    throw new InvalidListPaginationError();
  try {
    if (BigInt(value) > MAX_BIGINT) throw new InvalidListPaginationError();
  } catch (error) {
    if (error instanceof InvalidListPaginationError) throw error;
    throw new InvalidListPaginationError();
  }
  return value;
};

const parseDate = (value: unknown) => {
  if (typeof value !== "string") throw new InvalidListPaginationError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new InvalidListPaginationError();
  return value;
};

export const parseListPageLimit = (value: string | undefined) => {
  if (value === undefined) return DEFAULT_LIST_PAGE_LIMIT;
  if (!/^[1-9]\d{0,2}$/.test(value)) throw new InvalidListPaginationError();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_LIST_PAGE_LIMIT)
    throw new InvalidListPaginationError();
  return limit;
};

const encode = (kind: string, data: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ version: 1, kind, ...data }), "utf8").toString(
    "base64url",
  );

const decode = (value: string | undefined, keys: string[]) => {
  if (value === undefined) return null;
  if (!value || value.length > 512 || !BASE64_URL.test(value))
    throw new InvalidListPaginationError();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new InvalidListPaginationError();
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new InvalidListPaginationError();
    const record = decoded as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== keys.sort().join(","))
      throw new InvalidListPaginationError();
    if (record.version !== 1) throw new InvalidListPaginationError();
    return record;
  } catch (error) {
    if (error instanceof InvalidListPaginationError) throw error;
    throw new InvalidListPaginationError();
  }
};

export const encodeDateIdCursor = (
  kind: "received" | "sent" | "groups",
  cursor: DateIdCursor,
) => encode(kind, cursor);

export const parseDateIdCursor = (
  kind: "received" | "sent" | "groups",
  value: string | undefined,
): DateIdCursor | null => {
  const record = decode(value, ["at", "id", "kind", "version"]);
  if (!record || record.kind !== kind) {
    if (record) throw new InvalidListPaginationError();
    return null;
  }
  return { at: parseDate(record.at), id: parseId(record.id) };
};

export const encodeFriendCursor = (cursor: FriendCursor) =>
  encode("friends", cursor);

export const parseFriendCursor = (
  value: string | undefined,
): FriendCursor | null => {
  const record = decode(value, ["id", "kind", "name", "version"]);
  if (!record || record.kind !== "friends") {
    if (record) throw new InvalidListPaginationError();
    return null;
  }
  if (
    typeof record.name !== "string" ||
    !record.name ||
    record.name.length > 50 ||
    record.name !== record.name.toLocaleLowerCase()
  )
    throw new InvalidListPaginationError();
  return { name: record.name, id: parseId(record.id) };
};

export const encodeMemberCursor = (cursor: MemberCursor) =>
  encode("members", cursor);

export const parseMemberCursor = (
  value: string | undefined,
): MemberCursor | null => {
  const record = decode(value, [
    "id",
    "joinedAt",
    "kind",
    "roleOrder",
    "version",
  ]);
  if (!record || record.kind !== "members") {
    if (record) throw new InvalidListPaginationError();
    return null;
  }
  if (record.roleOrder !== 0 && record.roleOrder !== 1)
    throw new InvalidListPaginationError();
  return {
    roleOrder: record.roleOrder,
    joinedAt: parseDate(record.joinedAt),
    id: parseId(record.id),
  };
};

export async function* iterateIdBatches(
  load: (afterId: string | null, limit: number) => Promise<string[]>,
  batchSize: number,
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new Error("Batch size must be a positive integer.");
  let afterId: string | null = null;
  while (true) {
    const ids = await load(afterId, batchSize);
    if (!ids.length) return;
    for (const id of ids) yield id;
    if (ids.length < batchSize) return;
    const next = ids.at(-1)!;
    if (next === afterId)
      throw new Error("Keyset batch cursor did not advance.");
    afterId = next;
  }
}
