import { z } from "zod";
import "dotenv/config";
const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.url(),
});

export const config = EnvSchema.parse(process.env);
