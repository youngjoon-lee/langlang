import { AbortedError, type Lang, type TranslateHandlers, type Translator } from "./translate";

export const GOOGLE_NAME = "Google Translate (unofficial)";

// The keyless endpoint Google Translate's own web clients use (the same one the
// googletrans library uses). It isn't an official API: Google may rate-limit or block
// a network for a while, so the other translators stay available in Settings.
const ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t";

export class GoogleError extends Error {}

export class GoogleTranslator implements Translator {
  private current: AbortController | null = null;

  readonly ready = true;

  cancel() {
    this.current?.abort();
    this.current = null;
  }

  async translate(text: string, target: Lang, handlers: TranslateHandlers): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.current = controller;

    try {
      // POST so long texts don't hit URL length limits.
      const res = await fetch(`${ENDPOINT}&tl=${target}`, {
        method: "POST",
        body: new URLSearchParams({ q: text }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        throw new GoogleError(
          "Google Translate is temporarily blocking requests from your network. Try again later, or switch translators in Settings.",
        );
      }
      if (!res.ok) throw new GoogleError(`Google Translate error ${res.status}.`);

      // [[["translated", "original", …], …], null, "detected source", …]
      const data = (await res.json()) as [[string | null, ...unknown[]][] | null, ...unknown[]];
      const translated = (data[0] ?? []).map((segment) => segment[0] ?? "").join("");
      handlers.onText(translated);
    } catch (err) {
      if (controller.signal.aborted) throw new AbortedError();
      if (err instanceof TypeError) throw new GoogleError("Can't reach Google Translate. Check your connection.");
      throw err;
    } finally {
      if (this.current === controller) this.current = null;
    }
  }
}
