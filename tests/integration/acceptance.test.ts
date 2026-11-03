import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { buildHandoff, domainId, DomainError, routeMessage, snapshotTeam, type HandoffPackageV1, type Message, type Room, type TeamTemplate } from "../../packages/room-domain/src/index.js";
import { AutonomousRunner } from "../../packages/room-engine/src/index.js";
import type { PersonaActionResult } from "../../packages/runtime-ports/src/index.js";
import { openTeamRoomDatabase, RoomRepository, SqliteEventStore, SqliteTemplateStore } from "../../packages/sqlite-store/src/index.js";
import { createDeterministicAdapters, loadScenario } from "../../packages/test-adapters/src/index.js";
import { assertStream, cli, createRoom, databaseFixture, execute, failure, happy, happyRunner, members, reachCandidate, roomId, startRoom, temporaryDirectory, time } from "./acceptance-support.js";

test("1. create a room, review a generated deterministic team, and start it", async () => {
  const { service, events, db } = databaseFixture();
  const templates = new SqliteTemplateStore(db);
  const team: TeamTemplate = {
    id: domainId.teamTemplate("brief-team"), name: "Brief team", version: 1,
    members: members.map(member => ({ memberId: member.id, isFacilitator: member.isFacilitator,
      persona: { id: domainId.personaTemplate(`persona-${member.id}`), version: 1, name: member.name, role: member.role,
        responsibilities: member.responsibilities, domainPerspective: member.domainPerspective, communicationStyle: member.communicationStyle,
        constraints: member.constraints, collaborationGuidance: member.collaborationGuidance } })),
  };
  for (const entry of team.members) await templates.putPersona(entry.persona);
  await templates.putTeam(team);
  expect((await createRoom(service)).status).toBe("draft");
  const generated = snapshotTeam((await templates.getTeam(team.id, 1))!);
  const proposed = await execute(service, { type: "ProposeTeam", actor: "user", members: generated });
  expect(proposed).toMatchObject({ status: "team_review", streamVersion: 2, teamConfirmed: false });
  const reviewed = { ...generated[1]!, responsibilities: ["Keep evidence traceable"] };
  await execute(service, { type: "EditRoomMember", actor: "user", member: reviewed });
  expect(await templates.getTeam(team.id, 1)).toEqual(team);
  expect(await templates.getPersona(team.members[1]!.persona.id, 1)).toEqual(team.members[1]!.persona);
  expect((await execute(service, { type: "ConfirmTeam", actor: "user" })).status).toBe("ready");
  const running = await execute(service, { type: "StartRun", runId: domainId.run("run-1") });
  expect(running).toMatchObject({ status: "running", streamVersion: 5, teamConfirmed: true, activeRun: { id: "run-1" } });
  expect(running.members[1]).toEqual(reviewed);
  expect((await assertStream(service, events)).map(item => item.event.type)).toEqual(["RoomCreated", "TeamProposed", "RoomMemberEdited", "TeamConfirmed", "RunStarted"]);
});

test("2. route ordinary, mentioned, and quoted messages correctly", async () => {
  const context = databaseFixture();
  await startRoom(context.service);
  await happyRunner(context.service).step(roomId);
  const post = async (id: string, links: Message["links"] = []) => {
    const room = await context.service.load(roomId);
    return execute(context.service, { type: "PostMessage", actor: "user", message: { id: domainId.message(id), roomId, authorType: "user", authorId: "user", content: id, type: "user", sequence: room.latestMessageSequence + 1, createdAt: time, links } });
  };
  const ordinary = await post("ordinary");
  expect(routeMessage(ordinary, ordinary.messages.at(-1)!)).toEqual({ priorityMembers: [], facilitatorMustReview: true, referencedMessageIds: [] });
  const mentioned = await post("mentioned", [{ type: "mention", memberId: domainId.member("editor") }]);
  expect(routeMessage(mentioned, mentioned.messages.at(-1)!)).toEqual({ priorityMembers: ["editor"], facilitatorMustReview: true, referencedMessageIds: [] });
  const links = [{ type: "quote", messageId: domainId.message("message-research") }, { type: "reply", messageId: domainId.message("ordinary") }] as const;
  const quoted = await post("quoted", links);
  expect(routeMessage(quoted, quoted.messages.at(-1)!)).toEqual({ priorityMembers: [], facilitatorMustReview: true, referencedMessageIds: ["message-research", "ordinary"] });
  expect(quoted.messageLinks).toEqual([
    { messageId: "mentioned", link: { type: "mention", memberId: "editor" } },
    ...links.map(link => ({ messageId: "quoted", link })),
  ]);
  expect(quoted.memory).toHaveLength(1);
  expect(quoted.memory[0]).toMatchObject({ memberId: "researcher", provenance: ["message-research"] });
  await expect(execute(context.service, { type: "EditMemoryItem", actor: domainId.member("editor"), item: { ...quoted.memory[0]!, content: "Forbidden cross-member edit" } })).rejects.toMatchObject({ code: "validation" });
  expect(await context.service.load(roomId)).toEqual(quoted);
  const reopened = context.reopen();
  expect(await reopened.service.load(roomId)).toEqual(quoted);
  const log = await assertStream(reopened.service, reopened.events);
  expect(log.flatMap(item => item.event.type === "MessagePosted" ? item.event.message.links ?? [] : [])).toHaveLength(3);
  expect(log.at(-1)?.event.type).toBe("MessagePosted");
});

