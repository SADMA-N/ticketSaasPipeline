import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../repositories/taskRepositories.js", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../queue.js", () => ({
  deleteDlqMessage: vi.fn(),
}));

vi.mock("../../socket/emitter.js", () => ({
  emitSocketEvent: vi.fn(),
}));

vi.mock("../workerEvents.js", () => ({
  workerEvents: { emit: vi.fn() },
}));

import { handleDlqMessage } from "../dlqHandler.js";
import { getTask, updateTask } from "../../repositories/taskRepositories.js";
import { deleteDlqMessage } from "../queue.js";
import { emitSocketEvent } from "../../socket/emitter.js";

function makeTask(overrides = {}) {
  return {
    id: "task-123",
    state: "processing",
    currentPhase: "phase_1",
    phase1Done: false,
    phase2Done: false,
    phase1Retries: 3,
    phase2Retries: 0,
    phase1Output: null,
    phase2Output: null,
    inputTicket: { subject: "Test", body: "Test body", customer: { id: "c1", email: "a@b.com" } },
    createdAt: new Date(),
    stateChangedAt: new Date(),
    lastMutatedAt: new Date(),
    fallbackReason: null,
    fallbackAt: null,
    ...overrides,
  };
}

const RECEIPT = "dlq-receipt-handle";

beforeEach(() => {
  vi.clearAllMocks();
  (updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (deleteDlqMessage as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
describe("DLQ — total failure (Phase 1 never succeeded)", () => {
  it("sets state to needs_manual_review when phase1Done is false", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: false }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "needs_manual_review" }),
    );
  });

  it("does not set phase2Output on needs_manual_review", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: false }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    const call = (updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(call.phase2Output).toBeUndefined();
  });

  it("emits needs_manual_review socket event", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: false }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(emitSocketEvent).toHaveBeenCalledWith(
      "task-123",
      "needs_manual_review",
      expect.objectContaining({ reason: "Exceeded SQS delivery attempts" }),
    );
  });

  it("deletes DLQ message after handling", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: false }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(deleteDlqMessage).toHaveBeenCalledWith(RECEIPT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("DLQ — Phase 2 failure (Phase 1 succeeded)", () => {
  it("sets state to completed_with_fallback when phase1Done is true", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: true, phase1Output: { category: "billing" } }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({ state: "completed_with_fallback" }),
    );
  });

  it("stores static fallback phase2Output with null response_draft and next_actions", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: true, phase1Output: { category: "billing" } }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({
        phase2Output: {
          response_draft: null,
          internal_note: "Automated resolution draft could not be generated. Manual review required.",
          next_actions: null,
        },
      }),
    );
  });

  it("stores fallbackReason and fallbackAt", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: true, phase1Output: { category: "billing" } }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(updateTask).toHaveBeenCalledWith(
      "task-123",
      expect.objectContaining({
        fallbackReason: "Exceeded SQS delivery attempts",
        fallbackAt: expect.any(Date),
      }),
    );
  });

  it("emits completed_with_fallback socket event", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: true, phase1Output: { category: "billing" } }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(emitSocketEvent).toHaveBeenCalledWith(
      "task-123",
      "completed_with_fallback",
      expect.objectContaining({ reason: "Exceeded SQS delivery attempts" }),
    );
  });

  it("deletes DLQ message after handling", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTask({ phase1Done: true, phase1Output: { category: "billing" } }),
    );

    await handleDlqMessage("task-123", RECEIPT);

    expect(deleteDlqMessage).toHaveBeenCalledWith(RECEIPT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("DLQ — edge cases", () => {
  it("skips processing and deletes message if task not found", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await handleDlqMessage("task-123", RECEIPT);

    expect(updateTask).not.toHaveBeenCalled();
    expect(deleteDlqMessage).toHaveBeenCalledWith(RECEIPT);
  });
});