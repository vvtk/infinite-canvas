import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { authService } from "./auth.js";
import { recordRoutes } from "./records.js";
import { mediaRoutes } from "./media.js";
import { libraryRoutes } from "./library.js";
import { adminRoutes } from "./admin.js";
import { publicMediaRoutes } from "./public-media.js";
import { systemChannelRoutes } from "./system-channel.js";
import { storageRoutes } from "./storage/routes.js";

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
        reply.code(status).send({ message: status >= 500 ? "服务暂时不可用，请稍后重试" : error instanceof ZodError ? "请求参数无效或超出限制" : (error as Error).message, code: status < 500 ? (error as {code?:string}).code : undefined });
    });
    const { requireSession, requireAdmin, requireSuperAdmin } = authService(app, pool, config);
    await systemChannelRoutes(app, pool, requireSuperAdmin, requireSession);
    const {reschedule} = await libraryRoutes(app,pool,config,requireAdmin);
    adminRoutes(app,pool,config,requireAdmin,requireSuperAdmin,requireSession,reschedule);
    await storageRoutes(app,pool,config,requireSuperAdmin);
    publicMediaRoutes(app,pool,config,requireAdmin);
    recordRoutes(app, pool, config, requireSession);
    mediaRoutes(app, pool, config, requireSession);
    app.get("/api/health", async () => { await pool.query("SELECT 1"); return { ok: true }; });
    return app;
}
