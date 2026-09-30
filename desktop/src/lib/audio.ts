export function rmsOf(buf: Float32Array): number {
  if (!buf || !buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export function linearResample(data: Float32Array, srIn: number, srOut: number): Float32Array {
  const ratio = srOut / srIn;
  const n = Math.max(1, Math.floor(data.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const f = x - i0;
    out[i] = data[i0] * (1 - f) + data[i1] * f;
  }
  return out;
}

export function decodeAudioDataP(ctx: AudioContext, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let p: any = null;
    try {
      p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    } catch (e) {
      reject(e);
      return;
    }
    if (p && p.then) p.then(resolve).catch(reject);
  });
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === "audioinput");
  } catch (e) {
    return [];
  }
}

export const AudioCapture = {
  stream: null as MediaStream | null,
  rec: null as MediaRecorder | null,
  chunks: [] as Blob[],
  mime: "",
  genStart: 0,
  running: false,
  ctx: null as AudioContext | null,
  sr: 48000,
  noise: 0.002,
  threshold: 0.006,
  peak: 0,
  level: 0,
  processing: true,

  pickMime(): string | null {
    if (typeof MediaRecorder === "undefined") return null;
    const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const o of opts) {
      try {
        if (MediaRecorder.isTypeSupported(o)) return o;
      } catch (e) {
        /* ignore */
      }
    }
    return "";
  },

  async start(deviceId: string | null, processing: boolean) {
    this.processing = !!processing;
    const constraints: any = {
      audio: {
        echoCancellation: this.processing,
        noiseSuppression: this.processing,
        autoGainControl: this.processing,
        channelCount: 1,
      },
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const mime = this.pickMime();
    if (mime === null) throw new Error("This environment cannot record audio.");
    this.mime = mime || "";
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (e) {
        /* ignore */
      }
    }
    this.sr = this.ctx.sampleRate;
    this.chunks = [];
    this.noise = 0.002;
    this.threshold = 0.006;
    this.peak = 0;
    this.level = 0;
    this.startRecorder();
    this.genStart = Date.now();
    this.running = true;
  },

  startRecorder() {
    const self = this;
    this.rec = new MediaRecorder(this.stream!, this.mime ? { mimeType: this.mime } : undefined);
    this.rec.ondataavailable = function (e: any) {
      if (e.data && e.data.size) self.chunks.push(e.data);
    };
    this.rec.start(1000);
  },

  async restartRecorder() {
    const old = this.rec;
    this.chunks = [];
    this.genStart = Date.now();
    this.startRecorder();
    try {
      if (old) {
        old.ondataavailable = null as any;
        old.stop();
      }
    } catch (e) {
      /* ignore */
    }
  },

  updateLevels(rms: number) {
    this.level = rms;
    if (rms > this.peak) this.peak = rms;
    if (rms < this.noise) this.noise = rms;
    else this.noise = this.noise * 0.9995 + rms * 0.0005;
    this.threshold = Math.max(0.0035, this.noise * 3);
  },

  async getRecentPCM(seconds: number): Promise<{ data: Float32Array; sr: number }> {
    if (!this.running) return { data: new Float32Array(0), sr: this.sr };
    if (Date.now() - this.genStart > 45000) await this.restartRecorder();
    if (!this.chunks.length) return { data: new Float32Array(0), sr: this.sr };
    const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
    let buf: AudioBuffer;
    try {
      buf = await decodeAudioDataP(this.ctx!, await blob.arrayBuffer());
    } catch (e) {
      return { data: new Float32Array(0), sr: this.sr };
    }
    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const n = Math.min(data.length, Math.floor(seconds * sr));
    return { data: data.slice(data.length - n), sr: sr };
  },

  async to16k(data: Float32Array, srIn: number): Promise<Float32Array> {
    if (!data.length) return data;
    if (srIn === 16000) return data;
    try {
      const outLen = Math.max(1, Math.floor((data.length * 16000) / srIn));
      const off = new OfflineAudioContext(1, outLen, 16000);
      const buf = off.createBuffer(1, data.length, srIn);
      buf.getChannelData(0).set(data);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      const out = rendered.getChannelData(0);
      if (out.length === outLen) return out;
      throw new Error("short render");
    } catch (e) {
      return linearResample(data, srIn, 16000);
    }
  },

  ctxState(): string {
    return this.ctx ? this.ctx.state : "closed";
  },

  stop() {
    this.running = false;
    try {
      if (this.rec) {
        this.rec.ondataavailable = null as any;
        this.rec.stop();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      /* ignore */
    }
    try {
      if (this.ctx) this.ctx.close();
    } catch (e) {
      /* ignore */
    }
    this.rec = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
  },
};
