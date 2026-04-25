# AI-Powered Support Ticket Processing Pipeline
### Product Requirements Document

| Field | Value |
|---|---|
| Status | Draft |
| Version | 2.0 |
| Review Status | Review-ready |
| Date | April 22, 2026 |
| Audience | Product Managers, Stakeholders, Customer Success, Leadership |
| Source | Backend_Task_AI_Ticket_Pipeline.pdf |

---

## Roles & Definitions

| Role | Who They Are | What They Receive |
|---|---|---|
| **SaaS Platform (API Client)** | The platform or internal service that submits tickets to this backend and consumes its outputs programmatically | Task IDs, status responses, socket events, and the full structured output (Phase 1 + Phase 2) |
| **Support Team (Internal User)** | The staff who use the AI-generated outputs surfaced by the SaaS platform to process tickets faster and more consistently | Triage metadata, response drafts, internal notes, recommended next actions, and fallback flags |

> **Note on end customers:** The end customer who originally submitted the support ticket is the beneficiary of this system but is not a direct actor. They interact with the SaaS platform's own UI — not with this backend service. This PRD does not define any customer-facing interface.

---

## 1. Overview

This PRD defines the product scope and epic breakdown for an AI-powered backend service that processes customer support tickets through a two-phase AI pipeline. The service is designed for a SaaS support platform where support teams need faster, more consistent ticket handling.

> **Key scope decision for stakeholders:** This system generates AI-assisted drafts for internal review only. It does not send any reply to the end customer automatically — not even as a fallback. All outbound customer communication remains the responsibility of the Support Team.

---

## 2. Task Lifecycle & State Model

Every ticket submission creates a task that moves through the following canonical states. This table is the single source of truth — no other states are valid.

| State | Who Sets It | What It Means |
|---|---|---|
| `pending` | System on intake | Task created, queued for processing, not yet picked up by a worker |
| `processing` | Worker on pickup | Worker has started Phase 1 or Phase 2 |
| `completed` | Worker after Phase 2 success | Both phases succeeded; full output is available |
| `completed_with_fallback` | Worker after Phase 2 exhausts retries | Phase 1 succeeded; Phase 2 failed permanently. `outputs.phase_1` is populated. `outputs.phase_2.response_draft` is `null`, `outputs.phase_2.next_actions` is `null`, and `outputs.phase_2.internal_note` contains a static fallback string — there is no AI-generated draft. |
| `needs_manual_review` | Worker after Phase 1 exhausts retries | Phase 1 failed permanently; no AI output is available. Original ticket payload is preserved for manual handling |

> **`failed` is not a user-facing state.** It is an internal, transient signal used within the queue/worker layer to trigger retries. Once retries are exhausted, the task always resolves to either `completed_with_fallback` or `needs_manual_review`. The word `failed` must not appear as a final task state in any API response or socket event.

> **Dead-letter queue (DLQ) is an internal infrastructure concern.** Moving a message to the DLQ is the mechanism that triggers the transition to `completed_with_fallback` or `needs_manual_review`. It is not itself a task state and is not visible in the status API.

---

## 3. API & Socket Contracts

These are the minimum field contracts. Implementation details (e.g. exact field names, HTTP framework) are deferred to epic planning.

### Status API Response — Minimum Fields

Every response from the status endpoint must include:

| Field | Type | Description |
|---|---|---|
| `task_id` | string | Unique identifier for the task |
| `state` | string | One of the five canonical states from Section 2 |
| `current_phase` | string or null | The phase actively running right now. Set to `phase_1` when the worker starts Phase 1, switches to `phase_2` only when the `phase_2_started` socket event is emitted. `null` if not yet started or already in a terminal state. |
| `retry_count` | object | Per-phase retry counts, e.g. `{ phase_1: 0, phase_2: 2 }` |
| `created_at` | timestamp | When the task was created |
| `state_changed_at` | timestamp | When the `state` field last changed — use this to detect lifecycle transitions |
| `last_mutated_at` | timestamp | When any field on the task record last changed, including `outputs` — use this for polling to detect new data without a state change (e.g. Phase 1 output becoming available while state is still `processing`) |
| `outputs` | object or null | The task result shape — contains AI-generated Phase 1 and Phase 2 data when available, and static fallback values where AI generation did not succeed. See Output Shape below |
| `input_ticket` | object or null | The original ticket payload. Always present on `needs_manual_review`; `null` on all other states |
| `fallback_info` | object or null | Present on `completed_with_fallback` and `needs_manual_review`. Contains `{ reason, triggered_at }`. `null` on all other states |

