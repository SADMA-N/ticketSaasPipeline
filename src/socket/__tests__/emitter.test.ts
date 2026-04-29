//emitter.ts (socket logic) working or not verifing with mock socket.io server and client connections
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initSocket, closeSocket, emitSocketEvent } from "../emitter.js";
import { logger } from "../../logger.js";
import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

const mocks = vi.hoisted(() => {
  const mockSocket = { on: vi.fn(), join: vi.fn() };
  const mockRoom = { emit: vi.fn() };
  const mockIo = {
    on: vi.fn(),
    to: vi.fn(() => mockRoom),
    close: vi.fn().mockResolvedValue(undefined), // to close server
  };
  return { mockSocket, mockRoom, mockIo }; // fake socket ,room and socket.io return krtesi
});

// replacing socket.io
vi.mock("socket.io", () => ({
  Server: vi.fn(function () {
    return mocks.mockIo;
  }),
}));

// replacing logger
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { mockSocket, mockRoom, mockIo } = mocks;
const mockHttpServer = {} as HttpServer;

// Re-establish base implementations after each resetAllMocks
function restoreBaseMocks() {
  mockIo.to.mockReturnValue(mockRoom);
  mockIo.close.mockResolvedValue(undefined);
}

// Extract first logger.info call arg — avoids repeated cast boilerplate
function getLogArg(): Record<string, unknown> {
  return vi.mocked(logger.info).mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks(); // mock er call history clear kre implementation reset kre
  restoreBaseMocks();
});

describe("emitSocketEvent , io not initialized", () => {
  it("does not throw", () => {
    expect(() => emitSocketEvent("task-123", "started")).not.toThrow(); // function wont crash without io
  });

  it("logs task_id and event name on every call", () => {
    emitSocketEvent("task-123", "phase_1_started");
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "task-123",
        event: "phase_1_started",
      }),
      "socket event",
    );
  });

  it("log entry includes ISO timestamp", () => {
    emitSocketEvent("task-123", "started");
    expect(getLogArg()["timestamp"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it.each([
    { event: "phase_1_started", phase: "phase_1" },
    { event: "phase_1_complete", phase: "phase_1" },
    { event: "phase_2_started", phase: "phase_2" },
    { event: "phase_2_complete", phase: "phase_2" },
  ] as const)("phase is '$phase' for event '$event'", ({ event, phase }) => {
    emitSocketEvent("task-123", event);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ phase }),
      "socket event",
    );
  });

  it("phase field absent on non-phase event", () => {
    emitSocketEvent("task-123", "started");
    expect(getLogArg()["phase"]).toBeUndefined();
  });

  //(task shesh hbr event)  loge outcome field thakte hbe and tar value hbe event erNam
  it.each([
    { event: "completed" },
    { event: "completed_with_fallback" },
    { event: "needs_manual_review" },
  ] as const)(
    "outcome field present on terminal event '$event'",
    ({ event }) => {
      emitSocketEvent("task-123", event);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: event }),
        "socket event",
      );
    },
  );

  //retry terminal event na tai outcome field thakbena
  it("outcome field absent on non-terminal event", () => {
    emitSocketEvent("task-123", "retry", { phase: "phase_1", attempt: 2 });
    expect(getLogArg()["outcome"]).toBeUndefined();
  });

  // metadata ja dibe ta log e show krano
  it("metadata logged when provided", () => {
    emitSocketEvent("task-123", "retry", { phase: "phase_1", attempt: 2 });
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { phase: "phase_1", attempt: 2 } }),
      "socket event",
    );
  });

  //metadata na dile null show krano
  it("metadata is null in log when not provided", () => {
    emitSocketEvent("task-123", "started");
    expect(getLogArg()["metadata"]).toBeNull();
  });

  //retry hle , metadata te j phase thakbe ta phase hishebe dekano
  it("phase derived from metadata when caller passes it explicitly", () => {
    emitSocketEvent("task-123", "retry", { phase: "phase_2", attempt: 3 });
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "phase_2" }),
      "socket event",
    );
  });

  //io na thakai , loggerDebug e explicit mesg show krano
  it("logs debug when emit is skipped due to io not initialized", () => {
    emitSocketEvent("task-123", "started");
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-123", event: "started" }),
      "Socket emit skipped — io not initialized",
    );
  });
});

