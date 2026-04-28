# Full Architecture & Flow Diagram

## Overall Flow

```
╔══════════════════════════════════════════════════════════════════════╗
║                     OVERALL FLOW                                     ║
╚══════════════════════════════════════════════════════════════════════╝

  CLIENT
    │
    │  POST /tickets
    ▼
┌─────────────────────────────────────────────────────┐
│  API SERVER  (app.ts)                               │
│  Express + Socket.IO bound to same HTTP server      │
│                                                     │
│  /tickets ──► ticketsRouter ──► ticketsController   │
│  /tasks   ──► tasksRouter   ──► tasksController     │
└──────────────────┬──────────────────────────────────┘
                   │ ticketService.submitTicket()
                   │  1. save task to DB (Prisma)
                   │  2. push taskId to SQS queue
                   │  3. return 202 + task_id
                   ▼
          ┌─────────────────┐
          │   SQS QUEUE     │  (AWS / LocalStack)
          │   (queue.ts)    │
          └────────┬────────┘
                   │ worker polls every ~1s
                   ▼
┌─────────────────────────────────────────────────────┐
│  WORKER  (worker.ts)                                │
│  Runs separately — npm run dev:worker               │
│                                                     │
│  poll()    ──► processJob()  ──► processor.ts       │
│  pollDlq() ──► handleDlqMessage() ──► dlqHandler.ts │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  PROCESSOR  (processor.ts)                          │
│                                                     │
│  1. getTask() from DB                               │
│  2. Phase 1 ──► runPhase1() ──► AI (Portkey/Gemini) │
│  3. Phase 2 ──► runPhase2() ──► AI (Portkey/Gemini) │
│  4. updateTask() after each step                    │
│  5. emitSocketEvent() at every milestone  ◄─────────┼─── 🔔 EVENTS HERE
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  EMITTER  (socket/emitter.ts)          ◄── 📝 LOGS HERE
│                                                     │
│  emitSocketEvent(taskId, event, metadata)           │
│    │                                                │
│    ├── logger.info({task_id, event, timestamp,      │
│    │               phase?, outcome?, metadata})     │
│    │   → stdout JSON  (pino)                        │
│    │                                                │
│    └── io.to("task:<id>").emit(event, payload)      │
│        → Socket.IO room → subscribed clients        │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
          POSTMAN / BROWSER
          (subscribed via "subscribe" event)
```

---

## Folder Structure

```
src/
├── app.ts                  ← entry point, Express + Socket.IO setup
├── logger.ts               ← pino logger (used by emitter + worker)
│
├── config/
│   ├── env.ts              ← validates all env vars (zod)
│   ├── sqs.ts              ← AWS SQS client
│   └── portkey.ts          ← AI gateway client
│
├── schemas/
│   └── ticket.ts           ← zod schema for ticket input validation
│
├── routes/
│   ├── ticketsRouter.ts    ← POST /tickets
│   └── tasksRouter.ts      ← GET /tasks/:taskId
│
├── controllers/
│   ├── ticketsController.ts ← validates input, calls ticketService
│   └── tasksController.ts  ← validates UUID, calls taskService
│
├── services/
│   ├── ticketService.ts    ← createTask in DB + push to SQS
│   └── taskService.ts      ← getTask from DB
│
├── repositories/
│   └── taskRepositories.ts ← raw Prisma queries (create/get/update/delete)
│
├── lib/
│   └── prisma.ts           ← Prisma client singleton
│
├── socket/
│   └── emitter.ts          ← Socket.IO setup + emitSocketEvent()
│                             📝 LOGS HERE  🔔 EVENTS HERE
│
└── worker/
    ├── worker.ts           ← poll SQS + pollDlq, workerEvents listeners
    ├── processor.ts        ← main job logic, calls phase1/phase2
    ├── phase1.ts           ← AI call phase 1
    ├── phase2.ts           ← AI call phase 2
    ├── dlqHandler.ts       ← handles dead-letter queue messages
    ├── queue.ts            ← SQS receive/delete helpers
    └── workerEvents.ts     ← internal EventEmitter (phase_2_started, task_terminal)
```

---

## Who Calls Whom

```
app.ts
  └── initSocket(httpServer)         → emitter.ts

ticketsController
  └── submitTicket()                 → ticketService.ts
        ├── createTask()             → taskRepositories.ts → Prisma → DB
        └── SQS.send()              → queue (SQS)

tasksController
  └── getTaskById()                  → taskService.ts
        └── getTask()               → taskRepositories.ts → Prisma → DB

worker.ts
  ├── processJob()                   → processor.ts
  │     ├── getTask/updateTask()     → taskRepositories.ts
  │     ├── runPhase1()              → phase1.ts → Portkey/Gemini AI
  │     ├── runPhase2()              → phase2.ts → Portkey/Gemini AI
  │     ├── emitSocketEvent()        → emitter.ts  📝🔔
  │     └── workerEvents.emit()      → workerEvents.ts → worker.ts listeners
  │
  └── handleDlqMessage()            → dlqHandler.ts
        ├── getTask/updateTask()     → taskRepositories.ts
        └── emitSocketEvent()        → emitter.ts  📝🔔
```

---

## Where Logging and Events Happen

```
emitter.ts → emitSocketEvent()
  📝 logger.info()  ← every call logs to stdout JSON
  🔔 io.emit()      ← every call fires socket event to client

Events emitted at these moments (processor.ts):
  started             → processing begins
  phase_1_started     → phase 1 AI call starts
  phase_1_complete    → phase 1 done
  retry               → any phase retrying (+ phase + attempt in metadata)
  phase_2_started     → phase 2 AI call starts
  phase_2_complete    → phase 2 done
  completed           → all done ✓ (+ duration_ms)
  completed_with_fallback → phase 2 gave up (+ reason + duration_ms)
  needs_manual_review → phase 1 gave up (+ reason + duration_ms)
```
