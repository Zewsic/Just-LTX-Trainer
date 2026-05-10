use crate::ssh::{collect_keys, exec_remote, exec_stream, resolve_pod_ssh_endpoint};
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

fn shell_escape(s: &str) -> String {
    let escaped = s.replace('\'', r#"'\''"#);
    format!("'{}'", escaped)
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn session_name(project: &str) -> String {
    format!("ltx_cap_{}", safe_name(project))
}

fn state_dir(project: &str) -> String {
    format!("{}/{}", STATE_DIR_BASE, safe_name(project))
}

#[derive(Serialize, Default)]
pub struct CaptionStatus {
    pub state: String, // "pending" | "running" | "done" | "failed"
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
    let dir = state_dir(&project_name);
    let session = session_name(&project_name);
    let script = format!(
        r#"set +e
mkdir -p {dir}
log_sz=0
[ -f {dir}/log ] && log_sz=$(wc -c < {dir}/log | tr -d ' ')
if [ -f {dir}/exit ]; then
  ec=$(cat {dir}/exit | tr -d '[:space:]')
  echo "done|$ec|$log_sz"
elif tmux has-session -t {session} 2>/dev/null; then
  echo "running|0|$log_sz"
else
  echo "pending|0|$log_sz"
fi
"#,
        dir = dir,
        session = session
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let line = out.lines().last().unwrap_or("").trim();
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < 3 {
        return Ok(CaptionStatus {
            state: "pending".into(),
            ..Default::default()
        });
    }
    let st = parts[0].to_string();
    let ec: Option<i32> = if st == "done" {
        parts[1].parse().ok()
    } else {
        None
    };
    let log_size: u64 = parts[2].parse().unwrap_or(0);
    let final_state = if st == "done" {
        if ec.unwrap_or(0) == 0 {
            "done"
        } else {
            "failed"
        }
    } else {
        st.as_str()
    };
    Ok(CaptionStatus {
        state: final_state.to_string(),
        exit_code: ec,
        log_size,
    })
}

#[derive(Deserialize)]
pub struct StartCaptionArgs {
    pub api_key: String,
    pub pod_id: String,
    pub project_name: String,
    pub provider: String, // "qwen_omni" | "gemini_flash"
    #[serde(default)]
    pub instructions: Option<String>,
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
    if provider != "qwen_omni" && provider != "gemini_flash" {
        return Err(format!("unknown provider: {}", provider));
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
        shell_escape(&format!("{}/ready/", dataset_dir)),
        "--output".into(),
        shell_escape(&format!("{}/captions.json", dataset_dir)),
        "--captioner-type".into(),
        provider.into(),
        "--num-workers".into(),
        workers.to_string(),
    ];
    cli_args.push(if args.audio { "--audio" } else { "--no-audio" }.into());
    if let Some(instr) = args.instructions.as_ref() {
        if !instr.trim().is_empty() {
            cli_args.push("-i".into());
            cli_args.push(shell_escape(instr));
        }
    }
    if provider == "gemini_flash" {
        if let Some(k) = args.gemini_api_key.as_ref() {
            cli_args.push("--api-key".into());
            cli_args.push(shell_escape(k));
        }
    }
    if args.override_all {
        cli_args.push("--override".into());
    }

    let dir = state_dir(&args.project_name);
    let session = session_name(&args.project_name);

    // С флагом override НЕ восстанавливаем ручные подписи поверх — пусть
    // captioner полностью перезапишет captions.json.
    let merge_step = if args.override_all {
        format!(
            r#"echo 'override mode — skipping manual merge'
"#,
        )
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
PYTHONUNBUFFERED=1 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/caption_videos.py {cli}

{merge}
echo 'caption: done'
"#,
        path = PATH_SETUP,
        dataset = dataset_dir,
        cli = cli_args.join(" "),
        merge = merge_step,
        provider_setup = provider_setup,
    );

    let outer = format!(
        r#"set -eu
mkdir -p {dir}
if ! command -v tmux >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq tmux
fi
cat > {dir}/run.sh <<'LTX_CAP_EOF'
{inner}
LTX_CAP_EOF
chmod +x {dir}/run.sh
rm -f {dir}/exit
: > {dir}/log
tmux kill-session -t {session} 2>/dev/null || true
tmux new-session -d -s {session} "bash {dir}/run.sh; echo \$? > {dir}/exit"
tmux pipe-pane -t {session} -o "cat >> {dir}/log"
echo 'started {session}'
"#,
        dir = dir,
        session = session,
        inner = inner_script,
    );

    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);
    exec_remote(&host, port, "root", &keys, &outer).await?;
    Ok(())
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
    let dir = state_dir(&project_name);
    let script = format!(
        r#"set +e
f={dir}/log
if [ ! -f "$f" ]; then
  echo 0
  exit 0
fi
sz=$(wc -c < "$f" | tr -d ' ')
echo "$sz"
if [ "$sz" -gt "{since}" ]; then
  tail -c +$(({since}+1)) "$f"
fi
"#,
        dir = dir,
        since = since,
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let (first, rest) = match out.split_once('\n') {
        Some((a, b)) => (a, b),
        None => (out.as_str(), ""),
    };
    Ok(CaptionTail {
        total: first.trim().parse::<u64>().unwrap_or(0),
        content: rest.to_string(),
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
        safe_name(&args.project_name),
        test_id
    );

    let mut cli_args: Vec<String> = vec![
        shell_escape(&format!("{}/", test_dir)),
        "--output".into(),
        shell_escape(&format!("{}/captions.json", test_dir)),
        "--captioner-type".into(),
        provider.into(),
        "--num-workers".into(),
        "1".into(),
    ];
    cli_args.push(if args.audio { "--audio" } else { "--no-audio" }.into());
    if let Some(i) = args.instructions.as_ref() {
        if !i.trim().is_empty() {
            cli_args.push("-i".into());
            cli_args.push(shell_escape(i));
        }
    }
    if provider == "gemini_flash" {
        if let Some(k) = args.gemini_api_key.as_ref() {
            cli_args.push("--api-key".into());
            cli_args.push(shell_escape(k));
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
PYTHONUNBUFFERED=1 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/caption_videos.py {cli}
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

fn shell_escape_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
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
        payload = shell_escape_single(&json_text),
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
    let dir = state_dir(&project_name);
    let session = session_name(&project_name);
    let script = format!(
        r#"set +e
tmux kill-session -t {session} 2>/dev/null
rm -f {dir}/exit {dir}/log
echo done
"#,
        dir = dir,
        session = session,
    );
    exec_remote(&host, port, "root", &keys, &script).await?;
    Ok(())
}