test("3. interrupt autonomous work, pause at a safe boundary, and resume", async () => {
  const { service, events } = databaseFixture();
  await startRoom(service);
  const adapters = createDeterministicAdapters(happy);
  let release!: (result: PersonaActionResult) => void;
  let signal!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve });
  const act = vi.fn(async () => { signal(); return new Promise<PersonaActionResult>(resolve => { release = resolve }) });
  const runner = happyRunner(service, { persona: { act } });
  const advancing = runner.step(roomId);
  await started;
  const inFlight = await service.load(roomId);
  const pause = await execute(service, { type: "PauseRun", actor: "user", reason: "Operator interruption" });
  const action = inFlight.actions[0]!;
  release(await adapters.persona.act({ room: inFlight, action, memory: [], callKey: "research" }));
  const paused = (await advancing).room;
  expect(pause.pauseRequested).toBe(true);
  expect(paused).toMatchObject({ status: "paused", pauseRequested: false });
  expect(paused.actions.map(action => action.status)).toEqual(["succeeded", "planned"]);
  expect((await runner.step(roomId)).room).toEqual(paused);
  expect(act).toHaveBeenCalledTimes(1);
  const beforeResume = await assertStream(service, events);
  expect(beforeResume.filter(item => item.event.type === "ActionStarted")).toHaveLength(1);
  expect(beforeResume.slice(-3).map(item => item.event.type)).toEqual(["MessagePosted", "MemoryUpdated", "ActionCompleted"]);
  expect(beforeResume.some(item => item.event.type === "RunPauseRequested")).toBe(true);
  await execute(service, { type: "ResumeRun", actor: "user" });
  expect((await happyRunner(service).step(roomId)).room.status).toBe("awaiting_acceptance");
  const log = await assertStream(service, events);
  expect(log.filter(item => item.event.type === "ActionStarted")).toHaveLength(2);
  expect(log.at(-1)?.event.type).toBe("CandidateProduced");
});

test("4. exit the CLI, restart the process, reopen the room, and continue from the same logical position", async () => {
  const context = databaseFixture();
  await startRoom(context.service);
  const fixture = resolve("tests/fixtures/happy-path.json");
  const first = cli<{ room: Room }>(context.path, "run", "step", "--room", roomId, "--fixture", fixture).room;
  expect(first.actions.map(action => action.status)).toEqual(["succeeded", "planned"]);
  expect(cli<Room>(context.path, "room", "show", "--room", roomId)).toEqual(first);
  const completedRound = cli<{ room: Room }>(context.path, "run", "step", "--room", roomId, "--fixture", fixture).room;
  expect(completedRound.status).toBe("awaiting_acceptance");
  expect(completedRound.actions.map(action => action.status)).toEqual(["succeeded", "succeeded"]);
  expect(completedRound.messages).toHaveLength(2);
  expect(completedRound.memory).toHaveLength(1);
  // Each invocation is a new OS process, including after the completed round.
  expect(cli<Room>(context.path, "room", "show", "--room", roomId)).toEqual(completedRound);
  expect(cli<{ room: Room }>(context.path, "run", "step", "--room", roomId, "--fixture", fixture).room).toEqual(completedRound);
  const accepted = cli<Room>(context.path, "candidate", "accept", "--room", roomId, "--id", "candidate-1");
  expect(accepted).toMatchObject({ status: "completed", streamVersion: completedRound.streamVersion + 1 });
  expect(cli<Room>(context.path, "room", "show", "--room", roomId)).toEqual(accepted);
  const log = await assertStream(context.service, context.events);
  expect(log.filter(item => item.event.type === "ActionCompleted")).toHaveLength(2);
  expect(log.at(-1)?.event.type).toBe("CandidateAccepted");
}, 20000);

