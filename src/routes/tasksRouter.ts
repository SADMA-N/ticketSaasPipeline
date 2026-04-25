import { Router } from "express";
import { getTaskStatus } from "../controllers/tasksController";

const tasksRouter = Router();

tasksRouter.get("/:taskId", getTaskStatus);

export default tasksRouter;
