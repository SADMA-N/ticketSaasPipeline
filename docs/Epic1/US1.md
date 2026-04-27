# Epic 1 — Ticket Intake & Task State API

## US-1.1 — POST /tickets (All 5 ACs Complete)

### AC Flow

```
POST /tickets
  │
  ├─ [AC4] Zod validates request body
  │         TicketSchema.safeParse(req.body)
  │         ✗ invalid → 400 { error, details }
  │
  ├─ [AC3] createTask() → Postgres INSERT
  │         state: "pending", inputTicket: { subject, body, customer, metadata }
  │
  ├─ [AC5] SQS.sendMessage({ taskId }) → LocalStack queue
  │         ✗ fails → deleteTask(task.id) rollback → 500 { error: "Failed to enqueue task" }
  │         ✓ success → continue
  │
  └─ [AC1 + AC2] return 202 { task_id, state: "pending", status_url: "/tasks/:id" }
```

### Response Shape (PRD contract)

```json
{
  "task_id": "uuid-v4",
  "state": "pending",
  "status_url": "/tasks/uuid-v4"
}
```

### Files

| File | Purpose |
| ---- | ------- |
| `src/schemas/ticket.ts` | Zod schema for inbound ticket payload |
| `src/repositories/taskRepositories.ts` | `createTask`, `deleteTask`, `getTask` (Prisma wrappers) |
| `src/services/ticketService.ts` | `submitTicket()` — createTask + SQS enqueue + rollback |
| `src/controllers/ticketsController.ts` | Zod validate → call service → 202 |
| `src/routes/ticketsRouter.ts` | `POST /` wired to controller |
| `src/config/sqs.ts` | SQS client singleton (LocalStack endpoint in dev) |
| `src/config/env.ts` | Zod env schema including SQS vars |

### Infrastructure Added

| What | Detail |
| ---- | ------ |
| LocalStack | Docker service, port 4566, emulates AWS SQS |
| SQS queue | `ticket-queue` created in LocalStack (`000000000000` account) |
| Queue URL | `http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/ticket-queue` |
| AWS credentials (dev) | `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test` (LocalStack accepts any value) |

### AC5 Rollback Logic

```
createTask → Postgres (INSERT)
try:
  SQS.sendMessage({ taskId })
catch:
  deleteTask(task.id) → Postgres (DELETE)   ← strict rollback, no orphaned rows
  throw → controller → 500
success:
  return 202
```

---

## US-1.2 — GET /tasks/:taskId (All 8 ACs Code-Complete)

> AC2–AC6 testable only after worker built (US-2.1).

### AC Flow

```
GET /tasks/:taskId
  │
  ├─ [AC1] Zod validates taskId as UUID
  │         ✗ invalid → 400 { error: "Invalid task ID" }
  │
  └─ taskService.getTaskById(taskId)
       │
       ├─ getTask(taskId) → Postgres
       │   ✗ null → 404 { error: "Task not found" }
       │
       ├─ buildOutputs(task) — state gate:
       │   pending                      → null
       │   processing + phase_1 running → null
       │   processing + phase_1 done    → { phase_1: data, phase_2: null }
       │   completed                    → { phase_1: data, phase_2: data }
       │   completed_with_fallback      → { phase_1: data, phase_2: fallback message }
       │   needs_manual_review          → { phase_1: null, phase_2: null }
       │
       ├─ buildFallbackInfo(task):
       │   fallbackReason set  → { reason, fallback_at }
       │   fallbackReason null → null
       │
       └─ 200 {
            task_id, state, current_phase,
            retry_count: { phase_1, phase_2 },
            created_at, state_changed_at, last_mutated_at,
            outputs, input_ticket, fallback_info
          }
```

### Key Design Decisions

- `input_ticket` only exposed when `state === "needs_manual_review"`
- `failed` state never appears in API response (not in `TaskState` enum)
- Zod validates `taskId` param as UUID before DB hit

### Files

| File | Purpose |
| ---- | ------- |
| `src/repositories/taskRepositories.ts` | `getTask` added |
| `src/services/taskService.ts` | `getTaskById()`, `buildOutputs()`, `buildFallbackInfo()` |
| `src/controllers/tasksController.ts` | UUID param validation → call service → 200/404 |
| `src/routes/tasksRouter.ts` | `GET /:taskId` wired to controller |
