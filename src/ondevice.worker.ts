// Runs Mozilla's Bergamot translation engine (the one Firefox Translations uses) off the
// UI thread. Translation is synchronous and CPU-bound, so it lives in this worker.
import glue from "./vendor/bergamot/bergamot-translator.js?raw";

// The wasm module's embind classes are untyped.
type Bergamot = any;

// The glue is a classic script that defines `loadBergamot`; evaluate it to get the function.
const loadBergamot = new Function(`${glue}\nreturn loadBergamot;`)() as (module: object) => Bergamot;

export type PairFiles = { model: ArrayBuffer; lex: ArrayBuffer; vocab: ArrayBuffer };

export type Request =
  | { id: number; type: "load"; pair: string; wasm?: ArrayBuffer; files: PairFiles }
  | { id: number; type: "translate"; pair: string; text: string };

export type Reply = { id: number; text?: string; error?: string };

const ctx = self as unknown as {
  postMessage(message: Reply): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};

// Same alignments and decoder settings as Firefox's translations-engine.worker.js.
const ALIGNMENT: Record<keyof PairFiles, number> = { model: 256, lex: 64, vocab: 64 };
const CONFIG = {
  "beam-size": "1",
  normalize: "1.0",
  "word-penalty": "0",
  "max-length-break": "128",
  "mini-batch-words": "1024",
  workspace: "128",
  "max-length-factor": "2.0",
  "skip-cost": "true",
  "cpu-threads": "0",
  quiet: "true",
  "quiet-translation": "true",
  // The ko<->en models are "intgemm.alphas" models.
  "gemm-precision": "int8shiftAlphaAll",
  alignment: "soft",
};

let bergamot: Bergamot | null = null;
let service: Bergamot | null = null;
const models = new Map<string, Bergamot>();

function initEngine(wasmBinary: ArrayBuffer): Promise<Bergamot> {
  return new Promise((resolve, reject) => {
    const module = loadBergamot({
      // Start small and let the heap grow, as Firefox does.
      INITIAL_MEMORY: 41_943_040,
      print: () => {},
      printErr: (s: string) => console.warn("[bergamot]", s),
      onAbort: () => reject(new Error("The on-device engine failed to start.")),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        resolve(module);
      },
      wasmBinary,
    });
  });
}

function configText(): string {
  // Marian expects YAML with this exact indentation.
  const indent = "            ";
  return "\n" + Object.entries(CONFIG).map(([k, v]) => `${indent}${k}: ${v}\n`).join("") + indent;
}

function loadModel(b: Bergamot, pair: string, files: PairFiles): Bergamot {
  const aligned = {} as Record<keyof PairFiles, Bergamot>;
  for (const key of Object.keys(ALIGNMENT) as (keyof PairFiles)[]) {
    const memory = new b.AlignedMemory(files[key].byteLength, ALIGNMENT[key]);
    memory.getByteArrayView().set(new Uint8Array(files[key]));
    aligned[key] = memory;
  }
  const vocabs = new b.AlignedMemoryList();
  vocabs.push_back(aligned.vocab);
  const [from, to] = [pair.slice(0, 2), pair.slice(2)];
  return new b.TranslationModel(from, to, configText(), aligned.model, aligned.lex, vocabs, null);
}

function translate(b: Bergamot, model: Bergamot, text: string): string {
  const messages = new b.VectorString();
  const options = new b.VectorResponseOptions();
  let responses: Bergamot | null = null;
  try {
    messages.push_back(text);
    options.push_back({ qualityScores: false, alignment: true, html: false });
    responses = service.translate(model, messages, options);
    return responses.get(0).getTranslatedText();
  } finally {
    messages.delete();
    options.delete();
    responses?.delete();
  }
}

ctx.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      if (!bergamot) {
        if (!data.wasm) throw new Error("The on-device engine isn't loaded.");
        bergamot = await initEngine(data.wasm);
        service = new bergamot.BlockingService({ cacheSize: 0 });
      }
      if (!models.has(data.pair)) models.set(data.pair, loadModel(bergamot, data.pair, data.files));
      ctx.postMessage({ id: data.id });
    } else {
      const model = models.get(data.pair);
      if (!bergamot || !model) throw new Error(`The ${data.pair} model isn't loaded.`);
      ctx.postMessage({ id: data.id, text: translate(bergamot, model, data.text) });
    }
  } catch (err) {
    ctx.postMessage({ id: data.id, error: err instanceof Error ? err.message : String(err) });
  }
};
