import { expect, it } from "vitest";
import { decide, domainId, reduceRoom, routeMessage, type Message } from "../src/index.js";
import { envelope, events, member, replay } from "./task3-fixtures.js";
const room = replay(events.slice(0, 2));
const message: Message = { id: domainId.message("new"), roomId: room.id, authorType: "user", authorId: "user", content: "Question", type: "user", sequence: 1, createdAt: room.createdAt };
it("routes explicit mentions in link order without broadcasting", () => {
  const researcher = { ...member, id: domainId.member("researcher"), isFacilitator: false };
  const withTeam = { ...room, members: [...room.members, researcher] };
  expect(routeMessage(withTeam, { ...message, links: [{ type: "mention", memberId: researcher.id }, { type: "mention", memberId: member.id }, { type: "mention", memberId: researcher.id }] })).toEqual({ priorityMembers: [researcher.id, member.id], facilitatorMustReview: true, referencedMessageIds: [] });
  expect(routeMessage(room, message)).toEqual({ priorityMembers: [], facilitatorMustReview: true, referencedMessageIds: [] });
  expect(routeMessage(room, { ...message, authorType: "persona", authorId: member.id })).toMatchObject({ facilitatorMustReview: false });
});
it("projects persisted links and preserves quote and reply IDs", () => {
  const posted = reduceRoom(room, envelope({ type: "MessagePosted", message }, 3));
  const reply = { ...message, id: domainId.message("reply"), sequence: 2 };
  const replied = reduceRoom(posted, envelope({ type: "MessagePosted", message: reply }, 4));
  const linked = reduceRoom(replied, envelope({ type: "MessageLinked", messageId: reply.id, link: { type: "quote", messageId: message.id } }, 5));
  expect(routeMessage(linked, reply).referencedMessageIds).toEqual([message.id]);
  expect(routeMessage(posted, { ...reply, links: [{ type: "reply", messageId: message.id }, { type: "quote", messageId: message.id }] }).referencedMessageIds).toEqual([message.id]);
  expect(Object.isFrozen(linked.messageLinks)).toBe(true);
});
it("rejects foreign mentions and quote targets before decisions and replay", () => {
  for (const link of [{ type: "mention" as const, memberId: domainId.member("outside") }, { type: "quote" as const, messageId: domainId.message("foreign") }]) {
    const invalid = { ...message, links: [link] };
    expect(() => routeMessage(room, invalid)).toThrow(expect.objectContaining({ code: "validation" }));
    expect(decide(room, { type: "PostMessage", actor: "user", commandId: domainId.command("post"), roomId: room.id, expectedVersion: room.streamVersion, message: invalid })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(() => reduceRoom(room, envelope({ type: "MessagePosted", message: invalid }, 3))).toThrow(expect.objectContaining({ code: "corrupt_data" }));
  }
});

it("replays inline links and later links deterministically in posting order", () => {
  const source = reduceRoom(room, envelope({ type: "MessagePosted", message }, 3));
  const reply = { ...message, id: domainId.message("reply-inline"), sequence: 2, links: [{ type: "quote" as const, messageId: message.id }] };
  const decision = decide(source, { type: "PostMessage", actor: "user", commandId: domainId.command("post"), roomId: room.id, expectedVersion: source.streamVersion, message: reply });
  if (!decision.ok) throw decision.error;
  const posted = reduceRoom(source, envelope(decision.events[0]!, 4));
  const linked = reduceRoom(posted, envelope({ type: "MessageLinked", messageId: reply.id, link: { type: "mention", memberId: member.id } }, 5));
  expect(routeMessage(linked, reply)).toEqual({ priorityMembers: [member.id], facilitatorMustReview: true, referencedMessageIds: [message.id] });
  expect(source.messageLinks).toEqual([]);
  expect(posted.messageLinks).toHaveLength(1);
  expect(linked.messageLinks).toHaveLength(2);
});
