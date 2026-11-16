import { downloadPublicMedia, fetchLibraryItem } from "@/services/api/admin";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import type { Asset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

export async function loadPublicAsset(id: string): Promise<Asset> {
    const owner = useUserStore.getState().user?.id;
    const latest = await fetchLibraryItem("assets", id);
    const data = latest.data;
    const cover = data.coverUrl ? await uploadImage(data.coverUrl) : null;
    if (cover && !cover.storageKey) throw new Error("封面无法下载，未创建独立副本");
    const base = {
        id, createdAt: latest.createdAt, updatedAt: latest.updatedAt,
        title: data.title, tags: [...data.tags], coverUrl: cover?.url || "", note: data.description, source: "公共资产",
        metadata: { source: "public-library", publicId: id, cover: cover ? { storageKey: cover.storageKey, url: cover.url } : undefined },
    };
    let asset: Asset;
    if (data.assetKind === "text") asset = { ...base, kind: "text", data: { content: data.content || "" } };
    else if (data.assetKind === "image") {
        const image = await uploadImage(await downloadPublicMedia(data.mediaId!, "image"));
        asset = { ...base, coverUrl: cover?.url || image.url, kind: "image", data: { ...image, dataUrl: image.url } };
    } else {
        const video = await uploadMediaFile(await downloadPublicMedia(data.mediaId!, "video"), "video");
        asset = { ...base, kind: "video", data: { ...video, width: video.width || data.width || 0, height: video.height || data.height || 0 } };
    }
    if (owner !== useUserStore.getState().user?.id) throw new Error("账号已变化，请重新保存");
    return asset;
}
