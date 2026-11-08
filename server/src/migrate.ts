import { createPool, migrate } from "./db.js";
const pool = createPool(process.env.DATABASE_URL || "");
try { await migrate(pool); } finally { await pool.end(); }
