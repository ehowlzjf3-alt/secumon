//! Bounded file streams over retained Win32 parents. No namespace durability claim.
use super::*;

const FILE_MAXIMUM: usize = 1024 * 1024 * 1024;
const CHUNK_MAXIMUM: usize = 1024 * 1024;

fn retain(scope: &Scope) -> Result<Scope> {
    scope.check()?;
    let security = Security::current()?;
    if security.sid != scope.security.sid { return Err(unsafe_object("token_changed")); }
    Ok(Scope { ancestors: scope.ancestors.clone(), directory: Rc::clone(&scope.directory),
        security, private: scope.private, created: false })
}
fn bound(maximum: usize) -> Result<()> {
    if maximum > FILE_MAXIMUM { return Err(Fault::new("file_too_large", "preflight")); }
    Ok(())
}
fn path_info(info: &Snapshot) -> crate::PathInfo {
    crate::PathInfo { identity: info.id.clone(), kind: "regular".into(), bytes: info.bytes.to_string(),
        change_token: format!("{}:{}:{}:{}:{}:{}", info.id, info.bytes, info.write_time, info.change_time, info.attributes, info.links) }
}
fn close_scope(scope: Scope, prior: Result<()>) -> Result<()> {
    let errors = scope.close();
    // The caller separately retains the primary read/write failure when closing.
    prior?;
    if !errors.is_empty() { return Err(Fault::new("stream_ancestor_close_failed", "close")); }
    Ok(())
}

pub(crate) struct ReadStream {
    scope: Scope,
    file: Handle,
    before: Snapshot,
    position: usize,
    failed: bool,
}
impl ReadStream {
    pub(crate) fn info(&self) -> Result<crate::PathInfo> {
        self.scope.check()?;
        self.scope.security.check(&self.file)?;
        if snapshot(&self.file, false, "stream_read_recheck")? != self.before {
            return Err(Fault::new("file_changed", "stream_read_recheck"));
        }
        Ok(path_info(&self.before))
    }
    pub(crate) fn read(&mut self, maximum: usize) -> Result<Vec<u8>> {
        if self.failed || maximum == 0 || maximum > CHUNK_MAXIMUM {
            return Err(Fault::new("invalid_request", "stream_read"));
        }
        let result = (|| -> Result<Vec<u8>> {
            self.info()?;
            let remaining = (self.before.bytes as usize).saturating_sub(self.position);
            let mut bytes = vec![0u8; maximum.min(remaining.saturating_add(1))];
            let mut count = 0;
            crate::metrics(|value| value.data_reads += 1.0);
            if unsafe { ReadFile(self.file.0, bytes.as_mut_ptr(), bytes.len() as u32, &mut count, null_mut()) } == 0 {
                return Err(last("stream_read"));
            }
            crate::metrics(|value| value.data_bytes += f64::from(count));
            self.position += count as usize;
            if self.position > self.before.bytes as usize || count == 0 && self.position != self.before.bytes as usize {
                return Err(Fault::new("file_changed", "stream_read"));
            }
            self.info()?;
            bytes.truncate(count as usize); Ok(bytes)
        })();
        if result.is_err() { self.failed = true; }
        result
    }
    pub(crate) fn close(self) -> Result<()> {
        let Self { scope, file, .. } = self;
        close_scope(scope, file.close())
    }
}

