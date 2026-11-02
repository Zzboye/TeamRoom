# TeamRoom Core Engine Design

**Date:** 2026-11-02

**Status:** Approved

**Scope:** Phase 1 of the TeamRoom program

## 1. Purpose

TeamRoom is a Codex-first discussion-room plugin in which a single human works with a persistent team of AI personas. A room has a task, requirements, an approved team, a public conversation, per-persona structured memory, artifacts, sources, execution state, and a final handoff package. The experience should resemble a small real-world team: members divide work, discuss, challenge one another, execute permitted actions, and converge on a result under a visible facilitator.

The complete product is intentionally split into independently testable phases. This document specifies Phase 1: a headless, persistent discussion-room engine with a runnable command-line demonstration. It establishes the domain contracts and recovery guarantees on which the later Codex UI, real model integration, tool execution, and background runtime will depend.

## 2. Confirmed Product Decisions

The following decisions define the long-term product and constrain the Phase 1 interfaces:

- Codex desktop is the first host. A later ChatGPT adapter must not require changes to the room domain.
- The product is local-first and single-user in its initial releases.
- Rooms run in a hybrid mode: autonomous discussion continues by default, while the user can pause, speak, mention a member, or quote a message at any time.
- The facilitator is a visible, configurable persona. It assigns work, controls pacing, identifies disagreements, checks acceptance criteria, and requests user decisions.
- Every persona sees the public room transcript and maintains separate structured private memory. Raw model reasoning is neither stored nor exposed.
- Generated teams are reviewed before a room starts. A saved persona or team template is immutable; each room receives an independent snapshot that can be adjusted with user approval.
- Important external factual claims must be traceable to sources. Source capture is implemented in a later phase, while the Phase 1 handoff schema already reserves the required fields.
- A facilitator may stop autonomous work only by submitting a candidate result against the room's acceptance criteria. The user decides whether the result is accepted.
- Leaving a room can either pause it or allow it to continue. Background execution is implemented in a later phase; Phase 1 persists the policy and models the states.
- Tool execution eventually occurs in a room-specific workspace or worktree. High-risk or externally visible actions always require explicit approval.
- The default main-chat transfer is a structured handoff package rather than a full transcript.

## 3. Program Decomposition

TeamRoom is delivered as five design and implementation phases:

1. **Core engine:** domain model, event log, templates and snapshots, message routing, deterministic persona orchestration, pause and recovery, candidate results, handoff generation, and a CLI demonstration.
2. **Codex plugin UI:** room list, creation flow, team review, three-pane chat workspace, memory/source/artifact panels, and responsive behavior.
3. **Real model orchestration:** model adapters, parallel persona work, user interruption, budgets, convergence evaluation, and quality evaluation.
4. **Tools and research:** isolated workspaces, approval gateway, source ledger, artifact versions, tool safety, and side-effect recovery.
5. **Background and host integration:** leave-and-continue execution, notifications, main-chat injection, export and archive, and the future ChatGPT host boundary.

Each later phase receives its own approved design and implementation plan. Phase 1 must not implement later-phase behavior merely because an interface has been reserved for it.

## 4. Phase 1 Goals

Phase 1 must:

- define a framework-independent room domain;
- persist every accepted state change as an ordered event;
- rebuild a room from a snapshot plus subsequent events;
- create versioned persona and team templates and copy them into room-local member snapshots;
- route public messages, mentions, and quoted replies;
- maintain user-editable structured memory per room member;
- run deterministic facilitator and persona adapters through an autonomous loop;
- support pause, resume, user-input requests, approval requests, budget stops, candidate results, acceptance, and archive states;
- prevent duplicate committed actions after restart;
- generate a structured handoff package; and
- demonstrate all core flows through a CLI and automated tests.

## 5. Phase 1 Non-Goals

Phase 1 does not include:

- a graphical interface;
- a real language-model provider;
- web search or live source collection;
- filesystem or command execution outside the deterministic test adapters;
- worktree creation;
- a background daemon or desktop notifications;
- automatic injection into a Codex chat;
- multiple human participants;
- cloud storage or cross-device synchronization; or
- a production plugin package.

These exclusions are hard scope boundaries. Phase 1 may define ports and data fields for future capabilities, but it must not add speculative implementations.

## 6. Technology and Repository Structure

