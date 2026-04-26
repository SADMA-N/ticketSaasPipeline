# Technical PRD — AI-Powered Support Ticket Processing Pipeline

| Field | Value |
|---|---|
| Status | Draft |
| Version | 1.0 |
| Date | April 23, 2026 |
| Source PRD | AI_Ticket_Pipeline_PRD v2.0 |
| Audience | Backend Engineers |
| ORM | Prisma |
| AI Observability | LangSmith |

---

## 0. Document Purpose

This Technical PRD translates the product requirements from `AI_Ticket_Pipeline_PRD v2.0` into concrete engineering decisions: stack choices, data models, API contracts, component architecture, and implementation guidance per epic. Engineers should read the product PRD first for "why" and this document for "how."

---

## 1. Technology Stack

### 1.1 Core Runtime

| Layer | Technology | Version | Reason |
|---|---|---|---|
| Runtime | Node.js | 20 LTS | Stable LTS, native ESM, good async primitives |
| Language | TypeScript | 5.x | Type safety across API contracts, DB models, queue payloads |
| Framework | Express.js | 4.x | Minimal, familiar, large ecosystem |
| Process Manager | PM2 (prod) / ts-node-dev (dev) | latest | Zero-downtime restarts in prod |

### 1.2 Database & ORM

| Layer | Technology | Notes |
|---|---|---|
| Database | PostgreSQL 15 | ACID compliance, JSONB for ticket payload storage |
| ORM | **Prisma** | Schema-first, type-safe queries, migration management via `prisma migrate` |
| Connection Pooling | PgBouncer (prod) / Prisma direct (dev) | Pool size: 10 connections max |

### 1.3 Queue Infrastructure

| Layer | Technology | Notes |
|---|---|---|
| Queue | AWS SQS (`@aws-sdk/client-sqs`) | Managed queue; SDK already installed; same code works against real AWS in prod |
| Local Dev Broker | LocalStack (Docker, port 4566) | Emulates SQS locally — same Docker pattern as Postgres |
| Worker | Custom Node.js polling loop | Separate process from the API server; long-polls SQS (20s wait) |

> **DLQ Pattern with SQS:** Configure a Dead Letter Queue on the main SQS queue with `maxReceiveCount: 3`. After 3 failed visibility-timeout cycles, SQS automatically moves the message to the DLQ. A dedicated DLQ listener polls the DLQ and transitions task state to `completed_with_fallback` or `needs_manual_review` based on `phase1Done` checkpoint in Postgres.

### 1.4 Real-Time

| Layer | Technology | Notes |
|---|---|---|
| WebSockets | Socket.io 4.x | Namespaces per ticket, automatic reconnect, rooms per `task_id` |
| Transport | WebSocket with HTTP long-poll fallback | Covers clients that block WebSocket |

### 1.5 AI Integration

| Layer | Technology | Notes |
|---|---|---|
| AI Provider | Anthropic Claude (`claude-3-5-sonnet-20241022`) | Structured output via `tool_use` for schema enforcement |
| AI SDK | `@anthropic-ai/sdk` | Official Node SDK |
| AI Observability | **LangSmith** | Trace every LLM call — phase, input, output, latency, token counts |
| Schema Validation | Zod | Validates AI JSON output before persisting; parse failures = phase failure |

> **LangSmith Integration:** Wrap every Anthropic call in a LangSmith `traceable()` run. Tag runs with `task_id`, `phase`, and `attempt_number`. This enables per-task trace replay in the LangSmith UI.

### 1.6 Logging & Observability

| Layer | Technology | Notes |
|---|---|---|
| Structured Logger | Pino | JSON output, `task_id` bound via child logger for every request |
| Log Transport (prod) | Pino + stdout → log aggregator (e.g., Logtail, Datadog) | No file logging in containers |
| Tracing (AI) | LangSmith | AI-specific traces only — not a general APM |

### 1.7 Validation & Config

