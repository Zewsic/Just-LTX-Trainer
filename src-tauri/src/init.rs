//! 5-шаговая инициализация LTX-2 на поде. Каждый шаг — отдельная
//! `TmuxTask`, чтобы прогрессом можно было управлять независимо.

use crate::shell;
use crate::ssh::{collect_keys, resolve_pod_ssh_endpoint};
use crate::tmux_task::{task_at, TailChunk, TaskState, TmuxTask};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const STATE_DIR_BASE: &str = "/workspace/.ltx-init";
pub const STEP_IDS: &[&str] = &[
    "packages",
    "env",
    "model",
    "encoder",
    "telegram_bot_api",
    "verify",
];

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

/// Общий Telegram-хук для скриптов инициализации: `tg_notify()` + `trap`,
/// который шлёт сообщение об ошибке при любом неуспешном выходе шага
/// (скрипты идут под `set -eu`, так что `trap ... ERR` ловит первую же
/// упавшую команду).
fn tg_header(tg_token: &str, tg_chat: &str, step_label: &str) -> String {
    format!(
        r#"TG_TOKEN={tok}
TG_CHAT_ID={chat}
STEP_LABEL={label}
tg_notify() {{
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT_ID" ] || return 0
  curl -s -m 10 -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    --data-urlencode chat_id="$TG_CHAT_ID" --data-urlencode text="$1" >/dev/null 2>&1 || true
}}
trap 'tg_notify "❌ Ошибка инициализации сервера (шаг: $STEP_LABEL)"' ERR
"#,
        tok = shell::escape(tg_token),
        chat = shell::escape(tg_chat),
        label = shell::escape(step_label),
    )
}

fn packages_script(tg_token: &str, tg_chat: &str) -> String {
    format!(
        r#"set -eu
{path}
{tg}
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
        path = PATH_SETUP,
        tg = tg_header(tg_token, tg_chat, "packages")
    )
}

fn env_script(tg_token: &str, tg_chat: &str) -> String {
    format!(
        r#"set -eu
{path}
{tg}
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
        path = PATH_SETUP,
        tg = tg_header(tg_token, tg_chat, "env")
    )
}

fn model_script(hf_token: &str, tg_token: &str, tg_chat: &str) -> String {
    format!(
        r#"set -eu
{path}
{tg}
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
        tok = shell::escape(hf_token),
        tg = tg_header(tg_token, tg_chat, "model")
    )
}

fn encoder_script(hf_token: &str, tg_token: &str, tg_chat: &str) -> String {
    format!(
        r#"set -eu
{path}
{tg}
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
        tok = shell::escape(hf_token),
        tg = tg_header(tg_token, tg_chat, "encoder")
    )
}