The implementation uses TypeScript on Node.js, SQLite for local persistence, pnpm workspaces for package management, and Vitest for tests. The implementation plan will pin versions compatible with the Codex host in repository toolchain files and the lockfile.

The intended package boundaries are:

```text
apps/
  teamroom-cli/          Human-operated Phase 1 demonstration
packages/
  room-domain/           Pure types, invariants, commands, events, reducers
  room-engine/           Orchestration and application services
  runtime-ports/         Model, tool, clock, ID, artifact, and notification ports
  sqlite-store/          Migrations, event append, snapshots, repositories
  test-adapters/         Deterministic facilitator, personas, tools, clock, and IDs
tests/
  integration/           Cross-package and restart scenarios
  fixtures/              Versioned deterministic room scripts
```

Dependencies point inward: adapters depend on ports and the engine; the engine depends on the domain and ports; the domain depends on no infrastructure package. The CLI invokes application services and contains no business rules.

## 7. Domain Model

### 7.1 Room

A room is the aggregate root and contains:

- a stable room ID;
- title, task, requirements, and explicit acceptance criteria;
- lifecycle state;
- background policy, budget limits, and current usage;
- room-member snapshots;
- the latest committed public-message position;
- the active run and pending actions, if any;
- candidate-result and acceptance status;
- workspace and host references reserved for later phases; and
- creation, update, completion, and archive timestamps.

Lifecycle states are:

```text
draft -> team_review -> ready -> running -> convergence_check
running/convergence_check -> paused | awaiting_input | awaiting_approval
convergence_check -> awaiting_acceptance
awaiting_acceptance -> running | completed
any non-archived stable state -> archived
```

`paused`, `awaiting_input`, `awaiting_approval`, and `awaiting_acceptance` are stable persisted states. Process termination is not a domain state; a restarted process reconstructs the last stable state and reconciles pending actions.

### 7.2 Templates and Room Members

A `PersonaTemplate` is versioned and immutable. It contains identity, role, responsibilities, domain perspective, communication style, constraints, and default collaboration guidance. Editing a saved persona creates a new template version.

A `TeamTemplate` is also versioned and immutable. It references persona-template versions and records facilitator selection, responsibility assignments, and collaboration rules.

Creating a room copies selected template versions into `RoomMember` snapshots. A room-member snapshot can be adjusted during team review without modifying its source template. The room records the source template and version for traceability.

### 7.3 Public Messages and Links

Every public message has a stable ID, room ID, author type and ID, content, message type, creation sequence, and timestamp. Phase 1 supports user messages, persona messages, facilitator messages, system cards, action summaries, approval requests, candidate results, and handoffs.

Mentions and quoted replies are stored as explicit `MessageLink` records:

- `mention` links a message to a room member;
- `reply` links a message to the message being answered; and
- `quote` links to the exact historical message version used by the author.

The system stores links rather than embedding copied text as the source of truth. Rendering may display a text excerpt, but routing and audit behavior use the linked ID.

Routing rules are:

- an explicit mention gives the target member highest response priority;
- a quoted reply preserves its target and is visible to the facilitator;
- an unaddressed user message is evaluated by the facilitator, which selects relevant responders;
- not every member responds to every message; and
- a new user message prevents the next autonomous round from starting until the facilitator replans from a new committed snapshot.

### 7.4 Structured Persona Memory

Memory is a collection of typed `MemoryItem` records owned by one room member. Supported kinds are goal, fact, judgment, assumption, task, and completed item. Each item records provenance, confidence where applicable, creation and update events, and user-pinned status.

Users may view, edit, pin, or remove memory items. Personas cannot modify another member's memory. A private memory item can affect team state only after the member publishes a message, source reference, action result, or artifact change.

Raw chain-of-thought or hidden model reasoning is never stored as a memory item.

### 7.5 Runs, Actions, and Candidate Results

A `Run` represents one continuous attempt to advance a room. A run contains ordered rounds. Each round contains a facilitator plan and one or more `Action` records assigned to members.

Actions have stable IDs and move through `planned`, `started`, `succeeded`, `failed`, `cancelled`, or `status_unknown`. An action result may contain a public message, proposed memory changes, an artifact reference, a source reference, usage, and an error classification.

