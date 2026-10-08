// The media library (src-tauri/src/media.rs): audio and video in folders.

export type MediaKind = "audio" | "video";
export type MediaItem = {
  id: string;
  folder: string;
  kind: MediaKind;
  title: string;
  file: string;
  duration_s?: number | null;
  youtube_id?: string | null;
  channel?: string | null;
  added: number;
  /** Absolute path on this computer. */
  path: string;
};
export type MediaFolder = { id: string; name: string; kind: MediaKind };

export function fmtTime(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "";
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}
