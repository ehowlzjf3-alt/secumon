use crate::{Fault, MAX_BYTES};

pub(crate) fn policy(value: &str) -> Result<(), Fault> {
    match value {
        "process-crash" => Ok(()),
        "strict-namespace" => Err(Fault::new("namespace_durability_unsupported", "preflight")),
        _ => Err(Fault::new("invalid_durability_policy", "preflight")),
    }
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct Request {
    pub drive: String,
    pub parents: Vec<String>,
    pub directory: String,
    pub target: String,
}

pub(crate) fn leaf(value: &str) -> Result<(), Fault> {
    let reject = || Fault::new("unsafe_name", "preflight");
    if value.is_empty()
        || value.encode_utf16().count() > 255
        || value.ends_with(['.', ' '])
        || value.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
    {
        return Err(reject());
    }
    let first = value.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            first.strip_prefix(prefix).is_some_and(|rest| {
                matches!(
                    rest,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if reserved {
        return Err(reject());
    }
    Ok(())
}

impl Request {
    pub(crate) fn directory_path(path: &str) -> Result<Self, Fault> {
        let mut request = Self::new(path, "_metadata", "_metadata", 0)?;
        request.directory = request.parents.pop().unwrap_or_default();
        request.target.clear();
        Ok(request)
    }
    pub(crate) fn new(
        parent: &str,
        directory: &str,
        target: &str,
        bytes: usize,
    ) -> Result<Self, Fault> {
        if bytes > MAX_BYTES {
            return Err(Fault::new("file_too_large", "preflight"));
        }
        leaf(directory)?;
        leaf(target)?;
        if target.ends_with(".pending") || target.starts_with(".secumon-init-") {
            return Err(Fault::new("reserved_candidate_name", "preflight"));
        }
        let raw = parent.as_bytes();
        if raw.len() < 3
            || !raw[0].is_ascii_alphabetic()
            || raw[1] != b':'
            || raw[2] != b'\\'
            || parent.encode_utf16().count() > 4096
        {
            return Err(Fault::new("local_absolute_path_required", "preflight"));
        }
        let mut parents = Vec::new();
        if parent.len() > 3 {
            for part in parent[3..].split('\\') {
                leaf(part)?;
                parents.push(part.to_string());
            }
        }
        if parents.len() > 64 {
            return Err(Fault::new("path_too_deep", "preflight"));
        }
        Ok(Self {
            drive: parent[..3].to_ascii_uppercase(),
            parents,
            directory: directory.into(),
            target: target.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_is_explicit_and_strict_is_not_downgraded() {
        assert!(policy("process-crash").is_ok());
        assert_eq!(
            policy("strict-namespace").unwrap_err().code,
            "namespace_durability_unsupported"
        );
        assert_eq!(
            policy("default").unwrap_err().code,
            "invalid_durability_policy"
        );
    }
    #[test]
    fn rejects_windows_escape_and_alias_names() {
        for name in [
            "",
            ".",
            "..",
            "x/y",
            "x\\y",
            "x:stream",
            "NUL.json",
            "con",
            "LPT¹.txt",
            "x.",
            "x ",
            "a\0b",
        ] {
            assert!(leaf(name).is_err(), "{name:?}");
        }
        assert!(leaf("한글 파일.json").is_ok());
        assert!(leaf(".secumon").is_ok());
    }
    #[test]
    fn accepts_only_bounded_drive_absolute_paths() {
        let r = Request::new("c:\\folder\\한글", ".secumon", "identity.json", 0).unwrap();
        assert_eq!(r.drive, "C:\\");
        assert_eq!(r.parents.len(), 2);
        for parent in [
            "C:relative",
            "\\\\server\\share",
            "\\\\?\\C:\\x",
            "/tmp",
            "C:\\x\\..",
            "C:\\x\\",
            "C:\\x//y",
        ] {
            assert!(
                Request::new(parent, "scope", "config.json", 1).is_err(),
                "{parent:?}"
            );
        }
    }
    #[test]
    fn bounds_bytes_before_backend_and_reserves_candidate_names() {
        assert!(Request::new("C:\\", "scope", "config.json", MAX_BYTES).is_ok());
        assert_eq!(
            Request::new("C:\\", "scope", "config.json", MAX_BYTES + 1)
                .unwrap_err()
                .code,
            "file_too_large"
        );
        assert!(Request::new("C:\\", "scope", "other.pending", 0).is_err());
    }
}
