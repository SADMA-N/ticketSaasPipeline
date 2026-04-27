# Architecture — Epic 1 + Epic 2 (All ACs)

---

## US-2.1 — How Each AC Connects in the Codebase

```
AC1: API returns before processing begins
──────────────────────────────────────────
src/app.ts
  └── app.use("/tickets", ticketsRouter)
        └── src/routes/ticketsRouter.ts
              └── POST "/" → submitTickets()
                    └── src/controllers/ticketsController.ts
                          └── submitTicket(ticketData)
                                └── src/services/ticketService.ts
                                      ├── createTask()       ← Postgres write
                                      ├── SQS.sendMessage()  ← queue job
                                      └── return { task_id, state, status_url }
                                                ↑
                                      controller sends 202 HERE
                                      Worker hasn't run yet ✅ AC1


AC2: Queue job created for every successfully ingested ticket
──────────────────────────────────────────────────────────────
src/services/ticketService.ts
  └── sqsClient.send(SendMessageCommand({
        QueueUrl: config.SQS_QUEUE_URL,       ← from src/config/env.ts
        MessageBody: JSON.stringify({ taskId })
      }))
      ↑ sqsClient from src/config/sqs.ts      ← SQSClient pointing at localhost:4566
        ✗ fails → deleteTask() → 500           ← no orphan rows
        ✓ success → message in LocalStack      ✅ AC2


AC3: Worker consumes jobs independently of the API layer
─────────────────────────────────────────────────────────
[Separate process: npm run dev:worker]

src/worker/worker.ts  ← entrypoint
  └── poll() infinite loop
        └── receiveMessages()
              └── src/worker/queue.ts
                    └── sqsClient.send(ReceiveMessageCommand({
                          WaitTimeSeconds: 20   ← long-poll
                        }))
                        returns msg[] from LocalStack SQS

        for each msg:
          parse msg.Body → { taskId }
          processJob(taskId, receiptHandle)     ✅ AC3 (runs in own process)


AC4: Task state updated to reflect processing started
───────────────────────────────────────────────────────
src/worker/processor.ts: processJob()
  │
  ├── getTask(taskId)
  │     └── src/repositories/taskRepositories.ts → prisma.task.findUnique()
  │
  ├── GUARD: state ∈ { completed, completed_with_fallback, needs_manual_review }
  │          → deleteMessage() + return
  │
  ├── updateTask(taskId, {
  │     state: "processing",          ← ✅ AC4
  │     currentPhase: "phase_1",
  │     stateChangedAt: new Date()
  │   })
  │     └── src/repositories/taskRepositories.ts → prisma.task.update()
  │
  ├── updateTask({ phase1Retries: { increment: 1 } })   ← stub, Epic 3 fills this
  └── updateTask({ phase2Retries: { increment: 1 } })   ← stub, Epic 4 fills this

src/worker/worker.ts:
  ✓ processJob done → deleteMessage(receiptHandle)
  ✗ throws → no deleteMessage → visibility timeout → SQS retries
```

---

## Full Architecture — Epic 1 + Epic 2, All ACs

