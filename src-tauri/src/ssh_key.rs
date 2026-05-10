use crate::servers::graphql;
use russh_keys::{encode_pkcs8_pem, key, PublicKeyBase64};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const KEY_NAME: &str = "runpod_ed25519";
const KEY_COMMENT: &str = "just-ltx-trainer";

#[derive(Serialize)]
pub struct KeySetup {
    pub private_key_path: String,
    pub public_key: String,
    pub created: bool,
    pub uploaded: bool,
    pub already_present: bool,
}

#[derive(Serialize)]
pub struct KeyStatus {
    pub local_exists: bool,
    pub private_key_path: String,
    pub public_key: Option<String>,
    pub in_runpod: bool,
}

pub fn app_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(KEY_NAME))
}

fn read_pub(priv_path: &Path) -> Option<String> {
    let pub_path = priv_path.with_extension("pub");
    fs::read_to_string(pub_path).ok().and_then(|s| {
        let s = s.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    })
}

fn ensure_key(priv_path: &Path) -> Result<(String, bool), String> {
    if priv_path.exists() {
        if let Some(p) = read_pub(priv_path) {
            return Ok((p, false));
        }
    }
    let kp = key::KeyPair::generate_ed25519().ok_or("failed to generate key")?;

    let mut priv_buf: Vec<u8> = Vec::new();
    encode_pkcs8_pem(&kp, &mut priv_buf).map_err(|e| e.to_string())?;
    fs::write(priv_path, &priv_buf).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(priv_path, perm);
    }

    let pub_key = kp
        .clone_public_key()
        .map_err(|e| e.to_string())?;
    let b64 = pub_key.public_key_base64();
    let line = format!("ssh-ed25519 {} {}", b64, KEY_COMMENT);
    fs::write(priv_path.with_extension("pub"), &line).map_err(|e| e.to_string())?;
    Ok((line, true))
}

async fn fetch_user_pubkey(api_key: &str) -> Result<String, String> {
    let q = json!({ "query": "query { myself { pubKey } }" });
    let v = graphql(api_key, q).await?;
    Ok(v.pointer("/data/myself/pubKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

async fn save_user_pubkey(api_key: &str, pub_key: &str) -> Result<(), String> {
    let q = json!({
        "query": "mutation($input: UpdateUserSettingsInput!) { updateUserSettings(input: $input) { id } }",
        "variables": { "input": { "pubKey": pub_key } }
    });
    graphql(api_key, q).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_ssh_key_status(
    app: tauri::AppHandle,
    api_key: String,
) -> Result<KeyStatus, String> {
    let priv_path = app_key_path(&app)?;
    let local_exists = priv_path.exists();
    let public_key = if local_exists { read_pub(&priv_path) } else { None };
    let in_runpod = match (&public_key, fetch_user_pubkey(&api_key).await) {
        (Some(p), Ok(remote)) => remote.lines().any(|l| l.trim() == p.trim()),
        _ => false,
    };
    Ok(KeyStatus {
        local_exists,
        private_key_path: priv_path.display().to_string(),
        public_key,
        in_runpod,
    })
}

#[tauri::command]
pub async fn revoke_runpod_ssh_key(
    app: tauri::AppHandle,
    api_key: String,
) -> Result<(), String> {
    let priv_path = app_key_path(&app)?;
    if let Some(our_pub) = read_pub(&priv_path) {
        if let Ok(existing) = fetch_user_pubkey(&api_key).await {
            let kept: Vec<String> = existing
                .lines()
                .filter(|l| l.trim() != our_pub.trim() && !l.trim().is_empty())
                .map(String::from)
                .collect();
            let new_combined = kept.join("\n");
            save_user_pubkey(&api_key, &new_combined).await?;
        }
    }
    let _ = fs::remove_file(&priv_path);
    let _ = fs::remove_file(priv_path.with_extension("pub"));
    Ok(())
}

#[tauri::command]
pub async fn setup_runpod_ssh_key(
    app: tauri::AppHandle,
    api_key: String,
) -> Result<KeySetup, String> {
    let priv_path = app_key_path(&app)?;
    let (our_pub, created) = ensure_key(&priv_path)?;

    let existing = fetch_user_pubkey(&api_key).await.unwrap_or_default();
    let already_present = existing
        .lines()
        .any(|line| line.trim() == our_pub.trim());

    let mut uploaded = false;
    if !already_present {
        let combined = if existing.trim().is_empty() {
            our_pub.clone()
        } else {
            format!("{}\n{}", existing.trim_end(), our_pub)
        };
        save_user_pubkey(&api_key, &combined).await?;
        uploaded = true;
    }

    Ok(KeySetup {
        private_key_path: priv_path.display().to_string(),
        public_key: our_pub,
        created,
        uploaded,
        already_present,
    })
}
