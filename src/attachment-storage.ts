import { mkdir, unlink } from "node:fs/promises";
import { extname, join } from "node:path";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const storageDirectory = join(
  process.cwd(),
  Bun.env.ATTACHMENT_STORAGE_DIR?.trim() || "storage/attachments",
);

const safeFileTypes = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  ["application/zip", "zip"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx",
  ],
]);

const imageKind = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { extension: "jpg", mimeType: "image/jpeg" };
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  )
    return { extension: "png", mimeType: "image/png" };
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return { extension: "webp", mimeType: "image/webp" };
  if (
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
  )
    return { extension: "gif", mimeType: "image/gif" };
  return null;
};

export const sanitizeAttachmentName = (name: string) => {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment").slice(0, 180);
};

export type ValidatedUpload = {
  kind: "image" | "file";
  bytes: Uint8Array;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
};

export const validateUpload = async (
  file: File,
  requestedKind: string,
): Promise<ValidatedUpload | { error: string }> => {
  if (requestedKind !== "image" && requestedKind !== "file")
    return { error: "Choose Photo or File." };
  const limit = requestedKind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (!file.size || file.size > limit)
    return {
      error: `${requestedKind === "image" ? "Photo" : "File"} must be smaller than ${limit / 1024 / 1024} MB.`,
    };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const originalName = sanitizeAttachmentName(file.name);
  if (requestedKind === "image") {
    const detected = imageKind(bytes);
    if (!detected)
      return { error: "Photo must be a valid JPEG, PNG, WebP, or GIF image." };
    return {
      kind: "image",
      bytes,
      originalName,
      mimeType: detected.mimeType,
      extension: detected.extension,
      sizeBytes: bytes.length,
    };
  }
  const normalizedMimeType = file.type.toLowerCase().split(";", 1)[0].trim();
  const extension = safeFileTypes.get(normalizedMimeType);
  if (!extension || extname(originalName).slice(1).toLowerCase() !== extension)
    return {
      error:
        "File type is not allowed. Use PDF, TXT, CSV, ZIP, DOCX, XLSX, or PPTX.",
    };
  return {
    kind: "file",
    bytes,
    originalName,
    mimeType: normalizedMimeType,
    extension,
    sizeBytes: bytes.length,
  };
};

export const writeAttachment = async (upload: ValidatedUpload) => {
  await mkdir(storageDirectory, { recursive: true });
  const storageKey = `${crypto.randomUUID()}.${upload.extension}`;
  await Bun.write(join(storageDirectory, storageKey), upload.bytes);
  return storageKey;
};

export const attachmentFile = (storageKey: string) =>
  Bun.file(join(storageDirectory, storageKey));

export const removeAttachment = async (storageKey: string | null) => {
  if (!storageKey || !/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(storageKey)) return;
  await unlink(join(storageDirectory, storageKey)).catch(() => undefined);
};
