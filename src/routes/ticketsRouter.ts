import { Router } from "express";
import { submitTicket } from "../controllers/ticketsController";

const ticketRouter = Router();

ticketRouter.post("/", submitTicket);

export default ticketRouter;
