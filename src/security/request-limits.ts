export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 512 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "PayloadTooLargeError";
  }
}

const declaredLength = (request: Request) => {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
};

const readLimited = async (request: Request, maxBytes: number) => {
  const declared = declaredLength(request);
  if (declared != null && declared > maxBytes) throw new PayloadTooLargeError();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readJsonObject = async (
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> => {
  try {
    const bytes = await readLimited(request, maxBytes);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    return null;
  }
};

/**
 * Multipart parsers buffer by design. Reading a clone first guarantees that a
 * missing Content-Length or chunked request cannot exceed the route-specific
 * bound before formData() is invoked. Bun also enforces a server-wide cap.
 */
export const assertRequestBodyWithin = async (
  request: Request,
  maxBytes: number,
) => {
  await readLimited(request.clone(), maxBytes);
};