pub(crate) struct WriteCandidate {
    scope: Scope,
    file: Option<Handle>,
    target: String,
    candidate: String,
    identity: String,
    maximum: usize,
    written: usize,
    prepared: Option<Snapshot>,
    failed: bool,
    recoverable: bool,
}
impl WriteCandidate {
    fn release_candidate(&self, file: Handle, outcome: &mut SetupPublication) {
        if self.recoverable {
            outcome.cleanup = "retained_for_recovery".into();
            if let Err(close) = file.close() { outcome.close_win32_error = close.win32; }
        } else { cleanup_candidate(file, outcome); }
    }
    fn check(&self) -> Result<Snapshot> {
        self.scope.check()?;
        let file = self.file.as_ref().ok_or_else(|| Fault::new("closed_reference", "candidate"))?;
        self.scope.security.check(file)?;
        let info = snapshot(file, false, "candidate_recheck")?;
        if info.id != self.identity || info.bytes != self.written as u64 {
            return Err(Fault::new("file_changed", "candidate_recheck"));
        }
        Ok(info)
    }
    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<()> {
        if self.failed || self.prepared.is_some() || self.file.is_none() || bytes.len() > CHUNK_MAXIMUM {
            return Err(Fault::new("invalid_request", "stream_write"));
        }
        let result = (|| -> Result<()> {
            if bytes.len() > self.maximum.saturating_sub(self.written) { return Err(Fault::new("file_too_large", "stream_write")); }
            self.check()?;
            let file = self.file.as_ref().ok_or_else(|| Fault::new("closed_reference", "stream_write"))?;
            let mut offset = 0;
            while offset < bytes.len() {
                let mut count = 0;
                if unsafe { WriteFile(file.0, bytes[offset..].as_ptr(), (bytes.len() - offset) as u32, &mut count, null_mut()) } == 0 {
                    return Err(last("stream_write"));
                }
                if count == 0 { return Err(Fault::new("zero_byte_write", "stream_write")); }
                offset += count as usize;
            }
            self.written += bytes.len(); self.check()?; Ok(())
        })();
        if result.is_err() { self.failed = true; }
        result
    }
    pub(crate) fn prepare(&mut self) -> Result<()> {
        if self.failed { return Err(Fault::new("invalid_request", "candidate_prepare")); }
        if let Some(expected) = &self.prepared {
            if &self.check()? != expected { return Err(Fault::new("file_changed", "candidate_prepare")); }
            return Ok(());
        }
        let result = (|| -> Result<()> {
            self.check()?;
            let file = self.file.as_ref().ok_or_else(|| Fault::new("closed_reference", "candidate_prepare"))?;
            if unsafe { FlushFileBuffers(file.0) } == 0 { return Err(last("file_flush")); }
            self.prepared = Some(self.check()?); Ok(())
        })();
        if result.is_err() { self.failed = true; }
        result
    }
    pub(crate) fn publish(&mut self) -> SetupPublication {
        let mut outcome = SetupPublication::empty();
        outcome.candidate_name = Some(self.candidate.clone());
        outcome.publication = "not_published".into();
        if self.file.is_none() { outcome.fail(Fault::new("closed_reference", "publish")); return outcome; }
        outcome.file_flush = if self.prepared.is_some() { "completed" } else { "attempted" }.into();
        if let Err(fault) = self.prepare() {
            outcome.fail(fault);
            if let Some(file) = self.file.take() { self.release_candidate(file, &mut outcome); }
            return outcome;
        }
        outcome.file_flush = "completed".into();
        outcome.file_identity = Some(self.identity.clone());
        let file = self.file.take().expect("prepared candidate exists");
        match rename_new(&file, &self.scope.directory.handle, &self.target) {
            Ok(()) => {
                outcome.publication = "created".into(); outcome.cleanup = "consumed_by_rename".into();
                let verified = self.scope.check().and_then(|_| self.scope.security.check(&file))
                    .and_then(|_| snapshot(&file, false, "published_recheck"))
                    .and_then(|info| if info.id == self.identity && info.bytes == self.written as u64 { Ok(()) }
                        else { Err(Fault::new("published_file_changed", "reconcile")) });
                if let Err(fault) = verified { outcome.fail(fault); }
                if let Err(close) = file.close() {
                    outcome.close_win32_error = close.win32;
                    if outcome.code.is_none() { outcome.fail(close); }
                }
                if outcome.code.is_none() {
                    match self.scope.inspect_child(&self.target, true) {
                        Ok(info) if info.identity == self.identity && info.bytes == self.written.to_string() => {
                            outcome.ok = true; outcome.phase = "complete_process_crash_policy".into();
                        },
                        Ok(_) => outcome.fail(Fault::new("published_file_changed", "reconcile")),
                        Err(fault) => outcome.fail(fault),
                    }
                }
            },
            Err(fault) if matches!(fault.win32, Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS)) => {
                outcome.publication = "already_exists".into();
                if self.recoverable {
                    outcome.fail(fault); self.release_candidate(file, &mut outcome); return outcome;
                }
                cleanup_candidate(file, &mut outcome);
                match self.scope.inspect_child(&self.target, true) {
                    Ok(info) if outcome.cleanup == "removed" && outcome.close_win32_error.is_none() => {
                        outcome.ok = true; outcome.file_identity = Some(info.identity); outcome.phase = "existing_target_validated".into();
                    },
                    Ok(_) => outcome.fail(Fault { code: "cleanup_failed", phase: "cleanup", win32: outcome.cleanup_win32_error.or(outcome.close_win32_error) }),
                    Err(error) => outcome.fail(error),
                }
            },
            Err(fault) => {
                outcome.publication = "unknown".into(); outcome.cleanup = "retained_ambiguous".into(); outcome.fail(fault);
                if let Err(close) = file.close() { outcome.close_win32_error = close.win32; }
            },
        }
        outcome
    }
    pub(crate) fn close(mut self) -> Result<()> {
        let mut outcome = SetupPublication::empty();
        if let Some(file) = self.file.take() { self.release_candidate(file, &mut outcome); }
        let result = if outcome.cleanup_win32_error.is_some() || outcome.close_win32_error.is_some() {
            Err(Fault { code: "stream_candidate_cleanup_failed", phase: "cleanup", win32: outcome.cleanup_win32_error.or(outcome.close_win32_error) })
        } else { Ok(()) };
        close_scope(self.scope, result)
    }
}

