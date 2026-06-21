//! Авто-кэптионинг датасета на поде. Большой шаг (`start_caption`) пускается
//! как `TmuxTask`, тестовый запуск — короткий стриминг через `exec_stream`.
//!
//! Все пути с именем проекта подставляются в shell через двойные кавычки,
//! cli-аргументы — через `shell::escape`.

use crate::shell;
use crate::ssh::{collect_keys, exec_remote, exec_stream, resolve_pod_ssh_endpoint};
use crate::tmux_task::{task_at, TmuxTask};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

const STATE_DIR_BASE: &str = "/workspace/.ltx-caption";

const PATH_SETUP: &str = r#"export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env" || true
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true
export UV_CACHE_DIR=/workspace/.uv-cache
export UV_LINK_MODE=copy"#;

fn project_task(project: &str) -> TmuxTask {
    task_at(STATE_DIR_BASE, "ltx_cap_", project)
}

#[derive(Serialize, Default)]
pub struct CaptionStatus {
    pub state: String,
    pub exit_code: Option<i32>,
    pub log_size: u64,
}

#[tauri::command]
pub async fn check_caption_state(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<CaptionStatus, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let s = project_task(&project_name).state(&host, port, &keys).await?;
    Ok(CaptionStatus {
        state: s.state,
        exit_code: s.exit_code,
        log_size: s.log_size,
    })
}

#[derive(Deserialize)]
pub struct StartCaptionArgs {
    pub api_key: String,
    pub pod_id: String,
    pub project_name: String,
    pub provider: String, // "qwen_omni" | "gemini_flash" | "single"
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub single_caption: Option<String>,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub gemini_api_key: Option<String>,
    #[serde(default)]
    pub override_all: bool,
}

#[tauri::command]
pub async fn start_caption(
    app: tauri::AppHandle,
    args: StartCaptionArgs,
) -> Result<(), String> {
    let provider = args.provider.as_str();
    if provider != "qwen_omni" && provider != "gemini_flash" && provider != "single" {
        return Err(format!("unknown provider: {}", provider));
    }
    if provider == "single" {
        return start_caption_single(app, args).await;
    }
    let workers = if provider == "gemini_flash" { 4 } else { 1 };
    if provider == "gemini_flash"
        && args
            .gemini_api_key
            .as_ref()
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
    {
        return Err("Gemini API key is required for gemini_flash".into());
    }

    let dataset_dir = format!("/workspace/datasets/{}", args.project_name);
    let mut cli_args: Vec<String> = vec![
        shell::escape(&format!("{}/ready/", dataset_dir)),
        "--output".into(),
        shell::escape(&format!("{}/captions.json", dataset_dir)),
        "--captioner-type".into(),
        provider.into(),
        "--num-workers".into(),
        workers.to_string(),
    ];
    cli_args.push(if args.audio { "--audio" } else { "--no-audio" }.into());
    if let Some(instr) = args.instructions.as_ref() {
        if !instr.trim().is_empty() {
            cli_args.push("-i".into());
            cli_args.push(shell::escape(instr));
        }
    }
    if provider == "gemini_flash" {
        if let Some(k) = args.gemini_api_key.as_ref() {
            cli_args.push("--api-key".into());
            cli_args.push(shell::escape(k));
        }
    }
    if args.override_all {
        cli_args.push("--override".into());
    }

    let merge_step = if args.override_all {
        "echo 'override mode — skipping manual merge'\n".to_string()
    } else {
        format!(
            r#"cd "{dataset}"
python3 - <<'PYEOF'
import json
try:
    with open('captions.json') as f: auto = json.load(f)
except Exception as e:
    print('failed to read captions.json:', e); raise SystemExit(1)
try:
    with open('manual.json') as f: manual = json.load(f)
except Exception:
    manual = []
m = {{}}
for e in manual:
    if isinstance(e, dict) and 'media_path' in e and 'caption' in e:
        m[e['media_path']] = e['caption']
final = []
for e in auto:
    if isinstance(e, dict) and e.get('media_path') in m:
        e['caption'] = m[e['media_path']]
    final.append(e)
with open('captions.json', 'w') as f:
    json.dump(final, f, indent=2, ensure_ascii=False)
print(f'merged: {{len(final)}} total, {{len(m)}} manual overrides')
PYEOF
"#,
            dataset = dataset_dir
        )
    };

    let provider_setup = if provider == "gemini_flash" {
        r#"cd /workspace/LTX-2
uv pip install -q google-generativeai
"#
    } else {
        ""
    };

    let inner_script = format!(
        r#"set -eu
{path}
cd "{dataset}"
if [ -f captions.json ]; then
  cp captions.json manual.json
else
  echo "[]" > manual.json
fi
# Удаляем старый captions.json — иначе captioner_videos.py решит, что
# все клипы уже подписаны, и выйдет с "All media already have captions".
rm -f captions.json

{provider_setup}cd /workspace/LTX-2
PYTHONUNBUFFERED=1 COLUMNS=250 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/caption_videos.py {cli}

{merge}
echo 'caption: done'
"#,
        path = PATH_SETUP,
        dataset = dataset_dir,
        cli = cli_args.join(" "),
        merge = merge_step,
        provider_setup = provider_setup,
    );

    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);
    project_task(&args.project_name)
        .start(&host, port, &keys, &inner_script)
        .await
}

