//! Files for on-device translation: Mozilla's Bergamot engine (wasm) and its
//! Korean <-> English models, the same ones Firefox Translations uses.
//!
//! They're downloaded on first use from Mozilla's attachment CDN (immutable URLs),
//! checked against pinned SHA-256 hashes, and kept in the app data directory. The
//! frontend runs the engine in a web worker; this module only fetches and serves bytes.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, ipc::Channel};

const CDN: &str = "https://firefox-settings-attachments.cdn.mozilla.net/main-workspace";

struct Asset {
    /// Stable id the frontend asks for, also the file name on disk.
    id: &'static str,
    path: &'static str,
    sha256: &'static str,
    size: u64,
}

// From Firefox's Remote Settings: `translations-wasm` (bergamot-translator 3.0) and
// `translations-models` (desktop models, version 2.0). Changing the engine version
// means updating src/vendor/bergamot/bergamot-translator.js to the matching glue.
const ASSETS: &[Asset] = &[
    Asset {
        id: "bergamot-translator.wasm",
        path: "translations-wasm/05082c31-aee8-4249-9e01-c1865afd7520.wasm",
        sha256: "a3a89d9ad0a4ed8f27bf3e403701b23f5709816f6376438503f2fa5b0182c2dc",
        size: 4_960_506,
    },
    Asset {
        id: "enko.model.intgemm.alphas.bin",
        path: "translations-models/4041be52-9e75-41f1-9d4f-04801f112553.bin",
        sha256: "1c310a79b61b8824b2eb26b045db043d92722f3e66ea06998f7c89f48da9f6bc",
        size: 59_504_955,
    },
    Asset {
        id: "enko.lex.bin",
        path: "translations-models/f8a94a6b-264c-4c06-8016-2b57364fbd90.bin",
        sha256: "7734265822ce315c72334ad538e698ab3900ab8e8f04bd43768d0aecad6b6df7",
        size: 6_676_356,
    },
    Asset {
        id: "enko.vocab.spm",
        path: "translations-models/2143a895-2f68-4f00-8ebc-40c9563f304d.spm",
        sha256: "709bf0e425345e0e92ce41ed84348a1296a2107c92bdb6624404450ffecbd1f9",
        size: 1_406_926,
    },
    Asset {
        id: "koen.model.intgemm.alphas.bin",
        path: "translations-models/df186f1f-866e-4a67-af59-6470c3677938.bin",
        sha256: "1c902d6f7a8d7e3efe6ff4f7d4960a369957bca4ce2ce4a6e8572c231d525090",
        size: 59_504_955,
    },
    Asset {
        id: "koen.lex.bin",
        path: "translations-models/9256bedc-fb5d-4a9c-8a20-476fc246a7cb.bin",
        sha256: "471cd980c4ba08c240246f9361f64eb5d627848a135b5731d665f9efaa1e26ae",
        size: 8_617_080,
    },
    Asset {
        id: "koen.vocab.spm",
        path: "translations-models/b82773e2-0043-4160-86de-310155d111fb.spm",
        sha256: "1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598",
        size: 1_410_063,
    },
];

fn asset(id: &str) -> Result<&'static Asset, String> {
    ASSETS
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("Unknown on-device file \"{id}\""))
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ondevice");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A file counts as downloaded once it has the expected size; it was hash-checked
/// before being moved into place.
fn is_downloaded(dir: &Path, a: &Asset) -> bool {
    fs::metadata(dir.join(a.id)).is_ok_and(|m| m.len() == a.size)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    received: u64,
    total: u64,
}

/// Download whichever of `ids` aren't on disk yet, reporting overall progress.
#[tauri::command]
pub async fn ondevice_download(
    app: AppHandle,
    ids: Vec<String>,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let dir = assets_dir(&app)?;
    let missing = ids
        .iter()
        .map(|id| asset(id))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|a| !is_downloaded(&dir, a))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    // reqwest is built without a default TLS crypto provider (same as the updater).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::new();
    let total = missing.iter().map(|a| a.size).sum();
    let mut received = 0;

    for a in missing {
        let mut res = client
            .get(format!("{CDN}/{}", a.path))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Download failed: {e}"))?;

        let tmp = dir.join(format!("{}.part", a.id));
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| format!("Download failed: {e}"))?
        {
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            let _ = on_progress.send(Progress { received, total });
        }
        drop(file);

        let digest = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if digest != a.sha256 {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Downloaded file {} is corrupted.", a.id));
        }
        fs::rename(&tmp, dir.join(a.id)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether all of `ids` are already downloaded.
#[tauri::command]
pub fn ondevice_ready(app: AppHandle, ids: Vec<String>) -> Result<bool, String> {
    let dir = assets_dir(&app)?;
    for id in ids {
        if !is_downloaded(&dir, asset(&id)?) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Raw bytes of one downloaded file (arrives as an ArrayBuffer in the frontend).
#[tauri::command]
pub fn ondevice_file(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let path = assets_dir(&app)?.join(asset(&id)?.id);
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}
