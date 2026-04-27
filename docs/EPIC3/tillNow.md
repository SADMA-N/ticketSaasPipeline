# Architecture — Epic 1 + Epic 2 + Epic 3 (All ACs)

---

## US-3.1 — How Each AC Connects in the Codebase

```
AC1: runPhase1() returns all 6 fields
──────────────────────────────────────
src/worker/processor.ts: processJob()
  └── runPhase1(task.inputTicket)
        └── src/worker/phase1.ts
              └── portkey.chat.completions.create({
                    tools: [classify_ticket function schema],
                    tool_choice: { type: "function", name: "classify_ticket" }
                  })
                  → src/config/portkey.ts (Portkey client)
                  → Portkey gateway (portkey.ai)
                  → Gemini API (gemini-2.0-flash) [fallback: Groq]
                  ← tool_calls[0].function.arguments
                  → Phase1OutputSchema.parse()
                  ← { category, priority, sentiment,
                       escalation_flag, routing_target, summary }         ✅ AC1


AC2: Structured output — not free prose
─────────────────────────────────────────
src/worker/phase1.ts
  └── Phase1OutputSchema = z.object({
        category, priority (enum), sentiment (enum),
        escalation_flag (boolean), routing_target, summary
      })
      tool_choice forces function calling → guaranteed JSON schema
      Zod validates before returning                                       ✅ AC2


AC3: Parse failure → throw → SQS retry
─────────────────────────────────────────
src/worker/phase1.ts
  ├── !toolCall || !("function" in toolCall) → throw
  └── Phase1OutputSchema.parse() → ZodError if fields missing

src/worker/worker.ts
  └── catch(err) → no deleteMessage
        → visibility timeout → SQS retries automatically                  ✅ AC3


AC4: Persist before Phase 2
─────────────────────────────
src/worker/processor.ts
  └── updateTask(taskId, {
        phase1Output: phase1Output,   ← Postgres JSON field
        phase1Done: true,             ← checkpoint
        currentPhase: "phase_2",
      })
      THEN → Phase 2 check runs                                            ✅ AC4


AC5: Visible in GET /tasks/:id
────────────────────────────────
src/services/taskService.ts: buildOutputs()
  └── phase1Done && !phase2Done
        → { phase_1: task.phase1Output, phase_2: null }                   ✅ AC5
```

---

## Full Architecture — Epic 1 + Epic 2 + Epic 3, All ACs

