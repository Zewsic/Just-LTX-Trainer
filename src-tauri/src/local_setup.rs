use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct LocalTools {
    pub os: String,
    pub has_brew: bool,
    pub has_ffmpeg: bool,
    pub has_runpodctl: bool,
    pub brew_path: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub runpodctl_path: Option<String>,
    /// Пакетный менеджер, которым можно поставить ffmpeg автоматически на
    /// этой ОС (`brew`/`winget`/`choco`/`apt-get`/`dnf`/`pacman`/`zypper`),
    /// либо `None`, если авто-установка недоступна — тогда показываем
    /// `ffmpeg_manual`.
    pub ffmpeg_installer: Option<String>,
    /// Человекочитаемая инструкция по ручной установке ffmpeg под текущую ОС.
    pub ffmpeg_manual: String,
}

/// Возможные имена файла для `name` на текущей ОС. На Windows подставляем
/// расширения из PATHEXT (`.EXE`, `.CMD`, …), если имя ещё без расширения;
/// на Unix имя используется как есть.
fn exe_candidates(name: &str) -> Vec<String> {
    if cfg!(target_os = "windows") {
        if Path::new(name).extension().is_some() {
            return vec![name.to_string()];
        }
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        pathext
            .split(';')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(|ext| format!("{}{}", name, ext.to_lowercase()))
            .collect()
    } else {
        vec![name.to_string()]
    }
}

/// Директория, куда приложение само складывает скачанные бинари (runpodctl).
/// Не требует прав root и одинаково работает на всех ОС.
pub(crate) fn managed_bin_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.map(|b| b.join("just-ltx-trainer").join("bin"))
}

/// Ищет исполняемый файл `name` в директории `dir`, перебирая расширения.
fn probe_dir(dir: &Path, name: &str) -> Option<String> {
    for cand in exe_candidates(name) {
        let p = dir.join(&cand);
        if p.is_file() {
            return Some(p.display().to_string());
        }
    }
    None
}

/// Кроссплатформенный поиск исполняемого файла в PATH.
///
/// Не полагаемся на `which`/`where`: GUI-приложение (особенно запущенное из
/// Finder на macOS) наследует урезанный PATH, а на Windows `which` вообще нет.
/// Разбираем PATH напрямую (`split_paths` учитывает `:`/`;`), затем пробуем
/// типовые места установки под конкретную ОС.
pub(crate) fn find_executable(name: &str) -> Option<String> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            if let Some(p) = probe_dir(&dir, name) {
                return Some(p);
            }
        }
    }

    // Бинари, скачанные самим приложением (runpodctl), лежат вне PATH.
    if let Some(dir) = managed_bin_dir() {
        if let Some(p) = probe_dir(&dir, name) {
            return Some(p);
        }
    }

    let extra_dirs: &[&str] = if cfg!(target_os = "windows") {
        &[]
    } else if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    } else {
        // Linux: типовые prefix'ы + snap/flatpak.
        &["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"]
    };
    for p in extra_dirs {
        if let Some(found) = probe_dir(Path::new(p), name) {
            return Some(found);
        }
    }
    None
}

/// Прячет всплывающее окно консоли при запуске дочернего процесса на Windows
/// (иначе ffmpeg/ffprobe мигают чёрным окном на каждый клип). На остальных ОС
/// no-op.
pub(crate) fn hide_console(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        // tokio::process::Command предоставляет `creation_flags` как собственный
        // метод на Windows — трейт CommandExt импортировать не нужно.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Linux-пакетные менеджеры, которые умеем дёргать, и их аргументы для
/// неинтерактивной установки ffmpeg. Порядок = приоритет.
const LINUX_PMS: &[(&str, &[&str])] = &[
    ("apt-get", &["install", "-y", "ffmpeg"]),
    ("dnf", &["install", "-y", "ffmpeg"]),
    ("pacman", &["-S", "--noconfirm", "ffmpeg"]),
    ("zypper", &["--non-interactive", "install", "ffmpeg"]),
];

/// Какой пакетный менеджер доступен для авто-установки ffmpeg на этой ОС.
fn detect_ffmpeg_installer() -> Option<String> {
    if cfg!(target_os = "macos") {
        return find_executable("brew").map(|_| "brew".to_string());
    }
    if cfg!(target_os = "windows") {
        if find_executable("winget").is_some() {
            return Some("winget".to_string());
        }
        if find_executable("choco").is_some() {
            return Some("choco".to_string());
        }
        return None;
    }
    // Linux: для системного пакета нужен root. В GUI поднимаем права через
    // pkexec (графический диалог polkit) — без него авто-установку не
    // предлагаем, только инструкцию.
    if find_executable("pkexec").is_none() {
        return None;
    }
    LINUX_PMS
        .iter()
        .find(|(pm, _)| find_executable(pm).is_some())
        .map(|(pm, _)| pm.to_string())
}

/// Инструкция по ручной установке ffmpeg под текущую ОС (fallback, когда
/// авто-установка недоступна или упала).
fn ffmpeg_manual_hint() -> String {
    if cfg!(target_os = "windows") {
        "Установите ffmpeg через winget (`winget install Gyan.FFmpeg`) или \
Chocolatey (`choco install ffmpeg`). Либо скачайте статичную сборку с \
https://www.gyan.dev/ffmpeg/builds/ и добавьте её папку bin\\ в PATH."
            .to_string()
    } else if cfg!(target_os = "macos") {
        "Установите Homebrew с https://brew.sh, затем `brew install ffmpeg`. \
Либо скачайте статичную сборку с https://evermeet.cx/ffmpeg/ и положите \
бинарник в /usr/local/bin."
            .to_string()
    } else {
        "Установите ffmpeg пакетным менеджером: Debian/Ubuntu — \
`sudo apt install ffmpeg`; Fedora — `sudo dnf install ffmpeg`; Arch — \
`sudo pacman -S ffmpeg`; openSUSE — `sudo zypper install ffmpeg`."
            .to_string()
    }
}

#[tauri::command]
pub fn check_local_tools() -> LocalTools {
    let brew_path = find_executable("brew");
    let ffmpeg_path = find_executable("ffmpeg");
    let runpodctl_path = find_executable("runpodctl");
    let has_ffmpeg = ffmpeg_path.is_some();
    LocalTools {
        os: std::env::consts::OS.to_string(),
        has_brew: brew_path.is_some(),
        has_ffmpeg,
        has_runpodctl: runpodctl_path.is_some(),
        brew_path,
        ffmpeg_path,
        runpodctl_path,
        // Если ffmpeg уже есть — installer не нужен.
        ffmpeg_installer: if has_ffmpeg {
            None
        } else {
            detect_ffmpeg_installer()
        },
        ffmpeg_manual: ffmpeg_manual_hint(),
    }
}

/// Запускает установочную команду и собирает stdout+stderr. На Windows
/// прячет окно консоли.
async fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    hide_console(&mut cmd);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    let mut out = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        return Err(if out.trim().is_empty() {
            format!("{} exited with failure", program)
        } else {
            out
        });
    }
    Ok(out)
}