| Layer | Technology | Notes |
|---|---|---|
| Runtime Validation | Zod | API request bodies, AI output schemas, env var parsing |
| Env Config | `zod` + `dotenv` | Fail-fast on startup if required env vars missing |

### 1.8 Dev Tooling

| Tool | Purpose |
|---|---|
| Docker + docker-compose | Local Postgres + LocalStack (SQS) in one command |
| ESLint + Prettier | Code style, enforced in CI |
| Vitest | Unit and integration tests |
| Supertest | HTTP endpoint integration tests |

---

## 2. Project Structure

> **Implementation note:** Actual structure uses layered MVC — `app.ts → routes/ → controllers/ → services/ → repositories/`. No `src/api/` or `src/db/` directories.

```
src/
├── app.ts                         # Express bootstrap, route mounting, error handlers
├── routes/
│   ├── ticketsRouter.ts           # POST /tickets
│   └── tasksRouter.ts             # GET /tasks/:taskId
├── controllers/
│   ├── ticketsController.ts       # submitTickets handler (Zod validate → service)
│   └── tasksController.ts         # getTaskStatus handler (Zod validate → service)
├── services/
│   ├── ticketService.ts           # submitTicket() — createTask + SQS enqueue
│   └── taskService.ts             # getTaskById() — fetch + buildOutputs + buildFallbackInfo
├── repositories/
│   └── taskRepositories.ts        # createTask, deleteTask, getTask, updateTask (Prisma)
├── worker/
│   ├── queue.ts                   # sendMessage, receiveMessage, deleteMessage (SQS helpers)
│   ├── processor.ts               # processJob() — phase orchestration + state updates
│   └── worker.ts                  # Polling loop entrypoint (separate process)
├── phases/
│   ├── phase1.ts                  # AI triage call + Zod validation
│   └── phase2.ts                  # AI resolution call + Zod validation
├── ai/
│   ├── client.ts                  # Anthropic SDK singleton
│   ├── prompts.ts                 # Phase 1 + Phase 2 prompt builders
│   └── langsmith.ts               # LangSmith traceable wrappers
├── socket/
│   └── emitter.ts                 # Socket.io event emitter with typed events
├── lib/
│   └── prisma.ts                  # PrismaClient singleton
├── schemas/
│   ├── ticket.ts                  # Inbound ticket Zod schema
│   ├── phase1Output.ts            # Phase 1 AI output Zod schema
│   └── phase2Output.ts            # Phase 2 AI output Zod schema
├── config/
│   ├── env.ts                     # Zod env schema + parsed config object
│   └── sqs.ts                     # SQS client singleton (LocalStack in dev)
├── types/
│   └── index.ts                   # Shared TypeScript types
└── logger.ts                      # Pino logger singleton

prisma/
├── schema.prisma
└── migrations/

docker-compose.yml
.env
```

---

## 3. Database Schema (Prisma)

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum TaskState {
  pending
  processing
  completed
  completed_with_fallback
  needs_manual_review
}

