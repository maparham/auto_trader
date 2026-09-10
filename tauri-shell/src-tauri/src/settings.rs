// The shell's only persisted state: which URL to load, and whether to come back
// after a reboot. Stored as JSON in the app data dir via the store plugin.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

pub const DEFAULT_URL: &str = "http://localhost:5173";
const STORE_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub url: String,
    pub autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Autostart defaults on: after a reboot the shell comes back on its own
        // and the menu-bar icon is there without a manual step.
        Self { url: DEFAULT_URL.to_string(), autostart: true }
    }
}

impl Settings {
    pub fn from_json(v: &serde_json::Value) -> Self {
        let d = Settings::default();
        Settings {
            url: v.get("url").and_then(|x| x.as_str()).unwrap_or(&d.url).to_string(),
            autostart: v.get("autostart").and_then(|x| x.as_bool()).unwrap_or(d.autostart),
        }
    }

    pub fn validate_url(raw: &str) -> Result<String, String> {
        let parsed = url::Url::parse(raw.trim()).map_err(|e| e.to_string())?;
        match parsed.scheme() {
            "http" | "https" => Ok(parsed.to_string()),
            other => Err(format!("unsupported scheme: {other}")),
        }
    }
}

pub fn load(app: &AppHandle<Wry>) -> Settings {
    let Ok(store) = app.store(STORE_FILE) else {
        return Settings::default();
    };
    let mut obj = serde_json::Map::new();
    if let Some(v) = store.get("url") {
        obj.insert("url".into(), v);
    }
    if let Some(v) = store.get("autostart") {
        obj.insert("autostart".into(), v);
    }
    Settings::from_json(&serde_json::Value::Object(obj))
}

pub fn save(app: &AppHandle<Wry>, s: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("url", serde_json::json!(s.url));
    store.set("autostart", serde_json::json!(s.autostart));
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_the_store_is_empty() {
        let s = Settings::from_json(&serde_json::json!({}));
        assert_eq!(s.url, DEFAULT_URL);
        assert!(s.autostart);
    }

    #[test]
    fn reads_a_stored_pair() {
        let s = Settings::from_json(&serde_json::json!({
            "url": "http://box.local:5173",
            "autostart": false
        }));
        assert_eq!(s.url, "http://box.local:5173");
        assert!(!s.autostart);
    }

    #[test]
    fn rejects_a_non_url() {
        assert!(Settings::validate_url("not a url").is_err());
        assert!(Settings::validate_url("ftp://box.local").is_err());
        assert!(Settings::validate_url("http://localhost:5173").is_ok());
    }
}
