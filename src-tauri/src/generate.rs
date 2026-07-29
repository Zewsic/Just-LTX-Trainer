//! «Generate» — тестовая генерация видео из уже обученного LoRA-чекпоинта,
//! отдельно от обучения. В отличие от training.rs (одна tmux-сессия на
//! проект), тут одна tmux-сессия на под — GPU общий, а очередь job'ов
//! (несколько запросов подряд) живёт целиком на фронте (см. tasks.tsx).
//!
//! Вызывает `ltx_pipelines.ti2vid_one_stage` — pipeline из соседнего с
//! ltx-trainer пакета (packages/ltx-pipelines в Lightricks/LTX-2), не
//! требующий отдельного spatial-upsampler чекпоинта. Точная команда собрана
//! по публичной документации пакета и не проверялась на живом поде —
//! `build_generate_script` ниже единственное место, которое нужно будет
//! поправить, если флаги на реальном поде отличаются.

use crate::shell;
use crate::ssh::{collect_keys, exec_remote, exec_remote_with_stdin, resolve_pod_ssh_endpoint};
use crate::tmux_task::TmuxTask;
use crate::training::{checkpoints_dir, mime_for_filename, ValidationFile, MODEL_PATH, TEXT_ENCODER_PATH};
use serde::Deserialize;
use std::path::Path;

fn generate_dir(pod_id: &str) -> String {
    format!("/workspace/.ltx-gen-out/{}", shell::safe_name(pod_id))
}

fn gen_task(pod_id: &str) -> TmuxTask {
    let safe = shell::safe_name(pod_id);
    TmuxTask::new(
        format!("ltx_gen_{}", safe),
        format!("/workspace/.ltx-gen/{}", safe),
    )
}

#[derive(Deserialize)]
pub struct GenerateArgs {
    pub api_key: String,
    pub pod_id: String,
    pub project_name: String,
    /// Уникальный id job'а с фронта — используется как имя выходного файла,
    /// чтобы результаты нескольких последовательных job'ов не затирали друг друга.
    pub job_id: String,
    pub step: u32,
    pub lora_weight: f32,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    /// Локальный путь к картинке (i2v conditioning) на машине пользователя —
    /// как и validation-картинки при обучении, читаем и грузим сами.
    pub image_path: Option<String>,
    pub seed: u32,
    pub width: u32,
    pub height: u32,
    pub num_frames: u32,
    pub num_inference_steps: u32,
}

fn build_generate_script(args: &GenerateArgs, image_remote_path: Option<&str>) -> String {
    let ckpt_path = format!(
        "{}/lora_weights_step_{:05}.safetensors",
        checkpoints_dir(&args.project_name),
        args.step
    );
    let out_dir = generate_dir(&args.pod_id);
    let out_file = format!("{}/gen_{}.mp4", out_dir, shell::safe_name(&args.job_id));

    let mut cmd = format!(
        r#"uv run python -m ltx_pipelines.ti2vid_one_stage \
  --checkpoint-path {model_q} \
  --gemma-root {te_q} \
  --lora {lora_q} \
  --prompt {prompt_q} \
  --num-frames {frames} \
  --height {h} --width {w} \
  --num-inference-steps {steps} \
  --seed {seed} \
  --output-path {out_q}"#,
        model_q = shell::escape(MODEL_PATH),
        te_q = shell::escape(TEXT_ENCODER_PATH),
        lora_q = shell::escape(&format!("{}:{}", ckpt_path, args.lora_weight)),
        prompt_q = shell::escape(&args.prompt),
        frames = args.num_frames,
        h = args.height,
        w = args.width,
        steps = args.num_inference_steps,
        seed = args.seed,
        out_q = shell::escape(&out_file),
    );
    if let Some(neg) = args.negative_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.push_str(&format!(" \\\n  --negative-prompt {}", shell::escape(neg)));
    }
    if let Some(img) = image_remote_path {
        cmd.push_str(&format!(" \\\n  --image {}", shell::escape(img)));
    }

    format!(
        r#"set -eu
mkdir -p {out_dir_q}
if [ ! -f {ckpt_q} ]; then
  echo "checkpoint not found: {ckpt_path}"
  exit 1
fi
cd /workspace/LTX-2
# На случай если предыдущий generate-job был убит по-грубому (tmux kill) и
# осиротевший python-процесс всё ещё держит GPU.
pkill -9 -f 'ltx_pipelines' 2>/dev/null || true
sleep 1
export PYTHONUNBUFFERED=1
{cmd}
"#,
        out_dir_q = shell::escape(&out_dir),
        ckpt_q = shell::escape(&ckpt_path),
        ckpt_path = ckpt_path,
        cmd = cmd,
    )
}

#[tauri::command]
pub async fn generate_start(app: tauri::AppHandle, args: GenerateArgs) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);

    let image_remote_path = if let Some(local) = args.image_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let bytes = tokio::fs::read(local)
            .await
            .map_err(|e| format!("read {}: {}", local, e))?;
        let ext = Path::new(local)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        let safe_ext = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
            ext
        } else {
            "jpg".to_string()
        };
        let remote_path = format!(
            "{}/img_{}.{}",
            generate_dir(&args.pod_id),
            shell::safe_name(&args.job_id),
            safe_ext
        );
        let write_script = format!(
            "set -eu\nmkdir -p {d}\ncat > {p}\n",
            d = shell::escape(&generate_dir(&args.pod_id)),
            p = shell::escape(&remote_path),
        );
        exec_remote_with_stdin(&host, port, "root", &keys, &write_script, &bytes)
            .await
            .map_err(|e| format!("upload {}: {}", local, e))?;
        Some(remote_path)
    } else {
        None
    };

    let script = build_generate_script(&args, image_remote_path.as_deref());
    gen_task(&args.pod_id).start(&host, port, &keys, &script).await
}

#[tauri::command]
pub async fn generate_state(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
) -> Result<crate::tmux_task::TaskState, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    gen_task(&pod_id).state(&host, port, &keys).await
}

#[tauri::command]
pub async fn generate_tail(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    since: u64,
) -> Result<crate::tmux_task::TailChunk, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    gen_task(&pod_id).tail(&host, port, &keys, since).await
}

#[tauri::command]
pub async fn generate_cancel(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    // reset() убивает только tmux-обёртку; сам python-процесс подчищаем на
    // старте следующего job'а (см. build_generate_script) — kill внутри
    // текущей SSH-сессии, открытой отдельно от tmux, ненадёжен.
    gen_task(&pod_id).reset(&host, port, &keys).await
}

#[tauri::command]
pub async fn read_generate_output(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    job_id: String,
) -> Result<ValidationFile, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let filename = format!("gen_{}.mp4", shell::safe_name(&job_id));
    let path = format!("{}/{}", generate_dir(&pod_id), filename);
    let script = format!(
        r#"set -eu
if [ ! -f "{p}" ]; then echo "not found"; exit 1; fi
base64 -w 0 "{p}"
"#,
        p = path
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let b64: String = out.chars().filter(|c| !c.is_whitespace()).collect();
    Ok(ValidationFile {
        size: (b64.len() / 4) * 3,
        mime: mime_for_filename(&filename),
        b64,
    })
}