model Task {
  id              String      @id @default(uuid())
  state           TaskState   @default(pending)

  // Phase tracking
  currentPhase    String?                           // "phase_1" | "phase_2" | null
  phase1Retries   Int         @default(0)
  phase2Retries   Int         @default(0)
  phase1Done      Boolean     @default(false)       // checkpoint: phase 1 succeeded
  phase2Done      Boolean     @default(false)       // checkpoint: phase 2 succeeded

  // Stored input
  inputTicket     Json                              // always stored at creation

  // Outputs (populated progressively)
  phase1Output    Json?                             // populated after Phase 1 succeeds
  phase2Output    Json?                             // populated after Phase 2 succeeds

  // Fallback metadata
  fallbackReason  String?
  fallbackAt      DateTime?

  // Timestamps
  createdAt       DateTime    @default(now())
  stateChangedAt  DateTime    @default(now())
  lastMutatedAt   DateTime    @default(now()) @updatedAt

  @@index([state])
  @@index([createdAt])
}
```

> **Design Notes:**
> - `phase1Done` / `phase2Done` are the phase-level checkpoints. When the worker picks up a job, it reads these flags to resume from the last successful phase — never re-running a completed phase.
> - `inputTicket` is stored as JSONB at creation time, always — not only on failure.
> - `lastMutatedAt` uses Prisma's `@updatedAt` — it changes whenever any field changes, enabling polling clients to detect Phase 1 output availability without a state change.
> - `stateChangedAt` is updated manually only on `state` transitions.
> - `fallbackReason` and `fallbackAt` map to the `fallback_info` object in the API response.

---

## 4. API Contract (Implementation Detail)

### 4.1 POST `/tickets` — Submit Ticket

**Request Body (Zod schema):**
```typescript
const TicketSchema = z.object({
  subject:  z.string().min(1).max(500),
  body:     z.string().min(1).max(10000),
  customer: z.object({
    id:    z.string(),
    email: z.string().email(),
  }),
  metadata: z.record(z.unknown()).optional(),
});
```

**Success Response — `202 Accepted`:**
```json
{
  "task_id": "uuid-v4",
  "state": "pending",
  "status_url": "/tasks/uuid-v4"
}
```

**Transactional Guarantee:** Both the Prisma `task.create` and the BullMQ `queue.add` must succeed before responding 202. If `queue.add` throws after `task.create`, call `task.delete` to roll back before returning `500`. This prevents orphaned `pending` records.

```typescript
// Pseudo-code — api/routes/tickets.ts
const task = await prisma.task.create({ data: { inputTicket, state: 'pending' } });
try {
  await ticketQueue.add('process', { taskId: task.id }, { jobId: task.id });
} catch (err) {
  await prisma.task.delete({ where: { id: task.id } }); // strict rollback
  throw new Error('Queue enqueue failed');
}
res.status(202).json({ task_id: task.id, state: 'pending', status_url: `/tasks/${task.id}` });
```

**Error Responses:**
| Condition | Status | Body |
|---|---|---|
| Validation failure | `400` | `{ error: "Validation failed", details: ZodError.issues }` |
| Enqueue failure | `500` | `{ error: "Failed to enqueue task" }` |

---

### 4.2 GET `/tasks/:taskId` — Query Task Status

**Success Response — `200 OK`** (mapped from DB model to API contract):

```typescript
// Mapping layer — db/tasks.ts
function toApiResponse(task: Task): TaskStatusResponse {
  return {
    task_id:         task.id,
    state:           task.state,
    current_phase:   task.currentPhase,
    retry_count:     { phase_1: task.phase1Retries, phase_2: task.phase2Retries },
    created_at:      task.createdAt,
    state_changed_at: task.stateChangedAt,
    last_mutated_at: task.lastMutatedAt,
    outputs:         buildOutputs(task),
    input_ticket:    task.state === 'needs_manual_review' ? task.inputTicket : null,
    fallback_info:   buildFallbackInfo(task),
  };
}
```

**`buildOutputs` logic:**
```typescript
function buildOutputs(task: Task) {
  if (task.state === 'pending') return null;
  if (task.state === 'processing' && !task.phase1Done) return null;
  if (task.state === 'needs_manual_review') return { phase_1: null, phase_2: null };

  // Phase 1 available, phase 2 still running
  if (task.phase1Done && !task.phase2Done) {
    return { phase_1: task.phase1Output, phase_2: null };
  }

  // completed — both phases succeeded
  if (task.state === 'completed') {
    return { phase_1: task.phase1Output, phase_2: task.phase2Output };
  }

  // completed_with_fallback — phase 2 AI failed
  if (task.state === 'completed_with_fallback') {
    return {
      phase_1: task.phase1Output,
      phase_2: {
        response_draft: null,
        internal_note: "Automated resolution draft could not be generated. Manual review required.",
        next_actions: null,
      },
    };
  }
  return null;
}
```

**Error Responses:**
| Condition | Status |
|---|---|
| Unknown `taskId` | `404` |
| DB error | `500` |

---

## 5. Queue & Worker Architecture

### 5.1 Queue Configuration (SQS)

```typescript
// config/sqs.ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from './env.js';

