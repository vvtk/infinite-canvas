import { initializeAccount, type AccountSession } from "@/lib/account-storage";

async function bootstrap() {
    let session: AccountSession = { user: null };
    let offlineAccount = localStorage.getItem("canvas:last-account") || "guest";
    let sessionConfirmed = false;
    try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
            session = await response.json();
            sessionConfirmed = true;
        }
    } catch {
        offlineAccount = localStorage.getItem("canvas:last-account") || "guest";
    }
    if (session.user) localStorage.setItem("canvas:last-account", session.user.id);
    initializeAccount(session, offlineAccount);
    if (sessionConfirmed && !session.user && offlineAccount !== "guest") {
        const { clearAccountCredential } = await import("@/services/account");
        await clearAccountCredential();
        localStorage.removeItem("canvas:last-account");
        window.location.replace("/");
        return;
    }
    await import("./app");
}
void bootstrap();
