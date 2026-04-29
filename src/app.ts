import { createServer, Server } from "http";
import app from "./app.setup.js";
import { config } from "./config/env.js";
import { logger } from "./logger.js";
import { initSocket, closeSocket } from "./socket/emitter.js";
import { prisma } from "./lib/prisma.js";

export function buildHttpServer(): Server {
  const httpServer = createServer(app); // express app http server create kre
  initSocket(httpServer); // Socket attach to get real-time updates
  return httpServer;
}

//graceful shutdown
export function registerShutdownHandlers(server: Server): void {
  
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "Shutdown signal received");

    setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000).unref(); // wait till 10s

    server.closeAllConnections();
    server.close(async (err) => {// closing taking new req
      if (err) {
        logger.error(err, "Error during graceful shutdown");
        process.exit(1);
      }
      await closeSocket(); // closeing socket connections
      await prisma.$disconnect();// closeing db connections
      logger.info("Server closed gracefully");
      process.exit(0);
    });
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

export function startServer(): Server {
  const server = buildHttpServer();

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Server running");
  });

  registerShutdownHandlers(server);
  return server;
}

startServer();