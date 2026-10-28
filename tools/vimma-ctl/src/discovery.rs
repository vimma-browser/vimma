/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Finding the profile and reading its discovery file (spec § Profile discovery; macOS: spec
//! macos-build).

use crate::json;
use crate::protocol::{Discovery, decode_discovery};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The discovery file's name inside the profile.
pub const FILE_NAME: &str = "vimma-control.json";
/// Largest discovery file read; the real one is under 200 bytes.
pub const MAX_FILE_SIZE: usize = 64 * 1024;
/// The pref that turns the control socket on.
pub const PREF: &str = "vimma.control.enabled";

/// The environment discovery depends on, injected so tests need not touch the process's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// `VIMMA_PROFILE`: a profile directory, like `--profile`.
    pub profile: Option<PathBuf>,
}

impl Env {
    /// Read `HOME`, `XDG_CONFIG_HOME` and `VIMMA_PROFILE`; empty values count as unset.
    #[must_use]
    pub fn from_process() -> Self {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            home: var("HOME"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
            profile: var("VIMMA_PROFILE"),
        }
    }
}

/// Why no usable discovery file was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryError(pub String);

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DiscoveryError {}

/// The directory holding `profiles.ini`, where Firefox puts it on this platform: on macOS
/// `~/Library/Application Support/Vimma`; elsewhere `$XDG_CONFIG_HOME/vimma/vimma` (default
/// `~/.config/vimma/vimma`), or the legacy `~/.vimma/vimma` when that exists.
#[must_use]
pub fn profiles_root(env: &Env) -> Option<PathBuf> {
    profiles_root_for(env, Layout::HOST)
}

/// Firefox's profile layouts (`toolkit/xre/nsXREDirProvider.cpp`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// GTK: vendor/name under `XDG_CONFIG_HOME`, or the legacy dot directory.
    Xdg,
    /// macOS: the app's name under Application Support. Firefox ignores the vendor there and
    /// reads `XDG_CONFIG_HOME` only on GTK, so neither moves the root.
    MacOs,
}

impl Layout {
    const HOST: Self = if cfg!(target_os = "macos") {
        Self::MacOs
    } else {
        Self::Xdg
    };
}

fn profiles_root_for(env: &Env, layout: Layout) -> Option<PathBuf> {
    if layout == Layout::MacOs {
        return Some(env.home.as_ref()?.join("Library/Application Support/Vimma"));
    }
    if let Some(home) = &env.home {
        let legacy = home.join(".vimma/vimma");
        if legacy.is_dir() {
            return Some(legacy);
        }
    }
    let config = env
        .xdg_config_home
        .clone()
        .or_else(|| env.home.as_ref().map(|home| home.join(".config")))?;
    Some(config.join("vimma/vimma"))
}

/// `[section]` → key/value pairs, in file order.
fn parse_ini(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.trim().to_string(), Vec::new()));
        } else if let (Some((key, value)), Some(section)) =
            (line.split_once('='), sections.last_mut())
        {
            section
                .1
                .push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    sections
}

fn lookup<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

/// The default profile named by a `profiles.ini`: the first `[Install…]` section's `Default`,
/// else the `[Profile…]` with `Default=1`, else the only `[Profile…]`.
#[must_use]
pub fn profile_from_ini(text: &str, root: &Path) -> Option<PathBuf> {
    let sections = parse_ini(text);
    // Install sections hold a Path value as written in [Profile…], i.e. relative to the root
    // unless absolute; `Path::join` keeps an absolute path as it is.
    if let Some(path) = sections
        .iter()
        .filter(|(name, _)| name.starts_with("Install"))
        .find_map(|(_, pairs)| lookup(pairs, "Default"))
    {
        return Some(root.join(path));
    }
    let profiles: Vec<&Vec<(String, String)>> = sections
        .iter()
        .filter(|(name, pairs)| name.starts_with("Profile") && lookup(pairs, "Path").is_some())
        .map(|(_, pairs)| pairs)
        .collect();
    let chosen = profiles
        .iter()
        .find(|pairs| lookup(pairs, "Default") == Some("1"))
        .or(if profiles.len() == 1 {
            profiles.first()
        } else {
            None
        })?;
    let path = lookup(chosen, "Path")?;
    Some(if lookup(chosen, "IsRelative") == Some("0") {
        PathBuf::from(path)
    } else {
        root.join(path)
    })
}