test("5. handle a member failure and a simulated approval request without losing events", async () => {
  const failed = databaseFixture();
  await startRoom(failed.service);
  const failureAdapters = createDeterministicAdapters(failure);
  const failureRunner = happyRunner(failed.service, { persona: { act: async input => {
    const result = await failureAdapters.tool.execute({ roomId, actionId: input.action.id, idempotencyKey: input.action.idempotencyKey, callKey: "permanent", tool: "mock", input: "simulated member failure" });
    expect(result.status).toBe("permanent_failure");
    throw new DomainError("permanent_adapter", "Permanent simulated failure");
  } } });
  const paused = (await failureRunner.step(roomId)).room;
  expect(paused.status).toBe("paused");
  expect(paused.actions[0]).toMatchObject({ status: "failed", errorCode: "permanent_adapter" });
  expect(paused.actions[1]?.status).toBe("planned");
  expect((await assertStream(failed.service, failed.events)).slice(-2).map(item => item.event.type)).toEqual(["ActionCompleted", "RunPaused"]);
  expect(await failed.reopen().service.load(roomId)).toEqual(paused);

  const approved = databaseFixture();
  await startRoom(approved.service);
  const happyAdapters = createDeterministicAdapters(happy);
  const approvalRunner = happyRunner(approved.service, { facilitator: {
    plan: input => happyAdapters.facilitator.plan({ ...input, callKey: "round-1" }),
    evaluate: async input => {
      const pending = input.room.actions.find(action => action.status === "planned")!;
      const response = await failureAdapters.tool.execute({ roomId, actionId: pending.id, idempotencyKey: pending.idempotencyKey, callKey: "approval", tool: "mock", input: "simulated approval classification" });
      if (response.status !== "approval_required") throw new Error("Expected simulated approval");
      return { type: "request_approval", actionId: pending.id, reason: response.reason };
    },
  } });
  const waiting = (await approvalRunner.step(roomId)).room;
  expect(waiting.status).toBe("awaiting_approval");
  expect(waiting.actions.map(action => action.status)).toEqual(["succeeded", "planned"]);
  const before = await approved.events.load(roomId);
  expect(before.at(-1)?.event.type).toBe("ApprovalRequested");
  const reopened = approved.reopen();
  expect(await reopened.service.load(roomId)).toEqual(waiting);
  expect((await execute(reopened.service, { type: "ApproveAction", actor: "user", actionId: domainId.action("edit") })).status).toBe("running");
  expect((await happyRunner(reopened.service).step(roomId)).room.status).toBe("awaiting_acceptance");
  const log = await assertStream(reopened.service, reopened.events);
  expect(log.slice(0, before.length)).toEqual(before);
  expect(log.filter(item => item.event.type === "ActionApproved")).toHaveLength(1);
  expect(log.filter(item => item.event.type === "ActionCompleted")).toHaveLength(2);
});

test("6. converge against explicit acceptance criteria, submit a candidate, accept it, and export a handoff", async () => {
  const path = join(temporaryDirectory(), "demo.sqlite");
  cli(path, "init");
  const demo = cli<{ room: Room; handoff: HandoffPackageV1 }>(path, "demo", "--fixture", resolve("tests/fixtures/happy-path.json"));
  expect(demo.room).toMatchObject({ status: "awaiting_acceptance", candidate: { id: "candidate-1", acceptedAt: null } });
  expect(demo.room.candidate?.checklist.map(item => item.criterion)).toEqual(happy.acceptanceCriteria);
  expect(demo.room.candidate?.checklist.every(item => item.satisfied && item.evidence)).toBe(true);
  expect(demo.handoff).toEqual(buildHandoff(demo.room));
  const accepted = cli<Room>(path, "candidate", "accept", "--room", roomId, "--id", "candidate-1");
  expect(accepted.status).toBe("completed");
  expect(accepted.candidate?.acceptedAt).not.toBeNull();
  const jsonPath = join(temporaryDirectory(), "handoff.json");
  const json = cli<HandoffPackageV1>(path, "handoff", "export", "--room", roomId, "--format", "json", "--id", "handoff-json", "--output", jsonPath);
  expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual(json);
  expect(json).toEqual(buildHandoff(cli<Room>(path, "room", "show", "--room", roomId)));
  expect(json).toMatchObject({ schemaVersion: 1, roomId, status: "completed", eventSequence: accepted.streamVersion + 1,
    candidate: { id: "candidate-1", deliverable: demo.room.candidate!.deliverable },
    sources: { status: "not_collected_in_phase_1", entries: [], claimReferences: [] }, unresolvedIssues: [], artifacts: [],
    nextActions: ["Use the accepted deliverable"], limitations: ["Sources and claim references are not collected in Phase 1"] });
  expect(json.decisions[0]).toEqual({ content: demo.room.candidate!.decisions[0], messageIds: ["message-research", "message-edit"], eventSequence: demo.room.candidateEventSequence });
  const markdownPath = join(temporaryDirectory(), "handoff.md");
  cli(path, "handoff", "export", "--room", roomId, "--format", "markdown", "--id", "handoff-markdown", "--output", markdownPath);
  const markdown = readFileSync(markdownPath, "utf8");
  for (const heading of ["Task", "Requirements", "Acceptance checklist", "Candidate", "Decisions", "Sources", "Unresolved issues", "Limitations", "Next actions", "Artifacts"]) expect(markdown).toContain(`## ${heading}`);
  expect(markdown).toContain("candidate-1 (accepted)");
  expect(markdown).toContain(demo.room.candidate!.deliverable);
  expect(markdown).toContain(`Event: ${accepted.streamVersion + 2}`);
  expect(markdown).not.toContain("Evidence collected and cited for the brief.");
  expect(cli<Room>(path, "room", "show", "--room", roomId).streamVersion).toBe(accepted.streamVersion + 2);
  const db = openTeamRoomDatabase(path);
  try {
    const log = await assertStream(RoomRepository.sqlite(db), new SqliteEventStore(db));
    expect(log.slice(-4).map(item => item.event.type)).toEqual(["CandidateProduced", "CandidateAccepted", "HandoffGenerated", "HandoffGenerated"]);
  } finally { db.close() }
}, 20000);

