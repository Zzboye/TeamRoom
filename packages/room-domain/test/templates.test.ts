import { expect, it } from "vitest";
import { decide, domainId, reduceRoom, snapshotTeam, type PersonaTemplate, type TeamTemplate } from "../src/index.js";
import { envelope, events, member, replay } from "./task3-fixtures.js";

it("isolates versioned persona and team templates from room edits", () => {
  const persona: PersonaTemplate = { ...member, id: domainId.personaTemplate("persona"), version: 1 };
  const team: TeamTemplate = { id: domainId.teamTemplate("team"), name: "Team", version: 1, members: [{ memberId: member.id, persona, isFacilitator: true }] };
  const before = JSON.parse(JSON.stringify(team));
  const draft = replay(events.slice(0, 1));
  const proposed = decide(draft, { type: "ProposeTeam", actor: "user", commandId: domainId.command("propose"), roomId: draft.id, expectedVersion: draft.streamVersion, members: snapshotTeam(team) });
  if (!proposed.ok) throw proposed.error;
  const room = reduceRoom(draft, envelope(proposed.events[0]!, 2));
  const edited = decide(room, { type: "EditRoomMember", actor: "user", commandId: domainId.command("edit"), roomId: room.id, expectedVersion: room.streamVersion, member: { ...room.members[0]!, communicationStyle: "brief" } });
  if (!edited.ok) throw edited.error;
  const result = reduceRoom(room, envelope(edited.events[0]!, 3));
  expect(result.members[0]).toMatchObject({ communicationStyle: "brief", sourceTemplateId: persona.id, sourceTemplateVersion: 1 });
  expect(team).toEqual(before);
  expect(persona).toEqual(before.members[0]!.persona);
  expect(room.members[0]!.communicationStyle).toBe("clear");
  expect(Object.isFrozen(room.members[0]!.responsibilities)).toBe(true);
});

it("rejects invalid template versions and member identity edits", () => {
  const persona = { ...member, id: domainId.personaTemplate("persona"), version: 1 };
  const team = { id: domainId.teamTemplate("team"), name: "Team", version: 1, members: [{ memberId: member.id, persona, isFacilitator: true }] };
  for (const version of [0, -1, 1.5, NaN]) {
    expect(() => snapshotTeam({ ...team, version })).toThrow();
    expect(() => snapshotTeam({ ...team, members: [{ ...team.members[0]!, persona: { ...persona, version } }] })).toThrow();
  }
  const room = replay();
  const base = { type: "EditRoomMember" as const, actor: "user" as const, commandId: domainId.command("edit"), roomId: room.id, expectedVersion: room.streamVersion };
  expect(decide(room, { ...base, actor: member.id, member }).ok).toBe(false);
  expect(decide(room, { ...base, member: { ...member, sourceTemplateVersion: 2 } }).ok).toBe(false);
  expect(decide(room, { ...base, member: { ...member, isFacilitator: false } }).ok).toBe(false);
});
