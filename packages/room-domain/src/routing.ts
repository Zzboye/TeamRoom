import { DomainError } from "./errors.js";
import type { MessageId, RoomMemberId } from "./ids.js";
import type { Message, MessageLink, Room } from "./model.js";

export interface MessageRoute {
  readonly priorityMembers: readonly RoomMemberId[];
  readonly facilitatorMustReview: boolean;
  readonly referencedMessageIds: readonly MessageId[];
}

export function validateMessageLink(room: Room, link: MessageLink): void {
  if (link.type === "mention") {
    if (!room.members.some(member => member.id === link.memberId)) throw new DomainError("validation", "Mention target is outside the room");
  } else if ((link.type !== "quote" && link.type !== "reply") || !room.messages.some(message => message.id === link.messageId && message.roomId === room.id)) {
    throw new DomainError("validation", "Reference target is outside the room");
  }
}

/** Explicit links are ordered, stable IDs; routing never broadcasts to the team. */
export function routeMessage(room: Room, message: Message): MessageRoute {
  if (message.roomId !== room.id) throw new DomainError("validation", "Message belongs to another room");
  const links = [...(room.messageLinks ?? []).filter(entry => entry.messageId === message.id).map(entry => entry.link), ...(message.links ?? [])];
  const priorityMembers = new Set<RoomMemberId>();
  const referencedMessageIds = new Set<MessageId>();
  for (const link of links) {
    validateMessageLink(room, link);
    if (link.type === "mention") priorityMembers.add(link.memberId);
    else referencedMessageIds.add(link.messageId);
  }
  return Object.freeze({ priorityMembers: Object.freeze([...priorityMembers]), facilitatorMustReview: message.authorType === "user", referencedMessageIds: Object.freeze([...referencedMessageIds]) });
}
