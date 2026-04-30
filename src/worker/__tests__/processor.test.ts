import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock all external dependencies ──────────────────────────────────────────
vi.mock("../../repositories/taskRepositories.js", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
}));

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

// ── base task factory ────────────────────────────────────────────────────────
function makeTask(overrides = {}) {
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

const RECEIPT = "receipt-handle-abc";

beforeEach(() => {
  vi.clearAllMocks();
  (updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (deleteMessage as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
describe("Phase 1 simulated failures", () => {
  it("increments phase1Retries and throws when Phase 1 fails", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Retries: 0 }),
    );
    (runPhase1 as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("AI timeout"),
    );

    await expect(processJob("task-123", RECEIPT)).rejects.toThrow("AI timeout");

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ phase1Retries: { increment: 1 } }),
    );
  });

  it("sets needs_manual_review when phase1Retries hits limit (3)", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Retries: 3 }),
    );

    await processJob("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "needs_manual_review" }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });

  it("emits retry event with phase and attempt on Phase 1 retry", async () => {
    const { emitSocketEvent } = await import("../../socket/emitter.js");

    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Retries: 1 }),
    );
    (runPhase1 as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fail"),
    );

    await expect(processJob("task-123", RECEIPT)).rejects.toThrow();

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
    const phase1Task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 0,
    });

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(phase1Task) // first getTask call
      .mockResolvedValueOnce(phase1Task); // freshTask call

    (runPhase2 as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Phase 2 AI error"),
    );

    await expect(processJob("task-123", RECEIPT)).rejects.toThrow(
      "Phase 2 AI error",
    );

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ phase2Retries: { increment: 1 } }),
    );
  });

  it("sets completed_with_fallback when phase2Retries hits limit (3)", async () => {
    const phase1Task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 3,
    });

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(phase1Task)
      .mockResolvedValueOnce(phase1Task);

    await processJob("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed_with_fallback" }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });

  it("emits retry event with phase and attempt on Phase 2 retry", async () => {
    const { emitSocketEvent } = await import("../../socket/emitter.js");

    const phase1Task = makeTask({
      phase1Done: true,
      phase1Output: { foo: "bar" },
      phase2Retries: 2,
    });

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(phase1Task)
      .mockResolvedValueOnce(phase1Task);

    (runPhase2 as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fail"),
    );

    await expect(processJob("task-123", RECEIPT)).rejects.toThrow();

    expect(emitSocketEvent).toHaveBeenCalledWith(
      "task-123",
      "retry",
      expect.objectContaining({ phase: "phase_2", attempt: 3 }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Idempotency", () => {
  it("skips processing if task already in terminal state", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ state: "completed" }),
    );

    await processJob("task-123", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });

  it("skips if task not found", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await processJob("task-123", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Happy path — both phases succeed", () => {
  it("runs phase1 then phase2 and reaches completed state", async () => {
    const task = makeTask({ phase1Retries: 0, phase2Retries: 0 });
    const phase1Output = {
      category: "billing",
      priority: "high",
      sentiment: "negative",
      escalation_flag: false,
      routing_target: "billing-team",
      summary: "Double charge",
    };
    const phase2Output = {
      response_draft: "[DRAFT] Sorry",
      internal_note: "Refund needed",
      next_actions: ["issue_refund"],
    };

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce({ ...task, phase1Done: true, phase1Output });

    (runPhase1 as ReturnType<typeof vi.fn>).mockResolvedValue(phase1Output);
    (runPhase2 as ReturnType<typeof vi.fn>).mockResolvedValue(phase2Output);

    await processJob("task-123", RECEIPT);

    expect(runPhase1).toHaveBeenCalledTimes(1);
    expect(runPhase2).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed" }),
    );
  });

  it("emits started → phase_1_started → phase_1_complete → phase_2_started → phase_2_complete → completed events in order", async () => {
    const task = makeTask({ phase1Retries: 0, phase2Retries: 0 });
    const phase1Output = {
      category: "billing",
      priority: "high",
      sentiment: "negative",
      escalation_flag: false,
      routing_target: "billing-team",
      summary: "Double charge",
    };
    const phase2Output = {
      response_draft: "[DRAFT] Sorry",
      internal_note: "Refund needed",
      next_actions: ["issue_refund"],
    };

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce({ ...task, phase1Done: true, phase1Output });

    (runPhase1 as ReturnType<typeof vi.fn>).mockResolvedValue(phase1Output);
    (runPhase2 as ReturnType<typeof vi.fn>).mockResolvedValue(phase2Output);

    await processJob("task-123", RECEIPT);

    const emitCalls = (
      emitSocketEvent as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[1]);
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
    const phase1Output = {
      category: "billing",
      priority: "high",
      sentiment: "negative",
      escalation_flag: false,
      routing_target: "billing-team",
      summary: "Double charge",
    };
    const phase2Output = {
      response_draft: "[DRAFT] Sorry",
      internal_note: "Refund needed",
      next_actions: ["issue_refund"],
    };
    const task = makeTask({ phase1Done: true, phase1Output, phase2Retries: 0 });

    (getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task);

    (runPhase2 as ReturnType<typeof vi.fn>).mockResolvedValue(phase2Output);

    await processJob("task-123", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed" }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("Malformed queue messages", () => {
  it("skips gracefully when task state is already terminal (completed_with_fallback)", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ state: "completed_with_fallback" }),
    );

    await processJob("task-123", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });

  it("skips gracefully when task state is needs_manual_review", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ state: "needs_manual_review" }),
    );

    await processJob("task-123", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });

  it("skips and deletes message when task record not found in DB", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await processJob("unknown-task-id", RECEIPT);

    expect(runPhase1).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(RECEIPT);
  });
});
