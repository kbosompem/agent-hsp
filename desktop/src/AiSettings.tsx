// Settings for the AI sermon summary: any OpenAI- or Anthropic-compatible
// service, including a model running on this computer.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export type LlmSettings = { enabled: boolean; protocol: string; base_url: string; model: string; has_key: boolean };

const PRESETS: { name: string; protocol: string; base_url: string; model: string; note: string }[] = [
  {
    name: "z.ai (GLM)",
    protocol: "openai",
    base_url: "https://api.z.ai/api/paas/v4",
    model: "glm-5.3-flash",
    note: "A GLM Coding Plan key uses https://api.z.ai/api/coding/paas/v4 instead.",
  },
  { name: "Anthropic (Claude)", protocol: "anthropic", base_url: "https://api.anthropic.com", model: "claude-haiku-5-5", note: "" },
  { name: "OpenAI", protocol: "openai", base_url: "https://api.openai.com/v1", model: "", note: "Type the model name from your OpenAI account." },
  { name: "Ollama on this computer", protocol: "openai", base_url: "http://localhost:11434/v1", model: "llama3.2", note: "No key needed. Run ollama pull with the model name first, and start Ollama with OLLAMA_CONTEXT_LENGTH=32768 or it reads only the end of a long sermon." },
  { name: "LM Studio on this computer", protocol: "openai", base_url: "http://localhost:1234/v1", model: "", note: "No key needed. Start LM Studio's server and type the loaded model's name." },
];

export default function AiSettings({ onChange }: { onChange: (s: LlmSettings) => void }) {
  const [s, setS] = useState<LlmSettings>({ enabled: false, protocol: "openai", base_url: "", model: "", has_key: false });
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<LlmSettings>("llm_settings").then(setS).catch(() => {});
  }, []);

  async function save(apiKey: string | null): Promise<boolean> {
    try {
      await invoke("set_llm_settings", { enabled: s.enabled, protocol: s.protocol, baseUrl: s.base_url, model: s.model, apiKey });
      const fresh = await invoke<LlmSettings>("llm_settings");
      setS(fresh);
      onChange(fresh);
      setKey("");
      setReplacing(false);
      return true;
    } catch (e) {
      toast.error(String(e));
      return false;
    }
  }

  async function saveAndTest() {
    setBusy(true);
    try {
      if (!(await save(key ? key : null))) return;
      const reply = await invoke<string>("llm_complete", {
        system: "You check that a connection works.",
        user: "Reply with the single word OK.",
        maxTokens: 400,
      });
      toast.success("The AI answered: " + reply.trim().slice(0, 60));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  const showKey = !s.has_key || replacing;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="ai-on">Write a live summary of the sermon</Label>
        <Switch id="ai-on" checked={s.enabled} onCheckedChange={(c) => setS({ ...s, enabled: c })} />
      </div>
      <div className="grid grid-cols-[90px_1fr] items-center gap-2">
        <Label>Start from</Label>
        <Select
          value=""
          onValueChange={(name) => {
            const p = PRESETS.find((x) => x.name === name);
            if (!p) return;
            setS({ ...s, protocol: p.protocol, base_url: p.base_url, model: p.model || s.model });
            setNote(p.note);
          }}
        >
          <SelectTrigger><SelectValue placeholder="Choose a service to fill in the address" /></SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label>Speaks</Label>
        <Select value={s.protocol} onValueChange={(v) => setS({ ...s, protocol: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI-compatible (chat completions)</SelectItem>
            <SelectItem value="anthropic">Anthropic-compatible (messages)</SelectItem>
          </SelectContent>
        </Select>
        <Label>Address</Label>
        <Input value={s.base_url} placeholder="https://api.example.com/v1" onChange={(e) => setS({ ...s, base_url: e.target.value })} />
        <Label>Model</Label>
        <Input value={s.model} placeholder="model name" onChange={(e) => setS({ ...s, model: e.target.value })} />
        <Label>API key</Label>
        {showKey ? (
          <Input type="password" value={key} placeholder="blank for a server on this computer" onChange={(e) => setKey(e.target.value)} />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            Saved
            <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>Replace</Button>
            <Button variant="ghost" size="sm" onClick={() => void save("")}>Remove</Button>
          </div>
        )}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div className="flex gap-2">
        <Button onClick={() => void saveAndTest()} disabled={busy}>{busy ? "Testing…" : "Save and test"}</Button>
        <Button variant="outline" onClick={() => void save(key ? key : null)} disabled={busy}>Save</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        While you listen, the transcript and the verses shown go to this service every minute or two, and the summary appears under Sermon
        notes. At Stop the session folder gets summary.md (the AI summary), verses.md (only the verses shown) and transcript.txt (the full
        transcript) next to the recording.
      </p>
    </div>
  );
}
