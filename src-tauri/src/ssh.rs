use russh::client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct SshOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub command: String,
}

#[derive(Debug, Serialize)]
pub struct SshResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

struct Handler;

#[async_trait::async_trait]
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tauri::command]
pub async fn ssh_exec(opts: SshOptions) -> Result<SshResult, String> {
    exec_inner(opts).await.map_err(|e| e.to_string())
}

async fn exec_inner(opts: SshOptions) -> anyhow::Result<SshResult> {
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..<_>::default()
    });
    let mut session =
        client::connect(cfg, (opts.host.as_str(), opts.port), Handler).await?;

    let authed = match opts.auth_kind.as_str() {
        "password" => {
            let pw = opts.password.unwrap_or_default();
            session.authenticate_password(&opts.user, pw).await?
        }
        _ => {
            let path = opts.key_path.unwrap_or_default();
            let path = shellexpand::tilde(&path).into_owned();
            let key = russh_keys::load_secret_key(&path, None)?;
            session
                .authenticate_publickey(&opts.user, Arc::new(key))
                .await?
        }
    };
    if !authed {
        anyhow::bail!("authentication failed");
    }

    let mut channel = session.channel_open_session().await?;
    channel.exec(true, opts.command.as_bytes()).await?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg::*;
        match msg {
            Data { ref data } => stdout.extend_from_slice(data),
            ExtendedData { ref data, ext } if ext == 1 => stderr.extend_from_slice(data),
            ExitStatus { exit_status } => {
                code = Some(exit_status);
            }
            Eof | Close => break,
            _ => {}
        }
    }

    Ok(SshResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: code,
    })
}

#[derive(Serialize)]
pub struct SshProbeResult {
    pub ok: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_used: Option<String>,
    pub error: Option<String>,
}

fn home_key_candidates() -> Vec<PathBuf> {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return vec![],
    };
    ["id_ed25519", "id_rsa", "id_ecdsa"]
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|p| p.exists())
        .collect()
}

