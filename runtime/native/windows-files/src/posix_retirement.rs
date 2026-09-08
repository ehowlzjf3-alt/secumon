use crate::directory_retirement::{DirectoryRetirementResult, RetirementIdentity};
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io,
    mem::MaybeUninit,
    os::{
        fd::{FromRawFd, IntoRawFd},
        unix::fs::MetadataExt,
    },
};

struct Failure {
    code: &'static str,
    phase: &'static str,
    errno: Option<i32>,
}
type Result<T> = std::result::Result<T, Failure>;
fn fail(code: &'static str, phase: &'static str) -> Failure {
    Failure {
        code,
        phase,
        errno: None,
    }
}
fn io_failure(phase: &'static str) -> Failure {
    Failure {
        code: "posix_io",
        phase,
        errno: io::Error::last_os_error().raw_os_error(),
    }
}
fn leaf(name: &str) -> Result<CString> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains('/')
        || name.contains('\0')
    {
        return Err(fail("invalid_request", "preflight"));
    }
    CString::new(name).map_err(|_| fail("invalid_request", "preflight"))
}
fn matches(metadata: &Metadata, expected: &RetirementIdentity) -> bool {
    metadata.dev().to_string() == expected.volume && metadata.ino().to_string() == expected.object
}
fn private(metadata: &Metadata) -> bool {
    metadata.is_dir()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.mode() & 0o022 == 0
}
fn named(parent: i32, name: &CString) -> Result<Option<libc::stat>> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let fault = io_failure("inspect_child");
        return if fault.errno == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(fault)
        };
    }
    Ok(Some(unsafe { stat.assume_init() }))
}
fn named_matches(stat: &libc::stat, expected: &RetirementIdentity) -> bool {
    stat.st_dev.to_string() == expected.volume && stat.st_ino.to_string() == expected.object
}
fn safe_named(stat: &libc::stat) -> bool {
    stat.st_mode & libc::S_IFMT == libc::S_IFDIR
        && stat.st_uid == unsafe { libc::geteuid() }
        && stat.st_mode & 0o022 == 0
}
fn metadata(file: &File, phase: &'static str) -> Result<Metadata> {
    file.metadata().map_err(|error| Failure {
        code: "posix_io",
        phase,
        errno: error.raw_os_error(),
    })
}
fn check_parent(path: &str, file: &File, expected: &RetirementIdentity) -> Result<()> {
    let held = metadata(file, "parent_recheck")?;
    let current = std::fs::symlink_metadata(path).map_err(|error| Failure {
        code: "posix_io",
        phase: "parent_recheck",
        errno: error.raw_os_error(),
    })?;
    if !private(&held)
        || !private(&current)
        || !matches(&held, expected)
        || !matches(&current, expected)
    {
        return Err(fail("parent_changed", "parent_recheck"));
    }
    Ok(())
}