/// The profile directory: `explicit` (`--profile`), else `VIMMA_PROFILE`, else the default
/// profile from `profiles.ini`.
///
/// # Errors
/// When there is no home directory, no `profiles.ini`, or it names no profile.
pub fn find_profile(explicit: Option<&Path>, env: &Env) -> Result<PathBuf, DiscoveryError> {
    if let Some(dir) = explicit
        .map(Path::to_path_buf)
        .or_else(|| env.profile.clone())
    {
        return Ok(dir);
    }
    let root = profiles_root(env).ok_or_else(|| {
        DiscoveryError("cannot find the Vimma profile: HOME is not set; pass --profile".into())
    })?;
    let ini = root.join("profiles.ini");
    let text = std::fs::read_to_string(&ini).map_err(|e| {
        DiscoveryError(format!(
            "cannot find the Vimma profile: cannot read {}: {e}; has Vimma run? Or pass --profile",
            ini.display()
        ))
    })?;
    profile_from_ini(&text, &root).ok_or_else(|| {
        DiscoveryError(format!(
            "cannot find the Vimma profile: {} names no default profile; pass --profile",
            ini.display()
        ))
    })
}

/// Read and check `<profile>/vimma-control.json`.
///
/// # Errors
/// When the file is missing, readable by group or others, or not a valid discovery file.
pub fn read_discovery(profile: &Path) -> Result<Discovery, DiscoveryError> {
    let path = profile.join(FILE_NAME);
    let metadata = std::fs::metadata(&path).map_err(|e| {
        DiscoveryError(format!(
            "Vimma is not running (or the control socket is off): no {} ({e}); \
             set the pref {PREF} to true",
            path.display()
        ))
    })?;
    check_mode(&path, &metadata)?;
    let too_big = || {
        DiscoveryError(format!(
            "refusing {}: larger than {MAX_FILE_SIZE} bytes",
            path.display()
        ))
    };
    if metadata.len() > MAX_FILE_SIZE as u64 {
        return Err(too_big());
    }
    // Read at most one byte past the limit, in case the file grew since the metadata call.
    let mut text = String::new();
    std::fs::File::open(&path)
        .and_then(|file| {
            file.take(MAX_FILE_SIZE as u64 + 1)
                .read_to_string(&mut text)
        })
        .map_err(|e| DiscoveryError(format!("cannot read {}: {e}", path.display())))?;
    if text.len() > MAX_FILE_SIZE {
        return Err(too_big());
    }
    let value = json::parse(&text)
        .map_err(|e| DiscoveryError(format!("{} is not valid JSON: {e}", path.display())))?;
    let discovery = decode_discovery(&value)
        .map_err(|e| DiscoveryError(format!("{} is not a discovery file: {e}", path.display())))?;
    check_pid(&path, discovery.pid)?;
    Ok(discovery)
}

/// A crashed or killed browser cannot delete its file: say so instead of dialling a port that
/// something else may have taken. This is only a hint: a reused pid passes it. What protects the
/// user is the handshake: the server must prove it knows the token (the challenge) before the
/// client sends the token or any command, so a squatter on the port learns neither.
fn check_pid(path: &Path, pid: u64) -> Result<(), DiscoveryError> {
    if pid_alive(pid) {
        return Ok(());
    }
    Err(DiscoveryError(format!(
        "Vimma is not running: {} is stale (pid {pid} has exited; a crash or a kill leaves it \
         behind, and the next start replaces it)",
        path.display()
    )))
}

#[cfg(target_os = "linux")]
fn pid_alive(pid: u64) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn pid_alive(pid: u64) -> bool {
    ps_lists(pid)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u64) -> bool {
    true
}

