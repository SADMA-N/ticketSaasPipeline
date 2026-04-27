
------------------------------------FULL SYSTEM ARCHITECTURE--------
                ┌──────────────────────────────┐
                │        CLIENT (Postman)      │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │        API SERVER            │
                │  POST /tickets              │
                └──────────────┬───────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         │                                           │
         ▼                                           ▼
┌──────────────────────┐                 ┌──────────────────────┐
│      PostgreSQL      │                 │     SQS QUEUE        │
│   (task table)       │                 │   ticket-queue       │
│ state: pending       │                 │ { taskId }           │
└──────────────────────┘                 └──────────┬───────────┘
                                                   │
                                                   ▼
                                    ┌──────────────────────────┐
                                    │     WORKER (poll)        │
                                    └──────────┬───────────────┘
                                               │
                                               ▼
                                    ┌──────────────────────────┐
                                    │     processJob()         │
                                    └──────────┬───────────────┘
                                               │
                               ┌───────────────┴───────────────┐
                               │                               │
                               ▼                               ▼
                      ✅ SUCCESS PATH                  ❌ FAILURE PATH




---------------------------SUCCESS FLOW
processJob()
   ↓
runPhase1 (AI call via Portkey)
   ↓
DB update:
  phase1Done = true
  currentPhase = phase_2
   ↓
emit("phase_2_started")
   ↓
deleteMessage() → SQS থেকে remove
   ↓
DONE ✔️



-------------------------------FAILURE FLOW (retry + DLQ)

processJob()
   ↓
runPhase1 fail ❌
   ↓
retry (max 3 বার)
   ↓
still fail ❌
   ↓
SQS auto move → DLQ




          DLQ PROCESSING FLOW

┌──────────────────────────────┐
│     DLQ (ticket-queue-dlq)   │
└──────────────┬───────────────┘
               │
               ▼
     pollDlq() worker
               │
               ▼
     handleDlqMessage()
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
phase1Done ✔️      phase1Done ❌
       │                │
       ▼                ▼
completed_with_    needs_manual_
fallback           review

       ↓
DB update
       ↓
deleteDlqMessage()




-----------------CONNECTION MAP 
.env
  ↓
env.ts (config)
  ↓
portkey.ts (AI client)
  ↓
runPhase1()
  ↓
processJob()
  ↓
worker.ts
  ↓
SQS (main queue + DLQ)
  ↓
setup-queues.sh (creates them)