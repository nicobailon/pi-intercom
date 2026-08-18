import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_FILE_NAME,
  findChannelFile,
  loadChannel,
  channelRejectsSession,
  channelMemberFor,
  intendedMismatchReason,
  resolveBoundId,
  formatTargetLabel,
  type SessionLike,
} from "./channel.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "intercom-channel-test-"));
  return dir;
}

const shortId = (session: SessionLike) => session.id.slice(0, 8);

test("findChannelFile walks up parent directories", () => {
  const root = tempDir();
  try {
    const project = join(root, "a", "b");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", CHANNEL_FILE_NAME), JSON.stringify({ name: "t", members: [{ name: "x" }] }));

    assert.equal(findChannelFile(project), join(project, ".pi", CHANNEL_FILE_NAME));
    // Found from a nested cwd below the project root.
    assert.equal(findChannelFile(join(project, "sub", "deep")), join(project, ".pi", CHANNEL_FILE_NAME));
    // Nothing above the root.
    assert.equal(findChannelFile(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadChannel validates structure", () => {
  const root = tempDir();
  try {
    const file = join(root, CHANNEL_FILE_NAME);
    writeFileSync(file, JSON.stringify({ name: "任务组", allowNameOnly: true, members: [{ name: "a", role: "发起者" }, { name: "b" }] }));
    const config = loadChannel(file);
    assert.equal(config.name, "任务组");
    assert.equal(config.members.length, 2);
    assert.equal(config.members[0]!.role, "发起者");
    assert.equal(config.members[1]!.role, undefined);
    assert.equal(config.allowNameOnly, true);
    writeFileSync(file, JSON.stringify({ name: "strict", members: [{ name: "a" }] }));
    assert.throws(() => loadChannel(file), /stable "id"/);

    writeFileSync(file, "not json");
    assert.throws(() => loadChannel(file), /Invalid channel file/);

    writeFileSync(file, JSON.stringify({ name: "x", members: [] }));
    assert.throws(() => loadChannel(file), /members/);

    writeFileSync(file, JSON.stringify({ name: "x", members: [{}] }));
    assert.throws(() => loadChannel(file), /members\[0\]/);

    // id-only member is valid.
    writeFileSync(file, JSON.stringify({ name: "x", members: [{ id: "01a000af-a036" }] }));
    assert.deepEqual(loadChannel(file).members, [{ id: "01a000af-a036" }]);

    writeFileSync(file, JSON.stringify({ name: "x", members: [{ name: "A" }, { name: "a" }] }));
    assert.throws(() => loadChannel(file), /duplicate member name/);
    writeFileSync(file, JSON.stringify({ name: "x", members: [{ id: "same" }, { id: "same" }] }));
    assert.throws(() => loadChannel(file), /duplicate member id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("channelRejectsSession allows members, rejects outsiders", () => {
  const config = { name: "任务组", allowNameOnly: true, members: [{ name: "eng-lead", role: "发起者" }, { name: "Executor" }] };

  assert.equal(channelRejectsSession(config, { id: "1", name: "eng-lead" }), null);
  assert.equal(channelRejectsSession(config, { id: "2", name: "executor" }), null); // case-insensitive
  assert.match(channelRejectsSession(config, { id: "3", name: "outsider" })!, /"outsider" is not a member/);
  assert.match(channelRejectsSession(config, { id: "4", name: "eng-lead-2" })!, /not a member/); // prefix does not match
  assert.match(channelRejectsSession(config, null)!, /could not be resolved/);
});

test("resolveBoundId maps identity names to bound session ids", () => {
  const config = {
    name: "任务组",
    allowNameOnly: true,
    members: [
      { name: "导师", id: "01a000c6-0bba-7254-bc23-dadfdbf32552" },
      { name: "秘书", id: "01a000ad-7617-7bb8-9933-8e9bf9fc0b27" },
      { name: "无名氏" },
    ],
  };
  assert.equal(resolveBoundId(config, "导师"), "01a000c6-0bba-7254-bc23-dadfdbf32552");
  assert.equal(resolveBoundId(config, "秘 书".replace(" ", "")), "01a000ad-7617-7bb8-9933-8e9bf9fc0b27"); // trimmed case-insensitive
  assert.equal(resolveBoundId(config, "无名氏"), null); // member without id has no binding
  assert.equal(resolveBoundId(config, "不存在"), null);
});

test("channelMemberFor resolves member by name or bound id", () => {
  const config = {
    name: "任务组",
    allowNameOnly: true,
    members: [
      { name: "导师", role: "导师", id: "01a000c6-0bba-7254-bc23-dadfdbf32552" },
      { name: "秘书", role: "秘书" },
    ],
  };
  // A same-name but different endpoint is not the bound identity.
  assert.equal(channelMemberFor(config, { id: "x", name: "导师" }), null);
  // By bound id — runtime alias session.
  assert.equal(channelMemberFor(config, { id: "01a000c6-0bba-7254-bc23-dadfdbf32552", name: "subagent-chat-01a000c6", runtimeFallbackAlias: true })?.name, "导师");
  // Name-only member.
  assert.equal(channelMemberFor(config, { id: "y", name: "秘 书".replace(" ", "") })?.name, "秘书");
  // Outsider.
  assert.equal(channelMemberFor(config, { id: "z", name: "路人" }), null);
});

test("formatTargetLabel prefers identity label over runtime alias", () => {
  const session = { id: "01a000c6-0bba-7254", name: "subagent-chat-01a000c6-0bba-7254" };
  const plain = formatTargetLabel(session, "x", (s) => s.id.slice(0, 8));
  assert.match(plain, /^subagent-chat-/);
  const identified = formatTargetLabel(session, "x", (s) => s.id.slice(0, 8), "导师");
  assert.equal(identified, "导师 (01a000c6)");
  assert.match(formatTargetLabel(null, "stale", (s) => s.id.slice(0, 8)), /unverified/);
});

test("channelRejectsSession binds members by exact id", () => {

  const tutorId = "01a000c6-0bba-7254-bc23-dadfdbf32552";
  const config = { name: "任务组", allowNameOnly: true, members: [{ name: "导师", role: "导师", id: tutorId }, { name: "秘书" }] };

  // Runtime alias (no /name) matches by id.
  assert.equal(channelRejectsSession(config, { id: tutorId, name: `subagent-chat-${tutorId}`, runtimeFallbackAlias: true }), null);
  // A user name without the bound endpoint is rejected.
  assert.match(channelRejectsSession(config, { id: "other", name: "导师" })!, /is not a member/);
  // Different session id, different name: rejected.
  assert.match(channelRejectsSession(config, { id: "01a000ad-7617-7bb8-9933-8e9bf9fc0b27", name: "subagent-chat-x" })!, /is not a member/);
  // A member with both identity and endpoint requires both to match.
  assert.match(channelRejectsSession(config, { id: "whatever", name: "导师" })!, /is not a member/);
  // Name-only legacy members still match an explicit user name.
  assert.equal(channelRejectsSession(config, { id: "whatever", name: "秘书" }), null);
});

test("intendedMismatchReason refuses mismatched recipients", () => {
  const c = { id: "cccccccc", name: "c" };
  const e = { id: "eeeeeeee", name: "e" };

  // Matching intended + target passes.
  assert.equal(intendedMismatchReason("c", c, c, shortId), null);
  // Mismatch is refused with both sides named.
  const reason = intendedMismatchReason("c", c, e, shortId)!;
  assert.match(reason, /Refusing to send/);
  assert.match(reason, /"e"/);
  assert.match(reason, /"c"/);
  // Intended that resolves nowhere is refused.
  assert.match(intendedMismatchReason("ghost", null, e, shortId)!, /did not resolve/);
  // Target not connected while intended is.
  assert.match(intendedMismatchReason("c", c, null, shortId)!, /not a connected session/);
});