export const sqsClient = new SQSClient({
  region: config.AWS_REGION,
  endpoint: config.SQS_ENDPOINT,   // http://localhost:4566 in dev (LocalStack)
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
});
```

> **Phase-level retry vs SQS retry:** SQS retries operate via visibility timeout — if the worker throws without calling `deleteMessage`, the message becomes visible again after the timeout expires. Phase-level idempotency is achieved via `phase1Done` / `phase2Done` checkpoints in Postgres. On retry, the worker reads these flags and skips already-completed phases. Per-phase retry counts (`phase1Retries`, `phase2Retries`) are incremented manually in Postgres before each attempt — not derived from SQS.

### 5.2 Worker Flow

```typescript
// worker/worker.ts — polling loop
import { receiveMessages, deleteMessage } from './queue.js';
import { processJob } from './processor.js';

async function poll() {
  while (true) {
    const messages = await receiveMessages();   // long-poll, 20s wait
    for (const msg of messages) {
      const { taskId } = JSON.parse(msg.Body!);
      try {
        await processJob(taskId);
        await deleteMessage(msg.ReceiptHandle!); // only on success
      } catch (err) {
        // do NOT deleteMessage — visibility timeout → SQS auto-retries
      }
    }
  }
}
poll();

// worker/processor.ts — phase orchestration
export async function processJob(taskId: string) {
  const task = await getTask(taskId);

  // Idempotency guard — discard if already terminal
  const TERMINAL = ['completed', 'completed_with_fallback', 'needs_manual_review'];
  if (TERMINAL.includes(task.state)) return;

  await updateTask(taskId, { state: 'processing', currentPhase: 'phase_1' });

  // ── Phase 1 ──────────────────────────────────────
  if (!task.phase1Done) {
    await updateTask(taskId, { phase1Retries: { increment: 1 } });
    const phase1Result = await runPhase1(task.inputTicket);  // throws on failure
    await updateTask(taskId, { phase1Output: phase1Result, phase1Done: true, currentPhase: 'phase_2' });
  }

  // ── Phase 2 ──────────────────────────────────────
  const freshTask = await getTask(taskId);
  if (!freshTask.phase2Done) {
    await updateTask(taskId, { phase2Retries: { increment: 1 } });
    const phase2Result = await runPhase2(freshTask.inputTicket, freshTask.phase1Output);
    await updateTask(taskId, {
      phase2Output: phase2Result, phase2Done: true,
      state: 'completed', currentPhase: null, stateChangedAt: new Date(),
    });
  }
}
```

### 5.3 DLQ Handler

```typescript
// worker/dlqWorker.ts — polls Dead Letter Queue
export async function processDLQMessage(taskId: string, errorReason: string) {
  const task = await getTask(taskId);

  if (!task.phase1Done) {
    // Phase 1 never succeeded → needs_manual_review
    await updateTask(taskId, {
      state: 'needs_manual_review', currentPhase: null,
      fallbackReason: errorReason, fallbackAt: new Date(), stateChangedAt: new Date(),
    });
  } else {
    // Phase 1 ok, Phase 2 failed → completed_with_fallback
    await updateTask(taskId, {
      state: 'completed_with_fallback', currentPhase: null,
      fallbackReason: errorReason, fallbackAt: new Date(), stateChangedAt: new Date(),
    });
  }
}
```

---

## 6. AI Phase Implementation

### 6.1 Phase 1 — Ticket Triage

**Anthropic call pattern** (using `tool_use` to enforce structured output):

```typescript
// phases/phase1.ts
import { traceable } from 'langsmith/traceable';
import { anthropic } from '../ai/client';
import { Phase1OutputSchema } from '../schemas/phase1Output';

