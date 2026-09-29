fn main() {
    // App commands need an ACL entry or invokes fail with "not allowed".
    // Keep this list in sync with `generate_handler!` in lib.rs.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["browser_sign_in"])),
    )
    .expect("failed to run tauri-build");
}