describe("initSocket", () => {
  afterEach(async () => closeSocket()); // after each test , close the socket

  it("creates Socket.IO server with configured CORS origin", () => {
    const expectedOrigin = process.env["SOCKET_CORS_ORIGIN"] ?? "*";
    initSocket(mockHttpServer);
    expect(Server).toHaveBeenCalledWith(mockHttpServer, {
      cors: { origin: expectedOrigin },
    });
  });

  it("registers connection event handler", () => {
    initSocket(mockHttpServer);
    expect(mockIo.on).toHaveBeenCalledWith("connection", expect.any(Function));
  });

  it("ignores second initSocket call when already running", () => {
    initSocket(mockHttpServer);
    initSocket(mockHttpServer);
    expect(Server).toHaveBeenCalledOnce();
  });

  it("subscribes socket to task room on subscribe event", () => {
    mockIo.on.mockImplementation(
      (_event: string, cb: (s: typeof mockSocket) => void) => cb(mockSocket),
    );
    mockSocket.on.mockImplementation(
      (_event: string, cb: (taskId: unknown) => void) => cb("task-abc"),
    );

    initSocket(mockHttpServer);

    expect(mockSocket.join).toHaveBeenCalledWith("task:task-abc");
  });

  it.each([
    { label: "empty string", payload: "" },
    { label: "whitespace", payload: "   " },
    { label: "number", payload: 123 },
    { label: "object", payload: {} },
  ])("rejects invalid subscribe payload: $label", ({ payload }) => {
    mockIo.on.mockImplementation(
      (_event: string, cb: (s: typeof mockSocket) => void) => cb(mockSocket),
    );
    mockSocket.on.mockImplementation(
      (_event: string, cb: (taskId: unknown) => void) => cb(payload),
    );

    initSocket(mockHttpServer);

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});

describe("closeSocket", () => {
  it("resolves without error when io is not initialized", async () => {
    await expect(closeSocket()).resolves.toBeUndefined();
  });

  it("calls io.close() when io is initialized", async () => {
    mockIo.on.mockImplementation(() => {});
    initSocket(mockHttpServer);
    await closeSocket();
    expect(mockIo.close).toHaveBeenCalledOnce();
  });
});

describe("emitSocketEvent — io initialized", () => {
  beforeEach(() => {
    mockIo.on.mockImplementation(() => {});
    initSocket(mockHttpServer);
    vi.clearAllMocks();
    restoreBaseMocks();
  });

  afterEach(async () => closeSocket());

  it("emits to correct task room", () => {
    emitSocketEvent("task-456", "started");
    expect(mockIo.to).toHaveBeenCalledWith("task:task-456");
  });

  it("emits correct event name to room", () => {
    emitSocketEvent("task-456", "phase_1_started");
    expect(mockRoom.emit).toHaveBeenCalledWith(
      "phase_1_started",
      expect.any(Object),
    );
  });

  it("emits payload with task_id, event, timestamp and null metadata", () => {
    emitSocketEvent("task-456", "completed");
    expect(mockRoom.emit).toHaveBeenCalledWith(
      "completed",
      expect.objectContaining({
        task_id: "task-456",
        event: "completed",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        metadata: null,
      }),
    );
  });

  it("propagates metadata to client payload", () => {
    emitSocketEvent("task-456", "retry", { phase: "phase_1", attempt: 2 });
    expect(mockRoom.emit).toHaveBeenCalledWith(
      "retry",
      expect.objectContaining({ metadata: { phase: "phase_1", attempt: 2 } }),
    );
  });
});
