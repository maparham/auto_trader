mod auth;

use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![auth::browser_sign_in])
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                auth::handle_urls(&handle, &event.urls());
            });
            // Cold start: the callback that launched the app.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                auth::handle_urls(app.handle(), &urls);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chartkar");
}
