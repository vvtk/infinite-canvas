import { Pool, type PoolClient } from "pg";
import { readFile } from "node:fs/promises";

export const createPool = (connectionString: string) => new Pool({ connectionString });
export async function migrate(pool: Pool) {
    await pool.query(await readFile(new URL("../migrations/001_cloud.sql", import.meta.url), "utf8"));
}
export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
    const db = await pool.connect();
    try {
        await db.query("BEGIN");
        const result = await work(db);
        await db.query("COMMIT");
        return result;
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally { db.release(); }
}