### Output Shape by State

| State | `outputs` content |
|---|---|
| `pending` | `null` |
| `processing` (Phase 1 in progress) | `null` |
| `processing` (Phase 2 in progress) | `{ phase_1: { category, priority, sentiment, escalation, routing_target, summary }, phase_2: null }` — `current_phase` switches to `phase_2` when `phase_2_started` is emitted, at which point `outputs.phase_1` is already populated |
| `completed` | `{ phase_1: { category, priority, sentiment, escalation, routing_target, summary }, phase_2: { response_draft, internal_note, next_actions } }` |
| `completed_with_fallback` | `{ phase_1: { category, priority, sentiment, escalation, routing_target, summary }, phase_2: { response_draft: null, internal_note: "<static fallback message>", next_actions: null } }` |
| `needs_manual_review` | `{ phase_1: null, phase_2: null }` |

> **Contract note:** `outputs` holds the task result shape regardless of how it was produced — AI-generated where both phases succeeded, partially static on fallback. Operational metadata (`fallback_info`, `input_ticket`) is always at the top level of the response — never nested inside `outputs`. This keeps the `outputs` shape predictable regardless of task state.

### Socket Event Contract — Minimum Fields

Every socket event must include:

| Field | Type | Description |
|---|---|---|
| `task_id` | string | The task this event belongs to |
| `event` | string | The event type. Terminal events mirror canonical lifecycle states: `completed`, `completed_with_fallback`, `needs_manual_review`. Processing milestone events are: `started`, `phase_1_started`, `phase_1_complete`, `phase_2_started`, `phase_2_complete`, `retry`. `success`, `failure`, and `fallback` are not valid event names. |
| `timestamp` | timestamp | When the event occurred |
| `metadata` | object or null | Event-specific data (e.g. `{ phase: "phase_2", attempt: 2, reason: "..." }` for `retry`) |

---

## 4. Epic Overview & Build Order

Epics are sequenced by dependency. Each epic builds on the previous. Do not start an epic until its dependencies are done. All state names used in epics below refer to the canonical lifecycle defined in Section 2.

| # | Epic | Depends On | Key Outcome |
|---|---|---|---|
| E1 | Ticket Intake, Task State & Status API | — | Tasks exist and are queryable |
| E2 | Async Queue & Orchestration | E1 | Tasks are processed end-to-end |
| E3 | AI Triage Pipeline (Phase 1) | E2 | Tickets are classified |
| E4 | AI Resolution Draft Pipeline (Phase 2) | E3 | Response drafts are generated |
| E5 | Failure Recovery & Fallback Handling | E2, E3, E4 | System degrades gracefully |
| E6 | Real-Time Delivery & Observability | E1–E5 | System is visible and auditable |

---

## Epic 1 — Ticket Intake, Task State & Status API

**Depends on:** None — build this first

### Definition of Done

- [ ] The SaaS Platform can submit a ticket to the backend API and receive an immediate 202 response with a task ID, initial state, and a URL to the status endpoint.
- [ ] The 202 response is only returned after both task persistence and queue enqueue succeed — a task must never be acknowledged to the caller without being guaranteed to reach a worker.
- [ ] If task persistence succeeds but queue enqueue fails, the task record is deleted (strict rollback) and the request returns an error — no orphaned `pending` record is left in storage.
- [ ] The original ticket payload is stored in the task record at the moment of creation — not only on failure.
- [ ] Every task has a persisted state that transitions through the canonical lifecycle defined in Section 2.
- [ ] A client can query any task by ID and receive its current state and output using the contract defined in Section 3.
- [ ] All state transitions are persisted durably — no in-memory-only state.

### Checklist