/// Whether `/bin/ps -p` lists the pid, as `/proc/<pid>` exists on Linux: also for another
/// user's process, which `kill(pid, 0)` would not tell from an exited one without its errno.
/// `ps` rather than `kill`, since the crate forbids `unsafe` and has no libc binding (ADR-011).
/// When `/bin/ps` cannot be run the answer is "alive", which leaves the handshake to decide.
#[cfg(all(unix, any(test, not(target_os = "linux"))))]
fn ps_lists(pid: u64) -> bool {
    use std::process::{Command, Stdio};
    // pid 0 is the kernel's on macOS, never Vimma's; past i32::MAX no pid exists.
    if pid == 0 || pid > i32::MAX.unsigned_abs().into() {
        return false;
    }
    Command::new("/bin/ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_or(true, |status| status.success())
}

#[cfg(unix)]
fn check_mode(path: &Path, metadata: &std::fs::Metadata) -> Result<(), DiscoveryError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(DiscoveryError(format!(
            "refusing {}: mode {mode:o} lets other users read the token; run chmod 600 on it",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_mode(_path: &Path, _metadata: &std::fs::Metadata) -> Result<(), DiscoveryError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// A temp dir that is removed when dropped, also when the test panics (#207).
    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    fn temp_dir() -> TempDir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "vimma-ctl-unit-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn temp_dirs_are_removed_when_dropped() {
        let path = {
            let dir = temp_dir();
            fs::write(dir.join("f"), "x").unwrap();
            dir.to_path_buf()
        };
        assert!(!path.exists());
    }

    #[cfg(unix)]
    fn write_mode(path: &Path, text: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    const REAL_INI: &str = "[Install4F96D1932A9F858E]\nDefault=jpa751c5.default-release\nLocked=1\n\n\
        [Profile1]\nName=default\nIsRelative=1\nPath=73jd4zyp.default\nDefault=1\n\n\
        [Profile0]\nName=default-release\nIsRelative=1\nPath=jpa751c5.default-release\n\n\
        [General]\nStartWithLastProfile=1\nVersion=2\n";

    #[test]
    fn install_section_default_wins_over_profile_default() {
        let root = Path::new("/r");
        assert_eq!(
            profile_from_ini(REAL_INI, root),
            Some(root.join("jpa751c5.default-release"))
        );
    }

    #[test]
    fn falls_back_to_the_default_profile_then_the_only_one() {
        let root = Path::new("/r");
        let two = "[Profile0]\nPath=a\nIsRelative=1\n[Profile1]\nPath=b\nIsRelative=1\nDefault=1\n";
        assert_eq!(profile_from_ini(two, root), Some(root.join("b")));
        let one =
            "; comment\n# comment\n[General]\nVersion=2\n[Profile0]\n Path = only \nIsRelative=1\n";
        assert_eq!(profile_from_ini(one, root), Some(root.join("only")));
        let ambiguous = "[Profile0]\nPath=a\nIsRelative=1\n[Profile1]\nPath=b\nIsRelative=1\n";
        assert_eq!(profile_from_ini(ambiguous, root), None);
        assert_eq!(profile_from_ini("", root), None);
    }

    #[test]
    fn absolute_paths_are_kept() {
        let ini = "[Profile0]\nPath=/elsewhere/p\nIsRelative=0\nDefault=1\n";
        assert_eq!(
            profile_from_ini(ini, Path::new("/r")),
            Some(PathBuf::from("/elsewhere/p"))
        );
    }

    #[test]
    fn install_default_may_be_absolute() {
        let ini = "[InstallABC]\nDefault=/abs/p\n[Profile0]\nPath=x\nIsRelative=1\n";
        assert_eq!(
            profile_from_ini(ini, Path::new("/r")),
            Some(PathBuf::from("/abs/p"))
        );
    }

    #[test]
    fn root_prefers_xdg_then_home_then_legacy() {
        let home = temp_dir();
        let env = Env {
            home: Some(home.to_path_buf()),
            xdg_config_home: Some(PathBuf::from("/xdg")),
            profile: None,
        };
        let root = |env: &Env| profiles_root_for(env, Layout::Xdg);
        assert_eq!(root(&env), Some(PathBuf::from("/xdg/vimma/vimma")));
        let env = Env {
            xdg_config_home: None,
            ..env
        };
        assert_eq!(root(&env), Some(home.join(".config/vimma/vimma")));
        fs::create_dir_all(home.join(".vimma/vimma")).unwrap();
        assert_eq!(root(&env), Some(home.join(".vimma/vimma")));
        assert_eq!(root(&Env::default()), None);
    }

    #[test]
    fn profiles_root_finds_application_support_vimma_on_macos() {
        let home = temp_dir();
        let env = Env {
            home: Some(home.to_path_buf()),
            xdg_config_home: None,
            profile: None,
        };
        let expected = home.join("Library/Application Support/Vimma");
        assert_eq!(
            profiles_root_for(&env, Layout::MacOs),
            Some(expected.clone())
        );
        // Firefox reads no legacy ~/.vimma on macOS.
        fs::create_dir_all(home.join(".vimma/vimma")).unwrap();
        assert_eq!(profiles_root_for(&env, Layout::MacOs), Some(expected));
        assert_eq!(profiles_root_for(&Env::default(), Layout::MacOs), None);
    }

    #[test]
    fn xdg_config_home_does_not_move_the_macos_profile_root() {
        let env = Env {
            home: Some(PathBuf::from("/Users/u")),
            xdg_config_home: Some(PathBuf::from("/Users/u/.config")),
            profile: None,
        };
        assert_eq!(
            profiles_root_for(&env, Layout::MacOs),
            Some(PathBuf::from("/Users/u/Library/Application Support/Vimma"))
        );
    }

    #[test]
    fn the_host_uses_its_own_layout() {
        let env = Env {
            home: Some(PathBuf::from("/h")),
            xdg_config_home: None,
            profile: None,
        };
        let expected = if cfg!(target_os = "macos") {
            "/h/Library/Application Support/Vimma"
        } else {
            "/h/.config/vimma/vimma"
        };
        assert_eq!(profiles_root(&env), Some(PathBuf::from(expected)));
    }

    #[test]
    fn find_profile_order() {
        let home = temp_dir();
        let env = Env {
            home: Some(home.to_path_buf()),
            xdg_config_home: Some(home.join("xdg")),
            profile: Some(PathBuf::from("/from-env")),
        };
        assert_eq!(
            find_profile(Some(Path::new("/explicit")), &env),
            Ok(PathBuf::from("/explicit"))
        );
        assert_eq!(find_profile(None, &env), Ok(PathBuf::from("/from-env")));
        let env = Env {
            profile: None,
            ..env
        };
        let err = find_profile(None, &env).unwrap_err();
        assert!(err.0.contains("profiles.ini"), "{err}");
        let root = profiles_root(&env).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("profiles.ini"), REAL_INI).unwrap();
        assert_eq!(
            find_profile(None, &env),
            Ok(root.join("jpa751c5.default-release"))
        );
        fs::write(root.join("profiles.ini"), "[General]\n").unwrap();
        assert!(
            find_profile(None, &env)
                .unwrap_err()
                .0
                .contains("--profile")
        );
        assert!(find_profile(None, &Env::default()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_0600_discovery_file() {
        let dir = temp_dir();
        let pid = std::process::id(); // alive: this test
        let text = format!(r#"{{"protocol":1,"port":4000,"token":"{TOKEN}","pid":{pid}}}"#);
        write_mode(&dir.join(FILE_NAME), &text, 0o600);
        let found = read_discovery(&dir).unwrap();
        assert_eq!(found.port, 4000);
        assert_eq!(found.pid, u64::from(pid));
    }

    #[cfg(unix)]
    #[test]
    fn a_discovery_file_whose_pid_has_exited_is_stale_on_every_unix() {
        let dir = temp_dir();
        // Above Linux's largest pid_max (2^22) and macOS's (99998), so no process has it.
        let text = format!(r#"{{"protocol":1,"port":4000,"token":"{TOKEN}","pid":999999999}}"#);
        write_mode(&dir.join(FILE_NAME), &text, 0o600);
        let err = read_discovery(&dir).unwrap_err();
        assert!(
            err.0.contains("stale") && err.0.contains("pid 999999999"),
            "{err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ps_tells_a_running_pid_from_an_exited_one() {
        assert!(ps_lists(u64::from(std::process::id())));
        // Another user's process is running too: launchd or init, owned by root.
        assert!(ps_lists(1));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let exited = u64::from(child.id());
        child.wait().unwrap();
        assert!(!ps_lists(exited));
        assert!(!ps_lists(0));
        assert!(!ps_lists(u64::from(u32::MAX)));
        assert!(!ps_lists(u64::MAX));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_file_others_can_read() {
        let dir = temp_dir();
        let text = format!(r#"{{"protocol":1,"port":4000,"token":"{TOKEN}","pid":7}}"#);
        write_mode(&dir.join(FILE_NAME), &text, 0o644);
        let err = read_discovery(&dir).unwrap_err();
        assert!(err.0.contains("chmod 600"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_an_oversized_file_without_reading_it() {
        let dir = temp_dir();
        let padding = " ".repeat(MAX_FILE_SIZE);
        let text = format!(r#"{{"protocol":1,"port":4000,"token":"{TOKEN}","pid":7}}{padding}"#);
        write_mode(&dir.join(FILE_NAME), &text, 0o600);
        let err = read_discovery(&dir).unwrap_err();
        assert!(err.0.contains("larger than 65536 bytes"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn reports_missing_and_invalid_files() {
        let dir = temp_dir();
        let err = read_discovery(&dir).unwrap_err();
        assert!(err.0.contains("not running"), "{err}");
        assert!(err.0.contains(PREF), "{err}");
        write_mode(&dir.join(FILE_NAME), "{", 0o600);
        assert!(
            read_discovery(&dir)
                .unwrap_err()
                .0
                .contains("not valid JSON")
        );
        write_mode(&dir.join(FILE_NAME), r#"{"port":1}"#, 0o600);
        assert!(read_discovery(&dir).unwrap_err().0.contains("protocol"));
    }
}
