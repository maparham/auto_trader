//! Browser sign-in for the Android app. The app opens chartkar.app's handoff
//! page with a random state, the page mints a single-use Clerk ticket and
//! returns it through an intent URL to /app-auth/callback, and the app checks
//! the state before loading its bundled UI with ?__clerk_ticket=. Pending
//! state is persisted by the caller, because Android may kill the app while
//! the user is in the browser.

use serde::{Deserialize, Serialize};

pub const TTL_SECS: u64 = 300;
pub const CALLBACK_HOST: &str = "chartkar.app";
pub const CALLBACK_PATH: &str = "/app-auth/callback";
pub const HANDOFF_ORIGIN: &str = "https://chartkar.app/";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pending {
    pub state: String,
    pub expires_at: u64,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Accept(String),
    Expired,
    Mismatch,
}

pub fn random_state() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// "https://chartkar.app/app-auth/callback?ticket=..&state=.." -> (ticket, state).
/// Any other scheme, host or path, or a missing value, is None.
pub fn parse_callback(raw: &str) -> Option<(String, String)> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "https" || u.host_str() != Some(CALLBACK_HOST) {
        return None;
    }
    if u.path().trim_end_matches('/') != CALLBACK_PATH {
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

/// Nothing pending or past the deadline: Expired (the caller clears state
/// and tells the user). A different state: Mismatch (dropped; a newer
/// attempt stays pending). Otherwise Accept with the ticket.
pub fn decide(pending: Option<&Pending>, state: &str, ticket: String, now: u64) -> Outcome {
    match pending {
        None => Outcome::Expired,
        Some(p) if p.state != state => Outcome::Mismatch,
        Some(p) if now > p.expires_at => Outcome::Expired,
        Some(_) => Outcome::Accept(ticket),
    }
}

pub fn handoff_url(state: &str) -> String {
    let mut u = url::Url::parse(HANDOFF_ORIGIN).expect("constant origin parses");
    u.query_pairs_mut()
        .append_pair("shell_auth", "1")
        .append_pair("return", "app")
        .append_pair("state", state);
    u.to_string()
}

/// The bundled index at the webview's own origin (http or https
/// tauri.localhost, whichever the build uses) with one query pair.
pub fn app_url(current: &url::Url, key: &str, value: &str) -> url::Url {
    let mut u = current.join("/").expect("root joins");
    u.set_query(None);
    u.query_pairs_mut().append_pair(key, value);
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(state: &str, expires_at: u64) -> Pending {
        Pending { state: state.into(), expires_at }
    }

    #[test]
    fn parse_callback_reads_ticket_and_state() {
        assert_eq!(
            parse_callback("https://chartkar.app/app-auth/callback?ticket=sit_a%26b&state=s1"),
            Some(("sit_a&b".into(), "s1".into()))
        );
    }

    #[test]
    fn parse_callback_rejects_other_hosts_paths_and_schemes() {
        assert_eq!(parse_callback("https://evil.example/app-auth/callback?ticket=t&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/other?ticket=t&state=s"), None);
        assert_eq!(parse_callback("http://chartkar.app/app-auth/callback?ticket=t&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/app-auth/callback?ticket=&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/app-auth/callback?ticket=t"), None);
    }

    #[test]
    fn decide_accepts_matching_state_in_time() {
        let p = pending("s1", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 1000), Outcome::Accept("t".into()));
    }

    #[test]
    fn decide_expired_after_deadline() {
        let p = pending("s1", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 1001), Outcome::Expired);
    }

    #[test]
    fn decide_nothing_pending_is_expired() {
        assert_eq!(decide(None, "s1", "t".into(), 0), Outcome::Expired);
    }

    #[test]
    fn decide_mismatch_keeps_pending() {
        // A second tap on "Sign in" replaced s1 with s2; s1's callback is dropped.
        let p = pending("s2", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 10), Outcome::Mismatch);
    }

    #[test]
    fn pending_round_trips_through_json() {
        let p = pending("s1", 42);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(serde_json::from_value::<Pending>(v).unwrap(), p);
    }

    #[test]
    fn handoff_url_shape() {
        assert_eq!(
            handoff_url("s1"),
            "https://chartkar.app/?shell_auth=1&return=app&state=s1"
        );
    }

    #[test]
    fn app_url_keeps_origin_and_replaces_query() {
        let cur = url::Url::parse("http://tauri.localhost/some/path?x=1").unwrap();
        assert_eq!(
            app_url(&cur, "__clerk_ticket", "sit_a&b").as_str(),
            "http://tauri.localhost/?__clerk_ticket=sit_a%26b"
        );
        let https = url::Url::parse("https://tauri.localhost/").unwrap();
        assert!(app_url(&https, "auth_error", "expired").as_str().starts_with("https://tauri.localhost/?"));
    }

    #[test]
    fn random_state_is_64_hex_chars_and_varies() {
        let a = random_state();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_state());
    }
}
