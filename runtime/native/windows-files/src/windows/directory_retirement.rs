use super::*;
use crate::directory_retirement::{DirectoryRetirementResult, RetirementIdentity};

fn id(expected: &RetirementIdentity) -> String {
    format!("{}:{}", expected.volume, expected.object)
}
fn named(scope: &Scope, name: &str) -> Result<Option<crate::PathInfo>> {
    match scope.inspect_child(name, true) {
        Ok(value) => Ok(Some(value)),
        Err(fault) if missing(&fault) => Ok(None),
        Err(fault) => Err(fault),
    }
}

pub(crate) fn retire(
    parent: &str,
    source: &str,
    destination: &str,
    expected_parent: &RetirementIdentity,
    expected_source: &RetirementIdentity,
) -> DirectoryRetirementResult {
    let mut result = DirectoryRetirementResult::new();
    let mut scope: Option<Scope> = None;
    let mut held: Option<Handle> = None;
    let outcome = (|| -> Result<()> {
        crate::request::leaf(source)?;
        crate::request::leaf(destination)?;
        if source.eq_ignore_ascii_case(destination) {
            return Err(Fault::new("invalid_request", "preflight"));
        }
        scope = Some(Scope::open_directory(parent, true)?);
        let parent = scope.as_ref().unwrap();
        parent.check()?;
        if parent.directory.id != id(expected_parent) {
            return Err(Fault::new("parent_changed", "preflight"));
        }
        let from = named(parent, source)?;
        let to = named(parent, destination)?;
        let already = if let Some(to) = &to {
            if to.kind != "directory" || to.identity != id(expected_source) {
                return Err(Fault::new("destination_exists", "preflight"));
            }
            if from
                .as_ref()
                .is_some_and(|value| value.identity == id(expected_source))
            {
                return Err(Fault::new("identity_ambiguous", "preflight"));
            }
            true
        } else {
            let from = from
                .as_ref()
                .ok_or_else(|| Fault::new("source_missing", "preflight"))?;
            if from.kind != "directory" || from.identity != id(expected_source) {
                return Err(Fault::new("source_changed", "preflight"));
            }
            false
        };
        let source_path = child(
            &parent.directory.path,
            if already { destination } else { source },
        );
        // This distinct handle has DELETE access. Ordinary retained metadata scopes must be closed by the caller first.
        held = Some(Handle::from_file(
            unsafe {
                CreateFileW(
                    wide(&source_path).as_ptr(),
                    FILE_READ_ATTRIBUTES | DELETE | READ_CONTROL,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            "retire_directory",
        )?);
        let handle = held.as_ref().unwrap();
        let before = snapshot(handle, true, "source_recheck")?;
        parent.security.check(handle)?;
        if before.id != id(expected_source)
            || !final_path(handle)?.eq_ignore_ascii_case(&source_path)
        {
            return Err(Fault::new("source_changed", "source_recheck"));
        }
        parent.check()?;
        if already {
            result.outcome = "already_retired".into();
        } else {
            result.outcome = "unknown".into();
            if let Err(mut fault) = rename_new(handle, &parent.directory.handle, destination) {
                if matches!(fault.win32, Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS)) {
                    result.outcome = "not_moved".into();
                    fault.code = "destination_exists";
                }
                return Err(fault);
            }
            result.outcome = "moved".into();
        }
        let after = snapshot(handle, true, "destination_recheck")?;
        parent.security.check(handle)?;
        if after.id != before.id
            || !final_path(handle)?
                .eq_ignore_ascii_case(&child(&parent.directory.path, destination))
        {
            return Err(Fault::new("destination_changed", "destination_recheck"));
        }
        let current_source = named(parent, source)?;
        if !already && current_source.is_some()
            || already
                && current_source.as_ref().map(|value| &value.identity)
                    != from.as_ref().map(|value| &value.identity)
        {
            return Err(Fault::new("source_changed", "destination_recheck"));
        }
        parent.check()?;
        // Windows exposes no supported namespace barrier here. No directory fsync is claimed.
        result.ok = true;
        result.phase = "complete".into();
        Ok(())
    })();
    if let Err(fault) = outcome {
        result.fail(
            fault.code,
            fault.phase,
            fault.win32.map(|value| value as i32),
        );
    }
    if let Some(handle) = held {
        if let Err(fault) = handle.close() {
            result.cleanup(format!("{}:{}:{:?}", fault.code, fault.phase, fault.win32));
        }
    }
    if let Some(scope) = scope {
        for fault in scope.close() {
            result.cleanup(fault);
        }
    }
    result
}