impl Scope {
    pub(crate) fn open_read_regular(&self, leaf: &str, maximum: usize) -> Result<ReadStream> {
        crate::request::leaf(leaf)?; bound(maximum)?;
        let scope = retain(self)?;
        let file = Handle::from_file(unsafe { CreateFileW(wide(&child(&scope.directory.path, leaf)).as_ptr(),
            GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "open_file")?;
        let before = snapshot(&file, false, "stream_read_metadata")?;
        scope.security.check(&file)?;
        if before.bytes > maximum as u64 { return Err(Fault::new("file_too_large", "stream_read")); }
        scope.check()?;
        Ok(ReadStream { scope, file, before, position: 0, failed: false })
    }
    pub(crate) fn create_candidate(&self, target: &str, maximum: usize) -> Result<WriteCandidate> {
        crate::request::leaf(target)?; bound(maximum)?;
        if target.ends_with(".pending") || target.starts_with(".secumon-init-") { return Err(Fault::new("reserved_candidate_name", "preflight")); }
        let scope = retain(self)?;
        if !scope.private { return Err(unsafe_object("candidate_parent")); }
        let candidate = format!(".secumon-init-{}.pending", uuid::Uuid::new_v4());
        let file = Handle::from_file(unsafe { CreateFileW(wide(&child(&scope.directory.path, &candidate)).as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, &scope.security.attributes(), CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "create_candidate")?;
        let info = snapshot(&file, false, "candidate")?;
        scope.security.check(&file)?; scope.check()?;
        Ok(WriteCandidate { scope, file: Some(file), target: target.into(), candidate, identity: info.id,
            maximum, written: 0, prepared: None, failed: false, recoverable: false })
    }
    /// The host has proved the original prefix. Reopen only its exact observed object, never truncate it.
    pub(crate) fn recoverable_candidate(&self, target: &str, candidate: &str, maximum: usize,
        expected: Option<crate::PathInfo>) -> Result<WriteCandidate> {
        crate::request::leaf(target)?; crate::request::leaf(candidate)?; bound(maximum)?;
        let digest = candidate.strip_prefix(".secumon-restore-").and_then(|name| name.strip_suffix(".pending"));
        if target.ends_with(".pending") || target.starts_with(".secumon-init-") ||
            !digest.is_some_and(|part| part.len() == 64 && part.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))) {
            return Err(Fault::new("invalid_recovery_candidate", "preflight"));
        }
        let scope = retain(self)?;
        if !scope.private { return Err(unsafe_object("candidate_parent")); }
        let disposition = if expected.is_some() { OPEN_EXISTING } else { CREATE_NEW };
        let file = Handle::from_file(unsafe { CreateFileW(wide(&child(&scope.directory.path, candidate)).as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, &scope.security.attributes(), disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "create_candidate")?;
        let info = snapshot(&file, false, "recovery_candidate")?;
        scope.security.check(&file)?; scope.check()?;
        if info.bytes > maximum as u64 { return Err(Fault::new("file_too_large", "recovery_candidate")); }
        if let Some(expected) = expected {
            let current = path_info(&info);
            if expected.kind != "regular" || expected.identity != current.identity || expected.bytes != current.bytes || expected.change_token != current.change_token {
                return Err(Fault::new("file_changed", "recovery_candidate"));
            }
        } else if info.bytes != 0 { return Err(Fault::new("file_changed", "recovery_candidate")); }
        if unsafe { SetFilePointerEx(file.0, info.bytes as i64, null_mut(), FILE_BEGIN) } == 0 { return Err(last("recovery_seek")); }
        Ok(WriteCandidate { scope, file: Some(file), target: target.into(), candidate: candidate.into(), identity: info.id,
            maximum, written: info.bytes as usize, prepared: None, failed: false, recoverable: true })
    }
}