A `CandidateResult` contains the proposed deliverable, an acceptance-criteria checklist, supporting decisions, unresolved issues, and relevant message and artifact references. Only the facilitator may propose a candidate result; only the user may accept it.

## 8. Commands, Events, and State Reconstruction

External callers interact with the engine only through commands. The initial command set includes:

- `CreateRoom`, `ProposeTeam`, `ConfirmTeam`, `StartRun`;
- `PostMessage`, `PauseRun`, `ResumeRun`;
- `ApproveAction`, `RejectAction`, `ProvideRequestedInput`;
- `EditMemoryItem`, `PinMemoryItem`, `RemoveMemoryItem`;
- `AcceptCandidate`, `RejectCandidate`, `GenerateHandoff`; and
- `ArchiveRoom`.

The engine validates the command against current state and emits one or more immutable domain events. Representative events include:

- `RoomCreated`, `TeamProposed`, `TeamConfirmed`;
- `MessagePosted`, `MessageLinked`, `MemoryUpdated`;
- `RunStarted`, `RoundPlanned`, `ActionStarted`, `ActionCompleted`;
- `RunPaused`, `InputRequested`, `ApprovalRequested`;
- `ConvergenceChecked`, `CandidateProduced`, `CandidateAccepted`;
- `HandoffGenerated`, and `RoomArchived`.

The SQLite transaction appends events with a room-local monotonically increasing sequence and updates the expected stream version atomically. A concurrent writer with a stale expected version receives a conflict and must reload before retrying the command. Domain state is rebuilt by reducing events from the most recent valid snapshot.

## 9. Autonomous Orchestration

The Phase 1 autonomous loop uses deterministic adapters but follows the production control flow:

1. Collect newly committed user messages, completed actions, and pending decisions.
2. Ask the facilitator adapter for a structured plan against one immutable room snapshot.
3. Validate the plan, assignments, budget, and state transition.
4. Start independent persona actions concurrently when they have no declared dependency.
5. Commit action results in a deterministic order defined by plan position and action ID, regardless of completion timing.
6. Apply valid public messages and memory proposals as domain events.
7. Ask the facilitator to check acceptance criteria.
8. Continue, request input, request approval, pause for limits or error, or submit a candidate result.

The facilitator cannot grant permissions, mutate other members' memory, accept its own result, or bypass budget rules. The engine validates every structured adapter response before emitting events.

Pause is cooperative at a safe boundary: it prevents new actions from starting. Already-started Phase 1 test actions finish or cancel according to their adapter script. Their outcomes are recorded before the room reaches a stable paused state.

## 10. Runtime Ports and Deterministic Adapters

The engine defines ports for:

- facilitator planning and convergence evaluation;
- persona action execution;
- tool execution and approval classification;
- artifact storage;
- clocks and ID generation;
- usage accounting; and
- notifications and host handoff.

Phase 1 provides deterministic adapters controlled by versioned scenario fixtures. A fixture can prescribe messages, memory proposals, delays, failures, approval requests, timeouts, and convergence outcomes. Deterministic clocks and IDs make event streams reproducible.

The mock tool port does not execute real commands or external actions. It can simulate safe success, retryable failure, permanent failure, approval required, timeout, and unknown completion status so the engine's recovery rules are testable.

## 11. Persistence and Recovery

SQLite stores rooms, template versions, room-member snapshots, messages, message links, memory items, runs, actions, candidate results, handoffs, snapshots, and the append-only event log. Write-ahead logging and foreign-key enforcement are enabled.

Snapshots are performance aids, not independent sources of truth. Each snapshot records the last included event sequence and a schema version. If validation fails, the store ignores the snapshot and rebuilds from the event stream.

Recovery follows this sequence:

1. load the newest valid snapshot;
2. replay later events;
3. locate actions without terminal outcomes;
4. reconcile each action through its adapter and idempotency key;
5. resume safe deterministic actions or mark uncertain actions `status_unknown`; and
6. pause for user review whenever completion cannot be proven.

An action with a potentially external side effect is never blindly retried. Later real tool adapters must record execution intent before dispatch and completion after dispatch using the same idempotency key.

Database migrations are ordered, transactional where SQLite permits, and tested both from a fresh database and from every released Phase 1 schema fixture.

## 12. Handoff Package

The Phase 1 handoff is a versioned structured document containing:

