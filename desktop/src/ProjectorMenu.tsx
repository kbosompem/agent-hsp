// The Projector menu in the console header: find the projector window, reload
// or close it, and choose the display it fills. Turns red when the projector
// window is closed, so a lost projector is never silent.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Projector } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Display = { index: number; name: string; width: number; height: number; primary: boolean; projector: boolean };

const run = (cmd: string, args?: Record<string, unknown>) => void invoke(cmd, args).catch((e) => toast.error(String(e)));

export default function ProjectorMenu({ open }: { open: boolean }) {
  const [displays, setDisplays] = useState<Display[]>([]);
  return (
    <DropdownMenu onOpenChange={(o) => o && void invoke<Display[]>("list_displays").then(setDisplays).catch(() => setDisplays([]))}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant={open ? "outline" : "destructive"}
          className={cn("size-9", !open && "animate-pulse")}
          title={open ? "Projector window: find it, reload it, or choose its display (F brings it to the front)" : "The projector window is closed"}
          aria-label={open ? "Projector" : "Projector closed"}
        >
          <Projector />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuItem onSelect={() => run("projector_show")}>
          {open ? "Bring to front" : "Open the projector"} <DropdownMenuShortcut>F</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run("projector_reopen")}>Reload (if it looks stuck)</DropdownMenuItem>
        {open && <DropdownMenuItem onSelect={() => run("projector_close")}>Close</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Fill a display</DropdownMenuLabel>
        {displays.map((d) => (
          <DropdownMenuItem key={d.index} onSelect={() => run("projector_to_display", { index: d.index, name: d.name, fill: true })}>
            <span className="truncate">
              {d.index + 1}. {d.name} · {d.width}×{d.height}
              {d.primary ? " · main screen" : ""}
            </span>
            {d.projector && <DropdownMenuShortcut>projector here</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => run("identify_displays")}>Which display is which? (numbers for 4 s, never over a filled projector)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            const here = displays.find((d) => d.primary) ?? displays[0];
            if (here) run("projector_to_display", { index: here.index, name: here.name, fill: false });
          }}
        >
          Bring back as a window on the main screen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
