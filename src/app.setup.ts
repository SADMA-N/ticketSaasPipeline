import express, { Request, Response } from "express";
import ticketsRouter from "./routes/ticketsRouter.js";
import tasksRouter from "./routes/tasksRouter.js";

const app = express();
app.use(express.json());
app.use("/tickets", ticketsRouter);
app.use("/tasks", tasksRouter);
app.use((req: Request, res: Response) => {
  res.status(404).json({ status: "404 fail", message: "Route not found" });
});

export default app;
