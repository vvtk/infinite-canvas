export class CloudError extends Error {
    constructor(public status: number, message: string, public body?: unknown) { super(message); }
}
export const cloudController = new AbortController();
export async function cloudRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal: AbortSignal | null = cloudController.signal): Promise<T> {
    const response = await fetch(`/api${path}`, { method, signal, credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new CloudError(503, "云服务尚未配置");
    const data = await response.json();
    if (!response.ok) throw new CloudError(response.status, data.message || "云请求失败，本地数据已保留", data);
    return data as T;
}
