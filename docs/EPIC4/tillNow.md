# Architecture — Epic 1 + Epic 2 + Epic 3 + Epic 4 (All ACs)

---

## Full Architecture — All Epics

```
┌──────────────────────────────────────────────────────────────────────┐
│                       DOCKER (docker-compose)                         │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐  │
│  │   PostgreSQL     │  │  LocalStack SQS   │  │    pgAdmin       │  │
│  │   port: 5432     │  │  port: 4566       │  │   port: 8080     │  │
│  │   task table     │  │  ticket-queue     │  │                  │  │
│  │                  │  │  ticket-queue-dlq │  │                  │  │
│  └────────┬─────────┘  └────────┬──────────┘  └──────────────────┘  │
└───────────│────────────────────│─────────────────────────────────────┘
            │                    │
     ┌──────┘          ┌─────────┴──────────┐
     ▼                 ▼                    ▼
┌──────────────┐  ┌────────────────┐  ┌────────────────────────────────┐
│ npm run      │  │ npm run        │  │ npm run dev:worker             │
│ dev:server   │  │ dev:queues     │  │ Worker process                 │
│ API (3000)   │  │ setup-queues   │  │                                │
│              │  │ .sh (one-time) │  │ worker.ts                      │
│ POST /tickets│  └────────────────┘  │  ├── poll()         main queue │
│ ──────────── │                      │  │     └── receiveMessages()   │
│ ticketsRouter│                      │  │                             │
│ └─ticketsCtrl│                      │  └── pollDlq()        DLQ     │
│      │       │                      │        └── receiveDlqMessages()│
│ [US-1.1 AC4] │                      │                                │
│ Zod validate │                      │  for each msg in main queue:   │
│      │       │                      │    processJob(taskId, handle)  │
│ [US-1.1 AC3] │                      │    └─ processor.ts             │
│ createTask() │                      │         │                      │
│ └─ Postgres  │                      │  [US-2.1 AC4]                  │
│   {pending}  │                      │  getTask() → Postgres          │
│      │       │                      │  GUARD: terminal? → discard    │
│ [US-1.1 AC5] │                      │  updateTask({                  │
│ SQS.send()   │                      │    state: "processing",        │
│  ✗→ delete   │                      │    currentPhase: "phase_1"     │
│  ✓→ continue │                      │  })                            │
│      │       │                      │         │                      │
│ return 202 { │                      │  [US-3.1] PHASE 1              │
│  task_id,    │                      │  phase1Retries >= 3?           │
│  state,      │                      │    → needs_manual_review       │
│  status_url  │                      │  else:                         │
│ }            │                      │    phase1Retries +1            │
│              │                      │    runPhase1(inputTicket)      │
│ GET /tasks/  │                      │    └─ phase1.ts                │
│ :taskId      │                      │         └─ callLLM(ticket)     │
│ ──────────── │                      │              retry: 3 attempts │
│ tasksRouter  │                      │              → Portkey → Gemini│
│ └─ tasksCtrl │                      │         ← Phase1Output         │
│      │       │                      │    updateTask({                │
│ Zod UUID     │                      │      phase1Output,             │
│ ✗ → 400      │                      │      phase1Done: true,         │
│      │       │                      │      currentPhase: "phase_2"   │
│ getTask()    │                      │    })                          │
│ ✗ → 404      │                      │    workerEvents.emit(          │
│      │       │                      │      "phase_2_started"         │
│ buildOutputs │                      │    )                           │
│ ┌──────────┐ │                      │         │                      │
│ │pending   │ │                      │  [US-4.1] PHASE 2              │
│ │→ null    │ │                      │  freshTask = getTask()         │
│ │p1+!p2    │ │                      │  phase2Retries >= 3?           │
│ │→{p1,null}│ │                      │    → completed_with_fallback   │
│ │completed │ │                      │  else:                         │
│ │→{p1,p2}  │ │                      │    phase2Retries +1            │
│ │c_w_fall  │ │                      │    runPhase2(ticket, p1Output) │
│ │→{p1,msg} │ │                      │    └─ phase2.ts                │
│ │n_m_rev   │ │                      │         └─ callLLM(ticket,     │
│ │→{null,   │ │                      │                    triage)     │
│ │  null}   │ │                      │              retry: 3 attempts │
│ └──────────┘ │                      │              → Portkey → Gemini│
│      │       │                      │         ← Phase2Output         │
│ 200 {        │                      │    updateTask({                │
│  task_id,    │                      │      phase2Output,             │
│  state,      │                      │      phase2Done: true,         │
│  outputs,    │                      │      state: "completed"        │
│  ...         │                      │    })                          │
│ }            │                      │         │                      │
└──────────────┘                      │  ✓ deleteMessage()             │
                                      │  ✗ throw → SQS retry           │
                                      │                                │
                                      │  for each msg in DLQ:          │
                                      │    handleDlqMessage()          │
                                      │    └─ dlqHandler.ts            │
                                      │         phase1Done?            │
                                      │           ✓ → completed_with_  │
                                      │               fallback         │
                                      │           ✗ → needs_manual_    │
                                      │               review           │
                                      │         deleteDlqMessage()     │
                                      └────────────────────────────────┘


STATE MACHINE (Postgres task.state)
─────────────────────────────────────────────────────────

POST /tickets
      │
  [pending]  ← createTask() — US-1.1
      │
  Worker picks up (US-2.1)
      │
  [processing]
  currentPhase: phase_1
      │
  phase1Retries >= 3?          runPhase1() → Portkey → Gemini
      │ YES                         │ throws             │ success
      ▼                             ▼                    ▼
[needs_manual_review]     SQS retry (up to 3)    phase1Done: true
                                                  currentPhase: phase_2
                                                  workerEvents.emit("phase_2_started")
                                                        │
                                           phase2Retries >= 3?
                                                 │ YES       │ NO
                                                 ▼           ▼
                                        [completed_with_ runPhase2() → Portkey → Gemini
                                         fallback]          │ throws        │ success
                                                            ▼               ▼
                                                    SQS retry         phase2Done: true
                                                    (up to 3)         state: "completed"

  DLQ (after SQS maxReceiveCount=3):
    phase1Done=false → [needs_manual_review]
    phase1Done=true  → [completed_with_fallback]


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
  │       → queue.ts → LocalStack SQS (long-poll, main queue)
  │       → processor.ts → taskRepositories → Postgres (state: processing)
  │       │
  │       │ PHASE 1
  │       → phase1.ts → callLLM(ticket) → config/portkey.ts → Portkey → Gemini
  │       ← { category, priority, sentiment, escalation_flag,
  │            routing_target, summary }
  │       → taskRepositories → Postgres (phase1Output, phase1Done: true)
  │       → workerEvents.emit("phase_2_started")
  │       │
  │       │ PHASE 2
  │       → phase2.ts → callLLM(ticket, triage) → config/portkey.ts → Portkey → Gemini
  │       ← { response_draft, internal_note, next_actions }
  │       → taskRepositories → Postgres (phase2Output, phase2Done: true, state: completed)
  │       → queue.ts → deleteMessage()
  │
  │     DLQ Worker (same process, parallel)
  │       → queue.ts → LocalStack SQS (long-poll, DLQ)
  │       → dlqHandler.ts → taskRepositories → Postgres
  │         (state: needs_manual_review OR completed_with_fallback)
  │       → queue.ts → deleteDlqMessage()
  │
  └── GET /tasks/:id
        → tasksController → taskService
        → taskRepositories → Postgres (read)
        → buildOutputs() → { phase_1: {...}, phase_2: {...} }
        ← 200 { task_id, state: "completed", current_phase: null,
                outputs: { phase_1: {...}, phase_2: {...} },
                retry_count, created_at, ... }


NEW FILES (Epic 4)
──────────────────
  src/worker/phase2.ts      ← runPhase2() + Phase2OutputSchema + Phase2Error + callLLM()

MODIFIED FILES (Epic 4)
────────────────────────
  src/worker/processor.ts   ← replaced Phase 2 stub with real runPhase2() call
                               + Phase 2 retry limit → completed_with_fallback


PORTKEY ROUTING (same for both phases)
────────────────────────────────────────
  .env → PORTKEY_API_KEY + PORTKEY_CONFIG_ID
    → env.ts → config
    → portkey.ts → Portkey client singleton
    → phase1.ts / phase2.ts → portkey.chat.completions.create()
    → Portkey gateway (portkey.ai)
        ├── Try: Gemini (gemini-2.0-flash)   ← primary
        └── Fail → Try: Groq (llama-3.3-70b) ← fallback
    ← tool_calls[0].function.arguments
    → PhaseNOutputSchema.parse()
    ← structured output
```
