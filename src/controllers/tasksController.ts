import { Request, Response } from "express";
import { z } from "zod";
import { getTaskById } from "../services/taskService.js";

const ParamsSchema = z.object({
  taskId: z.uuid(),
});

export const getTaskStatus = async (req: Request, res: Response) => {
  const result = ParamsSchema.safeParse(req.params);
  // console.log("hello");

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid task ID",
      details: result.error.issues,
    });
  }

  const taskData = await getTaskById(result.data.taskId);

  if (!taskData) {
    return res.status(404).json({ error: "Task not found" });
  }

  return res.status(200).json(taskData);
};
