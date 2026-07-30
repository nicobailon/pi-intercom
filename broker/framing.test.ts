import test from "node:test";
import assert from "node:assert/strict";
import { createMessageReader, writeMessage } from "./framing.ts";

function framePayload(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

test("createMessageReader handles normal fragmented frames", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
    64,
  );
  const frameA = framePayload(Buffer.from(JSON.stringify({ type: "one" }), "utf-8"));
  const frameB = framePayload(Buffer.from(JSON.stringify({ type: "two" }), "utf-8"));
  const combined = Buffer.concat([frameA, frameB]);

  reader(combined.subarray(0, 2));
  reader(combined.subarray(2, 7));
  reader(combined.subarray(7));

  assert.deepEqual(messages, [{ type: "one" }, { type: "two" }]);
  assert.deepEqual(errors, []);
});

test("createMessageReader reassembles a fragmented frame after a header-boundary fast-path frame", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
    64,
  );
  const frameA = framePayload(Buffer.from(JSON.stringify({ a: 1 }), "utf-8"));
  const frameB = framePayload(Buffer.from(JSON.stringify({ bb: "1234567890" }), "utf-8"));

  reader(frameA.subarray(0, 4)); // chunk ends exactly at the end of frame A's header
  reader(frameA.subarray(4)); // frame A's payload arrives whole (zero-copy fast path)
  reader(frameB.subarray(0, 6)); // frame B header + partial payload (buffered path)
  reader(frameB.subarray(6));

  assert.deepEqual(messages, [{ a: 1 }, { bb: "1234567890" }]);
  assert.deepEqual(errors, []);
});

test("createMessageReader rejects an oversized declared frame", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
    8,
  );
  const oversizedFrame = framePayload(Buffer.from(JSON.stringify({ text: "too large" }), "utf-8"));

  reader(oversizedFrame);

  assert.deepEqual(messages, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Intercom frame length \d+ exceeds maximum 8 bytes/);
});

test("createMessageReader rejects an oversized frame before retaining same-chunk payload bytes", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
    8,
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(9, 0);

  reader(Buffer.concat([header, Buffer.alloc(1024 * 1024)]));

  assert.deepEqual(messages, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Intercom frame length 9 exceeds maximum 8 bytes");
});

test("createMessageReader rejects a partial oversized frame before buffering the payload", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
    8,
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(9, 0);

  reader(header);

  assert.deepEqual(messages, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Intercom frame length 9 exceeds maximum 8 bytes");
});

test("writeMessage emits frames accepted by createMessageReader", () => {
  const chunks: Buffer[] = [];
  const socket = { write: (chunk: Buffer) => chunks.push(chunk) };
  const messages: unknown[] = [];
  const reader = createMessageReader((message) => messages.push(message), assert.fail, 64);

  writeMessage(socket as never, { ok: true });
  reader(Buffer.concat(chunks));

  assert.deepEqual(messages, [{ ok: true }]);
});
