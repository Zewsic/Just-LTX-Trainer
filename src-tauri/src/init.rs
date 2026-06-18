//! 5-шаговая инициализация LTX-2 на поде. Каждый шаг — отдельная
//! `TmuxTask`, чтобы прогрессом можно было управлять независимо.

use crate::shell;
use crate::ssh::{collect_keys, resolve_pod_ssh_endpoint};
use crate::tmux_task::{task_at, TailChunk, TaskState, TmuxTask};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const STATE_DIR_BASE: &str = "/workspace/.ltx-init";
pub const STEP_IDS: &[&str] = &["packages", "env", "model", "encoder", "verify"];

const PATH_SETUP: &str = r#"export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env" || true
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true
export UV_CACHE_DIR=/workspace/.uv-cache
export UV_LINK_MODE=copy"#;

fn step_task(step: &str) -> TmuxTask {
    // Префикс сессии — `ltx_<step>`. Чтобы сохранить совместимость со старыми
    // сессиями (которые могли остаться от прошлой инициализации), используем
    // ту же схему.
    task_at(STATE_DIR_BASE, "ltx_", step)
}

fn packages_script() -> String {
    format!(
        r#"set -eu
{path}
echo '== checking existing tools =='
if command -v uv >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  echo 'uv and ffmpeg already installed'
  exit 0
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo '== apt-get update =='
  apt-get update -qq
  echo '== installing ffmpeg =='
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg
fi
if ! command -v uv >/dev/null 2>&1; then
  echo '== installing uv =='
  curl -LsSf https://astral.sh/uv/install.sh | sh
  {path}
fi
uv --version
echo 'packages: done'
"#,
        path = PATH_SETUP
    )
}

fn env_script() -> String {
    format!(
        r#"set -eu
{path}
cd /workspace
if [ ! -d LTX-2 ]; then
  echo '== git clone Lightricks/LTX-2 =='
  git clone https://github.com/Lightricks/LTX-2.git
else
  echo '== LTX-2 repo already cloned =='
fi
cd LTX-2
echo '== uv sync --frozen =='
uv sync --frozen
echo '== installing huggingface_hub CLI =='
uv pip install -U huggingface_hub
echo 'env: done'
"#,
        path = PATH_SETUP
    )
}

fn model_script(hf_token: &str) -> String {
    format!(
        r#"set -eu
{path}
cd /workspace/LTX-2
. .venv/bin/activate
mkdir -p /workspace/ckpt
cd /workspace/ckpt
export HF_TOKEN={tok}
export HUGGINGFACE_HUB_TOKEN={tok}
echo '== downloading Lightricks/LTX-2.3 / ltx-2.3-22b-dev.safetensors =='
hf download Lightricks/LTX-2.3 ltx-2.3-22b-dev.safetensors --local-dir .
echo 'model: done'
"#,
        path = PATH_SETUP,
        tok = shell::escape(hf_token)
    )
}

fn encoder_script(hf_token: &str) -> String {
    format!(
        r#"set -eu
{path}
cd /workspace/LTX-2
. .venv/bin/activate
cd /workspace/ckpt
export HF_TOKEN={tok}
export HUGGINGFACE_HUB_TOKEN={tok}
echo '== downloading google/gemma-3-12b-it-qat-q4_0-unquantized =='
hf download google/gemma-3-12b-it-qat-q4_0-unquantized --local-dir gemma-text-encoder
echo 'encoder: done'
"#,
        path = PATH_SETUP,
        tok = shell::escape(hf_token)
    )
}

fn verify_script() -> &'static str {
    r#"set -eu
echo '== verifying =='
test -f /workspace/ckpt/ltx-2.3-22b-dev.safetensors && echo 'ltx weights ok'
test -d /workspace/ckpt/gemma-text-encoder && echo 'text encoder ok'
test -d /workspace/LTX-2/.venv && echo 'venv ok'
ls -lh /workspace/ckpt
echo 'verify: done'
"#
}

fn step_script(step: &str, hf_token: &str) -> Result<String, String> {
    Ok(match step {
        "packages" => packages_script(),
        "env" => env_script(),
        "model" => model_script(hf_token),
        "encoder" => encoder_script(hf_token),
        "verify" => verify_script().to_string(),
        other => return Err(format!("unknown step: {}", other)),
    })
}

#[derive(Serialize, Default)]
pub struct StepStatus {
    pub state: String,
    pub exit_code: Option<i32>,
    pub log_size: u64,
}

impl From<TaskState> for StepStatus {
    fn from(s: TaskState) -> Self {
        Self {
            state: s.state,
            exit_code: s.exit_code,
            log_size: s.log_size,
        }
    }
}

#[derive(Serialize)]
pub struct InitState {
    pub tmux_available: bool,
    pub steps: HashMap<String, StepStatus>,
}

#[tauri::command]
pub async fn check_init_state(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
) -> Result<InitState, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);

    let mut steps = HashMap::new();
    for &id in STEP_IDS {
        let task = step_task(id);
        let st = task.state(&host, port, &keys).await?;
        steps.insert(id.to_string(), st.into());
    }

    // tmux_available: если хоть один шаг успешно отработал state() — tmux ок.
    // На самом деле важнее, что apt поставит tmux при первом start. Возвращаем
    // true, если start_init_step поставит tmux сам.
    Ok(InitState {
        tmux_available: true,
        steps,
    })
}

#[derive(Deserialize)]
pub struct StartStepArgs {
    pub api_key: String,
    pub pod_id: String,
    pub step: String,
    #[serde(default)]
    pub hf_token: Option<String>,
}

#[tauri::command]
pub async fn start_init_step(
    app: tauri::AppHandle,
    args: StartStepArgs,
) -> Result<(), String> {
    let hf = args.hf_token.unwrap_or_default();
    if matches!(args.step.as_str(), "model" | "encoder") && hf.trim().is_empty() {
        return Err("HuggingFace token is required for downloads".into());
    }
    let script = step_script(&args.step, &hf)?;
    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);
    step_task(&args.step)
        .start(&host, port, &keys, &script)
        .await
}

#[derive(Serialize)]
pub struct TailResult {
    pub total: u64,
    pub content: String,
}

impl From<TailChunk> for TailResult {
    fn from(t: TailChunk) -> Self {
        Self {
            total: t.total,
            content: t.content,
        }
    }
}

#[tauri::command]
pub async fn tail_init_log(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    step: String,
    since: u64,
) -> Result<TailResult, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    Ok(step_task(&step)
        .tail(&host, port, &keys, since)
        .await?
        .into())
}

#[tauri::command]
pub async fn reset_init_step(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    step: String,
) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    step_task(&step).reset(&host, port, &keys).await
}