- room identity, task, requirements, and acceptance criteria;
- accepted or current candidate result;
- key decisions with message references;
- source entries and claim references, which may be empty in Phase 1 and are explicitly labeled as unavailable rather than inferred;
- unresolved questions and known limitations;
- recommended next actions;
- artifact references; and
- the room and event position from which the package was generated.

The CLI can render this object as readable Markdown and export the canonical JSON form. The full transcript is not embedded by default.

## 13. CLI Demonstration

The CLI is an application adapter. It supports commands to:

- initialize, create, list, open, archive, and inspect rooms;
- create and list persona and team templates;
- propose and confirm a room team;
- start, pause, resume, and step an autonomous run;
- post a normal, mentioned, or quoted message;
- inspect and edit structured member memory;
- inspect events, current state, pending actions, and candidate results;
- approve, reject, or answer pending requests; and
- accept a candidate and export a handoff.

Interactive output clearly distinguishes user, facilitator, persona, system, action, approval, and error records. The CLI exits without special shutdown requirements because all committed state already resides in SQLite.

## 14. Error Handling and Safety

Errors use a typed classification: validation, conflict, retryable adapter failure, permanent adapter failure, timeout, approval required, budget exhausted, corrupt data, and status unknown.

- Validation and stale-version conflicts do not append partial events.
- Retryable operations use bounded attempts defined by the deterministic scenario; Phase 1 tests never depend on wall-clock sleeping.
- A member failure can be returned to the facilitator for reassignment or can pause the room; it does not silently disappear.
- Budget exhaustion always produces a visible pause event and a usage summary.
- Invalid adapter output is rejected and recorded as an adapter failure rather than coerced.
- Any uncertain side-effect status pauses the room for review.
- Secrets are outside the Phase 1 data model. Future credentials are represented only by opaque references to the host credential store.

## 15. Testing Strategy

### 15.1 Unit Tests

Unit tests cover reducers, state transitions, command validation, mention and quote routing, memory ownership, template immutability, budget calculations, facilitator authority limits, and handoff serialization.

### 15.2 Integration Tests

Integration tests use real SQLite databases in isolated temporary directories and deterministic adapters. They cover parallel action completion with deterministic commit order, optimistic-concurrency conflicts, snapshot creation, migration, source-free handoffs, and CLI-to-engine boundaries.

### 15.3 Recovery and Fault-Injection Tests

Tests terminate or reconstruct the engine after event append, snapshot creation, action start, simulated tool intent, action completion, and candidate submission. They prove that restart neither loses committed messages nor repeats a completed action.

### 15.4 End-to-End Scenarios

The acceptance suite includes:

1. create a room, review a generated deterministic team, and start it;
2. route ordinary, mentioned, and quoted messages correctly;
3. interrupt autonomous work, pause at a safe boundary, and resume;
4. exit the CLI, restart the process, reopen the room, and continue from the same logical position;
5. handle a member failure and a simulated approval request without losing events;
6. converge against explicit acceptance criteria, submit a candidate, accept it, and export a handoff; and
7. reject a candidate, return to running state, improve it, and accept a later version.

## 16. Phase 1 Acceptance Criteria

Phase 1 is complete only when:

- the package dependency rules are enforced and the domain package has no infrastructure dependency;
- the CLI demonstrates the complete Phase 1 flow without direct database manipulation;
- room state, public messages, structured memory, and pending work survive process restart exactly;
- no completed deterministic action is committed twice after recovery;
- user pause prevents new actions from starting;
- mention and quote links remain traceable by stable ID;
- saved templates remain unchanged when a room-member snapshot is edited;
- candidate results include an acceptance-criteria assessment;
- the JSON and Markdown handoff outputs contain all defined fields; and
- unit, integration, migration, recovery, and end-to-end suites pass in a clean environment.

## 17. Interfaces Reserved for Later Phases

Later phases may add implementations behind the existing ports, new event types, and versioned schema fields. They must preserve these invariants:

- the event stream remains the source of truth;
- room-member state remains isolated from saved templates and other rooms;
- the user can always pause autonomous work;
- permissions are enforced outside persona prompts;
- externally visible side effects are idempotent or require reconciliation;
- important factual claims can link to sources; and
- the host receives a structured handoff rather than an implicit transcript dump.
