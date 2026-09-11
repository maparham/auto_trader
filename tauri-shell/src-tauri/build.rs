fn main() {
    // Commands defined by the app (not by a plugin) need an ACL entry, or the
    // capability below cannot grant them and every invoke from the served UI
    // fails with "not allowed". Keep this list in sync with `generate_handler!`.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["ping", "get_settings", "set_settings", "target_url", "notify_native", "set_status", "browser_sign_in"])),
    )
    .expect("failed to run tauri-build");
}
