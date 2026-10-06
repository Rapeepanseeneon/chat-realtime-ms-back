export const DEFAULT_HISTORY_PAGE_LIMIT = 50;
export const MAX_HISTORY_PAGE_LIMIT = 100;

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const POSITIVE_ID = /^[1-9]\d{0,18}$/;

export class InvalidHistoryPaginationError extends Error {
  constructor() {
    super("Invalid history pagination.");
    this.name = "InvalidHistoryPaginationError";
  }
}

export type PrivateHistoryCursor = {
  effectiveAt: string;
  id: string;
};

const parsePositiveId = (value: unknown) => {
  if (typeof value !== "string" || !POSITIVE_ID.test(value)) {
    throw new InvalidHistoryPaginationError();
  }
  try {
    if (BigInt(value) > MAX_BIGINT) throw new InvalidHistoryPaginationError();
  } catch (error) {
    if (error instanceof InvalidHistoryPaginationError) throw error;
    throw new InvalidHistoryPaginationError();
  }
  return value;
};

export const parseHistoryPageLimit = (value: string | undefined) => {
  if (value === undefined) return DEFAULT_HISTORY_PAGE_LIMIT;
  if (!/^[1-9]\d{0,2}$/.test(value)) {
    throw new InvalidHistoryPaginationError();
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_HISTORY_PAGE_LIMIT) {
    throw new InvalidHistoryPaginationError();
  }
  return limit;
};

export const parseGroupHistoryBeforeId = (value: string | undefined) =>
  value === undefined ? null : parsePositiveId(value);

export const encodePrivateHistoryCursor = (cursor: PrivateHistoryCursor) =>
  Buffer.from(
    JSON.stringify({ version: 1, at: cursor.effectiveAt, id: cursor.id }),
    "utf8",
  ).toString("base64url");

export const parsePrivateHistoryCursor = (
  value: string | undefined,
): PrivateHistoryCursor | null => {
  if (value === undefined) return null;
  if (!value || value.length > 256 || !BASE64_URL.test(value)) {
    throw new InvalidHistoryPaginationError();
  }

  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new InvalidHistoryPaginationError();
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof InvalidHistoryPaginationError) throw error;
    throw new InvalidHistoryPaginationError();
  }

  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(",") !== "at,id,version"
  ) {
    throw new InvalidHistoryPaginationError();
  }
  const record = decoded as Record<string, unknown>;
  if (record.version !== 1 || typeof record.at !== "string") {
    throw new InvalidHistoryPaginationError();
  }
  const date = new Date(record.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.at) {
    throw new InvalidHistoryPaginationError();
  }
  return { effectiveAt: record.at, id: parsePositiveId(record.id) };
};
