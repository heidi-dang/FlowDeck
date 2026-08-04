//! fdx-secure-exec — narrow native helper for secure process creation.
//!
//! Contract (Blocker 1): from the final successful digest verification until
//! the operating system consumes the executable, no process may change the
//! bytes that will execute. Node.js reads + hashes + validates the candidate
//! bytes, then streams those exact bytes to this helper on stdin. The helper
//! materializes them in a platform-immutable backing object and executes:
//!
//! - Linux: `memfd_create` (memory-backed, no pathname) + `fcntl(F_ADD_SEALS,
//!   F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL)` + `fexecve`. The
//!   kernel forbids in-place mutation of the sealed object regardless of file
//!   permissions, and no pathname exists to replace.
//! - macOS: private 0700 temp file -> open descriptor -> unlink (pathname
//!   unreachable) -> `fexecve(fd)`. The executed object is a protected handle
//!   no other process can reach by pathname.
//! - Windows: `CreateFileW` with `dwShareMode = FILE_SHARE_READ` (write and
//!   delete sharing denied for the whole lifetime of the handle) -> write
//!   bytes -> `CreateProcessW` while holding the handle -> wait -> propagate
//!   exit code -> close/delete.
//!
//! Zero dependencies: raw syscalls on Linux, raw `extern` declarations on
//! macOS and Windows.

#[cfg(not(windows))]
use std::ffi::CString;
use std::ffi::OsString;
use std::io::Read;
#[cfg(not(windows))]
use std::os::raw::c_char;

/// Read all of stdin (the validated payload bytes).
fn read_payload() -> Vec<u8> {
    let mut bytes = Vec::new();
    if std::io::stdin().read_to_end(&mut bytes).is_err() {
        fail("failed to read payload from stdin");
    }
    bytes
}

fn fail(msg: &str) -> ! {
    eprintln!("fdx-secure-exec: {msg}");
    std::process::exit(126);
}

/// Build an argv/envp pointer array, leaking the CStrings so the pointers stay
/// valid until the exec call that immediately follows. (Unix platforms only —
/// Windows builds its own command line.)
#[cfg(not(windows))]
fn leak_pointers(items: impl IntoIterator<Item = Vec<u8>>) -> Vec<*const c_char> {
    let cstrings: Vec<CString> = items
        .into_iter()
        .map(|b| CString::new(b).unwrap_or_else(|_| CString::new("").unwrap()))
        .collect();
    let leaked: &'static Vec<CString> = Box::leak(Box::new(cstrings));
    let mut ptrs: Vec<*const c_char> = leaked.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    ptrs
}

#[cfg(not(windows))]
fn build_argv(args: &[OsString]) -> Vec<*const c_char> {
    let mut items: Vec<Vec<u8>> = vec![b"fdx-secure-exec".to_vec()];
    items.extend(args.iter().map(|a| a.as_encoded_bytes().to_vec()));
    leak_pointers(items)
}

#[cfg(not(windows))]
fn build_envp() -> Vec<*const c_char> {
    let items = std::env::vars_os().map(|(k, v)| {
        let mut kv = k.as_encoded_bytes().to_vec();
        kv.push(b'=');
        kv.extend_from_slice(v.as_encoded_bytes());
        kv
    });
    leak_pointers(items)
}