test("7. reject a candidate, return to running state, improve it, and accept a later version", async () => {
  const { service, events } = databaseFixture();
  await startRoom(service);
  const original = await reachCandidate(service);
  expect(original.candidate?.id).toBe("candidate-1");
  const rejected = await execute(service, { type: "RejectCandidate", actor: "user", candidateId: domainId.candidate("candidate-1"), reason: "Add an actionable recommendation" });
  expect(rejected).toMatchObject({ status: "running", candidate: null });
  const revision = { ...happy.plans["round-1"]!.response.actions[1]!, id: domainId.action("revision"), roundId: domainId.round("round-2"), position: 0, dependencies: [], idempotencyKey: "intent-revision", instruction: "Add an actionable recommendation" };
  const candidate = { ...original.candidate!, id: domainId.candidate("candidate-2"), deliverable: `${original.candidate!.deliverable} Recommendation: publish the reviewed brief.`, messageIds: [...original.candidate!.messageIds, domainId.message("message-revision")], acceptedAt: null };
  const revised = loadScenario({ ...happy,
    plans: { "round-2": { response: { actions: [revision] } } },
    convergence: { "round-2": { response: { type: "candidate", candidate } } },
    personaActions: { revision: { response: { messages: [{ ...happy.personaActions["edit"]!.response.messages[0]!, id: "message-revision", content: "Recommendation: publish the reviewed brief." }], memoryProposals: [], usage: { tokens: 10 } } } },
  });
  const adapters = createDeterministicAdapters(revised);
  const runner = new AutonomousRunner({ service,
    facilitator: { plan: input => adapters.facilitator.plan({ ...input, callKey: "round-2" }), evaluate: input => adapters.facilitator.evaluate({ ...input, callKey: "round-2" }) },
    persona: { act: input => adapters.persona.act({ ...input, callKey: "revision" }) },
  });
  const later = (await runner.step(roomId)).room;
  expect(later.status).toBe("awaiting_acceptance");
  expect(later.candidate).toMatchObject({ id: "candidate-2", deliverable: candidate.deliverable, acceptedAt: null });
  expect(later.candidateEventSequence!).toBeGreaterThan(original.candidateEventSequence!);
  await expect(execute(service, { type: "AcceptCandidate", actor: "user", candidateId: domainId.candidate("candidate-1") })).rejects.toMatchObject({ code: "validation" });
  expect(await service.load(roomId)).toEqual(later);
  const accepted = await execute(service, { type: "AcceptCandidate", actor: "user", candidateId: domainId.candidate("candidate-2") });
  expect(accepted.status).toBe("completed");
  expect(accepted.candidate?.acceptedAt).not.toBeNull();
  const log = await assertStream(service, events);
  const candidates = log.flatMap(item => item.event.type === "CandidateProduced" ? [item.event.candidate] : []);
  expect(candidates.map(candidate => candidate.id)).toEqual(["candidate-1", "candidate-2"]);
  expect(candidates[0]?.acceptedAt).toBeNull();
  expect(log.filter(item => ["CandidateProduced", "CandidateRejected", "CandidateAccepted"].includes(item.event.type)).map(item => item.event.type)).toEqual(["CandidateProduced", "CandidateRejected", "CandidateProduced", "CandidateAccepted"]);
  expect(buildHandoff(accepted).candidate?.id).toBe("candidate-2");
});
