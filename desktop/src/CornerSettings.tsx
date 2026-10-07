// Look page: what goes in each corner of the projector (church name, a
// denomination or ministry logo, nothing), and the picture for the Logo
// screen. Any church can set its own; nothing is hard-coded.

import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CORNERS, Corner, CornerPos, OutputTheme, cornersOf } from "./SlideView";

const NAMES: Record<CornerPos, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right" };

/** Read a picture and shrink it to at most 800 px so the theme stays small. */
export async function pictureToDataUrl(f: File, max = 800): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    // PNG keeps transparent logos transparent.
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PickPicture({ onPick, label }: { onPick: (dataUrl: string) => void; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <label>
        <ImagePlus /> {label}
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) void pictureToDataUrl(f).then(onPick);
            e.target.value = "";
          }}
        />
      </label>
    </Button>
  );
}

export default function CornerSettings({ theme, setTheme }: { theme: OutputTheme; setTheme: (t: OutputTheme) => void }) {
  const corners = cornersOf(theme);
  const set = (pos: CornerPos, c: Corner) => setTheme({ ...theme, corners: { ...corners, [pos]: c } });

  return (
    <section className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Corner logos</div>
      <div className="grid grid-cols-2 gap-2">
        {CORNERS.map((pos) => {
          const c: Corner = corners[pos] ?? { kind: "none" };
          return (
            <div key={pos} className="flex flex-col gap-2 rounded-md border p-2">
              <div className="text-xs font-medium">{NAMES[pos]}</div>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={c.kind}
                onValueChange={(v) => v && set(pos, { ...c, kind: v as Corner["kind"] })}
              >
                <ToggleGroupItem value="none" className="px-2 text-xs">None</ToggleGroupItem>
                <ToggleGroupItem value="text" className="px-2 text-xs">Text</ToggleGroupItem>
                <ToggleGroupItem value="image" className="px-2 text-xs">Logo</ToggleGroupItem>
              </ToggleGroup>
              {c.kind === "text" && (
                <Input className="h-8 text-xs" placeholder="e.g. AMC Church" value={c.text ?? ""} onChange={(e) => set(pos, { ...c, text: e.target.value })} />
              )}
              {c.kind === "image" && (
                <div className="flex items-center gap-2">
                  {c.image ? (
                    <img src={c.image} alt="" className="h-8 max-w-20 rounded bg-black/40 object-contain p-0.5" />
                  ) : (
                    <span className="text-xs text-muted-foreground">No picture yet</span>
                  )}
                  <PickPicture label={c.image ? "Change" : "Choose"} onPick={(d) => set(pos, { ...c, image: d })} />
                </div>
              )}
              {c.kind !== "none" && (
                <Slider
                  min={c.kind === "image" ? 4 : 60}
                  max={c.kind === "image" ? 20 : 200}
                  step={1}
                  value={[c.size ?? (c.kind === "image" ? 9 : 100)]}
                  onValueChange={(v) => set(pos, { ...c, size: v[0] })}
                  aria-label="Size"
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Shown on verses, lyrics, announcements and the summary. Use a PNG with a transparent background for logos.
      </p>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Logo screen</span>
        {theme.logoImage && <img src={theme.logoImage} alt="" className="h-8 max-w-24 rounded bg-black/40 object-contain p-0.5" />}
        <PickPicture label={theme.logoImage ? "Change picture" : "Use a picture"} onPick={(d) => setTheme({ ...theme, logoImage: d })} />
        {theme.logoImage && (
          <Button variant="ghost" size="sm" onClick={() => setTheme({ ...theme, logoImage: undefined })} title="Show the church name instead">
            <Trash2 />
          </Button>
        )}
      </div>
    </section>
  );
}
