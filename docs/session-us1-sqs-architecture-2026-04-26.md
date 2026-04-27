# Session Recap — US-1.1, US-1.2, SQS Architecture

**Date:** 2026-04-26

---

## What We Built

### Foundation fixes

- Fixed `prisma/schema.prisma`: replaced fake `User` model with full `Task` model + `TaskState` enum
- Fixed `output` path in generator: `"../generated/prisma"` → `"../src/generated/prisma"` (was pointing to wrong dir)
- Fixed `datasource db`: added `url = env("DATABASE_URL")` (was missing)
- Ran `prisma migrate reset` + `prisma migrate dev --name init` → Task table created in Postgres
- Ran `prisma generate` → client regenerated with Task model

### Zod v4 gotchas discovered

- `z.string().email()` deprecated → use `z.email()`
- `z.record(z.unknown())` needs 2 args → `z.record(z.string(), z.unknown())`
- `z.string().uuid()` → use `z.uuid()` directly

---

## US-1.1 — POST /tickets

**ACs completed:** AC1, AC2, AC3, AC4
**AC5 deferred:** needs SQS (coming in US-2.1)

### Files created

| File                                   | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `src/schemas/ticket.ts`                | Zod schema for inbound ticket payload                   |
| `src/repositories/taskRepositories.ts` | `createTask`, `deleteTask`, `getTask` (Prisma wrappers) |
| `src/services/ticketService.ts`        | `submitTicket()` — business logic                       |
| `src/controllers/ticketsController.ts` | Zod validate → call service → 202                       |
| `src/routes/ticketsRouter.ts`          | `POST /` wired to controller                            |
| `src/app.ts`                           | Express bootstrap, route mounting, error handlers       |

### Response shape (PRD contract)

```json
{
  "task_id": "uuid",
  "state": "pending",
  "status_url": "/tasks/uuid"
}
```

### AC5 logic (to implement with SQS)

```
createTask → Postgres
try: SQS.sendMessage({ taskId })
catch: deleteTask(taskId) → 500    ← strict rollback, no orphaned rows
success: return 202
```

---

## US-1.2 — GET /tasks/:taskId

**All 8 ACs complete** (AC2–AC6 code-complete but untestable until worker built)

### Files created/updated

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `src/repositories/taskRepositories.ts` | Added `getTask`                                          |
| `src/services/taskService.ts`          | `getTaskById()`, `buildOutputs()`, `buildFallbackInfo()` |
| `src/controllers/tasksController.ts`   | UUID param validation → call service → 200/404           |
| `src/routes/tasksRouter.ts`            | `GET /:taskId` wired to controller                       |

### buildOutputs logic (state gate)

| Task state                     | outputs value                                  |
| ------------------------------ | ---------------------------------------------- |
| `pending`                      | `null`                                         |
| `processing` + phase_1 running | `null`                                         |
| `processing` + phase_1 done    | `{ phase_1: data, phase_2: null }`             |
| `completed`                    | `{ phase_1: data, phase_2: data }`             |
| `completed_with_fallback`      | `{ phase_1: data, phase_2: fallback message }` |
| `needs_manual_review`          | `{ phase_1: null, phase_2: null }`             |

### Key design decisions

- Zod validates `taskId` as UUID before hitting DB
- `input_ticket` only exposed when state = `needs_manual_review`
- `failed` never appears in API response (not in TaskState enum)

---

## Layer Architecture (after user refactor)

```
app.ts
  └── routes/ → controllers/ → services/ → repositories/ → lib/prisma.ts → PostgreSQL
```

| Layer           | Responsibility                                           |
| --------------- | -------------------------------------------------------- |
| `routes/`       | Wire HTTP verb + path to controller function             |
| `controllers/`  | Validate input (Zod), call service, return HTTP response |
| `services/`     | Business logic, response mapping                         |
| `repositories/` | Raw Prisma DB operations                                 |
| `lib/prisma.ts` | PrismaClient singleton                                   |

---

## US-2.1 + AC5 Plan — SQS + LocalStack

### Why SQS + LocalStack

- `@aws-sdk/client-sqs` already installed
- Mirrors Postgres-in-Docker pattern (zero new local tooling concepts)
- Same code works against real AWS SQS in prod

### Docker infrastructure to add

```yaml
localstack:
  image: localstack/localstack
  ports: ["4566:4566"]
  environment:
    SERVICES: sqs
```

### New files to create

```
src/config/sqs.ts              SQS client singleton (endpoint: localhost:4566 in dev)
src/worker/queue.ts            sendMessage, receiveMessage, deleteMessage helpers
src/worker/processor.ts        processJob() — phase orchestration, state updates
src/worker/worker.ts           polling loop (long-poll SQS, calls processor)
```

