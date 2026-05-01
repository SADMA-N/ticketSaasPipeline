import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock all external dependencies ──────────────────────────────────────────
vi.mock("../../repositories/taskRepositories.js", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
}));

// queue.js mocked to assert processJob never acks messages directly
vi.mock("../queue.js", () => ({
  deleteMessage: vi.fn(),
}));

vi.mock("../phase1.js", () => ({
  runPhase1: vi.fn(),
}));

vi.mock("../phase2.js", () => ({
  runPhase2: vi.fn(),
}));

vi.mock("../../socket/emitter.js", () => ({
  emitSocketEvent: vi.fn(),
}));

vi.mock("../workerEvents.js", () => ({
  workerEvents: { emit: vi.fn() },
}));

// ── imports after mocks ──────────────────────────────────────────────────────
import { processJob } from "../processor.js";
import { getTask, updateTask } from "../../repositories/taskRepositories.js";
import { deleteMessage } from "../queue.js";
import { runPhase1 } from "../phase1.js";
import { runPhase2 } from "../phase2.js";
import { emitSocketEvent } from "../../socket/emitter.js";
import { workerEvents } from "../workerEvents.js";

// ── shared fixtures ──────────────────────────────────────────────────────────
const PHASE1_OUTPUT = {
  category: "billing",
  priority: "high",
  sentiment: "negative",
  escalation_flag: false,
  routing_target: "billing-team",
  summary: "Double charge",
} as const;

const PHASE2_OUTPUT = {
  response_draft: "[DRAFT] Sorry for the inconvenience.",
  internal_note: "Refund needed",
  next_actions: ["issue_refund"],
};

// ── base task factory ────────────────────────────────────────────────────────
function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-123",
    state: "pending",
    currentPhase: null,
    phase1Done: false,
    phase2Done: false,
    phase1Retries: 0,
    phase2Retries: 0,
    phase1Output: null,
    phase2Output: null,
    inputTicket: {
      subject: "Test",
      body: "Test body",
      customer: { id: "c1", email: "a@b.com" },
    },
    createdAt: new Date(),
    stateChangedAt: new Date(),
    lastMutatedAt: new Date(),
    fallbackReason: null,
    fallbackAt: null,
    ...overrides,
  };
}

// sets up mocks for a full happy-path run (phase1 → phase2 → completed)
function setupBothPhasesMock() {
  const task = makeTask();
  const freshTask = { ...task, phase1Done: true, phase1Output: PHASE1_OUTPUT };
  vi.mocked(getTask)
    .mockResolvedValueOnce(task as never)
    .mockResolvedValueOnce(freshTask as never);
  vi.mocked(runPhase1).mockResolvedValue(PHASE1_OUTPUT);
  vi.mocked(runPhase2).mockResolvedValue(PHASE2_OUTPUT);
}

beforeEach(() => {
  vi.resetAllMocks(); // clears call history + implementations — prevents stale mock leakage
  vi.mocked(updateTask).mockResolvedValue({} as never);
});

