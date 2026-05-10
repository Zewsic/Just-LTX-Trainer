use crate::local_setup::find_executable;
use crate::projects::{load_project_inner, save_project_inner, UploadInfo};
use crate::ssh::{collect_keys, exec_remote, exec_stream, resolve_pod_ssh_endpoint};
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == 0x1b && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'[' {
                i += 2;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if b.is_ascii_alphabetic() {
                        break;
                    }
                }
                continue;
            } else if next == b']' {
                i += 2;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if b == 0x07 || b == 0x1b {
                        break;
                    }
                }
                continue;
            } else {
                i += 2;
                continue;
            }
        }
        out.push(c as char);
        i += 1;
    }
    out
}

fn parse_runpodctl_code(line: &str) -> Option<String> {
    let cleaned = strip_ansi(line);
    let lower = cleaned.to_lowercase();
    // "Code is: 1234-foo-bar" / "code is:..." — case-insensitive
    if let Some(idx) = lower.find("code is:") {
        let rest = cleaned[idx + "code is:".len()..].trim();
        let token = rest.split_whitespace().next()?.trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    // Запасной вариант — runpodctl сначала печатает голый код вида
    // "1234-word-word-word" / "5023-miami-egypt-media-9" одной строкой.
    let trimmed = cleaned.trim();
    if !trimmed.is_empty() && trimmed.contains('-') && !trimmed.contains(' ') {
        let parts: Vec<&str> = trimmed.split('-').collect();
        let looks_like_code = parts.len() >= 3
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.chars().all(|c| c.is_ascii_alphanumeric())
            });
        if looks_like_code {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[tauri::command]
pub async fn upload_dataset(
    app: AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<(), String> {
    let project = load_project_inner(&app, &project_name)?;
    let hash = project
        .last_build_hash
        .clone()
        .ok_or_else(|| "no built dataset to upload".to_string())?;
    let zip = project
        .last_build_zip
        .clone()
        .ok_or_else(|| "no built zip path".to_string())?;
    if !Path::new(&zip).exists() {
        return Err(format!("zip not found at {}", zip));
    }
    let runpodctl =
        find_executable("runpodctl").ok_or_else(|| "runpodctl not installed locally".to_string())?;

    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);

    let dataset_dir = format!("/workspace/datasets/{}", project.name);

    // Bootstrap pod-side: install runpodctl + unzip if missing, prepare dir
    let _ = app.emit(
        "ds_upload:phase",
        json!({ "phase": "bootstrap", "pod_id": pod_id, "project": project.name }),
    );
    let bootstrap = format!(
        r#"set -eu
mkdir -p /workspace/datasets
rm -rf "{dir}"
mkdir -p "{dir}"
if ! command -v unzip >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip
fi
if ! command -v runpodctl >/dev/null 2>&1; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) BIN=runpodctl-linux-amd64;;
    aarch64|arm64) BIN=runpodctl-linux-arm64;;
    *) echo "unsupported arch: $ARCH"; exit 1;;
  esac
  curl -fsSL "https://github.com/runpod/runpodctl/releases/latest/download/$BIN" -o /usr/local/bin/runpodctl
  chmod +x /usr/local/bin/runpodctl
fi
runpodctl --version || true
echo bootstrap_done
"#,
        dir = dataset_dir,
    );
    exec_remote(&host, port, "root", &keys, &bootstrap).await?;

    // Spawn local `runpodctl send`. Заворачиваем в `script -q /dev/null`,
    // чтобы у дочернего процесса был псевдо-TTY — иначе runpodctl
    // блок-буферизует stdout и мы не видим строчку «code is: ...» вовремя.
    let _ = app.emit(
        "ds_upload:phase",
        json!({ "phase": "send_starting", "pod_id": pod_id, "project": project.name }),
    );
    let mut send = Command::new("script")
        .args(["-q", "/dev/null"])
        .arg(&runpodctl)
        .arg("send")
        .arg(&zip)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn runpodctl send: {}", e))?;

    let stdout = send
        .stdout
        .take()
        .ok_or_else(|| "no stdout pipe".to_string())?;
    let stderr = send
        .stderr
        .take()
        .ok_or_else(|| "no stderr pipe".to_string())?;

    let (code_tx, mut code_rx) = mpsc::channel::<String>(1);

    let app_for_stdout = app.clone();
    let pod_for_stdout = pod_id.clone();
    let project_for_stdout = project.name.clone();
    let stdout_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut sent = false;
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stdout.emit(
                "ds_upload:log",
                json!({ "pod_id": pod_for_stdout, "project": project_for_stdout,
                        "side": "send", "line": line }),
            );
            if !sent {
                if let Some(code) = parse_runpodctl_code(&line) {
                    let _ = code_tx.send(code).await;
                    sent = true;
                }
            }
        }
    });
    let app_for_stderr = app.clone();
    let pod_for_stderr = pod_id.clone();
    let project_for_stderr = project.name.clone();
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit(
                "ds_upload:log",
                json!({ "pod_id": pod_for_stderr, "project": project_for_stderr,
                        "side": "send", "line": line, "stderr": true }),
            );
        }
    });

    // Ждём код (до 30с)
    let code = match tokio::time::timeout(Duration::from_secs(30), code_rx.recv()).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            let _ = send.kill().await;
            return Err("runpodctl send exited without producing a code".into());
        }
        Err(_) => {
            let _ = send.kill().await;
            return Err("timeout waiting for runpodctl send code".into());
        }
    };
    let _ = app.emit(
        "ds_upload:got_code",
        json!({ "pod_id": pod_id, "project": project.name, "code": &code }),
    );

    // Запускаем receive на поде
    let _ = app.emit(
        "ds_upload:phase",
        json!({ "phase": "transferring", "pod_id": pod_id, "project": project.name }),
    );
    let receive_cmd = format!(
        "set -eu\ncd \"{dir}\"\nrunpodctl receive {code}",
        dir = dataset_dir,
        code = code,
    );
    let app_for_recv = app.clone();
    let pod_for_recv = pod_id.clone();
    let project_for_recv = project.name.clone();
    let recv_result = exec_stream(&host, port, "root", &keys, &receive_cmd, move |buf, _| {
        let line = String::from_utf8_lossy(buf).to_string();
        let _ = app_for_recv.emit(
            "ds_upload:log",
            json!({ "pod_id": pod_for_recv, "project": project_for_recv,
                    "side": "receive", "line": line }),
        );
    })
    .await;

    // Ждём send-процесс
    let send_status = send.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    if let Err(e) = recv_result {
        return Err(format!("receive failed: {}", e));
    }
    if !send_status.success() {
        return Err(format!("runpodctl send exit: {}", send_status));
    }

    // Распаковываем zip → удаляем
    let _ = app.emit(
        "ds_upload:phase",
        json!({ "phase": "extracting", "pod_id": pod_id, "project": project.name }),
    );
    let extract = format!(
        r#"set -eu
cd "{dir}"
ZIP=$(ls *.zip 2>/dev/null | head -n1)
if [ -z "$ZIP" ]; then
  echo "no zip found in {dir}"
  exit 1
fi
unzip -q "$ZIP" -d .
rm -f "$ZIP"
ls -la
echo extract_done
"#,
        dir = dataset_dir,
    );
    let app_for_ext = app.clone();
    let pod_for_ext = pod_id.clone();
    let project_for_ext = project.name.clone();
    exec_stream(&host, port, "root", &keys, &extract, move |buf, _| {
        let line = String::from_utf8_lossy(buf).to_string();
        let _ = app_for_ext.emit(
            "ds_upload:log",
            json!({ "pod_id": pod_for_ext, "project": project_for_ext,
                    "side": "extract", "line": line }),
        );
    })
    .await?;

    // Сохраняем хэш аплоада в проекте
    let mut updated = project.clone();
    updated.last_uploads.insert(
        pod_id.clone(),
        UploadInfo {
            hash: hash.clone(),
            at: now_millis(),
        },
    );
    save_project_inner(&app, updated)?;

    let _ = app.emit(
        "ds_upload:done",
        json!({ "pod_id": pod_id, "project": project.name, "hash": hash,
                "dataset_dir": dataset_dir }),
    );
    Ok(())
}
