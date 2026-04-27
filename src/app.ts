import express, { Request, Response } from "express";
import dotenv from "dotenv";
import ticketsRouter from './routes/ticketsRouter.js';
import tasksRouter from "./routes/tasksRouter.js";


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json()); // read json from every single req

app.use("/tickets", ticketsRouter);
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
