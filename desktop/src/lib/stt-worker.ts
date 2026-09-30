let asr: any = null;
let device = "none";

function post(m: any) {
  (self as any).postMessage(m);
}

function withTimeout(p: Promise<any>, ms: number, label: string): Promise<any> {
  return Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(label + " timed out after " + Math.round(ms / 1000) + " s")), ms)
    ),
  ]);
}

self.onmessage = async (e: any) => {
  const msg = e.data;
  if (msg.cmd === "load") {
    try {
      const url = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
      const mod: any = await import(/* @vite-ignore */ url);
      mod.env.allowLocalModels = false;
      const attempts = msg.useWebgpu
        ? [
            { device: "webgpu", dtype: "q8" },
            { device: "wasm", dtype: "q8" },
            { device: "wasm", dtype: "fp32" },
          ]
        : [
            { device: "wasm", dtype: "q8" },
            { device: "wasm", dtype: "fp32" },
          ];
      for (const a of attempts) {
        try {
          post({ type: "progress", status: "init " + a.device + "/" + a.dtype });
          asr = await withTimeout(
            mod.pipeline("automatic-speech-recognition", msg.modelId, {
              device: a.device,
              dtype: a.dtype,
              progress_callback: (p: any) => post({ type: "progress", p }),
            }),
            180000,
            "model load (" + a.device + "/" + a.dtype + ")"
          );
          device = a.device + "/" + a.dtype;
          post({ type: "loaded", device });
          return;
        } catch (err: any) {
          asr = null;
        }
      }
      post({ type: "loadError", error: "all model attempts failed" });
    } catch (e: any) {
      post({ type: "loadError", error: String(e?.message || e) });
    }
  } else if (msg.cmd === "transcribe") {
    if (!asr) {
      post({ type: "result", id: msg.id, text: "", ms: 0, error: "model not loaded" });
      return;
    }
    try {
      const t0 = performance.now();
      const out = await withTimeout(
        asr(msg.f32, { chunk_length_s: 30, stride_length_s: 5 }),
        60000,
        "transcription"
      );
      const ms = Math.round(performance.now() - t0);
      const text = (out && out.text ? out.text : "").trim();
      post({ type: "result", id: msg.id, text, ms });
    } catch (e: any) {
      post({ type: "result", id: msg.id, text: "", ms: 0, error: String(e?.message || e) });
    }
  }
};