#[tauri::command]
pub async fn pod_ssh_probe(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
) -> SshProbeResult {
    let user = "root".to_string();

    let (host, port) = match resolve_pod_ssh_endpoint(&api_key, &pod_id).await {
        Ok(ep) => ep,
        Err(e) => {
            return SshProbeResult {
                ok: false,
                host: String::new(),
                port: 0,
                user,
                key_used: None,
                error: Some(e),
            }
        }
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = crate::ssh_key::app_key_path(&app) {
        if p.exists() {
            candidates.push(p);
        }
    }
    candidates.extend(home_key_candidates());

    if candidates.is_empty() {
        return SshProbeResult {
            ok: false,
            host,
            port,
            user,
            key_used: None,
            error: Some(
                "no SSH private key found (try \"Generate & add SSH key\")".into(),
            ),
        };
    }

    let mut last_err = String::new();
    for key_path in &candidates {
        match probe_with_key(&host, port, &user, key_path).await {
            Ok(()) => {
                return SshProbeResult {
                    ok: true,
                    host,
                    port,
                    user,
                    key_used: Some(key_path.display().to_string()),
                    error: None,
                };
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    SshProbeResult {
        ok: false,
        host,
        port,
        user,
        key_used: None,
        error: Some(last_err),
    }
}

async fn probe_with_key(
    host: &str,
    port: u16,
    user: &str,
    key_path: &std::path::Path,
) -> anyhow::Result<()> {
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..<_>::default()
    });
    let mut session =
        tokio::time::timeout(Duration::from_secs(15), client::connect(cfg, (host, port), Handler))
            .await
            .map_err(|_| anyhow::anyhow!("connection timeout"))??;

    let key = russh_keys::load_secret_key(key_path, None)
        .map_err(|e| anyhow::anyhow!("load key {}: {}", key_path.display(), e))?;
    let authed = session
        .authenticate_publickey(user, Arc::new(key))
        .await?;
    if !authed {
        anyhow::bail!("authentication failed");
    }
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, b"echo ok").await?;
    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg::*;
        match msg {
            ExitStatus { .. } | Eof | Close => break,
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn collect_keys(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Ok(p) = crate::ssh_key::app_key_path(app) {
        if p.exists() {
            c.push(p);
        }
    }
    c.extend(home_key_candidates());
    c
}

pub(crate) async fn exec_stream<F>(
    host: &str,
    port: u16,
    user: &str,
    keys: &[PathBuf],
    cmd: &str,
    mut on_chunk: F,
) -> Result<i32, String>
where
    F: FnMut(&[u8], bool) + Send,
{
    if keys.is_empty() {
        return Err("no SSH private key available".into());
    }
    let mut last_err = String::new();
    for key_path in keys {
        match exec_one_stream(host, port, user, key_path, cmd, &mut on_chunk).await {
            Ok(code) => return Ok(code),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

async fn exec_one_stream<F>(
    host: &str,
    port: u16,
    user: &str,
    key_path: &std::path::Path,
    cmd: &str,
    on_chunk: &mut F,
) -> anyhow::Result<i32>
where
    F: FnMut(&[u8], bool) + Send,
{
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60 * 30)),
        ..<_>::default()
    });
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(cfg, (host, port), Handler),
    )
    .await
    .map_err(|_| anyhow::anyhow!("connection timeout"))??;
    let key = russh_keys::load_secret_key(key_path, None)
        .map_err(|e| anyhow::anyhow!("load key {}: {}", key_path.display(), e))?;
    let authed = session
        .authenticate_publickey(user, Arc::new(key))
        .await?;
    if !authed {
        anyhow::bail!("authentication failed");
    }
    let mut channel = session.channel_open_session().await?;
    // Запрашиваем PTY: с псевдо-терминалом инструменты (uv / hf / apt) не
    // буферизуют stdout и эмитят прогресс-бары / промежуточные строки.
    channel
        .request_pty(true, "xterm-256color", 200, 50, 0, 0, &[])
        .await
        .ok();
    channel.exec(true, cmd.as_bytes()).await?;
    let mut exit: i32 = 0;
    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg::*;
        match msg {
            // С PTY stderr мерджится в stdout (канал Data) → ветку ExtendedData
            // игнорируем, чтобы не дублировать вывод.
            Data { ref data } => on_chunk(data, false),
            ExitStatus { exit_status } => exit = exit_status as i32,
            Eof | Close => break,
            _ => {}
        }
    }
    Ok(exit)
}

