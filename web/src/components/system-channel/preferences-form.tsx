import type { ReactNode } from "react";
import { Button, Form, Input, InputNumber, Radio, Select, Switch, Tag } from "antd";
import { RotateCcw } from "lucide-react";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions } from "@/lib/media-size";
import type { SystemModel, SystemPreferences } from "../../../../shared/system-channel";

export function SystemPreferencesForm({ value, models, onChange, overrides, onReset }: {
    value: SystemPreferences; models: SystemModel[];
    onChange: <K extends keyof SystemPreferences>(key: K, value: SystemPreferences[K]) => void;
    overrides?: Partial<SystemPreferences>; onReset?: (key: keyof SystemPreferences) => void;
}) {
    const field = (key: keyof SystemPreferences, label: string, control: ReactNode) => <Form.Item key={key} label={<span className="flex flex-wrap items-center gap-2">{label}{overrides ? <><Tag bordered={false}>{key in overrides ? "本地覆盖" : "继承系统"}</Tag>{key in overrides ? <Button type="text" size="small" icon={<RotateCcw className="size-3" />} onClick={() => onReset?.(key)}>恢复默认</Button> : null}</> : null}</span>} className="!mb-0">{control}</Form.Item>;
    const select = <K extends keyof SystemPreferences>(key: K, options: { label: string; value: string }[]) => <Select value={String(value[key])} options={options} onChange={next => onChange(key, next as SystemPreferences[K])} />;
    const number = (key: "count" | "canvasImageCount" | "videoSeconds" | "audioSpeed", min: number, max: number, step = 1) => <InputNumber className="!w-full" value={Number(value[key])} min={min} max={max} step={step} onChange={next => { if (next !== null) onChange(key, String(next)); }} />;
    return <Form layout="vertical" className="space-y-6" requiredMark={false}>
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {(["image", "video", "text", "audio"] as const).map((capability, index) => {
                const key = `${capability}Model` as const;
                return field(key, ["默认生图模型", "默认视频模型", "默认文本模型", "默认音频模型"][index], <Select showSearch allowClear placeholder="请选择模型" value={value[key] || undefined} options={models.filter(model => model.capability === capability).map(model => ({ label: model.name, value: model.name }))} onChange={next => onChange(key, next || "")} />);
            })}
        </div>
        <section className="space-y-4"><h2 className="text-sm font-medium">生图</h2><div className="grid gap-5 sm:grid-cols-2">
            {field("canvasImageCount", "画布默认生图张数", number("canvasImageCount", 1, 15))}
            {field("count", "工作台默认生图张数", number("count", 1, 15))}
            {field("quality", "图片质量", select("quality", ["auto", "low", "medium", "high", "xhigh", "max"].map((item, index) => ({ value: item, label: ["自动", "低", "中", "高", "极高", "最高"][index] }))))}
            {field("background", "图片背景", select("background", [{ value: "", label: "自动" }, { value: "transparent", label: "透明" }, { value: "opaque", label: "不透明" }]))}
            {field("size", "图片分辨率与比例", <div className="flex gap-2"><Select className="min-w-0 flex-1" value={inferMediaScale(value.size)} options={mediaScaleOptions.map(scale => ({ value: scale, label: scale === "auto" ? "自动" : scale.toUpperCase() }))} onChange={scale => onChange("size", computeMediaSize(scale, inferMediaRatio(value.size)))} /><Select className="min-w-0 flex-1" value={inferMediaRatio(value.size)} options={["auto", "1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"].map(ratio => ({ value: ratio, label: ratio === "auto" ? "自动比例" : ratio }))} onChange={ratio => onChange("size", computeMediaSize(inferMediaScale(value.size), ratio))} /></div>)}
            {field("returnBase64", "图片返回 Base64", <Switch checked={value.returnBase64} onChange={next => onChange("returnBase64", next)} />)}
        </div>
        <p className="text-xs text-muted-foreground">Base64 仅用于支持 response_format 的 OpenAI 图片接口；gpt-image 与 Gemini 按其协议处理。</p>
        {field("imageSystemPrompt", "生图系统提示词", <Input.TextArea rows={3} value={value.imageSystemPrompt} onChange={event => onChange("imageSystemPrompt", event.target.value)} placeholder="调用时加入，不改写输入框原文" />)}</section>
        <section className="space-y-4"><h2 className="text-sm font-medium">视频</h2><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {field("videoSeconds", "视频时长（秒）", number("videoSeconds", 4, 30))}
            {field("vquality", "视频分辨率", select("vquality", ["480", "720", "1080"].map(resolution => ({ value: resolution, label: `${resolution}p` }))))}
            {field("videoMode", "视频生成模式", select("videoMode", [{ value: "frames", label: "首尾帧" }, { value: "reference", label: "全能参考" }]))}
            {field("videoGenerateAudio", "视频音频生成", <Switch checked={value.videoGenerateAudio === "true"} onChange={next => onChange("videoGenerateAudio", String(next))} />)}
            {field("videoWatermark", "视频水印", <Switch checked={value.videoWatermark === "true"} onChange={next => onChange("videoWatermark", String(next))} />)}
        </div>
        {field("videoSystemPrompt", "视频系统提示词", <Input.TextArea rows={3} value={value.videoSystemPrompt} onChange={event => onChange("videoSystemPrompt", event.target.value)} placeholder="调用时加入，不改写输入框原文" />)}</section>
        <section className="space-y-4"><h2 className="text-sm font-medium">文本</h2><div className="grid gap-5 sm:grid-cols-2">
            {field("reasoningEffort", "文本推理强度", select("reasoningEffort", ["auto", "low", "medium", "high", "xhigh"].map((effort, index) => ({ value: effort, label: ["自动", "低", "中", "高", "极高"][index] }))))}
            {field("streamText", "文本流式传输", <Switch checked={value.streamText} onChange={next => onChange("streamText", next)} />)}
        </div>
        {field("textSystemPrompt", "文本 / 问答系统提示词", <Input.TextArea rows={3} value={value.textSystemPrompt} onChange={event => onChange("textSystemPrompt", event.target.value)} placeholder="调用时加入，不改写输入框原文" />)}</section>
        <section className="space-y-4"><h2 className="text-sm font-medium">音频</h2><div className="grid gap-5 sm:grid-cols-3">
            {field("audioVoice", "默认音频声音", <Select value={normalizeAudioVoiceValue(value.audioVoice)} options={audioVoiceOptions} onChange={next => onChange("audioVoice", next)} />)}
            {field("audioFormat", "默认音频格式", select("audioFormat", audioFormatOptions))}
            {field("audioSpeed", "默认音频语速", number("audioSpeed", 0.25, 4, 0.05))}
        </div>
        {field("audioInstructions", "默认音频指令", <Input.TextArea rows={2} value={value.audioInstructions} onChange={event => onChange("audioInstructions", event.target.value)} placeholder="例如：自然、温暖、适合旁白" />)}</section>
        {field("nodeRegenerateBehavior", "已有内容的节点再次生成时", <Radio.Group value={value.nodeRegenerateBehavior} onChange={event => onChange("nodeRegenerateBehavior", event.target.value)} options={[{ value: "overwrite", label: "覆盖当前节点" }, { value: "new-node", label: "新建衍生节点" }]} />)}
    </Form>;
}
