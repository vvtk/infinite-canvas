import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { authService } from "./auth.js";
import { recordRoutes } from "./records.js";
import { mediaRoutes } from "./media.js";

export async function createApp(config: Config, pool: Pool) {
    // Don't log request URLs: OAuth callback query strings contain usable codes.
    const app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook("onRequest", async (request, reply) => {
        reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== new URL(config.PUBLIC_URL).origin) {
            return reply.code(403).send({ message: "请求来源不允许" });
        }
    });
    app.setErrorHandler((error, _request, reply) => {
        const status = error instanceof ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500;
        reply.code(status).send({ message: status >= 500 ? "服务暂时不可用，请稍后重试" : error instanceof ZodError ? "请求参数无效或超出限制" : (error as Error).message });
    });
    const { requireSession } = authService(app, pool, config);
    recordRoutes(app, pool, config, requireSession);
    mediaRoutes(app, pool, config, requireSession);
    app.get("/api/health", async () => { await pool.query("SELECT 1"); return { ok: true }; });
    return app;
}