pub(crate) async fn exec_remote(
    host: &str,
    port: u16,
    user: &str,
    keys: &[PathBuf],
    cmd: &str,
) -> Result<String, String> {
    if keys.is_empty() {
        return Err("no SSH private key available".into());
    }
    let mut last_err = String::new();
    for key_path in keys {
        match exec_one(host, port, user, key_path, cmd).await {
            Ok(s) => return Ok(s),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// Запускает `cmd` на поде и пишет `stdin` в его stdin. Используем для
/// заливки бинарных файлов (картинки, чекпоинты) — никаких ARG_MAX-лимитов
/// и base64-оверхеда. Возвращает stdout команды.
pub(crate) async fn exec_remote_with_stdin(
    host: &str,
    port: u16,
    user: &str,
    keys: &[PathBuf],
    cmd: &str,
    stdin: &[u8],
) -> Result<String, String> {
    if keys.is_empty() {
        return Err("no SSH private key available".into());
    }
    let mut last_err = String::new();
    for key_path in keys {
        match exec_one_with_stdin(host, port, user, key_path, cmd, stdin).await {
            Ok(s) => return Ok(s),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

async fn exec_one_with_stdin(
    host: &str,
    port: u16,
    user: &str,
    key_path: &std::path::Path,
    cmd: &str,
    stdin: &[u8],
) -> anyhow::Result<String> {
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        ..<_>::default()
    });
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(cfg, (host, port), Handler),
    )
    .await
    .map_err(|_| anyhow::anyhow!("connection timeout"))??;
    let key = russh_keys::load_secret_key(key_path, None)
        .map_err(|e| anyhow::anyhow!("load key {}: {}", key_path.display(), e))?;
    let authed = session
        .authenticate_publickey(user, Arc::new(key))
        .await?;
    if !authed {
        anyhow::bail!("authentication failed");
    }
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, cmd.as_bytes()).await?;
    // Шлём stdin кусками — для крупных картинок (5+ MB) один data-фрейм
    // может не пролезть (server-side window). 32 KiB — заведомо безопасно.
    for chunk in stdin.chunks(32 * 1024) {
        channel.data(chunk).await?;
    }
    channel.eof().await?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg::*;
        match msg {
            Data { ref data } => stdout.extend_from_slice(data),
            ExtendedData { ref data, ext } if ext == 1 => stderr.extend_from_slice(data),
            ExitStatus { exit_status } => exit_code = Some(exit_status),
            Eof | Close => break,
            _ => {}
        }
    }
    if exit_code.unwrap_or(0) != 0 {
        let err = String::from_utf8_lossy(&stderr).into_owned();
        anyhow::bail!(
            "command exited with code {}: {}",
            exit_code.unwrap_or(0),
            err.trim()
        );
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

async fn exec_one(
    host: &str,
    port: u16,
    user: &str,
    key_path: &std::path::Path,
    cmd: &str,
) -> anyhow::Result<String> {
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..<_>::default()
    });
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(cfg, (host, port), Handler),
    )
    .await
    .map_err(|_| anyhow::anyhow!("connection timeout"))??;
    let key = russh_keys::load_secret_key(key_path, None)
        .map_err(|e| anyhow::anyhow!("load key {}: {}", key_path.display(), e))?;
    let authed = session
        .authenticate_publickey(user, Arc::new(key))
        .await?;
    if !authed {
        anyhow::bail!("authentication failed");
    }
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, cmd.as_bytes()).await?;
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg::*;
        match msg {
            Data { ref data } => stdout.extend_from_slice(data),
            ExtendedData { ref data, ext } if ext == 1 => stderr.extend_from_slice(data),
            ExitStatus { exit_status } => exit_code = Some(exit_status),
            Eof | Close => break,
            _ => {}
        }
    }
    if exit_code.unwrap_or(0) != 0 {
        let err = String::from_utf8_lossy(&stderr).into_owned();
        anyhow::bail!(
            "command exited with code {}: {}",
            exit_code.unwrap_or(0),
            err.trim()
        );
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

pub(crate) async fn resolve_pod_ssh_endpoint(
    api_key: &str,
    pod_id: &str,
) -> Result<(String, u16), String> {
    use serde_json::{json, Value};
    let q = json!({
        "query": "query($id: String!) { pod(input: { podId: $id }) { id desiredStatus runtime { ports { ip isIpPublic privatePort publicPort type } } } }",
        "variables": { "id": pod_id }
    });
    let v = crate::servers::graphql(api_key, q).await?;
    let pod = v
        .pointer("/data/pod")
        .ok_or_else(|| "pod not found".to_string())?;
    if pod.is_null() {
        return Err("pod not found".into());
    }
    let status = pod
        .get("desiredStatus")
        .and_then(Value::as_str)
        .unwrap_or("");
    if status != "RUNNING" {
        return Err(format!("pod is not running (status: {})", status));
    }
    let ports = pod
        .pointer("/runtime/ports")
        .and_then(Value::as_array)
        .ok_or_else(|| "pod has no runtime ports yet — wait a few seconds".to_string())?;
    for p in ports {
        let private_port = p.get("privatePort").and_then(Value::as_i64).unwrap_or(0);
        let kind = p.get("type").and_then(Value::as_str).unwrap_or("");
        let is_public = p.get("isIpPublic").and_then(Value::as_bool).unwrap_or(false);
        if private_port == 22 && kind.eq_ignore_ascii_case("tcp") && is_public {
            let ip = p
                .get("ip")
                .and_then(Value::as_str)
                .ok_or_else(|| "no IP for SSH port".to_string())?;
            let pub_port = p
                .get("publicPort")
                .and_then(Value::as_i64)
                .ok_or_else(|| "no public port for SSH".to_string())?;
            return Ok((ip.to_string(), pub_port as u16));
        }
    }
    Err("pod has no public 22/tcp mapping — was it deployed without SSH port exposed?".into())
}
