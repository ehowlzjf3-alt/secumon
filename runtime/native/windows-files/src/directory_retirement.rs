use napi_derive::napi;

#[napi(object)]
pub struct DirectoryRetirementCapabilities {
    pub api_version: u32,
    pub platform: String,
    pub no_replace: bool,
}

#[napi(object)]
pub struct RetirementIdentity {
    pub volume: String,
    pub object: String,
}

#[napi(object)]
pub struct DirectoryRetirementResult {
    pub ok: bool,
    pub outcome: String,
    pub durability: String,
    pub directory_synced: bool,
    pub code: Option<String>,
    pub phase: String,
    pub os_error: Option<i32>,
    pub cleanup_errors: Vec<String>,
}
impl DirectoryRetirementResult {
    pub(crate) fn new() -> Self {
        Self {
            ok: false,
            outcome: "not_moved".into(),
            durability: if cfg!(windows) {
                "process-crash"
            } else {
                "namespace-fsync"
            }
            .into(),
            directory_synced: false,
            code: None,
            phase: "preflight".into(),
            os_error: None,
            cleanup_errors: Vec::new(),
        }
    }
    pub(crate) fn fail(&mut self, code: &str, phase: &str, os_error: Option<i32>) {
        self.ok = false;
        self.code = Some(code.into());
        self.phase = phase.into();
        self.os_error = os_error;
    }
    pub(crate) fn cleanup(&mut self, error: String) {
        if self.code.is_none() {
            self.fail("close_failed", "close", None);
        }
        self.cleanup_errors.push(error);
    }
}

#[napi]
pub fn directory_retirement_capabilities() -> DirectoryRetirementCapabilities {
    DirectoryRetirementCapabilities {
        api_version: 1,
        platform: std::env::consts::OS.into(),
        no_replace: cfg!(any(windows, target_os = "macos", target_os = "linux")),
    }
}

/// Host-only same-parent directory retirement; no fallback can overwrite a destination.
#[napi]
pub fn retire_directory_no_replace(
    parent: String,
    source: String,
    destination: String,
    expected_parent: RetirementIdentity,
    expected_source: RetirementIdentity,
) -> DirectoryRetirementResult {
    #[cfg(windows)]
    {
        crate::windows::retire_directory(
            &parent,
            &source,
            &destination,
            &expected_parent,
            &expected_source,
        )
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        crate::posix_retirement::retire(
            &parent,
            &source,
            &destination,
            &expected_parent,
            &expected_source,
        )
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (
            parent,
            source,
            destination,
            expected_parent,
            expected_source,
        );
        let mut result = DirectoryRetirementResult::new();
        result.fail("unsupported_platform", "preflight", None);
        result
    }
}
