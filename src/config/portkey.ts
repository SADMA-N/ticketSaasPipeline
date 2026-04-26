import { Portkey } from "portkey-ai";
import { config } from "./env.js";

export const portkey = new Portkey({
  apiKey: config.PORTKEY_API_KEY,
  config: config.PORTKEY_CONFIG_ID,
});
