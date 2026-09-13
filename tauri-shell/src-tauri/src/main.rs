#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appnap;
mod browser_auth;
mod settings;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

/// Smoke command: the served UI calls this to prove the bridge is alive.
#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

/// Alerts that fired while the window was hidden, shown as a dock badge and
/// cleared the moment the user looks at the window again.
#[derive(Default)]
struct Unread(AtomicU32);

fn set_badge(app: &tauri::AppHandle, count: u32) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
}

/// The window's boot URL, which is the bundled splash page. Captured at startup
/// rather than spelled out: the asset origin is the runtime's business, and a
/// hardcoded "tauri://localhost/splash.html" resolves to "asset not found".
struct SplashUrl(std::sync::Mutex<Option<tauri::Url>>);

/// The one place the summon hotkey is defined.
const SUMMON_HOTKEY: &str = "CmdOrCtrl+Alt+T";

/// Show and focus the main window. Every "bring it back" path goes through here.
fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // Every path that reveals the window clears the backlog, so the badge can
    // never outlive the alerts the user has now seen.
    app.state::<Unread>().0.store(0, Ordering::Relaxed);
    set_badge(app, 0);
}

fn hide_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// The menu-bar glyph is a single static template image; it no longer changes
/// with live-engine state. The command stays registered because the web app
/// still invokes it on every transition (lib/shellStatus.ts).
#[tauri::command]
fn set_status(_app: tauri::AppHandle, _state: String) {}

/// Post a real macOS banner. The web app calls this instead of the Web
/// Notification API when it detects the shell: the window is normally hidden,
/// and a hidden WKWebView's own notifications are unreliable.
#[tauri::command]
fn notify_native(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;

    // Only alerts the user could not see should accumulate.
    let hidden = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .map(|visible| !visible)
        .unwrap_or(true);
    if hidden {
        let n = app.state::<Unread>().0.fetch_add(1, Ordering::Relaxed) + 1;
        set_badge(&app, n);
    }
    Ok(())
}

/// The address the splash waits on, and the app the shell finally shows.
#[tauri::command]
fn target_url(app: tauri::AppHandle) -> String {
    settings::load(&app).url
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
fn set_settings(app: tauri::AppHandle, url: String, autostart: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let url = settings::Settings::validate_url(&url)?;
    settings::save(&app, &settings::Settings { url: url.clone(), autostart })?;
    let launcher = app.autolaunch();
    let _ = if autostart { launcher.enable() } else { launcher.disable() };
    // Re-point the live window at once: no restart, no rebuild.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!(
            "window.location.replace({})",
            serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into())
        ));
    }
    Ok(())
}

/// Send the main window back to the splash, which probes the configured URL and
/// navigates on as soon as it answers. Going through the splash (rather than a
/// plain reload) means a wedged or dead UI lands on the retry loop instead of a
/// raw WebKit error page.
fn reload_ui(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        eprintln!("shell: reload found no main window");
        return;
    };
    // An absolute URL, never a relative path: once the window is on
    // http://localhost:5173, "splash.html" would resolve against THAT origin.
    let url = app.state::<SplashUrl>().0.lock().ok().and_then(|u| u.clone());
    // Loud on failure: this is the documented recovery for a wedged UI, so a
    // silent no-op here is worse than an error in the log.
    match url {
        None => eprintln!("shell: reload has no splash url recorded"),
        Some(url) => {
            if let Err(e) = w.navigate(url.clone()) {
                eprintln!("shell: reload could not navigate to {url}: {e}");
            }
        }
    }
}

/// Open the settings window, or focus it if it is already up.
fn open_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Chartkar Settings")
    .inner_size(460.0, 260.0)
    .resizable(false)
    .build();
}

fn main() {
    tauri::Builder::default()
        .manage(Unread::default())
        .manage(SplashUrl(std::sync::Mutex::new(None)))
        .manage(browser_auth::PendingAuth::default())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ping, get_settings, set_settings, target_url, notify_native, set_status, browser_auth::browser_sign_in])
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            appnap::hold_activity_assertion();

            // Remember where the window booted (the splash) before it navigates
            // on, so tray Reload can send it back there.
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(url) = w.url() {
                    if let Ok(mut slot) = app.state::<SplashUrl>().0.lock() {
                        *slot = Some(url);
                    }
                }
            }

            // Re-register autostart against the binary that is actually running.
            // Without this the LaunchAgent keeps whatever path was current when
            // the toggle was last flipped, so a dev-build registration survives
            // into the shipped app and starts a stale (or deleted) binary.
            {
                use tauri_plugin_autostart::ManagerExt;
                if settings::load(app.handle()).autostart {
                    let launcher = app.autolaunch();
                    let _ = launcher.disable();
                    let _ = launcher.enable();
                }
            }

            // Summon from anywhere. Registered in setup because registration is
            // fallible and wants a live app handle.
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                app.global_shortcut()
                    .on_shortcut(SUMMON_HOTKEY, |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            show_window(app);
                        }
                    })?;
                println!(
                    "shell: summon hotkey {SUMMON_HOTKEY} registered={}",
                    app.global_shortcut().is_registered(SUMMON_HOTKEY)
                );
            }

            // The stock macOS app menu binds Cmd+Q to a real quit. Rebuild the
            // app submenu without it and hand Cmd+Q to a Hide item instead, so
            // no reflexive keystroke can kill the live engine. Cmd+W and the red
            // button go through the close-request interceptor below.
            let hide_item = MenuItemBuilder::with_id("hide-window", "Hide Window")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let reload_item = MenuItemBuilder::with_id("reload-ui", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Chartkar")
                .about(Some(AboutMetadata::default()))
                .separator()
                .item(&hide_item)
                .item(&reload_item)
                .hide()
                .hide_others()
                .separator()
                .close_window()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let menu = MenuBuilder::new(app).items(&[&app_menu, &edit_menu]).build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "hide-window" {
                    // Chrome-style double-press quit: one Cmd+Q hides the
                    // window (the engine keeps running); a second within 2s
                    // really quits.
                    static LAST_Q: Mutex<Option<Instant>> = Mutex::new(None);
                    let now = Instant::now();
                    let mut last = LAST_Q.lock().unwrap();
                    if last.is_some_and(|t| now.duration_since(t) < Duration::from_secs(2)) {
                        app.exit(0);
                    }
                    *last = Some(now);
                    hide_window(app);
                } else if event.id() == "reload-ui" {
                    reload_ui(app);
                }
            });

            // Ask once at launch, so a banner fired hours later is not the first
            // time macOS has heard of us.
            {
                use tauri_plugin_notification::{NotificationExt, PermissionState};
                let granted = app
                    .notification()
                    .permission_state()
                    .map(|s| s == PermissionState::Granted)
                    .unwrap_or(false);
                if !granted {
                    let _ = app.notification().request_permission();
                }
            }

            // The menu-bar icon: the only place the app can be truly quit from,
            // and the way back to a hidden window.
            let show = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let hide = MenuItemBuilder::with_id("hide", "Hide Window").build(app)?;
            let reload = MenuItemBuilder::with_id("reload", "Reload").build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings...").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show, &hide, &reload, &settings, &quit])
                .build()?;

            TrayIconBuilder::with_id("main-tray")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "hide" => hide_window(app),
                    "reload" => reload_ui(app),
                    "settings" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide instead of closing: the WKWebView keeps running, so the
                // browser-driven live engine stays armed.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building auto-trader shell")
        .run(|app, event| {
            // Clicking the dock icon (or a notification banner) reopens rather
            // than launching a second instance: treat it as "show me".
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app);
            }
        });
}
