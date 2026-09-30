export const STT = {
  worker: null as Worker | null,
  status: "idle",
  device: "none",
  modelId: null as string | null,
  lastMs: 0,
  pending: new Map<number, { resolve: (t: string) => void; reject: (e: any) => void }>(),
  seq: 1,
  onStatus: null as ((p: any) => void) | null,

  ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./stt-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: any) => {
        const m = e.data;
        if (m.type === "loaded") {
          this.device = m.device;
          this.status = "ready";
        } else if (m.type === "progress") {
          if (m.p && this.onStatus) this.onStatus(m.p);
        } else if (m.type === "loadError") {
          this.status = "error";
          if (this.onStatus) this.onStatus({ status: "load failed: " + m.error });
        } else if (m.type === "result") {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            this.lastMs = m.ms || 0;
            if (m.error) p.reject(new Error(m.error));
            else p.resolve(m.text);
          }
        }
      };
    }
    return this.worker;
  },

  availableModels() {
    return [
      { id: "onnx-community/whisper-tiny.en", label: "Whisper tiny.en (40 MB, fast)" },
      { id: "onnx-community/whisper-base.en", label: "Whisper base.en (80 MB, better)" },
    ];
  },

  async load(modelId: string, onProgress: ((p: any) => void) | null, useWebgpu: boolean) {
    this.status = "loading";
    this.modelId = modelId;
    this.ensureWorker();
    this.onStatus = onProgress;
    this.worker!.postMessage({ cmd: "load", modelId: modelId, useWebgpu: useWebgpu });
    return new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (this.status === "ready") {
          clearInterval(check);
          resolve();
        } else if (this.status === "error") {
          clearInterval(check);
          reject(new Error("model load failed"));
        }
      }, 200);
    });
  },

  async transcribe(f32: Float32Array): Promise<string> {
    if (this.status !== "ready") throw new Error("model not loaded");
    const id = this.seq++;
    const copy = f32.slice();
    const p = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("transcription timed out"));
        }
      }, 60000);
    });
    this.worker!.postMessage({ cmd: "transcribe", id: id, f32: copy }, [copy.buffer]);
    return p;
  },
};
