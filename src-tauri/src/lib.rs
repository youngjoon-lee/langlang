use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+X";

/// The accelerator string currently registered as the global shortcut.
struct CurrentShortcut(Mutex<Option<String>>);

/// Whether the popup hides itself when another window takes focus (off by default).
struct AutoClose(AtomicBool);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show_popup(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        // No re-centering: the popup reopens wherever the user last dragged it
        // (it starts centered via `center` in tauri.conf.json).
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        let _ = app.emit("popup-shown", ());
    }
}

fn toggle_popup(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_popup(app);
        }
    }
}

/// Replace the global shortcut. Returns an error string (shown in the UI) if the
/// accelerator is invalid or already taken by another app; the old one is kept then.
#[tauri::command]
fn set_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    let new: Shortcut = accelerator
        .parse()
        .map_err(|e| format!("Invalid shortcut \"{accelerator}\": {e}"))?;

    let state = app.state::<CurrentShortcut>();
    let mut current = state.0.lock().unwrap();
    let gs = app.global_shortcut();

    if let Some(old) = current.as_deref().and_then(|s| s.parse::<Shortcut>().ok()) {
        if old == new {
            return Ok(());
        }
        let _ = gs.unregister(old);
    }

    if let Err(e) = gs.register(new) {
        // Restore the previous shortcut so the app stays reachable.
        if let Some(old) = current.as_deref().and_then(|s| s.parse::<Shortcut>().ok()) {
            let _ = gs.register(old);
        }
        return Err(format!("Could not register \"{accelerator}\": {e}"));
    }

    *current = Some(accelerator);
    Ok(())
}

#[tauri::command]
fn set_auto_close(app: AppHandle, enabled: bool) {
    app.state::<AutoClose>().0.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(win) = main_window(&app) {
        let _ = win.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_popup(app);
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_popup(app);
                    }
                })
                .build(),
        )
        .manage(CurrentShortcut(Mutex::new(None)))
        .manage(AutoClose(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            set_shortcut,
            set_auto_close,
            hide_popup
        ])
        .setup(|app| {
            // Menu-bar-only app on macOS: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Register the default right away so the shortcut works even before the
            // frontend loads; the frontend swaps in the user's saved one on startup.
            let _ = set_shortcut(app.handle().clone(), DEFAULT_SHORTCUT.to_string());

            let show = MenuItem::with_id(app, "show", "Open translator", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit langlang", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

            // macOS menu bar icons should be monochrome "template" images that the
            // system tints for light/dark menu bars; elsewhere use the color app icon.
            #[cfg(target_os = "macos")]
            let tray = TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true);
            #[cfg(not(target_os = "macos"))]
            let tray = TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone());

            tray.tooltip("langlang")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_popup(app),
                    "settings" => {
                        show_popup(app);
                        let _ = app.emit("open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // By default the popup stays on top until dismissed with Esc, the close
            // button, or the shortcut; with auto-close on, clicking elsewhere hides it.
            WindowEvent::Focused(false) => {
                if window.state::<AutoClose>().0.load(Ordering::Relaxed) {
                    let _ = window.hide();
                }
            }
            // Closing the window just hides it; quit from the tray menu.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running langlang");
}
