import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(cookieParser());
app.use(express.json()); // read json from every single req

app.listen(PORT, () => {
  console.log(`Server is running on port http://localhost:${PORT}/`);
});
