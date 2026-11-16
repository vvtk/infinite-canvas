import { useEffect, useState } from "react";
import { Alert, App, Button, Empty, Pagination, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchLibrary } from "@/services/api/admin";
import { loadPublicAsset } from "@/services/public-assets";
import { useAssetStore } from "@/stores/use-asset-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { cn } from "@/lib/utils";
import type { InsertAssetPayload } from "./asset-picker-modal";
import { ASSET_GROUPS, CanvasAssetCard, CanvasAssetGroup } from "./canvas-asset-items";

export function CanvasPublicAssets({ active, keyword, onInsert }: { active: boolean; keyword: string; onInsert: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [tagFilter, setTagFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [inserting, setInserting] = useState("");
    useEffect(() => setPage(1), [keyword]);
    const query = useQuery({ queryKey: ["library", "assets", "canvas", keyword, tagFilter, page], queryFn: () => fetchLibrary("assets", { keyword, tag: tagFilter === "all" ? undefined : tagFilter, page, pageSize: 20 }), enabled: active, placeholderData: previous => previous });
    const allTags = query.data?.tags.slice(0, 20) || [];
    const groups = ASSET_GROUPS.map(group => ({ ...group, items: (query.data?.items || []).filter(item => item.data.assetKind === group.kind) })).filter(group => group.items.length);
    const insert = async (id: string) => {
        setInserting(id);
        try {
            const asset = await loadPublicAsset(id);
            useAssetStore.getState().addAsset(asset);
            if (asset.kind === "text") onInsert({ kind: "text", content: asset.data.content, title: asset.title });
            else if (asset.kind === "image") onInsert({ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
            else onInsert({ kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height });
            message.success("已保存到我的资产并插入画布");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "公共资产插入失败");
        } finally {
            setInserting("");
        }
    };
    return <div className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}>
        <div className="hide-scrollbar flex h-9 shrink-0 items-start gap-1.5 overflow-x-auto whitespace-nowrap px-3 pb-2 [&_.ant-tag]:shrink-0">
            <Tag.CheckableTag checked={tagFilter === "all"} className={cn("prompt-filter-tag", tagFilter === "all" && "is-active")} onChange={() => { setTagFilter("all"); setPage(1); }}>{t("common.all")}</Tag.CheckableTag>
            {allTags.map(tag => <Tag.CheckableTag key={tag} checked={tagFilter === tag} className={cn("prompt-filter-tag", tagFilter === tag && "is-active")} onChange={() => { setTagFilter(value => value === tag ? "all" : tag); setPage(1); }}>{tag}</Tag.CheckableTag>)}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-gutter:stable]">
            {query.isPending ? <div className="flex justify-center py-8"><Spin size="small" /></div> : query.error ? <Alert type="error" title="公共资产加载失败" action={<Button size="small" type="text" onClick={() => void query.refetch()}>重试</Button>} /> : query.data?.total ? <>
                <div className="space-y-1">
                    {groups.map(group => <CanvasAssetGroup key={group.kind} kind={group.kind} count={group.items.length}>
                        {group.items.map(item => <CanvasAssetCard key={item.id} asset={{ kind: group.kind, title: item.data.title, coverUrl: item.data.coverUrl, data: { content: item.data.content, dataUrl: `/api/library/media/${item.data.mediaId}`, url: `/api/library/media/${item.data.mediaId}` } }} theme={theme} disabled={!!inserting} loading={inserting === item.id} insertLabel="保存并插入画布" onInsert={() => void insert(item.id)} />)}
                    </CanvasAssetGroup>)}
                </div>
                {query.data.total > 20 ? <div className="mt-3 flex justify-center"><Pagination simple size="small" current={page} pageSize={20} total={query.data.total} showSizeChanger={false} onChange={setPage} /></div> : null}
            </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共资产" className="pt-16" />}
        </div>
    </div>;
}