```
┌──────────────────────────────────────────────────────────────────────┐
│                       DOCKER (docker-compose)                         │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐  │
│  │   PostgreSQL     │  │  LocalStack SQS   │  │    pgAdmin       │  │
│  │   port: 5432     │  │  port: 4566       │  │   port: 8080     │  │
│  │   task table     │  │  ticket-queue     │  │                  │  │
│  └────────┬─────────┘  └────────┬──────────┘  └──────────────────┘  │
└───────────│────────────────────│─────────────────────────────────────┘
            │                    │
     ┌──────┘                    └──────────────┐
     ▼                                          ▼
┌─────────────────────────────┐   ┌─────────────────────────────────────┐
│   npm run dev:server        │   │      npm run dev:worker             │
│   API Server (port 3000)    │   │      Worker process                 │
│                             │   │                                     │
│  POST /tickets              │   │  worker.ts: poll()                  │
│  ──────────────             │   │  ─────────────────                  │
│  app.ts                     │   │  receiveMessages()                  │
│  └─ ticketsRouter           │   │    └─ queue.ts → SQS long-poll 20s  │
│       └─ ticketsCtrl        │   │                                     │
│            │                │   │  for each message:                  │
│  [US-1.1 AC4]               │   │    processJob(taskId, handle)       │
│  Zod validate body          │   │    └─ processor.ts                  │
│            │                │   │         │                           │
│  [US-1.1 AC3]               │   │  [US-2.1 AC4]                      │
│  createTask()               │   │  getTask() → Postgres               │
│  └─ taskRepositories        │   │  GUARD: terminal? → discard         │
│  └─ Postgres INSERT         │   │  updateTask({                       │
│     { state: pending }      │   │    state: "processing",             │
│            │                │   │    currentPhase: "phase_1"          │
│  [US-1.1 AC5]               │   │  })                                 │
│  SQS.sendMessage()          │   │         │                           │
│  └─ config/sqs.ts           │   │  [US-3.1 AC4]                      │
│  └─ LocalStack enqueue      │   │  phase1Retries +1                   │
│    ✗ → deleteTask → 500     │   │  runPhase1(inputTicket)             │
│    ✓ → continue             │   │    └─ phase1.ts                     │
│            │                │   │         └─ portkey.chat.completions │
│  [US-1.1 AC1+AC2]           │   │              .create({ tools: [...],│
│  return 202 {               │   │               tool_choice: fn })    │
│    task_id,                 │   │              → config/portkey.ts    │
│    state: "pending",        │   │              → Portkey gateway      │
│    status_url               │   │              → Gemini (fallback:    │
│  }                          │   │                Groq)                │
│                             │   │         └─ Phase1OutputSchema.parse │
│  GET /tasks/:taskId         │   │         ✗ throws → SQS retry [AC3] │
│  ─────────────────          │   │         ✓ updateTask({              │
│  app.ts                     │   │              phase1Output,          │
│  └─ tasksRouter             │   │              phase1Done: true,      │
│       └─ tasksCtrl          │   │              currentPhase: phase_2  │
│            │                │   │            }) [AC4]                 │
│  [US-1.2 AC1]               │   │         │                           │
│  Zod validate UUID          │   │  [stub] phase2Retries +1            │
│  ✗ invalid → 400            │   │  TODO: runPhase2() ← Epic 4         │
│            │                │   │         │                           │
│  getTaskById()              │   │  ✓ deleteMessage()                  │
│  └─ taskService.ts          │   │  ✗ throw → SQS retry                │
│       │                     │   │                                     │
│  getTask() → Postgres       │   │  [US-2.1 AC3]                      │
│  ✗ null → 404               │   │  runs fully independent             │
│       │                     │   │  of API server                      │
│  buildOutputs(task)         │   └─────────────────────────────────────┘
│  ┌──────────────────────┐   │
│  │ pending     → null   │   │   ┌──────────────────────────────────┐
│  │ processing+!p1 → null│   │   │   Portkey Dashboard (portkey.ai) │
│  │ p1Done+!p2Done →     │   │   │   ─────────────────────────────  │
│  │  {p1:data, p2:null}  │   │   │   Config: ticket-pipeline        │
│  │ completed →          │   │   │   Target 1: gemini (Gemini API)  │
│  │  {p1:data, p2:data}  │   │   │   Target 2: groq (fallback)      │
│  │ c_w_fallback →       │   │   │   Strategy: fallback             │
│  │  {p1:data, p2:msg}   │   │   └──────────────────────────────────┘
│  │ needs_review →       │   │
│  │  {p1:null, p2:null}  │   │
│  └──────────────────────┘   │
│       │                     │
│  buildFallbackInfo()        │
│  200 { task_id, state,      │
│    current_phase,           │
│    retry_count,             │
│    outputs,                 │
│    input_ticket,            │
│    fallback_info }          │
└─────────────────────────────┘


STATE MACHINE (Postgres task.state)
─────────────────────────────────────

POST /tickets
      │
  [pending]  ← createTask() — US-1.1
      │
  Worker picks up (US-2.1)
      │
  [processing]                         ← current state after US-3.1
  currentPhase: phase_1
      │
  runPhase1() → Portkey → Gemini       ← US-3.1
      │
  phase1Done: true
  phase1Output: { category, priority,
                  sentiment, escalation_flag,
                  routing_target, summary }
  currentPhase: phase_2
      │
  ┌───┴────────────────────────┐
  P1 fails × 3 (Epic 3+5)    P1 ok ← here now
      │                   currentPhase: phase_2
      ▼                        │
[needs_manual_review]    ┌─────┴──────┐
                    P2 fails × 3   P2 ok
                    (Epic 4+5)   (Epic 4)
                         │           │
                         ▼           ▼
             [completed_with_    [completed]
              fallback]


DATA FLOW SUMMARY
──────────────────

Client
  ├── POST /tickets { subject, body, customer }
  │     → ticketsController → ticketService
  │     → taskRepositories → Postgres (INSERT, state: pending)
  │     → config/sqs → LocalStack SQS (enqueue taskId)
  │     ← 202 { task_id, state: pending, status_url }
  │
  │     Worker (separate process)
  │       → queue.ts → LocalStack SQS (long-poll)
  │       → processor.ts → taskRepositories → Postgres (state: processing)
  │       → phase1.ts → config/portkey.ts → Portkey → Gemini
  │       ← { category, priority, sentiment, escalation_flag,
  │            routing_target, summary }
  │       → taskRepositories → Postgres (phase1Output, phase1Done: true)
  │
  └── GET /tasks/:id
        → tasksController → taskService
        → taskRepositories → Postgres (read)
        → buildOutputs() → { phase_1: {...}, phase_2: null }
        ← 200 { task_id, state, current_phase, retry_count,
                outputs, input_ticket, fallback_info }
```