export const runPhase1 = traceable(
  async (inputTicket: unknown): Promise<Phase1Output> => {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      tools: [{ name: 'triage_ticket', description: '...', input_schema: phase1JsonSchema }],
      tool_choice: { type: 'tool', name: 'triage_ticket' },
      messages: [{ role: 'user', content: buildPhase1Prompt(inputTicket) }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('No tool_use block in Phase 1 response');

    const parsed = Phase1OutputSchema.safeParse(toolUse.input);
    if (!parsed.success) throw new Error(`Phase 1 output invalid: ${parsed.error.message}`);

    return parsed.data;
  },
  { name: 'phase1_triage', metadata: { phase: 'phase_1' } }
);
```

**Phase 1 Zod Output Schema:**
```typescript
// schemas/phase1Output.ts
export const Phase1OutputSchema = z.object({
  category:       z.string(),
  priority:       z.enum(['low', 'medium', 'high', 'critical']),
  sentiment:      z.enum(['positive', 'neutral', 'negative', 'angry']),
  escalation:     z.boolean(),
  routing_target: z.string(),
  summary:        z.string().max(500),
});
export type Phase1Output = z.infer<typeof Phase1OutputSchema>;
```

### 6.2 Phase 2 — Resolution Draft

```typescript
// phases/phase2.ts
export const runPhase2 = traceable(
  async (inputTicket: unknown, phase1Output: Phase1Output): Promise<Phase2Output> => {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      tools: [{ name: 'draft_resolution', description: '...', input_schema: phase2JsonSchema }],
      tool_choice: { type: 'tool', name: 'draft_resolution' },
      messages: [{ role: 'user', content: buildPhase2Prompt(inputTicket, phase1Output) }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('No tool_use block in Phase 2 response');

    const parsed = Phase2OutputSchema.safeParse(toolUse.input);
    if (!parsed.success) throw new Error(`Phase 2 output invalid: ${parsed.error.message}`);

    return parsed.data;
  },
  { name: 'phase2_resolution', metadata: { phase: 'phase_2' } }
);
```

**Phase 2 Zod Output Schema:**
```typescript
// schemas/phase2Output.ts
export const Phase2OutputSchema = z.object({
  response_draft: z.string(),
  internal_note:  z.string(),
  next_actions:   z.array(z.string()).min(1),
});
export type Phase2Output = z.infer<typeof Phase2OutputSchema>;
```

### 6.3 LangSmith Configuration

```typescript
// ai/langsmith.ts
// Set these env vars — LangSmith auto-patches via LANGCHAIN_TRACING_V2
// LANGCHAIN_TRACING_V2=true
// LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
// LANGCHAIN_API_KEY=<your key>
// LANGCHAIN_PROJECT=ai-ticket-pipeline

// Each traceable() call in phase1.ts / phase2.ts automatically creates a LangSmith run.
// Bind task_id to the run via metadata when calling:
//
// runPhase1(ticket, { langsmithExtra: { metadata: { task_id: taskId, attempt: retryCount } } })
```

---

## 7. Socket Event System

### 7.1 Socket.io Setup

```typescript
// socket/emitter.ts
import { Server } from 'socket.io';

let io: Server;

export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    socket.on('subscribe', (taskId: string) => socket.join(`task:${taskId}`));
  });
}

export function emitSocketEvent(
  taskId: string,
  event: SocketEventName,
  metadata: Record<string, unknown> = {}
) {
  const payload: SocketEvent = {
    task_id:   taskId,
    event,
    timestamp: new Date().toISOString(),
    metadata:  Object.keys(metadata).length ? metadata : null,
  };
  io.to(`task:${taskId}`).emit(event, payload);
  logger.info({ ...payload });   // structured log mirrors every socket event
}
```

### 7.2 Valid Event Names (TypeScript enum)

```typescript
export type SocketEventName =
  | 'started'
  | 'phase_1_started'
  | 'phase_1_complete'
  | 'phase_2_started'
  | 'phase_2_complete'
  | 'retry'
  | 'completed'
  | 'completed_with_fallback'
  | 'needs_manual_review';
