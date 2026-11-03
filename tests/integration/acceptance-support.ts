import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect } from "vitest";
import { domainId, type Room, type RoomCommand, type RoomMember } from "../../packages/room-domain/src/index.js";
import { AutonomousRunner, RoomService, type RoomEventStore, type SnapshotStore } from "../../packages/room-engine/src/index.js";
import type { FacilitatorPort, PersonaPort } from "../../packages/runtime-ports/src/index.js";
import { openTeamRoomDatabase, SqliteEventStore, SqliteSnapshotStore } from "../../packages/sqlite-store/src/index.js";
import { createDeterministicAdapters, loadScenario } from "../../packages/test-adapters/src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() });
export const roomId = domainId.room("room-1");
export const time = "2026-11-02T00:00:00.000Z";
export const happy = loadScenario(JSON.parse(readFileSync(resolve("tests/fixtures/happy-path.json"), "utf8")));
export const failure = loadScenario(JSON.parse(readFileSync(resolve("tests/fixtures/failure-path.json"), "utf8")));
export const members: readonly RoomMember[] = ["facilitator", "researcher", "editor"].map(id => ({
  id: domainId.member(id), name: id, role: id === "facilitator" ? "Facilitator" : "Contributor",
  responsibilities: [], domainPerspective: "fixture", communicationStyle: "clear", constraints: [],
  collaborationGuidance: [], isFacilitator: id === "facilitator", sourceTemplateId: null, sourceTemplateVersion: null,
}));
export function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "teamroom-acceptance-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export function databaseFixture(options: {
  events?: (events: RoomEventStore) => RoomEventStore;
  snapshots?: (snapshots: SnapshotStore) => SnapshotStore;
  snapshotInterval?: number;
} = {}) {
  const directory = temporaryDirectory();
  const path = join(directory, "room.sqlite");
  let db = openTeamRoomDatabase(path);
  cleanups.push(() => { if (db.open) db.close() });
  const context = () => {
    const events = new SqliteEventStore(db);
    const snapshots = new SqliteSnapshotStore(db);
    const service = new RoomService({ events: options.events?.(events) ?? events, snapshots: options.snapshots?.(snapshots) ?? snapshots, snapshotInterval: options.snapshotInterval ?? 100 });
    return { db, events, snapshots, service };
  };
  return { directory, path, ...context(), reopen() { db.close(); db = openTeamRoomDatabase(path); return context() } };
}
type CommandInput<T = RoomCommand> = T extends unknown ? Omit<T, "roomId" | "commandId" | "expectedVersion"> : never;
export async function execute(service: RoomService, command: CommandInput): Promise<Room> {
  const version = command.type === "CreateRoom" ? 0 : (await service.load(roomId)).streamVersion;
  return service.execute({ ...command, roomId, commandId: domainId.command(`acceptance-${version}`), expectedVersion: version } as RoomCommand);
}
export async function createRoom(service: RoomService) {
  return execute(service, { type: "CreateRoom", title: "Research brief", task: "Prepare a reviewed brief", requirements: ["Keep evidence traceable"], acceptanceCriteria: happy.acceptanceCriteria, backgroundPolicy: "pause_on_leave" });
}
export async function startRoom(service: RoomService) {
  await createRoom(service);
  await execute(service, { type: "ProposeTeam", actor: "user", members });
  await execute(service, { type: "ConfirmTeam", actor: "user" });
  return execute(service, { type: "StartRun", runId: domainId.run("run-1") });
}
export function happyRunner(service: RoomService, overrides: { facilitator?: FacilitatorPort; persona?: PersonaPort } = {}) {
  const adapters = createDeterministicAdapters(happy);
  const facilitator: FacilitatorPort = {
    plan: input => adapters.facilitator.plan({ ...input, callKey: "round-1" }),
    evaluate: input => adapters.facilitator.evaluate({ ...input, callKey: input.room.actions.some(action => action.status === "planned") ? "round-1:1" : "round-1" }),
  };
  return new AutonomousRunner({ service, facilitator: overrides.facilitator ?? facilitator, persona: overrides.persona ?? { act: input => adapters.persona.act({ ...input, callKey: input.action.id }) } });
}
export async function reachCandidate(service: RoomService) {
  const runner = happyRunner(service);
  await runner.step(roomId);
  return (await runner.step(roomId)).room;
}
export async function assertStream(service: RoomService, events: RoomEventStore) {
  const room = await service.load(roomId);
  const log = await events.load(roomId);
  expect(log.map(event => event.sequence)).toEqual(Array.from({ length: room.streamVersion }, (_, index) => index + 1));
  expect(new Set(log.map(event => event.eventId)).size).toBe(log.length);
  return log;
}
export function cli<T>(path: string, ...args: string[]): T {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("apps/teamroom-cli/src/main.ts"), "--db", path, "--json", ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}