- [ ] Ticket submission endpoint is implemented and returns a 202 with task ID, initial state (`pending`), and status endpoint URL immediately.
- [ ] The 202 is only returned after both the task record is persisted and the queue job is successfully enqueued — if either step fails, the request returns an error and no task ID is issued.
- [ ] If persistence succeeds but enqueue fails, the task record is deleted before returning the error — no orphaned `pending` records remain in storage.
- [ ] Original ticket payload is persisted to the task record at creation time.
- [ ] Task state model is implemented with all five canonical states from Section 2.
- [ ] Status/result retrieval endpoint is implemented with all minimum fields from the Section 3 contract.
- [ ] Endpoint returns appropriate error for unknown task IDs.
- [ ] All endpoints are manually tested end-to-end.

### User Stories

---

#### US-1.1 — Submit a Support Ticket

**As a** SaaS Platform, **I want to** submit a support ticket to the backend and receive an immediate acknowledgment, **so that** I can track the task and relay the reference ID back to the end customer without waiting for processing to complete.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | Given a valid ticket payload, when I POST it, then I receive a 202 response containing the task ID, the initial state (`pending`), and the URL of the status endpoint for that task. |
| AC2 | The response is returned immediately — not after processing is complete. |
| AC3 | The task record is created in persistent storage with the original ticket payload included, before the response is returned. |
| AC4 | Given an invalid or malformed payload, when I POST it, then I receive a 400 error with a descriptive message. |
| AC5 | If task persistence succeeds but queue enqueue fails, the task record is deleted (strict rollback) and the request returns an error — a 202 is never issued for a task that has not been enqueued, and no orphaned `pending` record is left in storage. |

---

#### US-1.2 — Query Task Status and Result

**As a** SaaS Platform, **I want to** query the current status and result of a submitted ticket by its task ID, **so that** I can surface the processing state and AI-generated output to the Support Team at the right time.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | Given a valid task ID, when I GET the status endpoint, then I receive a response with all minimum fields defined in the Section 3 contract. |
| AC2 | When the task is `completed`, `outputs` contains the full Phase 1 and Phase 2 results as defined in the Section 3 output shape. |
| AC3 | When the task is `completed_with_fallback`, `outputs` contains Phase 1 results and the Phase 2 fallback shape; `fallback_info` is present at the top level with the failure reason and timestamp. |
| AC4 | When the task is `needs_manual_review`, `outputs` contains `null` for both phases; `input_ticket` and `fallback_info` are present at the top level of the response. |
| AC5 | When the task is `processing` and `current_phase` is `phase_2`, `outputs.phase_1` is already populated — Phase 1 results are not withheld until full completion. |
| AC6 | When the task is still in `processing` with `current_phase` as `phase_1`, `outputs` is `null`. |
| AC7 | Given an unknown task ID, when I GET it, then I receive a 404 response. |
| AC8 | The `state` field contains only the five canonical states from Section 2 — `failed` never appears in a final API response. |

---

## Epic 2 — Async Queue & Orchestration

**Depends on:** E1

### Definition of Done

- [ ] Submitted tickets are processed asynchronously via a queue — not in the request lifecycle.
- [ ] A worker picks up tasks and orchestrates Phase 1 followed by Phase 2 in sequence.
- [ ] If a phase fails, only that phase is retried — completed phases are not repeated.
- [ ] Tasks that exhaust retries are moved to a dead-letter queue (an internal infrastructure mechanism) and the task state is updated to `completed_with_fallback` or `needs_manual_review` accordingly.
- [ ] The system handles duplicate or redelivered messages without double-processing (idempotency).

### Checklist

- [ ] Queue infrastructure is set up and connected to the backend.
- [ ] Ticket submission enqueues a job after creating the task record.
- [ ] Worker consumes jobs and orchestrates Phase 1 then Phase 2.
- [ ] Phase-level checkpointing is implemented — worker can resume from last successful phase.
- [ ] Retry logic is implemented at the phase level with a configurable retry limit.
- [ ] Dead-letter handling is implemented as an internal queue mechanism — on DLQ, task state transitions to `completed_with_fallback` or `needs_manual_review` (never `failed`).
- [ ] Idempotency is enforced — reprocessing the same task ID does not produce duplicate outputs.
- [ ] Worker behavior is verified with simulated failures in Phase 1 and Phase 2 independently.

