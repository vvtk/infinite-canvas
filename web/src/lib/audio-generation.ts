export const audioVoiceOptions = [
    { value: "longanhuan_v3.1", label: "longanhuan_v3.1" },
    { value: "longanlingxin_v3.1", label: "longanlingxin_v3.1" },
    { value: "xunanchuan_v3.1", label: "xunanchuan_v3.1" },
    { value: "longanfengyue_v3.1", label: "longanfengyue_v3.1" },
];

const legacyAudioVoiceMap: Record<string, string> = {
    alloy: "longanhuan_v3.1",
    ash: "longanlingxin_v3.1",
    ballad: "xunanchuan_v3.1",
    coral: "longanfengyue_v3.1",
};

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function normalizeAudioVoiceValue(value: string) {
    const requested = String(value || "").trim();
    const mapped = legacyAudioVoiceMap[requested.toLowerCase()] || requested;
    return audioVoiceOptions.some((item) => item.value === mapped) ? mapped : audioVoiceOptions[0].value;
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
