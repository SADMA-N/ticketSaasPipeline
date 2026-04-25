import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import ticketRouter from "./routes/ticketsRouter";
import tasksRouter from "./routes/tasksRouter";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(cookieParser());
app.use(express.json()); // read json from every single req

app.use("/tickets", ticketRouter);
app.use("/tasks", tasksRouter);



//handle error
app.use((req : Request, res : Response) => {
  res.status(404).json({
    status: "404 fail",
    message: "Route not found",
  });
});




app.listen(PORT, () => {
  console.log(`Server is running on port http://localhost:${PORT}/`);
});
