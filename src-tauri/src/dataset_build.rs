use crate::local_setup::find_executable;
use crate::projects::{load_project_inner, projects_dir, sanitize, save_project_inner};
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone)]
pub struct BuildResult {
    pub zip_path: String,
    pub clips: usize,
    pub captions: usize,
    pub hash: String,
}

fn aspect_to_wh(a: &str) -> (u32, u32) {
    match a {
        "16:9" => (704, 384),
        "4:3" => (640, 480),
        "1:1" => (512, 512),
        "3:4" => (480, 640),
        "9:16" => (384, 704),
        _ => (704, 384),
    }
}

fn length_to_frames(secs: f64) -> u32 {
    if (secs - 3.7).abs() < 0.05 {
        89
    } else {
        121
    }
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("clip")
        .to_string()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
pub async fn build_dataset(
    app: AppHandle,
    project_name: String,
    hash: String,
) -> Result<BuildResult, String> {
    let project = load_project_inner(&app, &project_name)?;
    let ffmpeg = find_executable("ffmpeg").ok_or("ffmpeg not found in PATH".to_string())?;
    let ffprobe = find_executable("ffprobe").ok_or("ffprobe not found in PATH".to_string())?;

    let proj_dir = projects_dir(&app)?.join(sanitize(&project.name));
    let dataset_dir = proj_dir.join("dataset");
    let ready_dir = dataset_dir.join("ready");
    if dataset_dir.exists() {
        fs::remove_dir_all(&dataset_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&ready_dir).map_err(|e| e.to_string())?;

    let (width, height) = aspect_to_wh(&project.aspect_ratio);
    let frames = length_to_frames(project.length_seconds);
    let fps = 24u32;
    let chunk_sec = frames as f64 / fps as f64;
    let stride_sec = if project.overlap {
        chunk_sec / 2.0
    } else {
        chunk_sec
    };

    let _ = app.emit(
        "ds_build:start",
        json!({
            "project": project.name,
            "videos": project.videos.len(),
            "frames": frames,
            "width": width,
            "height": height,
            "chunk_sec": chunk_sec,
            "stride_sec": stride_sec,
        }),
    );

    let mut captions: Vec<serde_json::Value> = Vec::new();
    let mut total_clips = 0usize;
    let mut per_video_clips: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    for (vi, v) in project.videos.iter().enumerate() {
        let stem = file_stem(&v.path);
        let dur = ffprobe_duration(&ffprobe, &v.path).await?;
        let n_clips = if dur < chunk_sec {
            0
        } else {
            (((dur - chunk_sec) / stride_sec).floor() as i64 + 1).max(0) as usize
        };
        per_video_clips.insert(v.path.clone(), n_clips as u32);

        let _ = app.emit(
            "ds_build:video",
            json!({
                "project": project.name,
                "index": vi,
                "total": project.videos.len(),
                "name": stem,
                "duration": dur,
                "clips": n_clips,
            }),
        );

        let mut start = 0.0_f64;
        let mut i = 1;
        while start + chunk_sec <= dur + 1e-6 {
            let out_name = format!("{}_part{}.mp4", stem, i);
            let out = ready_dir.join(&out_name);
            let _ = app.emit(
                "ds_build:clip_start",
                json!({
                    "project": project.name,
                    "video_index": vi,
                    "name": stem,
                    "clip": i,
                    "of": n_clips,
                    "start": start,
                }),
            );
            run_ffmpeg(
                &ffmpeg,
                &v.path,
                start,
                frames,
                fps,
                width,
                height,
                &out,
                &app,
                &project.name,
            )
            .await?;

            if let Some(p) = v.prompt.as_ref() {
                if !p.trim().is_empty() {
                    captions.push(json!({
                        "caption": p,
                        "media_path": format!("ready/{}", out_name),
                    }));
                }
            }

            total_clips += 1;
            let _ = app.emit(
                "ds_build:clip_done",
                json!({
                    "project": project.name,
                    "video_index": vi,
                    "clip": i,
                    "total_clips": total_clips,
                }),
            );

            start += stride_sec;
            i += 1;
        }
    }

    fs::write(
        dataset_dir.join("captions.json"),
        serde_json::to_string_pretty(&captions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    fs::write(
        dataset_dir.join("info.json"),
        serde_json::to_string_pretty(&json!({
            "frames": frames,
            "width": width,
            "height": height,
            "fps": fps,
            "audio": project.audio,
            "hash": hash,
            "name": project.name,
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("ds_build:zipping", json!({ "project": project.name }));
    let zip_path = proj_dir.join("dataset.zip");
    if zip_path.exists() {
        fs::remove_file(&zip_path).ok();
    }
    create_zip(&dataset_dir, &zip_path)?;

    // запоминаем в проекте
    let mut updated = project.clone();
    updated.last_build_hash = Some(hash.clone());
    updated.last_build_zip = Some(zip_path.display().to_string());
    updated.last_build_at = now_millis();
    updated.last_build_clips = per_video_clips;
    save_project_inner(&app, updated)?;

    let result = BuildResult {
        zip_path: zip_path.display().to_string(),
        clips: total_clips,
        captions: captions.len(),
        hash,
    };
    let _ = app.emit(
        "ds_build:done",
        json!({
            "project": project.name,
            "zip_path": result.zip_path.clone(),
            "clips": result.clips,
            "captions": result.captions,
        }),
    );
    Ok(result)
}

async fn ffprobe_duration(ffprobe: &str, path: &str) -> Result<f64, String> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim()
        .parse::<f64>()
        .map_err(|e| format!("parse duration: {}", e))
}

async fn run_ffmpeg(
    ffmpeg: &str,
    input: &str,
    start: f64,
    frames: u32,
    fps: u32,
    width: u32,
    height: u32,
    out: &Path,
    app: &AppHandle,
    project: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-ss",
        &format!("{}", start),
        "-i",
        input,
        "-frames:v",
        &frames.to_string(),
        "-r",
        &fps.to_string(),
        "-vf",
        &format!("scale={}:{}:flags=lanczos", width, height),
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-y",
        out.to_str().unwrap_or_default(),
    ]);
    cmd.stderr(Stdio::piped());
    cmd.stdout(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(stderr) = child.stderr.take() {
        let mut reader = BufReader::new(stderr).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let _ = app.emit(
                        "ds_build:log",
                        json!({ "project": project, "line": line }),
                    );
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg failed for {}", input));
    }
    Ok(())
}

fn create_zip(src: &Path, dst: &Path) -> Result<(), String> {
    let f = fs::File::create(dst).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(f);
    let opts: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add_dir_recursive(&mut zip, src, src, opts)?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_recursive(
    zip: &mut zip::ZipWriter<fs::File>,
    base: &Path,
    dir: &Path,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let rel = p.strip_prefix(base).unwrap();
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if p.is_dir() {
            zip.add_directory(format!("{}/", rel_str), opts)
                .map_err(|e| e.to_string())?;
            add_dir_recursive(zip, base, &p, opts)?;
        } else {
            zip.start_file(rel_str, opts).map_err(|e| e.to_string())?;
            let mut f = fs::File::open(&p).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            zip.write_all(&buf).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> Result<(), String> {
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

fn _used(_: PathBuf) {} // silence unused import lint
