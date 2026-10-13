import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Translator, detectTarget, describeError, type Lang } from "./translate";

const DEFAULT_SHORTCUT = "CommandOrControl+Shift+X";
const IS_MAC = navigator.userAgent.includes("Mac");

const store = new LazyStore("settings.json");
const translator = new Translator();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = $<HTMLTextAreaElement>("source");
const result = $<HTMLDivElement>("result");
const direction = $<HTMLSpanElement>("direction");
const copyBtn = $<HTMLButtonElement>("copy-btn");
const translateView = $<HTMLElement>("translate-view");
const settingsView = $<HTMLElement>("settings-view");
const apiKeyInput = $<HTMLInputElement>("api-key");
const shortcutInput = $<HTMLInputElement>("shortcut");
const shortcutMsg = $<HTMLElement>("shortcut-msg");
const autoPasteInput = $<HTMLInputElement>("auto-paste");

let shortcut = DEFAULT_SHORTCUT;
let autoPaste = false;
let pendingShortcut = DEFAULT_SHORTCUT;
let lastTranslated = "";

// ---------- shortcut formatting ----------

/** Turn "CommandOrControl+Shift+X" into "⌘⇧X" on macOS or "Ctrl+Shift+X" elsewhere. */
function prettyShortcut(accel: string): string {
  const parts = accel.split("+").map((p) => {
    switch (p) {
      case "CommandOrControl":
      case "CmdOrCtrl":
        return IS_MAC ? "⌘" : "Ctrl";
      case "Command":
      case "Super":
        return IS_MAC ? "⌘" : "Win";
      case "Control":
        return IS_MAC ? "⌃" : "Ctrl";
      case "Alt":
        return IS_MAC ? "⌥" : "Alt";
      case "Shift":
        return IS_MAC ? "⇧" : "Shift";
      default:
        return p;
    }
  });
  return IS_MAC ? parts.join("") : parts.join("+");
}

/** Build a Tauri accelerator string from a keydown event, or null if it's only modifiers. */
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (["Space", "Enter", "Tab", "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight",
    "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"].includes(code)) key = code;
  else if (code.startsWith("Arrow")) key = code.slice(5);
  if (!key) return null;

  const mods: string[] = [];
  // ⌘ on macOS and Ctrl elsewhere map to the same cross-platform modifier.
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push("CommandOrControl");
  if (IS_MAC && e.ctrlKey) mods.push("Control");
  if (!IS_MAC && e.metaKey) mods.push("Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // Require a modifier unless it's a function key, so we don't hijack plain typing.
  if (mods.length === 0 && !/^F\d/.test(key)) return null;
  return [...mods, key].join("+");
}

// ---------- translate view ----------

function setDirection(text: string) {
  if (!text.trim()) {
    direction.textContent = "EN ⇄ 한";
    return;
  }
  const { target } = detectTarget(text);
  direction.textContent = target === "en" ? "한 → EN" : "→ 한국어";
}

function showError(message: string) {
  result.classList.remove("streaming");
  result.classList.add("error");
  result.textContent = message;
  copyBtn.hidden = true;
}

async function runTranslation() {
  const text = source.value.trim();
  if (!text) return;
  if (!translator.ready) {
    openSettings();
    shortcutMsg.textContent = "Add your API key to start translating.";
    return;
  }
  if (text === lastTranslated && result.textContent && !result.classList.contains("error")) return;

  const { target } = detectTarget(text);
  setDirection(text);
  lastTranslated = text;
  result.textContent = "";
  result.classList.remove("error");
  result.classList.add("streaming");
  copyBtn.hidden = true;

  try {
    await translator.translate(text, target as Lang, {
      onText: (delta) => {
        result.textContent += delta;
      },
    });
    result.textContent = (result.textContent ?? "").trim();
    result.classList.remove("streaming");
    copyBtn.hidden = !result.textContent;
  } catch (err) {
    const message = describeError(err);
    if (message) {
      lastTranslated = "";
      showError(message);
    }
  }
}

async function copyResult(): Promise<boolean> {
  const text = result.textContent?.trim();
  if (!text || result.classList.contains("error")) return false;
  await writeText(text);
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
  return true;
}

source.addEventListener("input", () => setDirection(source.value));

// Translate as soon as something is pasted — that's the main flow.
source.addEventListener("paste", () => {
  setTimeout(runTranslation, 0);
});

