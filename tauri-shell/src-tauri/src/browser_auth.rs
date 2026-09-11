//! Browser-auth loopback handoff (RFC 8252 shape): `browser_sign_in` opens the
//! default browser at the configured UI's handoff page with a one-shot
//! listener's port and a state nonce; the page redirects a single-use Clerk
//! sign-in token back to 127.0.0.1, and the main window is navigated to the
//! app with ?__clerk_ticket= for the frontend to consume.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// The state nonce of the currently pending sign-in attempt, if any. A new
/// attempt replaces it; the superseded listener thread notices and exits.
#[derive(Default)]
pub struct PendingAuth(pub Mutex<Option<String>>);

const DEADLINE: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);

const RESPONSE_OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
<!doctype html><meta charset=\"utf-8\"><title>Auto Trader</title>\
<body style=\"font:14px -apple-system,sans-serif;display:grid;place-items:center;height:100vh\">\
Signed in. You can close this tab and return to Auto Trader.</body>";

const RESPONSE_FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nforbidden";

fn random_state() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// "GET /callback?ticket=..&state=.. HTTP/1.1" -> (ticket, state).
/// Percent-decoding via the url crate; anything else is None.
pub fn parse_callback(request_line: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    let u = url::Url::parse(&format!("http://loopback{path}")).ok()?;
    if u.path() != "/callback" {
        return None;
    }
    let mut ticket = None;
    let mut state = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "ticket" => ticket = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    match (ticket, state) {
        (Some(t), Some(s)) if !t.is_empty() && !s.is_empty() => Some((t, s)),
        _ => None,
    }
}

/// The Chrome-side boot URL: the configured UI's ORIGIN (path dropped) with
/// the handoff query. None if the configured URL does not parse.
pub fn handoff_url(configured: &str, port: u16, state: &str) -> Option<String> {
    let base = url::Url::parse(configured).ok()?;
    let mut u = base.join("/").ok()?;
    u.query_pairs_mut()
        .append_pair("shell_auth", "1")
        .append_pair("port", &port.to_string())
        .append_pair("state", state);
    Some(u.to_string())
}

/// The webview target once a ticket arrived: the configured URL as-is with
/// __clerk_ticket appended (existing query preserved).
pub fn ticket_url(configured: &str, ticket: &str) -> Option<String> {
    let mut u = url::Url::parse(configured).ok()?;
    u.query_pairs_mut().append_pair("__clerk_ticket", ticket);
    Some(u.to_string())
}

/// Start (or restart) a browser sign-in. Returns the loopback port; the
/// frontend button treats any non-number reply as failure.
#[tauri::command]
pub fn browser_sign_in(app: tauri::AppHandle) -> Result<u16, String> {
    use tauri_plugin_opener::OpenerExt;

    let configured = crate::settings::load(&app).url;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_state();
    let url = handoff_url(&configured, port, &state)
        .ok_or_else(|| "the configured UI URL is invalid".to_string())?;

    // Replace any pending attempt; its listener thread exits on the mismatch.
    *app.state::<PendingAuth>().0.lock().unwrap() = Some(state.clone());

    let handle = app.clone();
    std::thread::spawn(move || listen(handle, listener, state));
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(port)
}

/// True and cleared only if the slot still holds `my_state`; false and left
/// untouched otherwise. The single place that decides whether a listener
/// thread is still the one allowed to act.
fn claim_slot(slot: &mut Option<String>, my_state: &str) -> bool {
    if slot.as_deref() == Some(my_state) {
        *slot = None;
        true
    } else {
        false
    }
}

/// Clear the slot only if it still holds `my_state`. Same guard as
/// `claim_slot`, kept separate because the deadline path has no ticket to
/// act on, just cleanup.
fn release_slot(slot: &mut Option<String>, my_state: &str) {
    if slot.as_deref() == Some(my_state) {
        *slot = None;
    }
}

