export const USER_ROLE = {
    USER: 1,
    ADMIN: 10,
    SUPER_ADMIN: 100,
} as const;

export function isAdminRole(role: number | undefined | null) {
    return (role || 0) >= USER_ROLE.ADMIN;
}

export function isSuperAdminRole(role: number | undefined | null) {
    return (role || 0) >= USER_ROLE.SUPER_ADMIN;
}

export function roleLabel(role: number | undefined | null) {
    return isSuperAdminRole(role) ? "超级管理员" : isAdminRole(role) ? "管理员" : "用户";
}
