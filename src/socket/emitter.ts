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

// io variable e socket server rakha hbe , now its empty but initSocket call howar por http server er sathe bind kore socket server ready thakbe emit er jonno
let io: Server;

// to setup socket server  // httpserver already chola server (Express/Node)
export function initSocket(httpServer: HttpServer) {
  io = new Server(httpServer, { cors: { origin: "*" } }); // CORS policy allow from all origins

  io.on("connection", (socket) => {
    socket.on("subscribe", (taskId: string) => socket.join(`task:${taskId}`));
    //socket = connection of that user
  });
}

export function emitSocketEvent(
  taskId: string,
  event: SocketEventName,
  metadata: Record<string, unknown> = {},
) {
  const phase = (metadata.phase as string | undefined) ?? EVENT_PHASE[event];
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

  if (!io) return;
  io.to(`task:${taskId}`).emit(event, payload); // task:${taskId} room e data emit kora hbe
}
