import { Channel, invoke } from "@tauri-apps/api/core";
import { AbortedError, detectTarget, type Lang, type TranslateHandlers, type Translator } from "./translate";
import type { PairFiles, Reply, Request } from "./ondevice.worker";

export const ONDEVICE_MODEL = "Bergamot by Mozilla";

const WASM = "bergamot-translator.wasm";
const pairFiles = (pair: string) => ({
  model: `${pair}.model.intgemm.alphas.bin`,
  lex: `${pair}.lex.bin`,
  vocab: `${pair}.vocab.spm`,
});

// A loaded engine holds a few hundred MB, so drop it once the user is done for a while.
// Reloading takes well under a second.
const IDLE_UNLOAD_MS = 3 * 60 * 1000;

type Pending = { resolve: (reply: Reply) => void; reject: (err: Error) => void };

/**
 * Translates Korean <-> English on this computer with Mozilla's Bergamot models (the ones
 * Firefox Translations uses). The models are downloaded on first use; text never leaves
 * the machine.
 */
export class OnDeviceTranslator implements Translator {
  private worker: Worker | null = null;
  private loaded = new Set<string>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private generation = 0;
  private idleTimer: number | undefined;

  readonly ready = true;

  cancel() {
    // The engine can't be interrupted mid-sentence; drop the result when it arrives.
    this.generation++;
  }

  /** Free the engine's memory now (it reloads on the next translation). */
  unload() {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = null;
    this.loaded.clear();
    for (const p of this.pending.values()) p.reject(new AbortedError());
    this.pending.clear();
  }

  async translate(text: string, target: Lang, handlers: TranslateHandlers): Promise<void> {
    const generation = ++this.generation;
    const check = () => {
      if (generation !== this.generation) throw new AbortedError();
    };
    clearTimeout(this.idleTimer);

    if (detectTarget(text).source === "other") {
      throw new Error("On-device AI translates only between Korean and English. Switch to Gemini in Settings for other languages.");
    }
    const pair = target === "ko" ? "enko" : "koen";

    try {
      if (!this.loaded.has(pair)) {
        await this.download(pair, handlers, check);
        await this.load(pair);
        check();
      }
      const reply = await this.call({ type: "translate", pair, text });
      check();
      handlers.onText(reply.text ?? "");
    } finally {
      if (generation === this.generation) {
        this.idleTimer = window.setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
      }
    }
  }

  private async download(pair: string, handlers: TranslateHandlers, check: () => void) {
    const ids = [WASM, ...Object.values(pairFiles(pair))];
    if (await invoke<boolean>("ondevice_ready", { ids })) return;

    const onProgress = new Channel<{ received: number; total: number }>();
    onProgress.onmessage = ({ received, total }) => {
      const mb = (n: number) => Math.round(n / 1_000_000);
      handlers.onStatus?.(
        `Downloading the on-device model (first time only)… ${Math.floor((received / total) * 100)}% · ${mb(received)} of ${mb(total)} MB`,
      );
    };
    handlers.onStatus?.("Downloading the on-device model (first time only)…");
    try {
      await invoke("ondevice_download", { ids, onProgress });
    } catch (err) {
      throw new Error(`Couldn't download the on-device model. Check your connection and try again. (${err})`);
    }
    check();
  }

  private async load(pair: string) {
    const ids = pairFiles(pair);
    const read = (id: string) => invoke<ArrayBuffer>("ondevice_file", { id });
    const [model, lex, vocab] = await Promise.all([read(ids.model), read(ids.lex), read(ids.vocab)]);
    const files: PairFiles = { model, lex, vocab };
    const fresh = !this.worker;
    const wasm = fresh ? await read(WASM) : undefined;
    await this.call(
      { type: "load", pair, wasm, files },
      [model, lex, vocab, ...(wasm ? [wasm] : [])],
    );
    this.loaded.add(pair);
  }

  private call(request: DistributiveOmit<Request, "id">, transfer: Transferable[] = []): Promise<Reply> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./ondevice.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data);
    };
    worker.onerror = (e) => {
      const err = new Error(`The on-device engine crashed: ${e.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
      this.loaded.clear();
    };
    this.worker = worker;
    return worker;
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
