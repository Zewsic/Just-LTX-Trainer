use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct UploadInfo {
    pub hash: String,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct TrainingConfig {
    /// Подпись (хэш build+upload+captions) на момент успешного предобучения.
    /// Если не совпадает с текущей — предобучение считается устаревшим.
    #[serde(default)]
    pub pretrain_signature: Option<String>,
    #[serde(default)]
    pub pretrain_done_at: i64,

    #[serde(default)]
    pub rank: Option<u32>, // 16 / 32 / 64 / 128 / 256
    #[serde(default)]
    pub mode: Option<String>, // "t2v" | "i2v" | "both"
    #[serde(default)]
    pub steps: Option<u32>,

    #[serde(default)]
    pub validation_prompts: Vec<String>,
    #[serde(default)]
    pub validation_images: Vec<String>,

    #[serde(default)]
    pub enable_gradient_checkpointing: Option<bool>,
    #[serde(default)]
    pub load_text_encoder_in_8bit: Option<bool>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct VideoEntry {
    pub path: String,
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    #[serde(default)]
    pub local_setup_done: bool,
    #[serde(default)]
    pub videos: Vec<VideoEntry>,
    #[serde(default = "default_aspect")]
    pub aspect_ratio: String,
    #[serde(default = "default_length")]
    pub length_seconds: f64,
    #[serde(default)]
    pub overlap: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub last_build_hash: Option<String>,
    #[serde(default)]
    pub last_build_zip: Option<String>,
    #[serde(default)]
    pub last_build_at: i64,
    /// Сколько клипов выдало каждое исходное видео при последней сборке.
    /// Ключ — абсолютный путь, значение — N. Видео с N=0 в датасет не попали.
    #[serde(default)]
    pub last_build_clips: HashMap<String, u32>,
    #[serde(default)]
    pub last_uploads: HashMap<String, UploadInfo>,
    #[serde(default)]
    pub training: TrainingConfig,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_aspect() -> String {
    "16:9".to_string()
}
fn default_length() -> f64 {
    5.0
}

pub(crate) fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let dir = dir.join("projects");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_. ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    s.trim().to_string()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = projects_dir(&app)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let pj = entry.path().join("project.json");
        if pj.exists() {
            if let Ok(text) = fs::read_to_string(&pj) {
                if let Ok(p) = serde_json::from_str::<Project>(&text) {
                    names.push(p.name);
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

pub(crate) fn load_project_inner(app: &tauri::AppHandle, name: &str) -> Result<Project, String> {
    let dir = projects_dir(app)?;
    let pj = dir.join(sanitize(name)).join("project.json");
    let text = fs::read_to_string(&pj).map_err(|e| format!("read {:?}: {}", pj, e))?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub(crate) fn save_project_inner(app: &tauri::AppHandle, mut p: Project) -> Result<Project, String> {
    let dir = projects_dir(app)?;
    let pdir = dir.join(sanitize(&p.name));
    fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
    let now = now_millis();
    p.updated_at = now;
    if p.created_at == 0 {
        p.created_at = now;
    }
    let text = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
    fs::write(pdir.join("project.json"), text).map_err(|e| e.to_string())?;
    Ok(p)
}

#[tauri::command]
pub fn load_project(app: tauri::AppHandle, name: String) -> Result<Project, String> {
    load_project_inner(&app, &name)
}

#[tauri::command]
pub fn save_project(app: tauri::AppHandle, project: Project) -> Result<Project, String> {
    save_project_inner(&app, project)
}

#[tauri::command]
pub fn create_project(app: tauri::AppHandle, name: String) -> Result<Project, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty name".into());
    }
    let dir = projects_dir(&app)?;
    let pdir = dir.join(sanitize(&trimmed));
    if pdir.exists() {
        return Err(format!("project '{}' already exists", trimmed));
    }
    let p = Project {
        name: trimmed,
        local_setup_done: false,
        videos: Vec::new(),
        aspect_ratio: default_aspect(),
        length_seconds: default_length(),
        overlap: false,
        audio: false,
        last_build_hash: None,
        last_build_zip: None,
        last_build_at: 0,
        last_build_clips: HashMap::new(),
        last_uploads: HashMap::new(),
        training: TrainingConfig::default(),
        created_at: 0,
        updated_at: 0,
    };
    save_project(app, p)
}

#[tauri::command]
pub fn delete_project(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = projects_dir(&app)?;
    let pdir = dir.join(sanitize(&name));
    if pdir.exists() {
        fs::remove_dir_all(&pdir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