```

> `success`, `failure`, and `fallback` are **not** valid event names and must not appear anywhere in the codebase.

### 7.3 Client Subscription Flow

```
Client connects to Socket.io
  → emits 'subscribe' with task_id
  → server calls socket.join(`task:<task_id>`)
  → receives all subsequent events for that task
```

---

## 8. Structured Logging

Every log entry must be valid JSON. Use Pino's child logger pattern to bind `task_id` once per job:

```typescript
// worker/processor.ts
const jobLogger = logger.child({ task_id: taskId });

jobLogger.info({ event: 'phase_1_started', phase: 'phase_1' });
jobLogger.info({ event: 'phase_1_complete', phase: 'phase_1', duration_ms: elapsed });
jobLogger.warn({ event: 'retry', phase: 'phase_2', attempt: retryCount, reason: err.message });
jobLogger.info({ event: 'completed', outcome: 'completed', duration_ms: totalElapsed });
```

**Mandatory fields per entry:**

| Field | Always Required | Only When Applicable |
|---|---|---|
| `task_id` | ✅ | |
| `event` | ✅ | |
| `timestamp` | ✅ (Pino adds automatically) | |
| `phase` | | `phase_1_started`, `phase_1_complete`, `phase_2_started`, `phase_2_complete`, `retry` |
| `outcome` | | Terminal events only: `completed`, `completed_with_fallback`, `needs_manual_review` |
| `attempt` | | `retry` events |
| `reason` | | `retry`, `completed_with_fallback`, `needs_manual_review` |
| `duration_ms` | | Terminal events (total processing duration) |

---

## 9. Idempotency Design

Two layers protect against duplicate processing:

1. **SQS message deduplication** — SQS standard queues can deliver a message more than once (at-least-once delivery). The worker-level guard (below) handles this.

2. **Worker terminal-state guard** — On job pickup, the worker reads the task's `state` from Postgres. If already in a terminal state (`completed`, `completed_with_fallback`, `needs_manual_review`), the job is discarded immediately — `deleteMessage` is called and the worker returns without touching outputs.

3. **Phase checkpoints** — `phase1Done` / `phase2Done` flags in Postgres ensure a retry never re-runs a phase that already succeeded. The worker checks these flags before running each phase.

This combination handles duplicate SQS delivery and the crash-recovery case where the worker is restarted mid-job.

---

## 10. Environment Variables

```bash
# .env

# App
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://postgres:testingpassword@localhost:5432/ticket_pipeline

