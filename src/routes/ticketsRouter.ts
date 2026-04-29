import { Router } from "express";
import { submitTickets } from "../controllers/ticketsController.js";

const ticketsRouter = Router({ strict: true, caseSensitive: true });

ticketsRouter.post("/", submitTickets);

export default ticketsRouter;
