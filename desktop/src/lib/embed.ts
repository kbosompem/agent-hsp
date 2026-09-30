export const Embedder = {
  worker: null as Worker | null,
  pending: new Map<number, { resolve: (v: Float32Array) => void; reject: (e: any) => void }>(),
  seq: 1,

  ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./embed-worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (e: any) => {
        const m = e.data;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error));
          else p.resolve(new Float32Array(m.vec));
        }
      };
    }
    return this.worker;
  },

  async embed(text: string): Promise<Float32Array> {
    const id = this.seq++;
    this.ensure();
    const p = new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("embedding timed out"));
        }
      }, 30000);
    });
    this.worker!.postMessage({ cmd: "embed", id: id, text: text });
    return p;
  },
};