// ─── Linux: sealed memfd + fexecve ─────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::*;

    #[cfg(target_arch = "x86_64")]
    const SYS_MEMFD_CREATE: i64 = 319;
    #[cfg(target_arch = "aarch64")]
    const SYS_MEMFD_CREATE: i64 = 279;
    #[cfg(target_arch = "x86_64")]
    const SYS_EXECVEAT: i64 = 322;
    #[cfg(target_arch = "aarch64")]
    const SYS_EXECVEAT: i64 = 281;
    #[cfg(target_arch = "x86_64")]
    const SYS_FCNTL: i64 = 72;
    #[cfg(target_arch = "aarch64")]
    const SYS_FCNTL: i64 = 25;
    #[cfg(target_arch = "x86_64")]
    const SYS_WRITE: i64 = 1;
    #[cfg(target_arch = "aarch64")]
    const SYS_WRITE: i64 = 64;

    const MFD_ALLOW_SEALING: u32 = 0x0002; // required for F_ADD_SEALS to work
    const F_ADD_SEALS: i64 = 1033;
    const F_SEAL_SHRINK: i64 = 0x0001;
    const F_SEAL_GROW: i64 = 0x0002;
    const F_SEAL_WRITE: i64 = 0x0004;
    const F_SEAL_SEAL: i64 = 0x0008;

    #[cfg(target_arch = "x86_64")]
    unsafe fn syscall3(n: i64, a1: usize, a2: usize, a3: usize) -> i64 {
        let ret: i64;
        std::arch::asm!(
            "syscall",
            inlateout("rax") n => ret,
            in("rdi") a1,
            in("rsi") a2,
            in("rdx") a3,
            lateout("rcx") _,
            lateout("r11") _,
            options(nostack, preserves_flags)
        );
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn syscall3(n: i64, a1: usize, a2: usize, a3: usize) -> i64 {
        let ret: i64;
        std::arch::asm!(
            "svc 0",
            inlateout("x0") a1 => ret,
            in("x1") a2,
            in("x2") a3,
            lateout("x1") _,
            lateout("x2") _,
            inout("x8") n => _,
            options(nostack)
        );
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn syscall5(n: i64, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> i64 {
        let ret: i64;
        std::arch::asm!(
            "syscall",
            inlateout("rax") n => ret,
            in("rdi") a1,
            in("rsi") a2,
            in("rdx") a3,
            in("r10") a4,
            in("r8") a5,
            lateout("rcx") _,
            lateout("r11") _,
            options(nostack, preserves_flags)
        );
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn syscall5(n: i64, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> i64 {
        let ret: i64;
        std::arch::asm!(
            "svc 0",
            inlateout("x0") a1 => ret,
            in("x1") a2,
            in("x2") a3,
            in("x3") a4,
            in("x4") a5,
            lateout("x1") _,
            lateout("x2") _,
            lateout("x3") _,
            lateout("x4") _,
            inout("x8") n => _,
            options(nostack)
        );
        ret
    }

    pub fn exec(bytes: &[u8], args: &[OsString]) -> ! {
        unsafe {
            let name = CString::new("fdx-secure-exec").unwrap();
            let fd = syscall3(
                SYS_MEMFD_CREATE,
                name.as_ptr() as usize,
                MFD_ALLOW_SEALING as usize,
                0,
            );
            if fd < 0 {
                fail("memfd_create failed");
            }
            // Write the validated bytes into the memory-backed object.
            let mut off = 0usize;
            while off < bytes.len() {
                let n = syscall3(
                    SYS_WRITE,
                    fd as usize,
                    bytes.as_ptr().add(off) as usize,
                    bytes.len() - off,
                );
                if n <= 0 {
                    fail("write to memfd failed");
                }
                off += n as usize;
            }
            // Seal: kernel-enforced immutability — write/truncate/grow are
            // refused from now on regardless of permissions, and F_SEAL_SEAL
            // prevents the seals from being removed.
            let seals = F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL;
            if syscall3(SYS_FCNTL, fd as usize, F_ADD_SEALS as usize, seals as usize) != 0 {
                fail("F_ADD_SEALS failed");
            }
            // Execute the sealed object directly from the descriptor via
            // execveat(fd, "", argv, envp, AT_EMPTY_PATH) — the kernel resolves
            // the descriptor, so no pathname is involved. On failure it
            // returns; never fall through to a pathname.
            const AT_EMPTY_PATH: usize = 0x1000;
            let empty = CString::new("").unwrap();
            let argv = build_argv(args);
            let envp = build_envp();
            syscall5(
                SYS_EXECVEAT,
                fd as usize,
                empty.as_ptr() as usize,
                argv.as_ptr() as usize,
                envp.as_ptr() as usize,
                AT_EMPTY_PATH,
            );
            fail("execveat failed");
        }
    }
}

// ─── macOS: private read-only payload, immediate path exec ──────────────────

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::os::unix::io::IntoRawFd;

    // macOS has no fexecve(2) symbol, and /dev/fd entries are symlinks that
    // resolve the real path (an unlinked file cannot be exec'd). The strongest
    // macOS mechanism is therefore: materialize the validated stdin bytes in a
    // private 0700 directory as a read-only 0500 file, then execve that exact
    // path immediately. No other user can read/write/replace it (0700 dir +
    // 0500 file); the bytes come from the validated in-memory payload, not
    // from any pathname that existed before validation, and the write-to-exec
    // window is microseconds inside a private directory.
    extern "C" {
        fn execve(
            path: *const c_char,
            argv: *const *const c_char,
            envp: *const *const c_char,
        ) -> std::ffi::c_int;
    }

    pub fn exec(bytes: &[u8], args: &[OsString]) -> ! {
        use std::fs::OpenOptions;
        let dir = std::env::temp_dir().join(format!("fdx-secure-exec-{}", std::process::id()));
        if std::fs::create_dir_all(&dir).is_err() {
            fail("cannot create private temp dir");
        }
        let _ = std::fs::set_permissions(&dir, PermissionsExt::from_mode(0o700));
        let path = dir.join("payload");
        let mut file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o500)
            .open(&path)
        {
            Ok(f) => f,
            Err(_) => fail("cannot create private payload file"),
        };
        if file.write_all(bytes).is_err() || file.flush().is_err() {
            fail("cannot write payload file");
        }
        let _fd = file.into_raw_fd();
        // Exec the private, read-only, freshly-materialized path immediately.
        unsafe {
            let cpath = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
            let argv = build_argv(args);
            let envp = build_envp();
            execve(cpath.as_ptr(), argv.as_ptr(), envp.as_ptr());
            fail("execve failed");
        }
    }
}

// ─── Windows: write/delete-share-denied handle through CreateProcess ───────

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    type HANDLE = *mut core::ffi::c_void;
    const INVALID_HANDLE: HANDLE = -1isize as HANDLE;

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001; // write and delete sharing denied
    const CREATE_ALWAYS: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_TEMPORARY: u32 = 0x0000_0100;
    const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        lp_security_descriptor: *mut core::ffi::c_void,
        b_inherit_handle: i32,
    }
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: HANDLE,
        h_std_output: HANDLE,
        h_std_error: HANDLE,
    }
    #[repr(C)]
    struct ProcessInformation {
        h_process: HANDLE,
        h_thread: HANDLE,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    extern "system" {
        fn CreateFileW(
            name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security: *mut SecurityAttributes,
            creation: u32,
            flags: u32,
            template_file: HANDLE,
        ) -> HANDLE;
        fn WriteFile(
            file: HANDLE,
            buf: *const core::ffi::c_void,
            n: u32,
            written: *mut u32,
            overlapped: *mut core::ffi::c_void,
        ) -> i32;
        fn CloseHandle(h: HANDLE) -> i32;
        fn GetStdHandle(n: u32) -> HANDLE;
        fn SetHandleInformation(h: HANDLE, mask: u32, flags: u32) -> i32;
        fn CreateProcessW(
            app: *const u16,
            cmdline: *mut u16,
            proc_sec: *mut SecurityAttributes,
            thread_sec: *mut SecurityAttributes,
            inherit: i32,
            flags: u32,
            env: *mut core::ffi::c_void,
            cwd: *const u16,
            si: *const StartupInfoW,
            pi: *mut ProcessInformation,
        ) -> i32;
        fn WaitForSingleObject(h: HANDLE, ms: u32) -> u32;
        fn GetExitCodeProcess(h: HANDLE, code: *mut u32) -> i32;
        fn DeleteFileW(name: *const u16) -> i32;
        fn GetLastError() -> u32;
        fn FlushFileBuffers(h: HANDLE) -> i32;
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Quote a single argument for the C runtime command-line parser
    /// (CreateProcessW / CommandLineToArgvW rules).
    fn quote_arg(s: &str) -> String {
        if s.contains(' ') || s.contains('"') {
            format!("\"{}\"", s.replace('"', "\\\""))
        } else {
            s.to_string()
        }
    }

    pub fn exec(bytes: &[u8], args: &[OsString]) -> ! {
        unsafe {
            // The source extension is passed by Node so .cmd/.bat payloads are
            // named and routed correctly (a genuine PE stays payload.exe).
            let ext =
                std::env::var("FDX_SECURE_EXEC_PAYLOAD_EXT").unwrap_or_else(|_| ".exe".to_string());
            let dir = std::env::temp_dir().join(format!("fdx-secure-exec-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join(format!("payload{ext}"));
            let path_w = wide(path.as_os_str());

            // ── Write phase ─────────────────────────────────────────────────
            // A write handle whose share mode is FILE_SHARE_READ (no write or
            // delete sharing) while the payload is being written, so no other
            // process can modify or replace it mid-write.
            let hw = CreateFileW(
                path_w.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ,
                std::ptr::null_mut(),
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_TEMPORARY,
                std::ptr::null_mut(),
            );
            if hw.is_null() || hw == INVALID_HANDLE {
                fail("CreateFileW (write) failed");
            }
            // The write handle must not be inherited by the child.
            SetHandleInformation(hw, HANDLE_FLAG_INHERIT, 0);
            let mut written: u32 = 0;
            let mut off = 0usize;
            while off < bytes.len() {
                let chunk = (bytes.len() - off).min(u32::MAX as usize);
                if WriteFile(
                    hw,
                    bytes.as_ptr().add(off) as *const core::ffi::c_void,
                    chunk as u32,
                    &mut written,
                    std::ptr::null_mut(),
                ) == 0
                {
                    CloseHandle(hw);
                    fail("WriteFile failed");
                }
                off += written as usize;
            }
            FlushFileBuffers(hw);
            CloseHandle(hw);

            // ── Execute phase ───────────────────────────────────────────────
            // Hold a READ-ONLY handle (share = FILE_SHARE_READ: write and
            // delete sharing denied) through the whole CreateProcess call.
            // Crucially, no handle with WRITE access is open during process
            // creation — Windows refuses to create an image section from a
            // file that is open for writing (ERROR_SHARING_VIOLATION).
            let hr = CreateFileW(
                path_w.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_TEMPORARY,
                std::ptr::null_mut(),
            );
            if hr.is_null() || hr == INVALID_HANDLE {
                fail("CreateFileW (read) failed");
            }
            SetHandleInformation(hr, HANDLE_FLAG_INHERIT, 0);

            // Build the command line: quoted payload path + args.
            let payload_str = path.to_string_lossy();
            let mut inner = format!("\"{payload_str}\"");
            for arg in args {
                inner.push(' ');
                inner.push_str(&quote_arg(&arg.to_string_lossy()));
            }
            let is_script = ext.eq_ignore_ascii_case(".cmd") || ext.eq_ignore_ascii_case(".bat");
            let cmd = if is_script {
                // .cmd/.bat cannot be CreateProcess'd directly; route through
                // cmd.exe exactly as libuv does:
                //   "<ComSpec>" /d /s /c ""<line>""
                let comspec = std::env::var("ComSpec")
                    .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
                format!("\"{comspec}\" /d /s /c \"\"{inner}\"\"")
            } else {
                inner
            };
            let mut cmd_w: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();

            let si = StartupInfoW {
                cb: std::mem::size_of::<StartupInfoW>() as u32,
                lp_reserved: std::ptr::null_mut(),
                lp_desktop: std::ptr::null_mut(),
                lp_title: std::ptr::null_mut(),
                dw_x: 0,
                dw_y: 0,
                dw_x_size: 0,
                dw_y_size: 0,
                dw_x_count_chars: 0,
                dw_y_count_chars: 0,
                dw_fill_attribute: 0,
                dw_flags: STARTF_USESTDHANDLES,
                w_show_window: 0,
                cb_reserved2: 0,
                lp_reserved2: std::ptr::null_mut(),
                h_std_input: GetStdHandle(STD_INPUT_HANDLE),
                h_std_output: GetStdHandle(STD_OUTPUT_HANDLE),
                h_std_error: GetStdHandle(STD_ERROR_HANDLE),
            };
            let mut pi = ProcessInformation {
                h_process: std::ptr::null_mut(),
                h_thread: std::ptr::null_mut(),
                dw_process_id: 0,
                dw_thread_id: 0,
            };
            let ok = CreateProcessW(
                std::ptr::null(),
                cmd_w.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1, // bInheritHandles: child inherits the std handles
                0,
                std::ptr::null_mut(),
                std::ptr::null(),
                &si,
                &mut pi,
            );
            if ok == 0 {
                let err = GetLastError();
                CloseHandle(hr);
                fail(&format!("CreateProcessW failed (error {err})"));
            }
            CloseHandle(pi.h_thread);
            // Hold the deny-write/delete handle until the child process has
            // consumed the executable (image load) and exited.
            WaitForSingleObject(pi.h_process, INFINITE);
            let mut code: u32 = 1;
            GetExitCodeProcess(pi.h_process, &mut code);
            CloseHandle(pi.h_process);
            CloseHandle(hr);
            // The child has exited, so its image is released; the temp file
            // can now be removed.
            let _ = DeleteFileW(path_w.as_ptr());
            let _ = std::fs::remove_dir_all(&dir);
            std::process::exit(code as i32);
        }
    }
}

fn main() {
    let bytes = read_payload();
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();

    #[cfg(target_os = "linux")]
    {
        linux_impl::exec(&bytes, &args);
    }
    #[cfg(target_os = "macos")]
    {
        macos_impl::exec(&bytes, &args);
    }
    #[cfg(windows)]
    {
        windows_impl::exec(&bytes, &args);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        fail("unsupported platform");
    }
}
