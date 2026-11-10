import { cloudRequest } from "@/services/api/cloud";

export type AccountOverview = {
    user: {
        id: string;
        displayId: string;
        username: string;
        displayName: string;
        avatarUrl: string;
        points: number;
        role: number;
        isAdmin: boolean;
    };
    storage: {
        usedBytes: number;
        quotaBytes: number;
    };
    links: {
        rechargeUrl: string;
    };
};

export function fetchAccountOverview() {
    return cloudRequest<AccountOverview>("/account/overview");
}