### User Stories

---

#### US-2.1 — Asynchronous Ticket Processing

**As a** SaaS Platform, **I want to** have submitted tickets processed asynchronously without blocking the intake response, **so that** the platform remains responsive and I can handle high ticket volumes without timeouts.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When a ticket is submitted, the API returns before processing begins. |
| AC2 | A queue job is created for every successfully ingested ticket. |
| AC3 | A worker consumes queue jobs and begins processing independently of the API layer. |
| AC4 | Task state is updated to reflect that async processing has started. |

---

#### US-2.2 — Phase-Level Retry Without Repeating Success

**As a** Support Team member, **I want to** have failed processing steps retried automatically without repeating steps that already succeeded, **so that** tickets are resolved as quickly as possible without unnecessary reprocessing.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When Phase 1 succeeds and Phase 2 fails, only Phase 2 is retried on the next attempt. |
| AC2 | When Phase 1 fails, the next attempt resumes at Phase 1 — Phase 2 is not attempted until Phase 1 succeeds on that attempt. |
| AC3 | The retry count is tracked per phase, not per task overall. |
| AC4 | When a phase exceeds the maximum retry count, the task moves to dead-letter handling. |
| AC5 | Phase completion state is persisted between retry attempts. |

---

#### US-2.3 — Dead-Letter Handling for Exhausted Tasks

**As a** Support Team member, **I want to** be notified when a ticket cannot be processed after multiple attempts, **so that** I can handle it manually and no ticket silently falls through the cracks.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When a task exceeds the maximum retry count, it is moved to the dead-letter queue — an internal infrastructure event not exposed in the API. |
| AC2 | On DLQ, the task state transitions to `needs_manual_review` (if Phase 1 failed) or `completed_with_fallback` (if Phase 2 failed). |
| AC3 | The resulting state is visible in the status API. |
| AC4 | A dead-lettered task does not block other tasks in the queue. |

---

#### US-2.4 — Idempotent Task Processing

**As a** SaaS Platform, **I want to** be guaranteed that redelivered or duplicate queue messages do not reprocess an already-handled task, **so that** retries and at-least-once delivery do not corrupt task state or produce duplicate outputs.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When a worker receives a queue message for a task that has already reached a terminal state (`completed`, `completed_with_fallback`, `needs_manual_review`), it discards the message without reprocessing. |
| AC2 | Reprocessing the same task ID does not produce duplicate Phase 1 or Phase 2 outputs in the task record. |
| AC3 | Reprocessing the same task ID does not emit duplicate terminal socket events (`completed`, `completed_with_fallback`, `needs_manual_review`). |
| AC4 | Reprocessing the same task ID does not produce invalid state transitions (e.g. `completed` → `processing`). |

---

## Epic 3 — AI Triage Pipeline (Phase 1)

**Depends on:** E2

### Definition of Done

- [ ] The worker calls an AI model with the raw ticket and receives structured triage metadata.
- [ ] Phase 1 output includes: category, priority, sentiment, escalation flag, routing target, and summary.
- [ ] The output is validated for structure before being persisted.
- [ ] Phase 1 result is stored in the task record and accessible via the status API.

### Checklist

- [ ] AI call for Phase 1 is implemented and triggered by the worker.
- [ ] Prompt produces all 6 required output fields consistently.
- [ ] Output schema validation is in place — invalid AI responses are caught.
- [ ] Validated Phase 1 output is persisted to the task record.
- [ ] When Phase 1 succeeds, `outputs.phase_1` is populated and the `phase_2_started` event is emitted — `current_phase` switches to `phase_2` at that moment. `state` remains `processing` throughout and no intermediate state transition occurs.
- [ ] Phase 1 is tested with representative ticket samples.

### User Stories

---

#### US-3.1 — AI-Based Ticket Triage

