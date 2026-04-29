// Socket.IO  diye real-time event pathano (task processing status)
import { Server } from "socket.io";
import type { Server as HttpServer } from "http";
import { logger } from "../logger.js";

export type SocketEventName =
  | "started"
  | "phase_1_started"
  | "phase_1_complete"
  | "phase_2_started"
  | "phase_2_complete"
  | "retry"
  | "completed"
  | "completed_with_fallback"
  | "needs_manual_review";

const TERMINAL_EVENTS = new Set<SocketEventName>([
  "completed",
  "completed_with_fallback",
  "needs_manual_review",
]);

const EVENT_PHASE: Partial<Record<SocketEventName, string>> = {
  phase_1_started: "phase_1",
  phase_1_complete: "phase_1",
  phase_2_started: "phase_2",
  phase_2_complete: "phase_2",
};

// Read directly from process.env
const CORS_ORIGIN = process.env["SOCKET_CORS_ORIGIN"] ?? "*";

const taskRoom = (taskId: string) => `task:${taskId}`;

let io: Server | undefined;

//HTTP server er upr Socket.IO chaluKra + client k fixed task room e join krano
export function initSocket(httpServer: HttpServer): void {
  if (io) {
    logger.warn(
      "initSocket called while socket server already running — ignoring",
    );
    return;
  }

  io = new Server(httpServer, { cors: { origin: CORS_ORIGIN } }); // creating socket.io server upon HTTP server

  // Listen for client connections and handle "subscribe" events to join task-specific rooms
  io.on("connection", (socket) => {
    socket.on("subscribe", (taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.trim() === "") {
        logger.warn({ taskId }, "Invalid subscribe payload — rejected");
        return;
      }
      socket.join(taskRoom(taskId)); // entered client into task-specific room
    });
  });
}

//graceful shutdown
export async function closeSocket(): Promise<void> {
  if (!io) return;
  await io.close();
  io = undefined;
}

export function emitSocketEvent(
  taskId: string,
  event: SocketEventName,
  metadata: Record<string, unknown> = {},
): void {
  const phase =
    typeof metadata.phase === "string" ? metadata.phase : EVENT_PHASE[event];
  const outcome = TERMINAL_EVENTS.has(event) ? event : undefined;

  const payload = {
    task_id: taskId,
    event,
    timestamp: new Date().toISOString(),
    metadata: Object.keys(metadata).length ? metadata : null,
  };

  logger.info(
    {
      ...payload,
      ...(phase !== undefined && { phase }),
      ...(outcome !== undefined && { outcome }),
    },
    "socket event",
  );

  if (!io) {
    // Expected in worker process — io only exists in API server process.
    logger.debug(
      { task_id: taskId, event },
      "Socket emit skipped — io not initialized",
    );
    return;
  }

  io.to(taskRoom(taskId)).emit(event, payload);
  //taskId specific room e emit krbe event + payload
}
