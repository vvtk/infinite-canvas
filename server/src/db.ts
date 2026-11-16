import { Pool, type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";

export const createPool = (connectionString: string) => new Pool({ connectionString });
export async function migrate(pool: Pool) {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
        await pool.query(await readFile(new URL(file, directory), "utf8"));
    }
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