### Files to update

```
src/services/ticketService.ts       add SQS enqueue + deleteTask rollback (AC5)
src/repositories/taskRepositories.ts  add updateTask() helper (worker needs it)
src/config/env.ts                   add SQS_QUEUE_URL, AWS_* to Zod schema
docker-compose.yml                  add localstack service
.env                                add SQS_QUEUE_URL=http://localhost:4566/...
```

### Full POST /tickets flow with SQS (all 5 ACs)

```
controller: Zod validate                           [AC4]
service: createTask → Postgres                     [AC3]
service: SQS.sendMessage({ taskId })               [AC5]
  ✗ fails → deleteTask → 500 (no orphaned rows)    [AC5 rollback]
  ✓ success → return 202 immediately               [AC1 + AC2]
```

### Worker flow (US-2.1)

```
worker.ts polls SQS (long-poll, 20s wait)
processor.ts:
  1. getTask from Postgres
  2. guard: terminal state → discard message
  3. updateTask({ state: "processing" })           [US-2.1 AC4]
  4. runPhase1 → Anthropic (Epic 3)
  5. runPhase2 → Anthropic (Epic 4)
  6. deleteMessage from SQS on success
  failure → visibility timeout → SQS auto-retries
  maxReceiveCount (3) → DLQ → needs_manual_review or completed_with_fallback
```

### State machine

```
[pending] → Worker picks up → [processing]
  [processing] phase_1 fails × 3 → [needs_manual_review]
  [processing] phase_1 ok → phase_2
    phase_2 fails × 3 → [completed_with_fallback]
    phase_2 ok → [completed]
```

---

## Commits Made

| Hash      | Message                                                            |
| --------- | ------------------------------------------------------------------ |
| `f388a1f` | feat(tickets): add ticket ingestion endpoint with task persistence |
| `3036895` | feat(tasks): add task status endpoint (US-1.2)                     |

---

## Outstanding Items

- US-1.1 AC5 (queue rollback) — implement with SQS setup
- US-2.1 — SQS + LocalStack + worker (next session)
- US-1.2 AC2–AC6 — testable only after worker built

---

## Full Architecture Diagram (US-1.1 + US-1.2 + US-2.1 with SQS)

### Infrastructure (Docker)

```
┌─────────────────────────────────────────────────────────┐
│                    docker-compose                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  PostgreSQL  │  │  LocalStack  │  │   pgAdmin    │  │
│  │  port: 5432  │  │  port: 4566  │  │  port: 8080  │  │
│  │              │  │  service:sqs │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘

Node processes (run separately, NOT in docker-compose):
  npm run dev:server  →  API Server  (port 3000)
  npm run dev:worker  →  Worker      (polls SQS)
```

---

### POST /tickets — Full Flow (all 5 ACs)

```
CLIENT
  │  POST /tickets { subject, body, customer, metadata }
  ▼
app.ts
  └── app.use("/tickets", ticketsRouter)
         │
         ▼
  ticketsRouter.ts
  └── POST "/" → submitTickets() [controller]
         │
         ▼
  ticketsController.ts
         │
         ├─── STEP 1: Zod validate req.body             [AC4]
         │    TicketSchema.safeParse(req.body)
         │    ✗ invalid → 400 { error, details }
         │    ✓ valid → call ticketService.submitTicket()
         │
         └─── ticketService.submitTicket(ticketData)
                │
                ├─── STEP 2: createTask(ticketData)     [AC3]
                │    → taskRepositories → prisma.task.create()
                │    → PostgreSQL: INSERT Task row
                │      { id: uuid, state: "pending",
                │        inputTicket: {...} }
                │
                ├─── STEP 3: SQS.sendMessage            [AC5 — NEW]
                │    sqsClient.send(SendMessageCommand({
                │      QueueUrl: QUEUE_URL,
                │      MessageBody: JSON.stringify({ taskId })
                │    }))
                │    ✗ throws:
                │    │   deleteTask(task.id)             [AC5 rollback]
                │    │   → Postgres DELETE Task row
                │    │   → 500 { error: "Failed to enqueue" }
                │    ✓ success → continue
                │
                └─── STEP 4: return 202                 [AC1 + AC2]
                     { task_id, state: "pending",
                       status_url: "/tasks/${task.id}" }
                     ← response ~50ms, before any AI runs
```

---

### Worker Flow (US-2.1 — separate process)

