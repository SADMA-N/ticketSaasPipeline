import { randomUUID } from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import ticketsRouter from "./routes/ticketsRouter.js";
import tasksRouter from "./routes/tasksRouter.js";
import { logger } from "./logger.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(express.json({ limit: "100kb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId =
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    req.headers["x-request-id"] = requestId; // req attach
    res.setHeader("x-request-id", requestId); // res attach
    next();
  });

  app.use("/tickets", ticketsRouter);
  app.use("/tasks", tasksRouter);

  // wrong route handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: "fail", message: "Route not found" });
  });

  //global error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err instanceof Error ? err : new Error(String(err)); // non error handle
    const status =
      ((err as Record<string, unknown>)["status"] as number) ??
      ((err as Record<string, unknown>)["statusCode"] as number) ??
      500;
    const isClientError = status < 500;

    if (!isClientError) {
      logger.error(error, "Unhandled error");
    }

    res
      .status(status)
      .json(
        isClientError
          ? { status: "fail", message: error.message }
          : { status: "error", message: "Internal server error" },
      );
  });

  return app;
}

export default createApp();