/// "Single" режим: один и тот же caption применяется ко всем клипам.
/// Никакая модель не запускается — просто сканируем `ready/` и пишем
/// captions.json напрямую. Merge с manual.json уважает override_all.
async fn start_caption_single(
    app: tauri::AppHandle,
    args: StartCaptionArgs,
) -> Result<(), String> {
    let caption = args
        .single_caption
        .as_ref()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if caption.is_empty() {
        return Err("single caption is empty".into());
    }
    let dataset_dir = format!("/workspace/datasets/{}", args.project_name);
    let override_flag = if args.override_all { "1" } else { "0" };

    // Питон-скрипт делает всю работу на поде: листает ready/*, пишет captions.json,
    // мержит с manual.json (если есть и не override).
    let inner_script = format!(
        r#"set -eu
{path}
cd "{dataset}"
if [ -f captions.json ]; then
  cp captions.json manual.json
fi
rm -f captions.json
export LTX_SINGLE_CAPTION={caption_env}
export LTX_OVERRIDE_ALL={override}
python3 - <<'PYEOF'
import json, os, glob, pathlib
cap = os.environ.get('LTX_SINGLE_CAPTION', '').strip()
override = os.environ.get('LTX_OVERRIDE_ALL', '0') == '1'
ready = pathlib.Path('ready')
if not ready.is_dir():
    print('ready/ not found'); raise SystemExit(1)
clips = sorted([p.name for p in ready.iterdir() if p.is_file()])
manual = {{}}
if not override:
    try:
        with open('manual.json') as f:
            for e in json.load(f):
                if isinstance(e, dict) and 'media_path' in e and 'caption' in e:
                    manual[e['media_path']] = e['caption']
    except Exception:
        pass
out = []
for name in clips:
    media_path = f'ready/{{name}}'
    text = manual.get(media_path) or cap
    out.append({{'media_path': media_path, 'caption': text}})
with open('captions.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
print(f'single: wrote {{len(out)}} captions, {{len(manual)}} manual overrides kept')
PYEOF
echo 'caption: done'
"#,
        path = PATH_SETUP,
        dataset = dataset_dir,
        caption_env = shell::escape(&caption),
        override = override_flag,
    );

    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);
    project_task(&args.project_name)
        .start(&host, port, &keys, &inner_script)
        .await
}

#[derive(Serialize)]
pub struct CaptionTail {
    pub total: u64,
    pub content: String,
}