```
┌─────────────────────────────────────────────────────────────────┐
│                     DOCKER (docker-compose)                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │   PostgreSQL    │  │   LocalStack SQS  │  │   pgAdmin     │  │
│  │   port: 5432    │  │   port: 4566      │  │   port: 8080  │  │
│  │   task table    │  │   ticket-queue    │  │               │  │
│  └────────┬────────┘  └────────┬─────────┘  └───────────────┘  │
└───────────│─────────────────────│────────────────────────────────┘
            │                     │
     ┌──────┘                     └──────────┐
     │                                       │
     ▼                                       ▼
┌──────────────────────────┐    ┌────────────────────────────────┐
│   npm run dev:server     │    │      npm run dev:worker        │
│   API Server (port 3000) │    │      Worker process            │
│                          │    │                                │
│  POST /tickets           │    │  worker.ts: poll()             │
│  ──────────────          │    │  ──────────────────────        │
│  app.ts                  │    │  receiveMessages()             │
│  └─ ticketsRouter        │    │    └─ queue.ts → SQS           │
│       └─ ticketsCtrl     │    │         WaitTimeSeconds: 20    │
│            │             │    │                                │
│  [US-1.1 AC4]            │    │  for each message:             │
│  Zod validate body       │    │    processJob(taskId)          │
│            │             │    │    └─ processor.ts             │
│  [US-1.1 AC3]            │    │         │                      │
│  createTask()            │    │ [US-2.1 AC4]                   │
│  └─ taskRepositories     │    │ getTask() → Postgres           │
│  └─ Postgres INSERT      │    │ GUARD: terminal? → discard     │
│     { state: pending }   │    │ updateTask({                   │
│            │             │    │   state: "processing",         │
│  [US-1.1 AC5]            │    │   currentPhase: "phase_1"      │
│  SQS.sendMessage()       │    │ })                             │
│  └─ config/sqs.ts        │    │ → Postgres UPDATE              │
│  └─ LocalStack enqueue   │    │         │                      │
│    ✗ → deleteTask → 500  │    │ [stub] phase1Retries +1        │
│    ✓ → continue          │    │ TODO: runPhase1() ← Epic 3     │
│            │             │    │         │                      │
│  [US-1.1 AC1+AC2]        │    │ [stub] phase2Retries +1        │
│  return 202 {            │    │ TODO: runPhase2() ← Epic 4     │
│    task_id,              │    │         │                      │
│    state: "pending",     │    │ ✓ deleteMessage()              │
│    status_url            │    │ ✗ throw → SQS retry            │
│  }                       │    │                                │
│                          │    │ [US-2.1 AC3]                   │
│  GET /tasks/:taskId      │    │ runs fully independent         │
│  ─────────────────       │    │ of API server                  │
│  app.ts                  │    └────────────────────────────────┘
│  └─ tasksRouter          │
│       └─ tasksCtrl       │
│            │             │
│  [US-1.2 AC1]            │
│  Zod validate UUID param │
│  ✗ invalid → 400         │
│            │             │
│  getTaskById()           │
│  └─ taskService.ts       │
│       │                  │
│  getTask() → Postgres    │
│  ✗ null → 404            │
│       │                  │
│  buildOutputs(task)      │
│  ┌────────────────────┐  │
│  │ pending     → null │  │
│  │ processing  →      │  │
│  │  p1 running → null │  │
│  │  p1 done →         │  │
│  │  {p1:data,p2:null} │  │
│  │ completed →        │  │
│  │  {p1:data,p2:data} │  │
│  │ c_w_fallback →     │  │
│  │  {p1:data,p2:msg}  │  │
│  │ needs_review →     │  │
│  │  {p1:null,p2:null} │  │
│  └────────────────────┘  │
│       │                  │
│  buildFallbackInfo()     │
│  200 {                   │
│    task_id, state,       │
│    current_phase,        │
│    retry_count,          │
│    outputs,              │
│    input_ticket,         │
│    fallback_info         │
│  }                       │
└──────────────────────────┘


STATE MACHINE (Postgres task.state)
────────────────────────────────────

POST /tickets
      │
  [pending]  ← createTask() sets this
      │
  Worker picks up (US-2.1)
      │
  [processing]  ← updateTask() sets this        ← current end state
  currentPhase: phase_1
      │
  ┌───┴────────────────────────┐
  P1 fails × 3 (Epic 3+5)    P1 ok (Epic 3)
      │                   currentPhase: phase_2
      ▼                        │
[needs_manual_review]    ┌─────┴──────┐
                    P2 fails × 3   P2 ok
                    (Epic 4+5)   (Epic 4)
                         │           │
                         ▼           ▼
             [completed_with_    [completed]
              fallback]
```