fn listen(app: tauri::AppHandle, listener: TcpListener, my_state: String) {
    let deadline = Instant::now() + DEADLINE;
    while Instant::now() < deadline {
        {
            let pending = app.state::<PendingAuth>();
            let slot = pending.0.lock().unwrap();
            if slot.as_deref() != Some(my_state.as_str()) {
                return; // superseded by a newer attempt
            }
        }
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(_) => {
                std::thread::sleep(POLL);
                continue;
            }
        };
        // The listener is non-blocking (accept polling); the callback read
        // must not be, or a slow browser write races us into an empty read.
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let first = text.lines().next().unwrap_or("");
        match parse_callback(first) {
            // A wrong state gets a 403 and the listener KEEPS waiting: an
            // attacker must not be able to burn the slot out from under the
            // real callback.
            Some((ticket, state)) if state == my_state => {
                // Re-check and claim under the same lock: a newer attempt may
                // have superseded us between the loop-top check and this
                // read, and a superseded thread must not act on its own
                // stale ticket, clear the new attempt's slot, or navigate.
                let pending = app.state::<PendingAuth>();
                let mut slot = pending.0.lock().unwrap();
                if !claim_slot(&mut slot, &my_state) {
                    return; // superseded mid-read: do not act
                }
                drop(slot);
                let _ = stream.write_all(RESPONSE_OK.as_bytes());
                finish(&app, &ticket);
                return;
            }
            _ => {
                let _ = stream.write_all(RESPONSE_FORBIDDEN.as_bytes());
            }
        }
    }
    // Deadline passed: clear the pending slot only if it is still ours.
    let pending = app.state::<PendingAuth>();
    let mut slot = pending.0.lock().unwrap();
    release_slot(&mut slot, &my_state);
}

/// Navigate the main window to the app with the ticket and bring it forward.
fn finish(app: &tauri::AppHandle, ticket: &str) {
    let configured = crate::settings::load(app).url;
    let Some(target) = ticket_url(&configured, ticket) else {
        eprintln!("shell: browser sign-in got a ticket but the configured URL is invalid");
        return;
    };
    let app = app.clone();
    // Window ops from a plain thread: hop to the main thread first.
    let _ = app.clone().run_on_main_thread(move || {
        let Some(w) = app.get_webview_window("main") else {
            eprintln!("shell: browser sign-in found no main window");
            return;
        };
        match tauri::Url::parse(&target) {
            Ok(u) => {
                if let Err(e) = w.navigate(u) {
                    eprintln!("shell: browser sign-in could not navigate: {e}");
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("shell: browser sign-in built a bad URL: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_callback() {
        let line = "GET /callback?ticket=sit_abc&state=n0nce HTTP/1.1";
        assert_eq!(
            parse_callback(line),
            Some(("sit_abc".into(), "n0nce".into()))
        );
    }

    #[test]
    fn percent_decodes_values() {
        let line = "GET /callback?ticket=a%2Bb&state=x%20y HTTP/1.1";
        assert_eq!(parse_callback(line), Some(("a+b".into(), "x y".into())));
    }

    #[test]
    fn rejects_wrong_path_or_missing_pieces() {
        assert_eq!(parse_callback("GET /other?ticket=t&state=s HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?ticket=t HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?state=s HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?ticket=&state=s HTTP/1.1"), None);
        assert_eq!(parse_callback(""), None);
    }

    #[test]
    fn handoff_url_uses_the_origin_only() {
        let u = handoff_url("https://chartkar.app/some/path?x=1", 49213, "n0nce").unwrap();
        assert_eq!(
            u,
            "https://chartkar.app/?shell_auth=1&port=49213&state=n0nce"
        );
    }

    #[test]
    fn ticket_url_appends_to_the_configured_url() {
        assert_eq!(
            ticket_url("https://chartkar.app", "sit_abc").unwrap(),
            "https://chartkar.app/?__clerk_ticket=sit_abc"
        );
        assert_eq!(
            ticket_url("http://localhost:5173/?a=1", "t").unwrap(),
            "http://localhost:5173/?a=1&__clerk_ticket=t"
        );
    }

    #[test]
    fn claim_slot_succeeds_and_clears_when_it_still_holds_my_state() {
        let mut slot = Some("n0nce".to_string());
        assert!(claim_slot(&mut slot, "n0nce"));
        assert_eq!(slot, None);
    }

    #[test]
    fn claim_slot_refuses_when_a_different_nonce_holds_the_slot() {
        let mut slot = Some("other".to_string());
        assert!(!claim_slot(&mut slot, "n0nce"));
        assert_eq!(slot, Some("other".to_string()));
    }

    #[test]
    fn claim_slot_refuses_when_the_slot_is_empty() {
        let mut slot: Option<String> = None;
        assert!(!claim_slot(&mut slot, "n0nce"));
        assert_eq!(slot, None);
    }

    #[test]
    fn release_slot_clears_only_its_own_nonce() {
        let mut mine = Some("n0nce".to_string());
        release_slot(&mut mine, "n0nce");
        assert_eq!(mine, None);

        let mut theirs = Some("other".to_string());
        release_slot(&mut theirs, "n0nce");
        assert_eq!(theirs, Some("other".to_string()));
    }
}
