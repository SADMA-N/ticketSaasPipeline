import { Router } from "express";
import { getTaskStatus } from "../controllers/tasksController.js";

const tasksRouter = Router({ strict: true, caseSensitive: true });

tasksRouter.get("/:taskId", getTaskStatus);

export default tasksRouter;