# SQS (LocalStack in dev)
SQS_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/ticket-queue
SQS_ENDPOINT=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# LangSmith
LANGCHAIN_TRACING_V2=true
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
LANGCHAIN_API_KEY=ls__...
LANGCHAIN_PROJECT=ai-ticket-pipeline
```

All variables are validated at startup via Zod:
```typescript
// config/env.ts
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.url(),
  SQS_QUEUE_URL: z.url(),
  SQS_ENDPOINT: z.url(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  ANTHROPIC_API_KEY: z.string(),
});
export const config = EnvSchema.parse(process.env);  // throws on startup if invalid
```

---

## 11. Epic-Level Implementation Plan

### Epic 1 — Ticket Intake, Task State & Status API

**US-1.1 — POST /tickets (AC1–AC4 complete, AC5 deferred to Epic 2)**

Files created:
- `prisma/schema.prisma` — Full `Task` model + `TaskState` enum ✅
- `src/config/env.ts` — Env validation (Zod) ✅
- `src/db/prisma.ts` — PrismaClient singleton (pg adapter) ✅
- `src/db/tasks.ts` — `createTask`, `deleteTask` helpers ✅
- `src/schemas/ticket.ts` — Inbound Zod schema (Zod v4) ✅
- `src/controllers/ticketsController.ts` — `submitTicket` handler ✅
- `src/routes/ticketsRouter.ts` — `POST /` wired to controller ✅
- `src/app.ts` — Express bootstrap, `/tickets` mounted, 404 + error handlers ✅

**US-1.1 AC5 — Strict rollback on queue failure (DEFERRED → Epic 2)**
- Requires BullMQ + ioredis + Redis running
- `deleteTask` helper already exists for rollback
- Wire in Epic 2 when queue infrastructure is added

**US-1.2 — GET /tasks/:taskId ✅**

Files created:
- `src/db/tasks.ts` — added `getTask` helper ✅
- `src/controllers/tasksController.ts` — `getTaskStatus` handler, UUID param validation via Zod ✅
- `src/routes/tasksRouter.ts` — `GET /:taskId` wired to controller ✅
- `src/app.ts` — mounted at `/tasks`, 4-arg global error handler added ✅

**Key decisions:**
- Zod validation inline in controller (not separate middleware)
- `GET /tasks/:taskId` reads directly from Postgres — no caching
- Prisma migration: `npx prisma migrate dev --name init` ✅ done

---

### Epic 2 — Async Queue & Orchestration (SQS + LocalStack)

**Files to create:**
- `src/config/sqs.ts` — SQS client singleton (LocalStack endpoint in dev, real AWS in prod)
- `src/worker/queue.ts` — `sendMessage`, `receiveMessages`, `deleteMessage` SQS helpers
- `src/worker/processor.ts` — Main job processor with phase orchestration
- `src/worker/worker.ts` — Polling loop entrypoint (started as a separate process)

**Files to update:**
- `src/services/ticketService.ts` — add SQS enqueue + `deleteTask` rollback (US-1.1 AC5)
- `src/repositories/taskRepositories.ts` — add `updateTask()` helper (worker needs it)
- `src/config/env.ts` — add SQS env vars to Zod schema
- `docker-compose.yml` — add `localstack` service
- `.env` — add `SQS_QUEUE_URL`, `SQS_ENDPOINT`, `AWS_*` vars

**Key decisions:**
- Worker is a **separate Node.js process** from the API server — started independently via `npm run dev:worker`. They share the same Prisma connection but nothing else.
- Phase checkpoints (`phase1Done`, `phase2Done`) are written to Postgres before each phase completes — if the worker crashes mid-job, the next SQS retry resumes from the correct phase.
- Per-phase retry counters (`phase1Retries`, `phase2Retries`) are incremented in Postgres before each attempt — source of truth for retry counts.
- SQS `deleteMessage` is called **only on full job success**. Any throw leaves the message in flight — visibility timeout expires → SQS makes it visible again → worker retries.
- LocalStack SQS queue must be created before first use: `aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name ticket-queue`

---

### Epic 3 — AI Triage Pipeline (Phase 1)

**Files to create:**
- `src/ai/client.ts` — Anthropic SDK singleton
- `src/ai/prompts.ts` — `buildPhase1Prompt(ticket): string`
- `src/phases/phase1.ts` — `runPhase1()` with LangSmith wrapper
- `src/schemas/phase1Output.ts` — Zod schema + TypeScript type

**Prompt design:**
- Use `tool_use` with `tool_choice: { type: "tool", name: "triage_ticket" }` to force structured output — no regex parsing of freeform text.
- Prompt includes: ticket subject, body, and customer metadata.
- The JSON schema for the tool input maps directly to `Phase1OutputSchema`.

**Validation rule:** If `Phase1OutputSchema.safeParse(toolInput)` fails, throw an error — this triggers BullMQ retry and increments `phase1Retries`.

---

### Epic 4 — AI Resolution Draft Pipeline (Phase 2)

**Files to create:**
- `src/ai/prompts.ts` — `buildPhase2Prompt(ticket, phase1Output): string` (add to existing file)
- `src/phases/phase2.ts` — `runPhase2()` with LangSmith wrapper
- `src/schemas/phase2Output.ts` — Zod schema + TypeScript type

**Prompt design:**
- Phase 2 prompt includes: original ticket + all 6 Phase 1 output fields as structured context.
- Uses `tool_use` with `tool_choice: { type: "tool", name: "draft_resolution" }`.
- The draft is marked as `[DRAFT - For internal review only. Do not send to customer without review.]` in the prompt instructions.

---

### Epic 5 — Failure Recovery & Fallback Handling

**Changes to existing files:**
- `src/worker/queue.ts` — Add `worker.on('failed', ...)` DLQ handler (Section 5.3)
- `src/db/tasks.ts` — Add `fallbackReason` + `fallbackAt` update helpers
- `src/api/routes/tasks.ts` — Ensure `buildFallbackInfo()` and static Phase 2 fallback values are returned correctly per state

**Static fallback string** (source of truth — must be consistent across DB and API response):
```typescript
export const PHASE2_FALLBACK_NOTE =
  "Automated resolution draft could not be generated after multiple attempts. Manual review required.";