#[tauri::command]
pub async fn tail_caption_log(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    since: u64,
) -> Result<CaptionTail, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let chunk = project_task(&project_name)
        .tail(&host, port, &keys, since)
        .await?;
    Ok(CaptionTail {
        total: chunk.total,
        content: chunk.content,
    })
}

#[derive(Deserialize)]
pub struct TestCaptionArgs {
    pub api_key: String,
    pub pod_id: String,
    pub project_name: String,
    pub provider: String,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub gemini_api_key: Option<String>,
}

#[derive(Serialize)]
pub struct TestCaptionResult {
    pub caption: String,
    pub clip_filename: String,
}

const JSON_START: &str = "===__LTX_JSON_START__===";
const JSON_END: &str = "===__LTX_JSON_END__===";

#[tauri::command]
pub async fn test_caption(
    app: tauri::AppHandle,
    args: TestCaptionArgs,
) -> Result<TestCaptionResult, String> {
    let provider = args.provider.as_str();
    if provider != "qwen_omni" && provider != "gemini_flash" {
        return Err(format!("unknown provider: {}", provider));
    }
    if provider == "gemini_flash"
        && args
            .gemini_api_key
            .as_ref()
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
    {
        return Err("Gemini API key is required for gemini_flash".into());
    }

    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);

    let dataset_dir = format!("/workspace/datasets/{}", args.project_name);
    let test_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let test_dir = format!(
        "{}/{}/test_{}",
        STATE_DIR_BASE,
        shell::safe_name(&args.project_name),
        test_id
    );

    let mut cli_args: Vec<String> = vec![
        shell::escape(&format!("{}/", test_dir)),
        "--output".into(),
        shell::escape(&format!("{}/captions.json", test_dir)),
        "--captioner-type".into(),
        provider.into(),
        "--num-workers".into(),
        "1".into(),
    ];
    cli_args.push(if args.audio { "--audio" } else { "--no-audio" }.into());
    if let Some(i) = args.instructions.as_ref() {
        if !i.trim().is_empty() {
            cli_args.push("-i".into());
            cli_args.push(shell::escape(i));
        }
    }
    if provider == "gemini_flash" {
        if let Some(k) = args.gemini_api_key.as_ref() {
            cli_args.push("--api-key".into());
            cli_args.push(shell::escape(k));
        }
    }

    let provider_setup = if provider == "gemini_flash" {
        "uv pip install -q google-generativeai\n"
    } else {
        ""
    };

    let script = format!(
        r#"set -eu
{path}
mkdir -p {test_dir}
CLIP=$(ls "{dataset}/ready/" 2>/dev/null | head -n1)
if [ -z "$CLIP" ]; then
  echo "no clips found in {dataset}/ready/"
  exit 1
fi
cp "{dataset}/ready/$CLIP" "{test_dir}/"
cd /workspace/LTX-2
{provider_setup}# Полный лог captioner идёт в stdout (видим в терминале) И в файл лога,
# чтобы потом распарсить маркеры. Принудительная line-буферизация stdout.
PYTHONUNBUFFERED=1 COLUMNS=250 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/caption_videos.py {cli}
echo
echo "{js}"
cat "{test_dir}/captions.json"
echo
echo "{je}"
echo "FILENAME=$CLIP"
rm -rf "{test_dir}"
"#,
        path = PATH_SETUP,
        test_dir = test_dir,
        dataset = dataset_dir,
        cli = cli_args.join(" "),
        js = JSON_START,
        je = JSON_END,
        provider_setup = provider_setup,
    );

    let buf = Arc::new(Mutex::new(String::new()));
    let buf_w = buf.clone();
    let app_emit = app.clone();
    let pod_for_e = args.pod_id.clone();
    let project_for_e = args.project_name.clone();
    let _ = app_emit.emit(
        "ds_caption_test:start",
        json!({ "pod_id": pod_for_e, "project": project_for_e }),
    );
    let pod_evt = args.pod_id.clone();
    let project_evt = args.project_name.clone();
    let exit = exec_stream(
        &host,
        port,
        "root",
        &keys,
        &script,
        move |chunk, _is_err| {
            let s = String::from_utf8_lossy(chunk).to_string();
            if let Ok(mut b) = buf_w.lock() {
                b.push_str(&s);
            }
            let _ = app_emit.emit(
                "ds_caption_test:log",
                json!({ "pod_id": pod_evt, "project": project_evt, "line": s }),
            );
        },
    )
    .await?;
    let out = buf.lock().map(|b| b.clone()).unwrap_or_default();
    if exit != 0 {
        return Err(format!("captioner exited with code {}", exit));
    }

    let between = match (out.find(JSON_START), out.find(JSON_END)) {
        (Some(a), Some(b)) if b > a => &out[a + JSON_START.len()..b],
        _ => return Err(format!("malformed captioner output:\n{}", out)),
    };
    let json_text = between.trim();
    let arr: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|e| format!("parse captions.json: {} (text: {})", e, json_text))?;
    let caption = arr
        .as_array()
        .and_then(|a| a.first())
        .and_then(|o| o.get("caption"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let filename = out
        .lines()
        .filter_map(|l| l.strip_prefix("FILENAME="))
        .last()
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(TestCaptionResult {
        caption,
        clip_filename: filename,
    })
}

#[derive(Serialize)]
pub struct PodClip {
    pub mime: String,
    pub b64: String,
    pub size: usize,
}

#[tauri::command]
pub async fn read_pod_clip(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    filename: String,
) -> Result<PodClip, String> {
    if filename.contains('/') || filename.contains("..") {
        return Err("invalid filename".into());
    }
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let path = format!(
        "/workspace/datasets/{}/ready/{}",
        project_name, filename
    );
    let script = format!(
        r#"set -eu
if [ ! -f "{p}" ]; then
  echo "not found"
  exit 1
fi
base64 -w 0 "{p}"
"#,
        p = path
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let b64: String = out.chars().filter(|c| !c.is_whitespace()).collect();
    let mime = if filename.to_lowercase().ends_with(".mp4") {
        "video/mp4".to_string()
    } else if filename.to_lowercase().ends_with(".webm") {
        "video/webm".to_string()
    } else {
        "video/mp4".to_string()
    };
    Ok(PodClip {
        size: (b64.len() / 4) * 3,
        mime,
        b64,
    })
}

#[derive(Serialize)]
pub struct CaptionEntry {
    pub media_path: String,
    pub caption: String,
}

#[tauri::command]
pub async fn write_pod_captions(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    entries: Vec<serde_json::Value>,
) -> Result<(), String> {
    let json_text = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let dir = format!("/workspace/datasets/{}", project_name);
    let script = format!(
        r#"set -eu
mkdir -p "{dir}"
printf '%s' {payload} > "{dir}/captions.json"
echo done
"#,
        dir = dir,
        payload = shell::escape(&json_text),
    );
    exec_remote(&host, port, "root", &keys, &script).await?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_pod_captions(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<Vec<CaptionEntry>, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let path = format!("/workspace/datasets/{}/captions.json", project_name);
    let script = format!(
        r#"set -eu
if [ ! -f "{p}" ]; then
  echo "[]"
  exit 0
fi
cat "{p}"
"#,
        p = path
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|e| format!("parse captions.json: {}", e))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| "captions.json is not an array".to_string())?;
    let mut entries = Vec::with_capacity(arr.len());
    for v in arr {
        let media = v.get("media_path").and_then(|x| x.as_str()).unwrap_or("");
        let cap = v.get("caption").and_then(|x| x.as_str()).unwrap_or("");
        if !media.is_empty() {
            entries.push(CaptionEntry {
                media_path: media.to_string(),
                caption: cap.to_string(),
            });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn reset_caption(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    project_task(&project_name).reset(&host, port, &keys).await
}