// ════════════════════════════════════════════════════════════════════════════
describe("Ack ownership — processJob never calls deleteMessage", () => {
  it("does not delete message when task not found", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    await processJob("task-123");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("does not delete message when task is already terminal", async () => {
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ state: "completed" }) as never,
    );
    await processJob("task-123");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("does not delete message when phase 1 retry limit reached", async () => {
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ phase1Retries: 3 }) as never,
    );
    await processJob("task-123");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("does not delete message when phase 2 retry limit reached", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 3,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);
    await processJob("task-123");
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Early return — no phases run", () => {
  it.each([
    "completed",
    "completed_with_fallback",
    "needs_manual_review",
  ] as const)("skips all work when task state is %s", async (state) => {
    vi.mocked(getTask).mockResolvedValue(makeTask({ state }) as never);
    await processJob("task-123");
    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
  });

  it("skips all work when task not found in DB", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    await processJob("task-123");
    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 1 simulated failures", () => {
  it("increments phase1Retries and throws when Phase 1 fails", async () => {
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ phase1Retries: 0 }) as never,
    );
    vi.mocked(runPhase1).mockRejectedValue(new Error("AI timeout"));

    await expect(processJob("task-123")).rejects.toThrow("AI timeout");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ phase1Retries: { increment: 1 } }),
    );
  });

  it("sets needs_manual_review when phase1Retries hits limit (3)", async () => {
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ phase1Retries: 3 }) as never,
    );

    await processJob("task-123");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "needs_manual_review" }),
    );
  });

  it("emits retry event with phase and attempt on Phase 1 retry", async () => {
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ phase1Retries: 1 }) as never,
    );
    vi.mocked(runPhase1).mockRejectedValue(new Error("fail"));

    await expect(processJob("task-123")).rejects.toThrow();

    expect(emitSocketEvent).toHaveBeenCalledWith(
      "task-123",
      "retry",
      expect.objectContaining({ phase: "phase_1", attempt: 2 }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 2 simulated failures", () => {
  it("increments phase2Retries and throws when Phase 2 fails", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 0,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);
    vi.mocked(runPhase2).mockRejectedValue(new Error("Phase 2 AI error"));

    await expect(processJob("task-123")).rejects.toThrow("Phase 2 AI error");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ phase2Retries: { increment: 1 } }),
    );
  });

  it("sets completed_with_fallback when phase2Retries hits limit (3)", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 3,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);

    await processJob("task-123");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed_with_fallback" }),
    );
  });

  it("emits retry event with phase and attempt on Phase 2 retry", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 2,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);
    vi.mocked(runPhase2).mockRejectedValue(new Error("fail"));

    await expect(processJob("task-123")).rejects.toThrow();

    expect(emitSocketEvent).toHaveBeenCalledWith(
      "task-123",
      "retry",
      expect.objectContaining({ phase: "phase_2", attempt: 3 }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Happy path — both phases succeed", () => {
  it("runs phase1 then phase2 and reaches completed state", async () => {
    setupBothPhasesMock();

    await processJob("task-123");

    expect(runPhase1).toHaveBeenCalledTimes(1);
    expect(runPhase2).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed" }),
    );
  });

  it("emits started → phase_1_started → phase_1_complete → phase_2_started → phase_2_complete → completed events in order", async () => {
    setupBothPhasesMock();

    await processJob("task-123");

    const emitCalls = vi.mocked(emitSocketEvent).mock.calls.map((c) => c[1]);
    expect(emitCalls).toEqual([
      "started",
      "phase_1_started",
      "phase_1_complete",
      "phase_2_started",
      "phase_2_complete",
      "completed",
    ]);
  });

  it("skips phase 1 when phase1Done already true (resumes at phase 2)", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: PHASE1_OUTPUT,
      phase2Retries: 0,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);
    vi.mocked(runPhase2).mockResolvedValue(PHASE2_OUTPUT);

    await processJob("task-123");

    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed" }),
    );
  });

  it("sets currentPhase to phase_2 when resuming with phase1Done true", async () => {
    const task = makeTask({
      phase1Done: true,
      phase1Output: PHASE1_OUTPUT,
      phase2Retries: 0,
    });
    vi.mocked(getTask)
      .mockResolvedValueOnce(task as never)
      .mockResolvedValueOnce(task as never);
    vi.mocked(runPhase2).mockResolvedValue(PHASE2_OUTPUT);

    await processJob("task-123");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ currentPhase: "phase_2" }),
    );
  });

  it("does not fire phase_2_started worker event when task vanishes between phases", async () => {
    vi.mocked(getTask)
      .mockResolvedValueOnce(makeTask() as never)
      .mockResolvedValueOnce(null); // task vanishes after phase 1
    vi.mocked(runPhase1).mockResolvedValue(PHASE1_OUTPUT);

    await processJob("task-123");

    expect(vi.mocked(workerEvents.emit)).not.toHaveBeenCalledWith(
      "phase_2_started",
      expect.anything(),
    );
  });
});
