import { Navigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { Spin } from "antd";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUserStore } from "@/stores/use-user-store";
import { fetchAccountOverview } from "@/services/api/account";

export default function AdminPage() {
    const { t } = useTranslation();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);
    const [checking, setChecking] = useState(true);
    const [allowed, setAllowed] = useState(false);
    const checkedRef = useRef(false);
    useEffect(() => {
        if (!user || checkedRef.current) return;
        checkedRef.current = true;
        void fetchAccountOverview()
            .then((overview) => {
                setUser({ ...overview.user, id: user.id });
                setAllowed(overview.user.isAdmin);
            })
            .catch(() => setAllowed(false))
            .finally(() => setChecking(false));
    }, [setUser, user]);
    if (!user) return <Navigate to="/" replace />;
    if (checking)
        return (
            <div className="flex h-full items-center justify-center">
                <Spin />
            </div>
        );
    if (!allowed) return <Navigate to="/" replace />;
    return (
        <main className="h-full overflow-auto px-6 py-10">
            <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-card p-8 shadow-sm">
                <ShieldCheck className="size-8" />
                <h1 className="mt-4 text-2xl font-semibold">{t("account.adminTitle")}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{t("account.adminDescription")}</p>
            </div>
        </main>
    );
}
