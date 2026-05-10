use crate::ssh::{collect_keys, exec_remote, resolve_pod_ssh_endpoint};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const STATE_DIR: &str = "/workspace/.ltx-init";
pub const STEP_IDS: &[&str] = &["packages", "env", "model", "encoder", "verify"];

fn shell_escape(s: &str) -> String {
    let escaped = s.replace('\'', r#"'\''"#);
    format!("'{}'", escaped)
}

const PATH_SETUP: &str = r#"export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env" || true
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true
export UV_CACHE_DIR=/workspace/.uv-cache
export UV_LINK_MODE=copy"#;

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
        tok = shell_escape(hf_token)
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
        tok = shell_escape(hf_token)
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
    pub state: String, // "pending" | "running" | "done" | "failed"
    pub exit_code: Option<i32>,
    pub log_size: u64,
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

    let script = format!(
        r#"set +e
mkdir -p {dir}
if command -v tmux >/dev/null 2>&1; then
  echo 'tmux|yes'
else
  echo 'tmux|no'
fi
for s in packages env model encoder verify; do
  log_sz=0
  if [ -f {dir}/$s.log ]; then
    log_sz=$(wc -c < {dir}/$s.log | tr -d ' ')
  fi
  if [ -f {dir}/$s.exit ]; then
    ec=$(cat {dir}/$s.exit | tr -d '[:space:]')
    echo "step|$s|done|$ec|$log_sz"
  elif tmux has-session -t ltx_$s 2>/dev/null; then
    echo "step|$s|running|0|$log_sz"
  else
    echo "step|$s|pending|0|$log_sz"
  fi
done
"#,
        dir = STATE_DIR
    );

    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let mut state = InitState {
        tmux_available: false,
        steps: HashMap::new(),
    };
    for raw in out.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("tmux|") {
            state.tmux_available = rest.trim() == "yes";
        } else if let Some(rest) = line.strip_prefix("step|") {
            let parts: Vec<&str> = rest.split('|').collect();
            if parts.len() >= 4 {
                let id = parts[0].to_string();
                let st = parts[1].to_string();
                let ec: Option<i32> = if st == "done" {
                    parts[2].trim().parse::<i32>().ok()
                } else {
                    None
                };
                let log_size = parts[3].trim().parse::<u64>().unwrap_or(0);
                let final_state = if st == "done" {
                    if ec.unwrap_or(0) == 0 {
                        "done"
                    } else {
                        "failed"
                    }
                } else {
                    st.as_str()
                };
                state.steps.insert(
                    id,
                    StepStatus {
                        state: final_state.to_string(),
                        exit_code: ec,
                        log_size,
                    },
                );
            }
        }
    }
    Ok(state)
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

    // Загружаем шаг-скрипт через heredoc (single-quoted → без раскрытия) и запускаем
    // его в detached tmux-сессии. Прогресс-лог пишется через pipe-pane.
    // Если tmux не установлен, ставим его перед стартом.
    let outer = format!(
        r#"set -eu
mkdir -p {dir}
if ! command -v tmux >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq tmux
fi
cat > {dir}/{step}.sh <<'LTX_INIT_STEP_EOF'
{script}
LTX_INIT_STEP_EOF
chmod +x {dir}/{step}.sh
rm -f {dir}/{step}.exit
: > {dir}/{step}.log
tmux kill-session -t ltx_{step} 2>/dev/null || true
tmux new-session -d -s ltx_{step} "bash {dir}/{step}.sh; echo \$? > {dir}/{step}.exit"
tmux pipe-pane -t ltx_{step} -o "cat >> {dir}/{step}.log"
echo 'started ltx_{step}'
"#,
        dir = STATE_DIR,
        step = args.step,
        script = script,
    );

    exec_remote(&host, port, "root", &keys, &outer).await?;
    Ok(())
}

#[derive(Serialize)]
pub struct TailResult {
    pub total: u64,
    pub content: String,
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
    // Первая строка — общий размер. Дальше — байты с позиции `since+1`.
    let script = format!(
        r#"set +e
f={dir}/{step}.log
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
        dir = STATE_DIR,
        step = step,
        since = since,
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let (first, rest) = match out.split_once('\n') {
        Some((a, b)) => (a, b),
        None => (out.as_str(), ""),
    };
    Ok(TailResult {
        total: first.trim().parse::<u64>().unwrap_or(0),
        content: rest.to_string(),
    })
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
    let script = format!(
        r#"set +e
tmux kill-session -t ltx_{step} 2>/dev/null
rm -f {dir}/{step}.exit {dir}/{step}.log
echo done
"#,
        dir = STATE_DIR,
        step = step,
    );
    exec_remote(&host, port, "root", &keys, &script).await?;
    Ok(())
}
