import { expect, test } from "bun:test";
import {
  MAX_IMAGE_BYTES,
  sanitizeAttachmentName,
  validateUpload,
} from "../src/attachment-storage";

test("attachment validation rejects unsafe, invalid and oversized uploads", async () => {
  const fakeImage = new File(["not an image"], "photo.png", {
    type: "image/png",
  });
  expect(await validateUpload(fakeImage, "image")).toEqual({
    error: "Photo must be a valid JPEG, PNG, WebP, or GIF image.",
  });

  const executable = new File(["echo unsafe"], "unsafe.exe", {
    type: "application/octet-stream",
  });
  expect("error" in (await validateUpload(executable, "file"))).toBe(true);

  const oversized = new File(
    [new Uint8Array(MAX_IMAGE_BYTES + 1)],
    "large.png",
    { type: "image/png" },
  );
  expect("error" in (await validateUpload(oversized, "image"))).toBe(true);
  expect(sanitizeAttachmentName("../../private<script>.txt")).toBe(
    ".._.._private_script_.txt",
  );
});

test("attachment validation uses detected image content instead of client MIME", async () => {
  const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = await validateUpload(
    new File([pngSignature], "renamed.jpg", { type: "image/jpeg" }),
    "image",
  );
  expect("error" in upload).toBe(false);
  if (!("error" in upload)) {
    expect(upload.mimeType).toBe("image/png");
    expect(upload.extension).toBe("png");
  }
});
