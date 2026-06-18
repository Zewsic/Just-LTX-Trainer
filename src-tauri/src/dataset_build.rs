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

/// Frames per chunk при произвольном fps. Используется в no_resize режиме:
/// trainer'у нужен `WxHxF` бакет, поэтому количество кадров считаем из
/// фактического fps клипа, а не из захардкоженных 24fps.
///
/// LTX-2 VAE требует frames вида `8k+1` (89, 97, 105, 113, 121…). Снапим
/// **вниз** от floor(secs*fps), чтобы chunk_sec гарантированно ≤ secs:
/// иначе клип, длительность которого ровно равна `secs`, при fps=29.97 и
/// округлении вверх получит chunk_sec=5.006s и будет отброшен с n_clips=0.
fn length_to_frames_at(secs: f64, fps: f64) -> u32 {
    let raw = (secs * fps).floor() as i64;
    if raw < 9 {
        return 9; // 8*1+1
    }
    let k = ((raw - 1) / 8) as u32;
    k * 8 + 1
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

    let no_resize = project.no_resize_video;
    let (fixed_width, fixed_height) = aspect_to_wh(&project.aspect_ratio);
    let fixed_frames = length_to_frames(project.length_seconds);
    let fixed_fps = 24u32;
    let fixed_chunk_sec = fixed_frames as f64 / fixed_fps as f64;

    let _ = app.emit(
        "ds_build:start",
        json!({
            "project": project.name,
            "videos": project.videos.len(),
            "frames": fixed_frames,
            "width": fixed_width,
            "height": fixed_height,
            "chunk_sec": fixed_chunk_sec,
            "no_resize": no_resize,
        }),
    );

    let mut captions: Vec<serde_json::Value> = Vec::new();
    let mut total_clips = 0usize;
    let mut per_video_clips: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut buckets_seen: std::collections::BTreeSet<(u32, u32, u32)> =
        std::collections::BTreeSet::new();

    for (vi, v) in project.videos.iter().enumerate() {
        let stem = file_stem(&v.path);
        let dur = ffprobe_duration(&ffprobe, &v.path).await?;

        // В no_resize режиме читаем нативные W×H×fps клипа; в fixed — берём
        // общие fixed_* параметры. Frames per chunk считаем из fps клипа,
        // чтобы trainer'у уехал корректный (W,H,F) бакет.
        let (clip_w, clip_h, clip_fps_f, clip_frames) = if no_resize {
            let (w, h, fps_f) = ffprobe_video_info(&ffprobe, &v.path).await?;
            let f = length_to_frames_at(project.length_seconds, fps_f);
            (w, h, fps_f, f)
        } else {
            (fixed_width, fixed_height, fixed_fps as f64, fixed_frames)
        };
        let chunk_sec = clip_frames as f64 / clip_fps_f.max(1.0);
        let stride_sec = if project.overlap { chunk_sec / 2.0 } else { chunk_sec };

        let mut n_clips = if dur < chunk_sec {
            0
        } else {
            (((dur - chunk_sec) / stride_sec).floor() as i64 + 1).max(0) as usize
        };

        // Audio VAE LTX-2 ждёт стерео-спектрограмму (2 канала). Если в
        // проекте включено аудио, а у клипа аудио-дорожки нет вообще —
        // pre-process упадёт где-то в середине датасета. Скипаем такие
        // видео целиком и сообщаем юзеру.
        if project.audio && n_clips > 0 {
            let has_audio = ffprobe_has_audio(&ffprobe, &v.path).await.unwrap_or(false);
            if !has_audio {
                n_clips = 0;
                let _ = app.emit(
                    "ds_build:skip",
                    json!({
                        "project": project.name,
                        "index": vi,
                        "name": stem,
                        "reason": "no_audio",
                    }),
                );
            }
        }
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
                "bucket_w": clip_w,
                "bucket_h": clip_h,
                "bucket_f": clip_frames,
                "src_fps": clip_fps_f,
                "chunk_sec": chunk_sec,
            }),
        );

        if n_clips == 0 {
            continue;
        }

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
                clip_frames,
                if no_resize { None } else { Some(fixed_fps) },
                if no_resize { None } else { Some((clip_w, clip_h)) },
                project.audio,
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

        if n_clips > 0 {
            buckets_seen.insert((clip_w, clip_h, clip_frames));
        }
    }

    let buckets: Vec<[u32; 3]> = buckets_seen.iter().map(|&(w, h, f)| [w, h, f]).collect();

    fs::write(
        dataset_dir.join("captions.json"),
        serde_json::to_string_pretty(&captions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    fs::write(
        dataset_dir.join("info.json"),
        serde_json::to_string_pretty(&json!({
            "frames": fixed_frames,
            "width": fixed_width,
            "height": fixed_height,
            "fps": fixed_fps,
            "no_resize": no_resize,
            "buckets": buckets,
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
    updated.last_build_buckets = buckets;
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

async fn ffprobe_has_audio(ffprobe: &str, path: &str) -> Result<bool, String> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(false);
    }
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

async fn ffprobe_video_info(ffprobe: &str, path: &str) -> Result<(u32, u32, f64), String> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
            path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe video info failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let parts: Vec<&str> = line.trim().split(',').collect();
    if parts.len() < 3 {
        return Err(format!("ffprobe video info bad output: {}", line));
    }
    let w: u32 = parts[0]
        .trim()
        .parse()
        .map_err(|e| format!("parse width '{}': {}", parts[0], e))?;
    let h: u32 = parts[1]
        .trim()
        .parse()
        .map_err(|e| format!("parse height '{}': {}", parts[1], e))?;
    let fps = parse_rational(parts[2].trim())?;
    Ok((w, h, fps))
}

fn parse_rational(s: &str) -> Result<f64, String> {
    if let Some((a, b)) = s.split_once('/') {
        let n: f64 = a.parse().map_err(|e| format!("rational num '{}': {}", a, e))?;
        let d: f64 = b.parse().map_err(|e| format!("rational den '{}': {}", b, e))?;
        if d == 0.0 {
            return Err(format!("rational zero denom in '{}'", s));
        }
        Ok(n / d)
    } else {
        s.parse::<f64>().map_err(|e| format!("rational '{}': {}", s, e))
    }
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
    fps: Option<u32>,
    size: Option<(u32, u32)>,
    audio: bool,
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
    ]);
    if let Some(f) = fps {
        cmd.args(["-r", &f.to_string()]);
    }
    if let Some((w, h)) = size {
        cmd.args(["-vf", &format!("scale={}:{}:flags=lanczos", w, h)]);
    }
    cmd.args(["-c:v", "libx264", "-crf", "18"]);
    if audio {
        // Audio VAE требует ровно 2 канала. -ac 2 апмиксит mono→stereo
        // (L=R) и даунмиксит surround→stereo. 48 kHz — стандарт mel'а.
        cmd.args([
            "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        ]);
    } else {
        cmd.arg("-an");
    }
    cmd.args(["-y", out.to_str().unwrap_or_default()]);
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

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("write {}: {}", path, e))
}

fn _used(_: PathBuf) {} // silence unused import lint
