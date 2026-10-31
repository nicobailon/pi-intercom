import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMachineName,
  MAX_RELAY_ENVELOPE_BYTES,
  MAX_RELAY_ORIGIN_FIELD_BYTES,
  MAX_RELAY_TARGET_BYTES,
  MAX_RELAY_TEXT_BYTES,
  parseRelayEnvelope,
  relayMessage,
  relaySenderName,
  resolveOrigin,
} from "./cross-machine-envelope.ts";

const fakeSessionId = "00000000-0000-4000-8000-000000000001";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    target: "reviewer",
    text: "payload",
    trust: "ssh-asserted",
    origin: { name: "worker", sessionId: fakeSessionId, machine: "laptop" },
    ...overrides,
  };
}

test("machine names default to the lowercased short hostname", () => {
  assert.equal(defaultMachineName("Build-Host.EXAMPLE"), "build-host");
});

test("operator origin lookup excludes its own transient CLI session", () => {
  const source = { id: fakeSessionId, name: "worker" };
  const transient = { id: "00000000-0000-4000-8000-000000000002", name: "worker" };
  assert.deepEqual(resolveOrigin([transient, source], "worker", "laptop", transient.id, {}), {
    name: "worker", sessionId: fakeSessionId, machine: "laptop",
  });
});

test("relay envelope carries structured origin and a one-line fallback marker", () => {
  const parsed = parseRelayEnvelope(JSON.stringify(envelope()));
  assert.equal(relaySenderName(parsed.origin), "worker@laptop");
  assert.equal(relayMessage(parsed), "[Unverified cross-machine origin]\npayload");
});

test("relay parser accepts exact field limits and preserves text whitespace", () => {
  const parsed = parseRelayEnvelope(JSON.stringify(envelope({
    target: "t".repeat(MAX_RELAY_TARGET_BYTES),
    text: ` ${"x".repeat(MAX_RELAY_TEXT_BYTES - 2)} `,
    origin: {
      name: "n".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES),
      sessionId: "s".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES),
      machine: "m".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES),
    },
  })));
  assert.equal(Buffer.byteLength(parsed.target), MAX_RELAY_TARGET_BYTES);
  assert.equal(Buffer.byteLength(parsed.text), MAX_RELAY_TEXT_BYTES);
  assert.equal(parsed.text.at(0), " ");
  assert.equal(parsed.text.at(-1), " ");

  const compact = JSON.stringify(envelope());
  const exactRaw = `${compact}${" ".repeat(MAX_RELAY_ENVELOPE_BYTES - Buffer.byteLength(compact))}`;
  assert.equal(parseRelayEnvelope(exactRaw).text, "payload");
});

test("relay parser rejects over-limit raw and field values", () => {
  const compact = JSON.stringify(envelope());
  assert.throws(
    () => parseRelayEnvelope(`${compact}${" ".repeat(MAX_RELAY_ENVELOPE_BYTES - Buffer.byteLength(compact) + 1)}`),
    /exceeds .* byte limit/,
  );
  for (const value of [
    envelope({ target: "t".repeat(MAX_RELAY_TARGET_BYTES + 1) }),
    envelope({ text: "x".repeat(MAX_RELAY_TEXT_BYTES + 1) }),
    envelope({ origin: { name: "n".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES + 1), sessionId: fakeSessionId, machine: "laptop" } }),
    envelope({ origin: { name: "worker", sessionId: "s".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES + 1), machine: "laptop" } }),
    envelope({ origin: { name: "worker", sessionId: fakeSessionId, machine: "m".repeat(MAX_RELAY_ORIGIN_FIELD_BYTES + 1) } }),
  ]) assert.throws(() => parseRelayEnvelope(JSON.stringify(value)), /Invalid cross-machine relay envelope/);
});

test("relay parser rejects undocumented fields", () => {
  assert.throws(() => parseRelayEnvelope(JSON.stringify(envelope({ extra: true }))), /Invalid cross-machine relay envelope/);
  assert.throws(() => parseRelayEnvelope(JSON.stringify(envelope({
    origin: { name: "worker", sessionId: fakeSessionId, machine: "laptop", extra: true },
  }))), /Invalid cross-machine relay envelope/);
});

test("relay parser rejects malformed envelopes and blank routing identities", () => {
  for (const value of [
    null,
    [],
    "envelope",
    envelope({ target: " \t" }),
    envelope({ text: 1 }),
    envelope({ origin: [] }),
    envelope({ origin: { name: " ", sessionId: fakeSessionId, machine: "laptop" } }),
    envelope({ origin: { name: "worker", sessionId: "\n", machine: "laptop" } }),
    envelope({ origin: { name: "worker", sessionId: fakeSessionId, machine: "\t" } }),
  ]) assert.throws(() => parseRelayEnvelope(JSON.stringify(value)));
  assert.throws(() => parseRelayEnvelope("{"), /Invalid cross-machine relay envelope JSON/);
});

test("relay parser rejects unsupported versions and trust claims", () => {
  assert.throws(() => parseRelayEnvelope(JSON.stringify(envelope({ version: 2 }))), /Unsupported cross-machine relay envelope version/);
  assert.throws(() => parseRelayEnvelope(JSON.stringify(envelope({ trust: "verified" }))), /Unsupported cross-machine relay envelope trust/);
});

test("origin lookup rejects duplicate names unless a full environment ID selects the source", () => {
  const sessions = [{ id: fakeSessionId, name: "worker" }, { id: "other-worker", name: "WORKER" }];
  assert.throws(() => resolveOrigin(sessions, "worker", "laptop", undefined, {}), /Multiple.*origin.*PI_INTERCOM_SESSION_ID/);
  assert.equal(resolveOrigin(sessions, "worker", "laptop", undefined, { PI_INTERCOM_SESSION_ID: fakeSessionId }).sessionId, fakeSessionId);
  assert.equal(resolveOrigin(sessions, "worker", "laptop", undefined, { PI_SESSION_ID: fakeSessionId }).sessionId, fakeSessionId);
});
