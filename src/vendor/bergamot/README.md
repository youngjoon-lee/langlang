# bergamot-translator glue

`bergamot-translator.js` is the Emscripten glue for the Bergamot translation engine,
copied unmodified from Firefox
([`toolkit/components/translations/bergamot-translator`](https://github.com/mozilla-firefox/firefox/tree/48d55cf7ec80093903e2ef7f58b61a84a22ef716/toolkit/components/translations/bergamot-translator),
bergamot-translator v0.6.0+eea6e5a8). It is licensed under the Mozilla Public License 2.0 (see `LICENSE`).

It must match the wasm binary the app downloads (bergamot-translator 3.0 from Firefox's Remote
Settings, pinned in `src-tauri/src/ondevice.rs`). Update both together.