```
LOCALSTACK SQS
  │  (Worker long-polls every 20s)
  ▼
worker/worker.ts  [npm run dev:worker]
  └── SQS.receiveMessage()
         │
         ▼
  worker/processor.ts: processJob({ taskId })
         │
         ├─── getTask(taskId) from Postgres
         │
         ├─── GUARD: terminal state check
         │    state ∈ { completed, completed_with_fallback,
         │              needs_manual_review }
         │    → SQS.deleteMessage() + return (discard duplicate)
         │
         ├─── updateTask({                              [US-2.1 AC4]
         │      state: "processing",
         │      currentPhase: "phase_1"
         │    })
         │
         ├─── PHASE 1: AI Triage (Epic 3 — future)
         │    if !phase1Done:
         │      updateTask({ phase1Retries: +1 })
         │      runPhase1(inputTicket) → Anthropic API
         │      ✗ throws → visibility timeout → SQS retries
         │      ✓ updateTask({
         │          phase1Output: result,
         │          phase1Done: true,
         │          currentPhase: "phase_2"
         │        })
         │
         ├─── PHASE 2: AI Resolution (Epic 4 — future)
         │    if !phase2Done:
         │      updateTask({ phase2Retries: +1 })
         │      runPhase2(inputTicket, phase1Output) → Anthropic
         │      ✗ throws → visibility timeout → SQS retries
         │      ✓ updateTask({
         │          phase2Output: result,
         │          phase2Done: true,
         │          state: "completed",
         │          currentPhase: null,
         │          stateChangedAt: new Date()
         │        })
         │
         └─── SQS.deleteMessage() ← only on full success
```

### SQS Retry & DLQ

```
Worker throws
  └── visibility timeout expires (e.g. 30s)
        └── SQS makes message visible again
              └── Worker picks up
                    └── phase1Done/phase2Done flags skip completed phases

maxReceiveCount reached (3 attempts)
  └── SQS moves to Dead Letter Queue (DLQ)
        └── DLQ listener:
              !phase1Done → updateTask({ state: "needs_manual_review",
                                        fallbackReason, fallbackAt })
               phase1Done → updateTask({ state: "completed_with_fallback",
                                        fallbackReason, fallbackAt })
```

---

### GET /tasks/:taskId Flow (US-1.2)

```
CLIENT polls status_url after POST
  │  GET /tasks/cda06056-e081-4df4-bb6a-1376310b3853
  ▼
app.ts → tasksRouter → getTaskStatus() [controller]
  │
  ├─── Zod validate taskId as UUID
  │    ✗ invalid → 400
  │
  └─── taskService.getTaskById(taskId)
         │
         ├─── getTask(taskId) → Postgres
         │    ✗ null → 404
         │
         ├─── buildOutputs(task):
         │    pending                      → null
         │    processing + phase_1 running → null
         │    processing + phase_1 done    → { phase_1: data, phase_2: null }
         │    completed                    → { phase_1: data, phase_2: data }
         │    completed_with_fallback      → { phase_1: data, phase_2: fallback }
         │    needs_manual_review          → { phase_1: null, phase_2: null }
         │
         ├─── buildFallbackInfo(task):
         │    fallbackReason set  → { reason, fallback_at }
         │    fallbackReason null → null
         │
         └─── 200 {
                task_id, state, current_phase,
                retry_count: { phase_1, phase_2 },
                created_at, state_changed_at, last_mutated_at,
                outputs, input_ticket, fallback_info
              }
```

---

### State Machine (Task in PostgreSQL)

```
         POST /tickets
               │
               ▼
           [pending]
               │
        Worker picks up (US-2.1)
               │
               ▼
         [processing]
         currentPhase: phase_1
               │
     ┌─────────┴──────────┐
  P1 fails              P1 ok
  (retries × 3)             │
       │              currentPhase: phase_2
       ▼                    │
[needs_manual_review]  ┌────┴────┐
                   P2 fails   P2 ok
                   (retries×3)    │
                       │          ▼
                       ▼      [completed]
          [completed_with_fallback]
```

---

### Full Data Flow Summary

```
Client
  ├── POST /tickets
  │     controller → service → repository → Postgres (create)
  │                          → config/sqs  → LocalStack SQS (enqueue)
  │                          ← 202 response (~50ms)
  │
  │     Worker (separate Node process)
  │       worker.ts  → SQS (long-poll)
  │       processor.ts → repository → Postgres (update state)
  │                    → Anthropic AI phase 1
  │                    → repository → Postgres (phase1Output)
  │                    → Anthropic AI phase 2
  │                    → repository → Postgres (phase2Output, completed)
  │
  └── GET /tasks/:id
        controller → service → repository → Postgres (read)
        ← 200 { state, outputs, fallback_info, ... }
```
