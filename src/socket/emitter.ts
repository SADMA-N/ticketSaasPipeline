import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

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
  const payload = {
    task_id: taskId,
    event,
    timestamp: new Date().toISOString(),
    metadata: Object.keys(metadata).length ? metadata : null,
  };
  io.to(`task:${taskId}`).emit(event, payload); // task:${taskId} room e data emit kora hbe
}
