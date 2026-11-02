import type { EventEnvelope, NewRoomEvent, PersonaTemplate, PersonaTemplateId, Room, RoomId, TeamTemplate, TeamTemplateId } from "@teamroom/room-domain";

/** append is atomic: either the whole batch commits at expectedVersion or conflict is thrown. */
export interface RoomEventStore {
  load(roomId: RoomId, afterSequence?: number): Promise<readonly EventEnvelope[]>;
  append(roomId: RoomId, expectedVersion: number, events: readonly NewRoomEvent[]): Promise<readonly EventEnvelope[]>;
}
export interface RoomSnapshot {
  readonly schemaVersion: 1;
  readonly roomId: RoomId;
  readonly sequence: number;
  readonly room: Room;
}
/** Implementations return null for unsupported or corrupt persisted snapshots. */
export interface SnapshotStore {
  load(roomId: RoomId): Promise<RoomSnapshot | null>;
  save(snapshot: RoomSnapshot): Promise<void>;
}
/** A template version is immutable; conflicting writes must be rejected. */
export interface TemplateStore {
  getPersona(id: PersonaTemplateId, version: number): Promise<PersonaTemplate | null>;
  putPersona(template: PersonaTemplate): Promise<void>;
  getTeam(id: TeamTemplateId, version: number): Promise<TeamTemplate | null>;
  putTeam(template: TeamTemplate): Promise<void>;
}
