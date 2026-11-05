import { DomainError } from "./errors.js";

declare const brand: unique symbol;
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type RoomId = Brand<string, "RoomId">;
export type RoomMemberId = Brand<string, "RoomMemberId">;
export type MemoryItemId = Brand<string, "MemoryItemId">;
export type MessageId = Brand<string, "MessageId">;
export type RunId = Brand<string, "RunId">;
export type RoundId = Brand<string, "RoundId">;
export type ActionId = Brand<string, "ActionId">;
export type CandidateId = Brand<string, "CandidateId">;
export type EventId = Brand<string, "EventId">;
export type CommandId = Brand<string, "CommandId">;
export type PersonaTemplateId = Brand<string, "PersonaTemplateId">;
export type TeamTemplateId = Brand<string, "TeamTemplateId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type SourceId = Brand<string, "SourceId">;
export type HandoffId = Brand<string, "HandoffId">;

function createId<Name extends string>(value: string, name: Name): Brand<string, Name> {
  if (value.trim().length === 0) {
    throw new DomainError("validation", `${name} must not be blank`);
  }
  return value as Brand<string, Name>;
}

export const domainId = Object.freeze({
  room: (value: string): RoomId => createId(value, "RoomId"),
  member: (value: string): RoomMemberId => createId(value, "RoomMemberId"),
  memoryItem: (value: string): MemoryItemId => createId(value, "MemoryItemId"),
  message: (value: string): MessageId => createId(value, "MessageId"),
  run: (value: string): RunId => createId(value, "RunId"),
  round: (value: string): RoundId => createId(value, "RoundId"),
  action: (value: string): ActionId => createId(value, "ActionId"),
  candidate: (value: string): CandidateId => createId(value, "CandidateId"),
  event: (value: string): EventId => createId(value, "EventId"),
  command: (value: string): CommandId => createId(value, "CommandId"),
  personaTemplate: (value: string): PersonaTemplateId => createId(value, "PersonaTemplateId"),
  teamTemplate: (value: string): TeamTemplateId => createId(value, "TeamTemplateId"),
  artifact: (value: string): ArtifactId => createId(value, "ArtifactId"),
  source: (value: string): SourceId => createId(value, "SourceId"),
  handoff: (value: string): HandoffId => createId(value, "HandoffId"),
});
