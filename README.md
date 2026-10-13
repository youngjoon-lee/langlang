<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="langlang icon">
</p>

<h1 align="center">langlang</h1>

A tiny popup translator for macOS, Windows, and Linux. Press a global shortcut, paste, and get a translation:

- **Korean text → English**
- **Anything else → Korean**

Built with [Tauri 2](https://tauri.app) and translates with Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`), which is free on the Gemini API free tier.

## Usage

| Action | Keys |
| --- | --- |
| Open / close popup | `⌘⇧X` on macOS, `Ctrl+Shift+X` on Windows/Linux (configurable) |
| Translate | paste (auto), or `Enter` |
| New line in input | `Shift+Enter` |
| Copy translation & close | `⌘Enter` / `Ctrl+Enter` |
| Close | `Esc`, or click anywhere else |

The app lives in the menu bar / system tray (no Dock icon on macOS). Use the tray menu for **Settings…** and **Quit**.

On first launch, the settings screen asks for your free [Gemini API key](https://aistudio.google.com/apikey). It's stored locally in the app's data directory (`settings.json`). In Settings you can also change the shortcut and turn on **auto-paste**, which fills in and translates the clipboard as soon as the popup opens.

## Development

Prerequisites: Rust, Node + pnpm, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS (WebView2 on Windows; `webkit2gtk-4.1`, `libappindicator3`/`libayatana-appindicator3` etc. on Linux).

```sh
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # produce installers (.dmg/.app, .msi/.exe, .deb/.AppImage/.rpm)
```

Build each platform's installer on that platform (or in CI).

### Platform notes

- **Linux / Wayland:** global shortcuts depend on the compositor. Under pure Wayland sessions they may not fire; bind your desktop's own shortcut to launch `langlang` instead. A second launch just opens the popup in the running instance.
- **Transparency:** rounded corners need a compositor on Linux; without one the window is square.

## Layout

- `src-tauri/src/lib.rs`: global shortcut, tray, popup window behavior (show centered, hide on blur/close)
- `src/translate.ts`: direction detection (Hangul vs. Latin script) and the streaming Gemini call
- `src/main.ts`: UI, settings, and keyboard handling
