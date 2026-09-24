import { expect, test } from "bun:test";
import { RateLimiter } from "../src/security/rate-limit";
import {
  assertRequestBodyWithin,
  PayloadTooLargeError,
  readJsonObject,
} from "../src/security/request-limits";

test("rate limiter throttles, enters cooldown and expires abandoned keys", () => {
  const limiter = new RateLimiter({
    capacity: 2,
    refillWindowMs: 1_000,
    cooldownMs: 2_000,
    violationsBeforeCooldown: 2,
    idleTtlMs: 100,
    maxEntries: 1,
  });

  expect(limiter.consume("first", 0).allowed).toBe(true);
  expect(limiter.consume("first", 0).allowed).toBe(true);
  expect(limiter.consume("first", 0).allowed).toBe(false);
  const cooldown = limiter.consume("first", 1);
  expect(cooldown.allowed).toBe(false);
  expect(cooldown.retryAfterMs).toBe(2_000);
  expect(limiter.consume("first", 1_500).allowed).toBe(false);
  expect(limiter.consume("first", 2_001).allowed).toBe(true);

  limiter.consume("abandoned", 3_000);
  expect(limiter.size).toBe(1);
  limiter.consume("replacement", 3_200);
  expect(limiter.size).toBe(1);
});

test("bounded JSON parsing rejects declared and streamed oversized bodies", async () => {
  expect(
    await readJsonObject(
      new Request("http://local.test", {
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
      }),
      64,
    ),
  ).toEqual({ hello: "world" });

  await expect(
    readJsonObject(
      new Request("http://local.test", {
        method: "POST",
        headers: { "Content-Length": "1000" },
        body: "{}",
      }),
      64,
    ),
  ).rejects.toBeInstanceOf(PayloadTooLargeError);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40));
      controller.enqueue(new Uint8Array(40));
      controller.close();
    },
  });
  await expect(
    readJsonObject(
      new Request("http://local.test", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      64,
    ),
  ).rejects.toBeInstanceOf(PayloadTooLargeError);
});

test("multipart preflight measures the actual stream without consuming request", async () => {
  const request = new Request("http://local.test", {
    method: "POST",
    body: new Uint8Array(128),
  });
  await expect(assertRequestBodyWithin(request, 64)).rejects.toBeInstanceOf(
    PayloadTooLargeError,
  );
  expect((await request.arrayBuffer()).byteLength).toBe(128);
});