async fn brew_install(formulas: &[&str]) -> Result<String, String> {
    let brew = find_executable("brew").ok_or_else(|| "brew not found".to_string())?;
    let mut args = vec!["install"];
    args.extend_from_slice(formulas);
    run_capture(&brew, &args).await
}

/// Кроссплатформенная авто-установка ffmpeg.
///
/// macOS → Homebrew; Windows → winget или Chocolatey; Linux → системный
/// пакетный менеджер под pkexec (графический запрос прав). Если подходящего
/// установщика нет — возвращаем инструкцию для ручной установки.
#[tauri::command]
pub async fn install_ffmpeg() -> Result<String, String> {
    let manual = ffmpeg_manual_hint();
    match detect_ffmpeg_installer().as_deref() {
        Some("brew") => brew_install(&["ffmpeg"]).await,
        Some("winget") => {
            let winget = find_executable("winget").ok_or("winget not found")?;
            run_capture(
                &winget,
                &[
                    "install",
                    "--id",
                    "Gyan.FFmpeg",
                    "-e",
                    "--source",
                    "winget",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            )
            .await
        }
        Some("choco") => {
            let choco = find_executable("choco").ok_or("choco not found")?;
            run_capture(&choco, &["install", "ffmpeg", "-y"]).await
        }
        Some(pm) => {
            // Linux: <pkexec> <pm> <args…>
            let (_, pm_args) = LINUX_PMS
                .iter()
                .find(|(name, _)| *name == pm)
                .ok_or_else(|| format!("unsupported package manager: {}", pm))?;
            let pkexec = find_executable("pkexec")
                .ok_or_else(|| format!("pkexec not found. {}", manual))?;
            let pm_path = find_executable(pm).ok_or_else(|| format!("{} not found", pm))?;
            let mut args: Vec<&str> = vec![pm_path.as_str()];
            args.extend_from_slice(pm_args);
            run_capture(&pkexec, &args).await
        }
        None => Err(format!("No supported package manager found. {}", manual)),
    }
}

/// Имя релизного ассета runpodctl под текущую платформу.
fn runpodctl_asset() -> Result<String, String> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("unsupported OS for runpodctl".to_string());
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" | "arm64" => "arm64",
        other => return Err(format!("unsupported arch for runpodctl: {}", other)),
    };
    let mut name = format!("runpodctl-{}-{}", os, arch);
    if cfg!(target_os = "windows") {
        name.push_str(".exe");
    }
    Ok(name)
}

/// Скачивает готовый бинарь runpodctl из GitHub-релизов в managed bin dir.
/// Работает на всех ОС без прав root и без пакетных менеджеров.
async fn download_runpodctl() -> Result<String, String> {
    let asset = runpodctl_asset()?;
    let url = format!(
        "https://github.com/runpod/runpodctl/releases/latest/download/{}",
        asset
    );
    let dir = managed_bin_dir().ok_or("cannot resolve app data dir for runpodctl")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    let bin_name = if cfg!(target_os = "windows") {
        "runpodctl.exe"
    } else {
        "runpodctl"
    };
    let dest = dir.join(bin_name);

    // reqwest сам ходит по редиректам GitHub (latest/download → CDN).
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("download runpodctl: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "download runpodctl: HTTP {} ({})",
            resp.status(),
            url
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read runpodctl body: {}", e))?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("write {}: {}", dest.display(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&dest, perm).map_err(|e| e.to_string())?;
    }
    Ok(format!("runpodctl installed to {}", dest.display()))
}

#[tauri::command]
pub async fn install_runpodctl() -> Result<String, String> {
    // На macOS с brew ставим формулой (привычный путь + авто-обновления).
    if cfg!(target_os = "macos") && find_executable("brew").is_some() {
        return brew_install(&["runpod/runpodctl/runpodctl"]).await;
    }
    // Иначе (Windows/Linux/macOS без brew) качаем бинарь напрямую.
    download_runpodctl().await
}
