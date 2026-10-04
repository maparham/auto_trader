mod auth;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![auth::browser_sign_in])
        .manage(auth::ColdStart::default())
        .setup(|app| {
            // The deep-link callback and setup run on Android's main thread,
            // and both the store and the webview round-trip through it, so
            // resolving and navigating always happen on a worker thread.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let handle = handle.clone();
                let urls = event.urls();
                std::thread::spawn(move || {
                    if let Some(target) = auth::resolve_urls(&handle, &urls) {
                        auth::go_to(&handle, &target);
                    }
                });
            });
            // Cold start: the callback that launched the app. Applied once
            // the first page load finishes (see on_page_load below).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                *app.state::<auth::ColdStart>().0.lock().unwrap() = Some(urls);
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let app = webview.app_handle().clone();
            let urls = app.state::<auth::ColdStart>().0.lock().unwrap().take();
            if let Some(urls) = urls {
                std::thread::spawn(move || {
                    if let Some(target) = auth::resolve_urls(&app, &urls) {
                        auth::go_to(&app, &target);
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Chartkar");
}
