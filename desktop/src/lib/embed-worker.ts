let embedder: any = null;

self.onmessage = async (e: any) => {
  const msg = e.data;
  if (msg.cmd === "embed") {
    try {
      if (!embedder) {
        const url = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
        const mod: any = await import(/* @vite-ignore */ url);
        mod.env.allowLocalModels = false;
        embedder = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "q8",
        });
      }
      const out = await embedder(msg.text, { pooling: "mean", normalize: true });
      (self as any).postMessage({ id: msg.id, vec: Array.from(out.data as Float32Array) });
    } catch (err: any) {
      (self as any).postMessage({ id: msg.id, error: String(err?.message || err) });
    }
  }
};