**As a** Support Team member, **I want to** have each incoming ticket automatically classified with category, priority, sentiment, escalation flag, routing target, and a summary, **so that** I can act on the right tickets first without manually reading and triaging each one.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | Given a raw ticket, Phase 1 produces all of: category, priority, sentiment, escalation flag, routing target, and concise summary. |
| AC2 | The output is structured — not free-form prose — so it can be stored and queried programmatically. |
| AC3 | If the AI returns an output that is missing required fields or is unparseable, Phase 1 is treated as failed and the retry logic from E2 applies. |
| AC4 | A successful Phase 1 output is persisted to the task record before Phase 2 begins. |
| AC5 | The Phase 1 output is visible in the task status API response. |

---

## Epic 4 — AI Resolution Draft Pipeline (Phase 2)

**Depends on:** E3

### Definition of Done

- [ ] The worker calls an AI model with the original ticket AND the Phase 1 output as context.
- [ ] Phase 2 output includes: a customer-facing response draft, an internal support note, and recommended next actions.
- [ ] The output is validated for structure before being persisted.
- [ ] Phase 2 result is stored in the task record and task is marked complete.

### Checklist

- [ ] AI call for Phase 2 is implemented and triggered after Phase 1 succeeds.
- [ ] Phase 1 output is included in the Phase 2 prompt context.
- [ ] Prompt produces all 3 required output fields consistently.
- [ ] Output schema validation is in place — invalid AI responses are caught.
- [ ] Validated Phase 2 output is persisted to the task record.
- [ ] Task state is updated to completed after Phase 2 succeeds.
- [ ] Phase 2 is tested with representative ticket and Phase 1 output pairs.

### User Stories

---

#### US-4.1 — AI-Based Resolution Drafting

**As a** Support Team member, **I want to** receive an AI-generated response draft, internal note, and recommended next actions for each ticket, **so that** I can resolve tickets faster and more consistently without starting from a blank page.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | Given a raw ticket and its Phase 1 output, Phase 2 produces all of: a customer-facing response draft, an internal support note, and recommended next actions. |
| AC2 | The Phase 1 output is used as context in the Phase 2 AI prompt — the draft is not generated from the raw ticket alone. |
| AC3 | The output is structured and stored in the task record. |
| AC4 | If the AI returns an output that is missing required fields or is unparseable, Phase 2 is treated as failed and the retry logic from E2 applies. |
| AC5 | The resolution draft is clearly marked as a draft — it is not sent to the customer automatically. |
| AC6 | The full task output (Phase 1 + Phase 2) is accessible via the status API once both phases are complete. |

---

## Epic 5 — Failure Recovery & Fallback Handling

**Depends on:** E2, E3, E4

### Definition of Done

- [ ] When a task fails after all retries, partial results from successful phases are preserved — not discarded.
- [ ] Tasks with partial results are marked `completed_with_fallback`.
- [ ] Tasks where Phase 1 fails entirely are marked `needs_manual_review`.
- [ ] When Phase 2 fails, `response_draft` and `next_actions` are set to `null` and `internal_note` is set to a static fallback string — consistent with the Section 3 output shape contract.
- [ ] No canned customer-facing reply is generated automatically — fallback is internal only.

### Checklist

- [ ] Partial result preservation is implemented — Phase 1 output is retained even if Phase 2 fails.
- [ ] completed_with_fallback state is implemented and applied correctly.
- [ ] needs_manual_review state is implemented and applied correctly.
- [ ] Static internal note fallback is implemented for Phase 2 AI failures.
- [ ] All fallback states are visible in the status API response.
- [ ] Fallback behavior is tested by simulating Phase 1 failure, Phase 2 failure, and total failure independently.
- [ ] Decision confirmed: no automatic outbound customer reply is generated in any failure scenario.

> **Decision Note:** Canned customer-facing replies are explicitly out of scope. The system describes AI-assisted support processing, not automatic customer messaging. Generating an outbound fallback reply changes the risk profile of the system. The safe default is manual review, not automatic response.

### User Stories

---

#### US-5.1 — Preserve Partial Results on Phase 2 Failure

**As a** Support Team member, **I want to** still have access to the triage data even when the response draft could not be generated, **so that** I can act on the classification and priority information manually rather than having to restart from scratch.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When Phase 1 succeeds and Phase 2 exhausts all retries, the task is marked completed_with_fallback. |
| AC2 | The Phase 1 output remains accessible via the status API. |
| AC3 | A static internal note is stored in place of the AI-generated note, indicating that manual review is required. |
| AC4 | No customer-facing draft is generated or stored in this scenario. |
| AC5 | The completed_with_fallback state is clearly distinguished from completed in the API response. |

