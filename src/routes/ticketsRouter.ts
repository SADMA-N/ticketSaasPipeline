import { Router } from "express";
import { submitTickets } from "../controllers/ticketsController.js";

const ticketRouter = Router();

ticketRouter.post("/", submitTickets);

export default ticketRouter;
