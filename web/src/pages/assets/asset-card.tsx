import type { ReactNode } from "react";
import { Button, Card, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { Asset } from "@/stores/use-asset-store";

type CardAsset = Pick<Asset, "title" | "kind" | "source" | "tags"> & { cover: string; summary: string };

export function AssetCard({ asset, onOpen, children }: { asset: CardAsset; onOpen: () => void; children: ReactNode }) {
    const { t } = useTranslation();
    return <Card hoverable className="overflow-hidden" styles={{ body: { padding: 0 } }} cover={
        <button type="button" className="block w-full text-left" onClick={onOpen}>
            {asset.cover ? <img src={asset.cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.summary : t("assets.noCover")}</div>}
        </button>
    }>
        <button type="button" className="block w-full text-left" onClick={onOpen}>
            <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                        <Typography.Text type="secondary" className="mt-1 block text-xs">{asset.source || t("assets.unknownSource")}</Typography.Text>
                    </div>
                    <Tag className="m-0 shrink-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                </div>
                <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">{asset.summary}</Typography.Paragraph>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {asset.tags.slice(0, 3).map(tag => <Tag key={tag} className="m-0 text-[11px]">{tag}</Tag>)}
                    {!asset.tags.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                </div>
            </div>
        </button>
        <div className="flex items-center gap-2 px-4 pb-4">
            <Button size="small" onClick={onOpen}>{t("common.view")}</Button>
            {children}
        </div>
    </Card>;
}
