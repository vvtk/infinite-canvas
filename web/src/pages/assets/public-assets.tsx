import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Alert, Button, Drawer, Empty, Image, Pagination, Spin } from "antd";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/image-utils";
import { fetchLibrary, type LibraryItem } from "@/services/api/admin";
import { loadPublicAsset } from "@/services/public-assets";
import { useAssetStore, type AssetKind } from "@/stores/use-asset-store";
import { AssetCard } from "./asset-card";

export function PublicAssets({ keyword, kindFilter }: { keyword: string; kindFilter: AssetKind | "all" }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState<LibraryItem | null>(null);
    const [saving, setSaving] = useState("");
    useEffect(() => setPage(1), [keyword, kindFilter]);
    const query = useQuery({
        queryKey: ["library", "assets", "page", keyword, kindFilter, page],
        queryFn: () => fetchLibrary("assets", { keyword, assetKind: kindFilter === "all" ? undefined : kindFilter, page, pageSize: 20 }),
    });
    const save = async (item: LibraryItem) => {
        setSaving(item.id);
        try {
            useAssetStore.getState().addAsset(await loadPublicAsset(item.id));
            message.success("已保存独立副本到我的资产");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving("");
        }
    };

    return <>
        <div className="flex flex-col gap-5">
            {query.error ? <Alert type="error" title="公共资产加载失败" description={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : null}
            {query.isPending ? <div className="flex justify-center py-20"><Spin /></div> : null}
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {query.data?.items.map(item => {
                    const data = item.data;
                    const summary = data.assetKind === "text" ? data.content || "" : [
                        data.width && data.height ? `${data.width}x${data.height}` : "",
                        data.bytes !== undefined ? formatBytes(data.bytes) : "",
                        data.mimeType,
                    ].filter(Boolean).join(" · ");
                    return <AssetCard key={item.id} asset={{
                        title: data.title,
                        kind: data.assetKind!,
                        source: t("assets.publicTitle"),
                        tags: data.tags,
                        cover: data.coverUrl || (data.assetKind === "image" ? `/api/library/media/${data.mediaId}` : ""),
                        summary,
                    }} onOpen={() => setSelected(item)}>
                        <Button size="small" icon={<Copy className="size-3.5" />} disabled={!!saving} loading={saving === item.id} onClick={() => void save(item)}>保存副本</Button>
                    </AssetCard>;
                })}
            </div>
            {query.isSuccess && !query.data.total ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共资产" className="py-20" /> : null}
            <div className="flex justify-center">
                <Pagination current={page} pageSize={20} total={query.data?.total || 0} showSizeChanger={false} onChange={setPage} />
            </div>
        </div>
        <Drawer title={selected?.data.title} size="large" open={!!selected} onClose={() => setSelected(null)}>
            {selected?.data.assetKind === "text" ? <pre className="whitespace-pre-wrap break-words">{selected.data.content}</pre> : selected?.data.assetKind === "image" ? <Image src={`/api/library/media/${selected.data.mediaId}`} /> : selected ? <video controls className="w-full" src={`/api/library/media/${selected.data.mediaId}`} /> : null}
        </Drawer>
    </>;
}
