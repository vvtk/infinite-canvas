import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApp } from "./app.js";
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const app = await createApp(config, pool);
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Canvas API listening on ${config.HOST}:${config.PORT}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await app.close(); await pool.end(); process.exit(0); });