/// Локальный `telegram-bot-api` сервер (лимит файла 2 ГБ вместо 50 МБ у
/// обычного Bot API) — нужен только если включена отправка чекпоинтов/
/// генераций. Если выключена или не хватает параметров — шаг мгновенно
/// завершается, не тратя время инициализации.
fn telegram_bot_api_script(
    tg_files_enabled: bool,
    api_id: &str,
    api_hash: &str,
    tg_token: &str,
    tg_chat: &str,
) -> String {
    if !tg_files_enabled
        || api_id.trim().is_empty()
        || api_hash.trim().is_empty()
        || tg_token.trim().is_empty()
    {
        return r#"set -eu
echo 'telegram_bot_api: skipped'
"#
        .to_string();
    }
    format!(
        r#"set -eu
{tg}
API_ID={api_id_q}
API_HASH={api_hash_q}
if ! command -v telegram-bot-api >/dev/null 2>&1; then
  echo '== installing telegram-bot-api =='
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || true
  if ! apt-get install -y -qq telegram-bot-api; then
    echo '== apt package unavailable, building telegram-bot-api from source =='
    apt-get install -y -qq git cmake g++ make zlib1g-dev libssl-dev gperf php-cli
    rm -rf /tmp/telegram-bot-api-build
    git clone --recursive https://github.com/tdlib/telegram-bot-api.git /tmp/telegram-bot-api-build
    cd /tmp/telegram-bot-api-build
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=/usr/local ..
    cmake --build . --target install -j"$(nproc)"
    cd /
    rm -rf /tmp/telegram-bot-api-build
  fi
fi
telegram-bot-api --version

if ! pgrep -f 'telegram-bot-api --api-id' >/dev/null 2>&1; then
  echo '== starting telegram-bot-api daemon =='
  nohup telegram-bot-api --api-id="$API_ID" --api-hash="$API_HASH" --local --http-port=8081 \
    > /var/log/telegram-bot-api.log 2>&1 &
  disown
fi

echo '== waiting for telegram-bot-api to come up =='
ok=0
for i in $(seq 1 20); do
  if curl -s -m 2 http://localhost:8081 >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  echo '== telegram-bot-api did not respond, log tail: =='
  tail -n 50 /var/log/telegram-bot-api.log || true
  exit 1
fi
echo 'telegram_bot_api: done'
"#,
        tg = tg_header(tg_token, tg_chat, "telegram_bot_api"),
        api_id_q = shell::escape(api_id),
        api_hash_q = shell::escape(api_hash),
    )
}

fn verify_script(tg_token: &str, tg_chat: &str) -> String {
    format!(
        r#"set -eu
{tg}
echo '== verifying =='
test -f /workspace/ckpt/ltx-2.3-22b-dev.safetensors && echo 'ltx weights ok'
test -d /workspace/ckpt/gemma-text-encoder && echo 'text encoder ok'
test -d /workspace/LTX-2/.venv && echo 'venv ok'
ls -lh /workspace/ckpt
echo 'verify: done'
tg_notify "✅ Сервер готов к работе"
"#,
        tg = tg_header(tg_token, tg_chat, "verify")
    )
}

#[allow(clippy::too_many_arguments)]
fn step_script(
    step: &str,
    hf_token: &str,
    tg_token: &str,
    tg_chat: &str,
    tg_files_enabled: bool,
    tg_api_id: &str,
    tg_api_hash: &str,
) -> Result<String, String> {
    Ok(match step {
        "packages" => packages_script(tg_token, tg_chat),
        "env" => env_script(tg_token, tg_chat),
        "model" => model_script(hf_token, tg_token, tg_chat),
        "encoder" => encoder_script(hf_token, tg_token, tg_chat),
        "telegram_bot_api" => {
            telegram_bot_api_script(tg_files_enabled, tg_api_id, tg_api_hash, tg_token, tg_chat)
        }
        "verify" => verify_script(tg_token, tg_chat),
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
    /// Если оба заданы — шаги инициализации шлют статус в Telegram
    /// (готовность сервера / ошибка шага).
    #[serde(default)]
    pub tg_bot_token: Option<String>,
    #[serde(default)]
    pub tg_chat_id: Option<String>,
    /// Если включено (и заданы api_id/api_hash) — шаг `telegram_bot_api`
    /// ставит и поднимает локальный Bot API сервер для отправки файлов.
    #[serde(default)]
    pub tg_files_enabled: bool,
    #[serde(default)]
    pub tg_api_id: Option<String>,
    #[serde(default)]
    pub tg_api_hash: Option<String>,
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
    let tg_token = args.tg_bot_token.unwrap_or_default();
    let tg_chat = args.tg_chat_id.unwrap_or_default();
    let tg_api_id = args.tg_api_id.unwrap_or_default();
    let tg_api_hash = args.tg_api_hash.unwrap_or_default();
    let script = step_script(
        &args.step,
        &hf,
        &tg_token,
        &tg_chat,
        args.tg_files_enabled,
        &tg_api_id,
        &tg_api_hash,
    )?;
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