---

#### US-5.2 — Flag Tasks for Manual Review on Total Failure

**As a** Support Team member, **I want to** be clearly flagged when a ticket could not be processed at all by the AI, **so that** I know to handle it manually and it does not get lost or delayed.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When Phase 1 exhausts all retries, the task is marked needs_manual_review. |
| AC2 | No Phase 2 processing is attempted for a task in this state. |
| AC3 | The needs_manual_review state is visible in the status API. |
| AC4 | The task record includes the original ticket payload so agents can act on it manually. |

---

## Epic 6 — Real-Time Delivery & Observability

**Depends on:** E1–E5

### Definition of Done

- [ ] Clients receive real-time socket events at every major processing milestone.
- [ ] Every phase execution, retry, fallback decision, and final outcome is logged in a structured format.
- [ ] Logs are sufficient to reconstruct the full processing history of any task from its ID.
- [ ] Socket events and logs are consistent — the same events trigger both.

### Checklist

- [ ] Socket connection is established and clients can subscribe to task updates.
- [ ] Events are emitted for: `started`, `phase_1_started`, `phase_1_complete`, `phase_2_started`, `phase_2_complete`, `retry`, `completed`, `completed_with_fallback`, `needs_manual_review` — no other event names are used.
- [ ] Structured logs are emitted for every socket event above. Every log entry always includes `task_id`, `event`, `timestamp`, and event-specific `metadata`. `phase` and `outcome` are included only when applicable — not required on events like `started` or `retry` where no final outcome exists yet.
- [ ] Retry attempts are logged with attempt number and reason.
- [ ] Fallback decisions are logged with the reason and resulting state.
- [ ] Final outcome (`completed`, `completed_with_fallback`, `needs_manual_review`) is logged — `failed` is logged only as a transient retry signal, never as a final outcome.
- [ ] Log output is verified to be parseable JSON or equivalent structured format.

### User Stories

---

#### US-6.1 — Real-Time Processing Updates via Socket

**As a** SaaS Platform, **I want to** receive real-time socket events as a ticket moves through the processing pipeline, **so that** I can push live status updates to the Support Team without polling the status API repeatedly.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | When processing begins, a `started` event is emitted to the client. |
| AC2 | When each phase starts and completes, a `phase_1_started`, `phase_1_complete`, `phase_2_started`, or `phase_2_complete` event is emitted respectively. |
| AC3 | When a retry occurs, a `retry` event is emitted with the attempt number and phase in the metadata. |
| AC4 | When processing completes successfully, a `completed` event is emitted with the final task state. |
| AC5 | When processing ends in a fallback, a `completed_with_fallback` event is emitted. When Phase 1 fails permanently, a `needs_manual_review` event is emitted. |
| AC6 | All events include the task ID and follow the socket contract defined in Section 3. |

---

#### US-6.2 — Structured Logging for Full Audit Trail

**As a** Support Team member, **I want to** have a complete audit trail of every processing step for any ticket, **so that** I can investigate issues, understand why a ticket was handled a certain way, and verify the system is working correctly.

**Acceptance Criteria**

| # | Criteria |
|---|---|
| AC1 | Every log entry always includes `task_id`, `event`, `timestamp`, and event-specific metadata. |
| AC2 | `phase` is included in log entries where a phase is active (e.g. `phase_1_started`, `retry`). `outcome` is included only on terminal entries (`completed`, `completed_with_fallback`, `needs_manual_review`). Neither field is required on events where they do not apply. |
| AC3 | Every fallback decision produces a log entry with task ID, trigger condition, and resulting state. |
| AC4 | Every final outcome produces a log entry with task ID, final state, and processing duration. |
| AC5 | All log entries are in a consistent structured format (e.g., JSON) — no unstructured prose logs for system events. |
| AC6 | Given a task ID, all log entries for that task can be filtered and read as a coherent timeline. |

---

*All implementation decisions (tech stack, libraries, infrastructure) are deferred to epic-level planning. This PRD defines what to build, not how to build it.*