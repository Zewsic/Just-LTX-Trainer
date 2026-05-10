use serde::Serialize;

#[derive(Serialize)]
pub struct LocalTools {
    pub os: String,
    pub has_brew: bool,
    pub has_ffmpeg: bool,
    pub has_runpodctl: bool,
    pub brew_path: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub runpodctl_path: Option<String>,
}

pub(crate) fn find_executable(name: &str) -> Option<String> {
    if let Ok(o) = std::process::Command::new("/usr/bin/which")
        .arg(name)
        .output()
    {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    for p in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        let candidate = std::path::Path::new(p).join(name);
        if candidate.exists() {
            return Some(candidate.display().to_string());
        }
    }
    None
}

#[tauri::command]
pub fn check_local_tools() -> LocalTools {
    let brew_path = find_executable("brew");
    let ffmpeg_path = find_executable("ffmpeg");
    let runpodctl_path = find_executable("runpodctl");
    LocalTools {
        os: std::env::consts::OS.to_string(),
        has_brew: brew_path.is_some(),
        has_ffmpeg: ffmpeg_path.is_some(),
        has_runpodctl: runpodctl_path.is_some(),
        brew_path,
        ffmpeg_path,
        runpodctl_path,
    }
}

async fn brew_install(formulas: &[&str]) -> Result<String, String> {
    let brew = find_executable("brew").ok_or_else(|| "brew not found".to_string())?;
    let output = tokio::process::Command::new(&brew)
        .arg("install")
        .args(formulas)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let mut out = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        return Err(out);
    }
    Ok(out)
}

#[tauri::command]
pub async fn install_ffmpeg() -> Result<String, String> {
    brew_install(&["ffmpeg"]).await
}

#[tauri::command]
pub async fn install_runpodctl() -> Result<String, String> {
    brew_install(&["runpod/runpodctl/runpodctl"]).await
}