```

**Testing approach:** Simulate failures by temporarily replacing `runPhase1` / `runPhase2` with functions that throw, then verify DLQ transitions and final states in the DB.

---

### Epic 6 — Real-Time Delivery & Observability

**Files to create:**
- `src/socket/emitter.ts` — Socket.io server + typed `emitSocketEvent`
- `src/logger.ts` — Pino singleton

**Changes to existing files:**
- `src/api/server.ts` — Mount Socket.io on the HTTP server via `initSocket(httpServer)`
- `src/worker/processor.ts` — Add `emitSocketEvent` calls at all phase milestones

**LangSmith dashboard setup:**
1. Tag all runs with `project: ai-ticket-pipeline` via `LANGCHAIN_PROJECT`
2. Create a saved filter in LangSmith for `metadata.task_id` to replay any task's full AI trace
3. Add `attempt_number` to run metadata to distinguish retry traces from first-attempt traces

---

## 12. docker-compose (Local Dev)

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: testingpassword
      POSTGRES_DB: ticket_pipeline
    ports: ['5432:5432']
    volumes: ['db_data:/var/lib/postgresql/data']

  pg_admin:
    image: dpage/pgadmin4
    ports: ['8080:80']
    environment:
      PGADMIN_DEFAULT_EMAIL: mdsadmansaki6@gmail.com
      PGADMIN_DEFAULT_PASSWORD: testingpassword
    depends_on: [db]

  localstack:
    image: localstack/localstack
    ports: ['4566:4566']
    environment:
      SERVICES: sqs

volumes:
  db_data:
```

> **Node processes run separately (NOT in docker-compose):**
> ```
> npm run dev:server   →  API Server  (port 3000)
> npm run dev:worker   →  Worker      (polls SQS)
> ```

---

## 13. Non-Functional Requirements

| Concern | Target | Notes |
|---|---|---|
| API response time (POST /tickets) | < 200ms p95 | Enqueue is async — no AI processing in request path |
| AI phase timeout | 30s per phase | Set `AbortSignal` on Anthropic SDK call; treat timeout as phase failure |
| Worker concurrency | 5 parallel jobs | Configurable via `WORKER_CONCURRENCY` |
| Queue retry backoff | Exponential: 2s, 4s, 8s | Configurable via `QUEUE_BACKOFF_MS` |
| Max retries per job | 3 attempts | Configurable via `QUEUE_MAX_ATTEMPTS` |
| DB connection pool | Max 10 | Managed by PgBouncer in prod |

---

## 14. Out of Scope

- Authentication / API key management on the intake endpoint (deferred)
- Outbound customer email / messaging (explicitly excluded — see Product PRD Section 4)
- Admin UI or dashboard (no frontend)
- Multi-tenancy (single namespace in this implementation)
- Rate limiting on the intake endpoint (deferred)

---

*This Technical PRD defines how to build the system. All product-level "why" decisions remain in `AI_Ticket_Pipeline_PRD v2.0`.*
