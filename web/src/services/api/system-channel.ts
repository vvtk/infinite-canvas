import { cloudRequest } from "./cloud";
import { getAccount } from "@/lib/account-storage";
import { useConfigStore } from "@/stores/use-config-store";
import type { SystemChannelSnapshot } from "../../../../shared/system-channel";

let pending: Promise<void> | undefined;
export function refreshSystemChannel() {
    if (getAccount() === "guest") return Promise.resolve();
    if (pending) return pending;
    const account = getAccount();
    useConfigStore.setState({ systemLoading: true });
    pending = cloudRequest<SystemChannelSnapshot>("/system-channel").then(systemSnapshot => {
        if (account === getAccount()) useConfigStore.setState({ systemSnapshot, systemError: "" });
    }).catch(error => {
        if (account === getAccount()) useConfigStore.setState({ systemError: error instanceof Error ? error.message : "系统渠道加载失败" });
    }).finally(() => {
        pending = undefined;
        if (account === getAccount()) useConfigStore.setState({ systemLoading: false });
    });
    return pending;
}
