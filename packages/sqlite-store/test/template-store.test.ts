import { domainId, snapshotTeam, type PersonaTemplate, type TeamTemplate } from "@teamroom/room-domain";
import { RoomService } from "@teamroom/room-engine";
import { afterEach, expect, test } from "vitest";
import { openTeamRoomDatabase } from "../src/database.js";
import { SqliteEventStore } from "../src/event-store.js";
import { SqliteTemplateStore } from "../src/template-store.js";
import { created, member, roomId } from "./fixtures.js";

const databases: ReturnType<typeof openTeamRoomDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close() });
function fixture() { const db = openTeamRoomDatabase(":memory:"); databases.push(db); return { db, templates: new SqliteTemplateStore(db), events: new SqliteEventStore(db) } }
const persona: PersonaTemplate = { id: domainId.personaTemplate("persona-1"), version: 1, name: "Lead", role: "Lead", responsibilities: ["plan"], domainPerspective: "planning", communicationStyle: "clear", constraints: [], collaborationGuidance: [] };
const team: TeamTemplate = { id: domainId.teamTemplate("team-1"), name: "Team", version: 1, members: [{ memberId: member.id, persona, isFacilitator: true }] };

test("persona and team versions are immutable and remain readable independently", async () => {
  const { templates } = fixture();
  await templates.putPersona(persona);
  const v2 = { ...persona, version: 2, name: "New lead" };
  await templates.putPersona(v2);
  await templates.putTeam(team);
  await templates.putTeam({ ...team, version: 2, members: [{ ...team.members[0]!, persona: v2 }] });
  await expect(templates.putPersona({ ...persona, name: "overwrite" })).rejects.toMatchObject({ code: "conflict" });
  await expect(templates.putTeam(team)).rejects.toMatchObject({ code: "conflict" });
  expect(await templates.getPersona(persona.id, 1)).toEqual(persona);
  expect(await templates.getPersona(persona.id, 2)).toEqual(v2);
  expect(await templates.getTeam(team.id, 1)).toEqual(team);
  expect((await templates.getTeam(team.id, 2))?.members[0]?.persona).toEqual(v2);
  expect(await templates.getPersona(persona.id, 99)).toBeNull();
});

test("persisting a copied room-member edit cannot mutate either template row", async () => {
  const { templates, events } = fixture();
  await templates.putPersona(persona); await templates.putTeam(team);
  const [copy] = snapshotTeam(team);
  await events.append(roomId, 0, [created, { type: "TeamProposed", members: [copy!] }]);
  const service = new RoomService({ events });
  await service.execute({ type: "EditRoomMember", commandId: domainId.command("edit"), roomId, expectedVersion: 2, actor: "user", member: { ...copy!, name: "Room-only lead" } });
  expect((await service.load(roomId)).members[0]?.name).toBe("Room-only lead");
  expect(await templates.getPersona(persona.id, 1)).toEqual(persona);
  expect(await templates.getTeam(team.id, 1)).toEqual(team);
});

test("invalid versions and corrupt stored template JSON produce typed errors", async () => {
  const { db, templates } = fixture();
  await expect(templates.putPersona({ ...persona, version: 0 })).rejects.toMatchObject({ code: "validation" });
  await templates.putPersona(persona);
  db.prepare("UPDATE persona_templates SET template_json = '{}'").run();
  await expect(templates.getPersona(persona.id, 1)).rejects.toMatchObject({ code: "corrupt_data" });
});