---

## phase_2_started Event — How It Works

```
WHAT IS IT?
────────────
Node.js built-in pub/sub (EventEmitter).
One place fires ("emit"), other places react ("on/listen").
No network. In-process only. Zero latency.


WHERE EACH FILE LIVES
──────────────────────
src/worker/workerEvents.ts   ← singleton EventEmitter instance
src/worker/processor.ts      ← emits "phase_2_started" after Phase 1 persists
src/worker/worker.ts         ← listens, logs the event


FLOW (in-process, same worker Node process)
────────────────────────────────────────────

processor.ts: processJob()
  │
  ├── runPhase1(inputTicket)             ← Portkey → Gemini
  │     └── returns Phase1Output
  │
  ├── updateTask({                       ← Postgres write (AC4)
  │     phase1Output,
  │     phase1Done: true,
  │     currentPhase: "phase_2",
  │   })
  │
  └── workerEvents.emit(                 ← event fired HERE
        "phase_2_started",
        { taskId }
      )
           │
           │   (EventEmitter dispatches synchronously)
           │
           ▼
worker.ts listener (registered before poll()):
  workerEvents.on("phase_2_started", ({ taskId }) => {
    console.log(`[event] phase_2_started — taskId: ${taskId}`)
  })
           │
           ▼
  Terminal output:
  [event] phase_2_started — taskId: <uuid>


WHY LISTENER MUST BE BEFORE poll()
────────────────────────────────────
poll() runs while(true) → never returns.
Any code after poll() is unreachable.
Listener registered before poll() → always active when event fires.

  ✗ WRONG:           ✓ CORRECT:
  poll();            workerEvents.on("phase_2_started", ...)
  workerEvents.on()  poll();
  ↑ never reached


PORTKEY ROUTING (inside runPhase1)
────────────────────────────────────
.env → PORTKEY_API_KEY + PORTKEY_CONFIG_ID
  → env.ts → config object
  → portkey.ts → Portkey client singleton
  → phase1.ts → portkey.chat.completions.create()
  → Portkey gateway (portkey.ai)
      ├── Try: Gemini (gemini-2.0-flash)   ← primary
      └── Fail → Try: Groq (llama-3.3-70b) ← fallback
  ← tool_calls[0].function.arguments
  → Phase1OutputSchema.parse()
  ← Phase1Output { category, priority, sentiment,
                   escalation_flag, routing_target, summary }
```