source.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    if (await copyResult()) await invoke("hide_popup");
  } else if (!e.shiftKey) {
    e.preventDefault();
    lastTranslated = "";
    runTranslation();
  }
});

copyBtn.addEventListener("click", copyResult);

$("paste-btn").addEventListener("click", async () => {
  const clip = (await readText().catch(() => "")).trim();
  source.focus();
  if (!clip) {
    showError("The clipboard has no text.");
    return;
  }
  source.value = clip;
  setDirection(clip);
  lastTranslated = "";
  runTranslation();
});

// ---------- settings view ----------

function openSettings() {
  apiKeyInput.value = apiKeyInput.dataset.saved ?? "";
  pendingShortcut = shortcut;
  shortcutInput.value = prettyShortcut(shortcut);
  shortcutMsg.textContent = "Click the box and press the keys you want to use.";
  shortcutMsg.classList.remove("error");
  autoPasteInput.checked = autoPaste;
  translateView.hidden = true;
  settingsView.hidden = false;
  apiKeyInput.focus();
}

function closeSettings() {
  settingsView.hidden = true;
  translateView.hidden = false;
  source.focus();
}

shortcutInput.addEventListener("keydown", (e) => {
  if (e.key === "Tab") return;
  e.preventDefault();
  if (e.key === "Escape") {
    shortcutInput.blur();
    return;
  }
  const accel = acceleratorFromEvent(e);
  if (accel) {
    pendingShortcut = accel;
    shortcutInput.value = prettyShortcut(accel);
    shortcutMsg.classList.remove("error");
    shortcutMsg.textContent = "Press Save to apply.";
  }
});

$("settings-cancel").addEventListener("click", closeSettings);
$("settings-btn").addEventListener("click", () => (settingsView.hidden ? openSettings() : closeSettings()));

$("settings-save").addEventListener("click", async () => {
  try {
    await invoke("set_shortcut", { accelerator: pendingShortcut });
  } catch (err) {
    shortcutMsg.textContent = String(err);
    shortcutMsg.classList.add("error");
    return;
  }
  shortcut = pendingShortcut;
  autoPaste = autoPasteInput.checked;
  const key = apiKeyInput.value.trim();
  translator.setApiKey(key);
  apiKeyInput.dataset.saved = key;

  await store.set("geminiApiKey", key);
  await store.set("shortcut", shortcut);
  await store.set("autoPaste", autoPaste);
  await store.save();
  updateHints();
  closeSettings();
});

// ---------- window behaviour ----------

function updateHints() {
  document.querySelectorAll<HTMLElement>("kbd.mod").forEach((k) => (k.textContent = IS_MAC ? "⌘" : "Ctrl"));
  source.title = `Open with ${prettyShortcut(shortcut)}`;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) {
    if (!settingsView.hidden && document.activeElement !== shortcutInput) closeSettings();
    else if (settingsView.hidden) invoke("hide_popup");
  }
});

listen("popup-shown", async () => {
  if (!settingsView.hidden) return;
  source.focus();
  if (autoPaste) {
    const clip = (await readText().catch(() => "")).trim();
    if (clip && clip !== source.value.trim()) {
      source.value = clip;
      setDirection(clip);
      runTranslation();
      return;
    }
  }
  // Select the previous text so a fresh paste replaces it.
  source.select();
});

listen("open-settings", openSettings);

// Open in the default browser rather than navigating the popup's webview.
$<HTMLAnchorElement>("github-link").addEventListener("click", (e) => {
  e.preventDefault();
  openUrl((e.currentTarget as HTMLAnchorElement).href);
});

// ---------- startup ----------

(async () => {
  const savedKey = (await store.get<string>("geminiApiKey")) ?? "";
  shortcut = (await store.get<string>("shortcut")) ?? DEFAULT_SHORTCUT;
  autoPaste = (await store.get<boolean>("autoPaste")) ?? false;

  translator.setApiKey(savedKey);
  apiKeyInput.dataset.saved = savedKey;

  if (shortcut !== DEFAULT_SHORTCUT) {
    await invoke("set_shortcut", { accelerator: shortcut }).catch((err) => {
      console.error(err);
      shortcut = DEFAULT_SHORTCUT;
    });
  }
  updateHints();
  $("app-version").textContent = `v${await getVersion()}`;
  if (!savedKey) openSettings();
})();
