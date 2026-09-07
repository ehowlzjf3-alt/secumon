//! Administrative publication of an already verified SQLite backup, preserving its object identity.
use super::*;

fn exact(info: &Snapshot, expected: &crate::PathInfo) -> bool {
    expected.kind == "regular" && info.id == expected.identity && info.bytes.to_string() == expected.bytes &&
        format!("{}:{}:{}:{}:{}:{}", info.id, info.bytes, info.write_time, info.change_time, info.attributes, info.links) == expected.change_token
}
impl Scope {
    fn held_admin_file(&self, leaf: &str, expected: &crate::PathInfo, rename: bool) -> Result<Handle> {
        crate::request::leaf(leaf)?; self.check()?;
        if !self.private { return Err(unsafe_object("admin_directory")); }
        let access = GENERIC_READ | GENERIC_WRITE | READ_CONTROL | if rename { DELETE } else { 0 };
        // No sharing: every SQLite/stream handle must have closed before flush or publication.
        let file = Handle::from_file(unsafe { CreateFileW(wide(&child(&self.directory.path, leaf)).as_ptr(),
            access, 0, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "open_file")?;
        self.security.check(&file)?;
        let info = snapshot(&file, false, "admin_metadata")?;
        if info.bytes > 1024 * 1024 * 1024 || !exact(&info, expected) { return Err(Fault::new("file_changed", "admin_metadata")); }
        self.check()?; Ok(file)
    }
    pub(crate) fn sync_regular(&self, leaf: &str, expected: &crate::PathInfo) -> Result<()> {
        let file = self.held_admin_file(leaf, expected, false)?;
        let result = (|| -> Result<()> {
            if unsafe { FlushFileBuffers(file.0) } == 0 { return Err(last("file_flush")); }
            self.security.check(&file)?;
            if !exact(&snapshot(&file, false, "admin_recheck")?, expected) { return Err(Fault::new("file_changed", "admin_recheck")); }
            self.check()
        })();
        let closed = file.close(); result?; closed
    }
    pub(crate) fn publish_existing(&self, leaf: &str, target: &Scope, target_leaf: &str, expected: &crate::PathInfo) -> SetupPublication {
        let mut outcome = SetupPublication::empty();
        outcome.candidate_name = Some(leaf.into());
        // The existing candidate belongs to the caller's immutable verification receipt. Never delete it here.
        outcome.cleanup = "retained_for_recovery".into();
        let opened = (|| -> Result<Handle> {
            crate::request::leaf(target_leaf)?; self.check()?; target.check()?;
            if !target.private || self.security.sid != target.security.sid { return Err(unsafe_object("admin_target")); }
            if self.directory.id.split(':').next() != target.directory.id.split(':').next() {
                return Err(Fault::new("volume_changed", "admin_target"));
            }
            if self.directory.id == target.directory.id && leaf.eq_ignore_ascii_case(target_leaf) {
                return Err(Fault::new("invalid_request", "admin_target"));
            }
            self.held_admin_file(leaf, expected, true)
        })();
        let file = match opened { Ok(file) => file, Err(fault) => { outcome.fail(fault); return outcome; } };
        outcome.file_identity = Some(expected.identity.clone());
        outcome.publication = "not_published".into(); outcome.file_flush = "attempted".into();
        let prepared = (|| -> Result<()> {
            if unsafe { FlushFileBuffers(file.0) } == 0 { return Err(last("file_flush")); }
            self.security.check(&file)?; target.security.check(&file)?;
            if !exact(&snapshot(&file, false, "admin_recheck")?, expected) { return Err(Fault::new("file_changed", "admin_recheck")); }
            self.check()?; target.check()
        })();
        if let Err(fault) = prepared { outcome.fail(fault); }
        else {
            outcome.file_flush = "completed".into();
            match rename_new(&file, &target.directory.handle, target_leaf) {
                Ok(()) => {
                    outcome.publication = "created".into(); outcome.cleanup = "consumed_by_rename".into();
                    let checked = (|| -> Result<()> {
                        self.check()?; target.check()?; target.security.check(&file)?;
                        let after = snapshot(&file, false, "published_recheck")?;
                        if after.id != expected.identity || after.bytes.to_string() != expected.bytes ||
                            !final_path(&file)?.eq_ignore_ascii_case(&child(&target.directory.path, target_leaf)) {
                            return Err(Fault::new("published_file_changed", "reconcile"));
                        }
                        Ok(())
                    })();
                    if let Err(fault) = checked { outcome.fail(fault); }
                },
                Err(fault) if matches!(fault.win32, Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS)) => {
                    outcome.publication = "already_exists".into(); outcome.fail(fault);
                },
                Err(fault) => { outcome.publication = "unknown".into(); outcome.cleanup = "retained_ambiguous".into(); outcome.fail(fault); },
            }
        }
        if let Err(close) = file.close() {
            outcome.close_win32_error = close.win32;
            if outcome.code.is_none() { outcome.fail(close); }
        }
        if outcome.code.is_none() {
            match target.inspect_child(target_leaf, true) {
                Ok(info) if info.identity == expected.identity && info.bytes == expected.bytes => {
                    outcome.ok = true; outcome.phase = "complete_process_crash_policy".into();
                },
                Ok(_) => outcome.fail(Fault::new("published_file_changed", "reconcile")),
                Err(fault) => outcome.fail(fault),
            }
        }
        outcome
    }
}
