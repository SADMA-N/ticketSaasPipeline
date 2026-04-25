-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('pending', 'processing', 'completed', 'completed_with_fallback', 'needs_manual_review');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "state" "TaskState" NOT NULL DEFAULT 'pending',
    "currentPhase" TEXT,
    "phase1Retries" INTEGER NOT NULL DEFAULT 0,
    "phase2Retries" INTEGER NOT NULL DEFAULT 0,
    "phase1Done" BOOLEAN NOT NULL DEFAULT false,
    "phase2Done" BOOLEAN NOT NULL DEFAULT false,
    "inputTicket" JSONB NOT NULL,
    "phase1Output" JSONB,
    "phase2Output" JSONB,
    "fallbackReason" TEXT,
    "fallbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMutatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_state_idx" ON "Task"("state");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