pub(crate) fn retire(
    parent: &str,
    source: &str,
    destination: &str,
    expected_parent: &RetirementIdentity,
    expected_source: &RetirementIdentity,
) -> DirectoryRetirementResult {
    let mut result = DirectoryRetirementResult::new();
    let mut handles: Vec<File> = Vec::new();
    let outcome = (|| -> Result<()> {
        if !parent.starts_with('/') || parent.len() > 4096 || source == destination {
            return Err(fail("invalid_request", "preflight"));
        }
        let parent_name = CString::new(parent).map_err(|_| fail("invalid_request", "preflight"))?;
        let source_name = leaf(source)?;
        let destination_name = leaf(destination)?;
        let raw = unsafe {
            libc::open(
                parent_name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if raw < 0 {
            return Err(io_failure("open_parent"));
        }
        handles.push(unsafe { File::from_raw_fd(raw) });
        check_parent(parent, &handles[0], expected_parent)?;
        let from = named(raw, &source_name)?;
        let to = named(raw, &destination_name)?;
        let already = if let Some(to) = &to {
            if !safe_named(to) || !named_matches(to, expected_source) {
                return Err(fail("destination_exists", "preflight"));
            }
            if from
                .as_ref()
                .is_some_and(|value| named_matches(value, expected_source))
            {
                return Err(fail("identity_ambiguous", "preflight"));
            }
            true
        } else {
            let from = from
                .as_ref()
                .ok_or_else(|| fail("source_missing", "preflight"))?;
            if !safe_named(from) || !named_matches(from, expected_source) {
                return Err(fail("source_changed", "preflight"));
            }
            false
        };
        let held_name = if already {
            &destination_name
        } else {
            &source_name
        };
        let held = unsafe {
            libc::openat(
                raw,
                held_name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if held < 0 {
            return Err(io_failure("open_source"));
        }
        handles.push(unsafe { File::from_raw_fd(held) });
        let original = metadata(&handles[1], "source_recheck")?;
        if !private(&original) || !matches(&original, expected_source) {
            return Err(fail("source_changed", "source_recheck"));
        }
        check_parent(parent, &handles[0], expected_parent)?;
        if !named(raw, held_name)?
            .as_ref()
            .is_some_and(|value| safe_named(value) && named_matches(value, expected_source))
        {
            return Err(fail("source_changed", "source_recheck"));
        }
        if already {
            result.outcome = "already_retired".into();
        } else {
            // POSIX rename is name-based: retain and compare the source object immediately before and after it.
            // This does not claim exclusion against arbitrary same-UID namespace mutations.
            result.outcome = "unknown".into();
            #[cfg(target_os = "macos")]
            let status = unsafe {
                libc::renameatx_np(
                    raw,
                    source_name.as_ptr(),
                    raw,
                    destination_name.as_ptr(),
                    libc::RENAME_EXCL,
                )
            };
            #[cfg(target_os = "linux")]
            let status = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    raw,
                    source_name.as_ptr(),
                    raw,
                    destination_name.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if status != 0 {
                let mut fault = io_failure("rename");
                if fault.errno == Some(libc::EEXIST) {
                    result.outcome = "not_moved".into();
                    fault.code = "destination_exists";
                }
                if fault.errno == Some(libc::ENOSYS)
                    || fault.errno == Some(libc::EINVAL)
                    || fault.errno == Some(libc::ENOTSUP)
                {
                    result.outcome = "not_moved".into();
                    fault.code = "no_replace_unsupported";
                }
                return Err(fault);
            }
            result.outcome = "moved".into();
        }
        let moved = metadata(&handles[1], "destination_recheck")?;
        if !private(&moved)
            || !matches(&moved, expected_source)
            || !named(raw, &destination_name)?
                .as_ref()
                .is_some_and(|value| safe_named(value) && named_matches(value, expected_source))
        {
            return Err(fail("destination_changed", "destination_recheck"));
        }
        let current_source = named(raw, &source_name)?;
        if !already && current_source.is_some()
            || already
                && current_source
                    .as_ref()
                    .map(|value| (value.st_dev, value.st_ino))
                    != from.as_ref().map(|value| (value.st_dev, value.st_ino))
        {
            return Err(fail("source_changed", "destination_recheck"));
        }
        handles[0].sync_all().map_err(|error| Failure {
            code: "posix_io",
            phase: "sync_parent",
            errno: error.raw_os_error(),
        })?;
        result.directory_synced = true;
        check_parent(parent, &handles[0], expected_parent)?;
        result.ok = true;
        result.phase = "complete".into();
        Ok(())
    })();
    if let Err(fault) = outcome {
        result.fail(fault.code, fault.phase, fault.errno);
    }
    for file in handles.into_iter().rev() {
        let fd = file.into_raw_fd();
        // One explicit close attempt; never retry a descriptor potentially reused after a failed close.
        if unsafe { libc::close(fd) } != 0 {
            result.cleanup(format!("close:{}", io::Error::last_os_error()));
        }
    }
    result
}
