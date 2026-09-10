// macOS App Nap and timer coalescing throttle hidden apps. The live engine runs
// inside the web view WHILE the window is hidden, so a throttled timer or a
// stalled WebSocket is a missed bar. Hold a process-lifetime activity assertion
// and leak it deliberately: releasing it is exactly what we never want.
#[cfg(target_os = "macos")]
pub fn hold_activity_assertion() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let info = NSProcessInfo::processInfo();
    let reason = NSString::from_str("auto_trader live engine runs while hidden");
    let options = NSActivityOptions::UserInitiated
        | NSActivityOptions::IdleSystemSleepDisabled
        | NSActivityOptions::LatencyCritical;
    let token = info.beginActivityWithOptions_reason(options, &reason);
    // Never ends: the assertion must outlive every window state.
    std::mem::forget(token);
}

#[cfg(not(target_os = "macos"))]
pub fn hold_activity_assertion() {}
