//! LoRA-обучение проекта на поде.
//!
//! Этап 1 (prep), сейчас выполнен:
//!   • очистка VRAM
//!   • загрузка валидационных картинок с локальной машины пользователя
//!   • генерация config.yaml в каталоге проекта на поде
//!
//! Этап 2 (preprocess): `process_dataset.py` с тригером, разрешением,
//! audio-флагом и опциональным 8-bit text-encoder. Парсим вывод на «Loaded N
//! valid media files», сравниваем с количеством партов; если не совпадает —
//! падаем с ошибкой `media_mismatch`.
//!
//! Этап 3 (vram_clear): empty_cache.
//!
//! Этапы 4 (train) и 5 (validate) — следующая итерация.
//!
//! Маркеры в stdout (одна строка):
//!   `LTX_PHASE: prep | preprocess | vram_clear | train | done`
//!   `LTX_STEP: <done>/<total>`
//!   `LTX_VAL_START: <step>` / `LTX_VAL_DONE: <step>`
//!   `LTX_ERR: <kind>`     где kind ∈ { oom | preprocess | media_mismatch | other }

use crate::local_setup::find_executable;
use crate::shell;
use crate::ssh::{collect_keys, exec_remote, exec_remote_with_stdin, resolve_pod_ssh_endpoint};
use crate::tmux_task::{task_at, TmuxTask};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const STATE_DIR_BASE: &str = "/workspace/.ltx-train";
const MODEL_PATH: &str = "/workspace/ckpt/ltx-2.3-22b-dev.safetensors";
const TEXT_ENCODER_PATH: &str = "/workspace/ckpt/gemma-text-encoder";

fn project_task(project: &str) -> crate::tmux_task::TmuxTask {
    task_at(STATE_DIR_BASE, "ltx_train_", project)
}

fn dataset_dir(project: &str) -> String {
    format!("/workspace/datasets/{}", project)
}

fn output_dir(project: &str) -> String {
    format!("{}/output", dataset_dir(project))
}

fn samples_dir(project: &str) -> String {
    format!("{}/samples", output_dir(project))
}

fn checkpoints_dir(project: &str) -> String {
    format!("{}/checkpoints", output_dir(project))
}

fn input_images_dir(project: &str) -> String {
    format!("{}/input_images", dataset_dir(project))
}

fn precomputed_dir(project: &str) -> String {
    format!("{}/.precomputed", dataset_dir(project))
}

/// `penis. ` или просто `penis` → `penis`. Убираем хвостовые точки/пробелы,
/// чтобы префикс не превращался в `penis..`.
fn normalize_trigger(s: &str) -> String {
    s.trim()
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string()
}

const PATH_SETUP: &str = r#"export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env" || true
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true
export UV_CACHE_DIR=/workspace/.uv-cache
export UV_LINK_MODE=copy"#;

#[derive(Default, Serialize)]
pub struct TrainingState {
    pub state: String,
    pub log_size: u64,
    pub exit_code: Option<i32>,
    pub phase: Option<String>,
    pub step: Option<u32>,
    pub total_steps: Option<u32>,
    /// "1:22:18" — оставленное время до конца обучения.
    pub eta: Option<String>,
    pub loss: Option<f32>,
    /// Скорость, например "2.62s/step".
    pub step_time: Option<String>,
    /// Учебный rate в виде строки ("9.16e-05") — отдаём как есть для UI.
    pub lr: Option<String>,
    /// Прогресс препроцессинга (этап captions / videos).
    pub preprocess_progress: Option<PreprocessProgress>,
    /// Активная валидация (если идёт прямо сейчас).
    pub validation_progress: Option<ValidationProgress>,
    /// Шаги, на которых валидация уже завершена (по логу `Validation samples for step N saved`).
    pub validations_done: Vec<u32>,
    pub current_validation: Option<u32>,
    /// Текстовое сообщение об ошибке (последняя строка лога после `LTX_ERR`).
    pub error: Option<String>,
    /// Категория ошибки.
    pub error_kind: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PreprocessProgress {
    /// "captions" | "videos"
    pub kind: String,
    pub done: u32,
    pub total: u32,
}

#[derive(Serialize, Clone)]
pub struct ValidationProgress {
    /// Текущий сэмпл, начиная с 1.
    pub sample: u32,
    pub samples_total: u32,
    /// Шаг инференса для текущего сэмпла (0..inference_steps).
    pub inf_step: u32,
    pub inf_total: u32,
    pub eta: Option<String>,
}

#[derive(Deserialize)]
pub struct StartTrainingArgs {
    pub api_key: String,
    pub pod_id: String,
    pub project_name: String,
    pub rank: u32,
    pub mode: String, // t2v | i2v | both
    pub steps: u32,
    #[serde(default)]
    pub trigger_word: Option<String>,
    #[serde(default)]
    pub validation_prompts: Vec<String>,
    /// Локальные пути на машине пользователя — мы их прочитаем и закинем на под.
    #[serde(default)]
    pub validation_images: Vec<String>,
    #[serde(default)]
    pub enable_gradient_checkpointing: bool,
    #[serde(default)]
    pub load_text_encoder_in_8bit: bool,
    #[serde(default)]
    pub expandable_segments: bool,
    /// Используется ли аудио в датасете.
    #[serde(default)]
    pub audio: bool,
    /// Сколько партов в датасете (нужно для sanity-check после preprocess).
    pub clip_count: u32,
    /// Список (W,H,F) бакетов. Один — в fixed-режиме, до пяти — в no_resize.
    /// Первый бакет считается «основным»: его пишем в validation.video_dims.
    pub buckets: Vec<[u32; 3]>,
    /// Если задан — игнорируем UI-поля и шлём этот YAML как config.yaml.
    #[serde(default)]
    pub raw_config_yaml: Option<String>,
}

#[tauri::command]
pub async fn start_training(
    app: tauri::AppHandle,
    args: StartTrainingArgs,
) -> Result<(), String> {
    if !matches!(args.mode.as_str(), "t2v" | "i2v" | "both") {
        return Err(format!("unknown mode: {}", args.mode));
    }
    if args.buckets.is_empty() {
        return Err("buckets list is empty — пересобери датасет".into());
    }

    let raw_mode = args
        .raw_config_yaml
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Валидация картинок vs промптов: только в обычном режиме. В raw-режиме
    // юзер сам отвечает за то, что лежит в его config.yaml.
    if !raw_mode {
        let n_prompts = args.validation_prompts.len();
        let n_images = args
            .validation_images
            .iter()
            .filter(|p| !p.trim().is_empty())
            .count();
        match args.mode.as_str() {
            "i2v" => {
                if n_images == 0 {
                    return Err(
                        "Режим i2v: добавь валидационные картинки (по одной на каждый промпт)".into(),
                    );
                }
                if n_images != n_prompts {
                    return Err(format!(
                        "Картинок {}, промптов {} — должны совпадать для режима i2v",
                        n_images, n_prompts
                    ));
                }
            }
            "both" => {
                if n_images > 0 && n_images != n_prompts {
                    return Err(format!(
                        "Картинок {}, промптов {} — для режима both должны совпадать (или удалить все картинки)",
                        n_images, n_prompts
                    ));
                }
            }
            _ => {}
        }
    }

    let (host, port) = resolve_pod_ssh_endpoint(&args.api_key, &args.pod_id).await?;
    let keys = collect_keys(&app);

    // 1. Загружаем валидационные картинки — только в обычном режиме. В raw-
    //    режиме предполагаем, что путь в config.yaml уже валиден.
    let yaml = if raw_mode {
        args.raw_config_yaml.as_deref().unwrap_or("").to_string()
    } else {
        let uploaded_images = upload_validation_images(
            &host,
            port,
            &keys,
            &args.project_name,
            &args.validation_images,
        )
        .await?;
        build_config_yaml(&args, &uploaded_images)
    };

    upload_config_yaml(&host, port, &keys, &args.project_name, &yaml).await?;

    let inner = build_inner_script(&args);
    project_task(&args.project_name)
        .start(&host, port, &keys, &inner)
        .await
}

/// Возвращает YAML, который ушёл бы на под при текущих параметрах. Используется
/// фронтом для «Export config» — юзер сохраняет его в файл, при необходимости
/// правит и потом грузит обратно как raw_config.
#[tauri::command]
pub fn export_training_config(args: StartTrainingArgs) -> Result<String, String> {
    if args.buckets.is_empty() {
        return Err("buckets list is empty".into());
    }
    // Картинки ещё не залиты — для экспорта берём их локальные пути как-есть.
    // Юзер всё равно подправит их, если будет использовать raw-режим.
    Ok(build_config_yaml(&args, &args.validation_images))
}

async fn upload_validation_images(
    host: &str,
    port: u16,
    keys: &[std::path::PathBuf],
    project: &str,
    local_paths: &[String],
) -> Result<Vec<String>, String> {
    let img_dir = input_images_dir(project);
    // wipe + recreate
    let cleanup = format!(
        r#"set -eu
rm -rf {d}
mkdir -p {d}
"#,
        d = shell::escape(&img_dir)
    );
    exec_remote(host, port, "root", keys, &cleanup).await?;
    let mut remote_paths = Vec::with_capacity(local_paths.len());
    for (i, p) in local_paths.iter().enumerate() {
        if p.trim().is_empty() {
            continue;
        }
        let bytes = tokio::fs::read(&p)
            .await
            .map_err(|e| format!("read {}: {}", p, e))?;
        let local_size = bytes.len();
        let ext = Path::new(p)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        let safe_ext = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
            ext
        } else {
            "jpg".to_string()
        };
        let remote_name = format!("img{}.{}", i + 1, safe_ext);
        let remote_path = format!("{}/{}", img_dir, remote_name);
        // Стримим бинарь в stdin удалённого `cat > file`. Никаких base64 и
        // ARG_MAX — пролезают любые размеры.
        let write_script = format!(
            "set -eu\ncat > {p}\nwc -c < {p}\n",
            p = shell::escape(&remote_path),
        );
        let out = exec_remote_with_stdin(host, port, "root", keys, &write_script, &bytes)
            .await
            .map_err(|e| format!("upload {}: {}", p, e))?;
        let remote_size: usize = out.trim().parse().unwrap_or(0);
        if remote_size != local_size {
            return Err(format!(
                "upload {} → {}: size mismatch (local={} bytes, remote={} bytes). \
                 Probably an SSH stdin truncation — repeat the start or report a bug.",
                p, remote_path, local_size, remote_size
            ));
        }
        remote_paths.push(remote_path);
    }
    Ok(remote_paths)
}

async fn upload_config_yaml(
    host: &str,
    port: u16,
    keys: &[std::path::PathBuf],
    project: &str,
    yaml: &str,
) -> Result<(), String> {
    let path = format!("{}/config.yaml", dataset_dir(project));
    let script = format!(
        r#"set -eu
mkdir -p "{d}"
printf '%s' {payload} > "{p}"
"#,
        d = dataset_dir(project),
        p = path,
        payload = shell::escape(yaml),
    );
    exec_remote(host, port, "root", keys, &script).await?;
    Ok(())
}

fn build_config_yaml(args: &StartTrainingArgs, validation_images_remote: &[String]) -> String {
    let trigger = normalize_trigger(args.trigger_word.as_deref().unwrap_or(""));

    let first_frame_p = match args.mode.as_str() {
        "t2v" => 0.0,
        "i2v" => 1.0,
        _ => 0.5, // both
    };

    let prompts_block = if args.validation_prompts.is_empty() {
        "    []".to_string()
    } else {
        args.validation_prompts
            .iter()
            .map(|p| {
                let prefixed = if trigger.is_empty() {
                    p.clone()
                } else {
                    format!("{}. {}", trigger, p)
                };
                format!("    - {}", yaml_sq(&prefixed))
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // images: только если mode != t2v И есть валидные пути. В режиме t2v
    // first_frame_conditioning_p=0.0 — картинки не нужны.
    let send_images = args.mode != "t2v" && !validation_images_remote.is_empty();
    let images_block = if send_images {
        let lines: Vec<String> = validation_images_remote
            .iter()
            .map(|p| format!("    - {}", yaml_sq(p)))
            .collect();
        format!("  images:\n{}", lines.join("\n"))
    } else {
        "  images: null".to_string()
    };

    let with_audio = if args.audio { "true" } else { "false" };
    let grad_ckpt = if args.enable_gradient_checkpointing {
        "true"
    } else {
        "false"
    };
    let te_8bit = if args.load_text_encoder_in_8bit {
        "true"
    } else {
        "false"
    };

    format!(
        r#"model:
  model_path: {model_path_q}
  text_encoder_path: {te_path_q}
  training_mode: "lora"
  load_checkpoint: null

lora:
  rank: {rank}
  alpha: {rank}
  dropout: 0.05
  target_modules:
    - "to_k"
    - "to_q"
    - "to_v"
    - "to_out.0"

training_strategy:
  name: "text_to_video"
  first_frame_conditioning_p: {first_frame_p}
  with_audio: {with_audio}
  audio_latents_dir: "audio_latents"

optimization:
  learning_rate: 1.0e-4
  steps: {steps}
  batch_size: 1
  gradient_accumulation_steps: 2
  max_grad_norm: 1.0
  optimizer_type: "adamw"
  scheduler_type: "linear"
  scheduler_params: {{}}
  enable_gradient_checkpointing: {grad_ckpt}

acceleration:
  mixed_precision_mode: "bf16"
  quantization: null
  load_text_encoder_in_8bit: {te_8bit}

data:
  preprocessed_data_root: {preproc_q}
  num_dataloader_workers: 4

validation:
  prompts:
{prompts_block}
  negative_prompt: "worst quality, inconsistent motion, blurry, jittery, distorted, static"
{images_block}
  video_dims: [{primary_w}, {primary_h}, {primary_f}]
  frame_rate: 24.0
  seed: 42
  inference_steps: 30
  interval: 250
  guidance_scale: 4.0
  stg_scale: 1.0
  stg_blocks: [29]
  stg_mode: "stg_av"
  generate_audio: {with_audio}
  skip_initial_validation: false

checkpoints:
  interval: 250
  keep_last_n: -1
  precision: "bfloat16"

flow_matching:
  timestep_sampling_mode: "shifted_logit_normal"
  timestep_sampling_params: {{}}

hub:
  push_to_hub: false
  hub_model_id: null

wandb:
  enabled: false
  project: "ltx23-motion-mtrig"
  tags: ["ltx2.3", "lora", "motion"]
  log_validation_videos: true

seed: 42
output_dir: {output_q}
"#,
        model_path_q = yaml_sq(MODEL_PATH),
        te_path_q = yaml_sq(TEXT_ENCODER_PATH),
        rank = args.rank,
        first_frame_p = format_f(first_frame_p),
        with_audio = with_audio,
        steps = args.steps,
        grad_ckpt = grad_ckpt,
        te_8bit = te_8bit,
        preproc_q = yaml_sq(&precomputed_dir(&args.project_name)),
        prompts_block = prompts_block,
        images_block = images_block,
        primary_w = args.buckets[0][0],
        primary_h = args.buckets[0][1],
        primary_f = args.buckets[0][2],
        output_q = yaml_sq(&output_dir(&args.project_name)),
    )
}

fn yaml_sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Сериализует бакеты в формат LTX-2: `"WxHxF;WxHxF;..."` (разделитель `;`).
/// См. https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-trainer/docs/dataset-preparation.md
fn buckets_csv(buckets: &[[u32; 3]]) -> String {
    buckets
        .iter()
        .map(|b| format!("{}x{}x{}", b[0], b[1], b[2]))
        .collect::<Vec<_>>()
        .join(";")
}

fn format_f(f: f32) -> String {
    if f.fract() == 0.0 {
        format!("{:.1}", f)
    } else {
        format!("{}", f)
    }
}

fn build_inner_script(args: &StartTrainingArgs) -> String {
    let dataset = dataset_dir(&args.project_name);
    let trigger = normalize_trigger(args.trigger_word.as_deref().unwrap_or(""));
    let state_dir =
        format!("{}/{}", STATE_DIR_BASE, shell::safe_name(&args.project_name));
    let with_audio_flag = if args.audio {
        "--with-audio"
    } else {
        "--no-with-audio"
    };
    let te_8bit_flag = if args.load_text_encoder_in_8bit {
        "--load-text-encoder-in-8bit"
    } else {
        "--no-load-text-encoder-in-8bit"
    };
    let expandable = if args.expandable_segments {
        "export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
    } else {
        ""
    };

    format!(
        r#"set -eu
{path}
{expandable}
emit() {{ printf 'LTX_%s\n' "$1"; }}

DATASET={dataset_q}
TRIGGER={trigger_q}
RES="{res_human}"
EXPECTED_CLIPS={expected}

# ─── PHASE 1: prep ────────────────────────────────────────────────────────
emit "PHASE: prep"
# Чистим прошлые preprocess-данные и output, чтобы не подтягивать старое.
# input_images уже залиты до старта tmux — их трогать не надо.
rm -rf "$DATASET/.precomputed" "$DATASET/output"
mkdir -p "$DATASET/output/samples" "$DATASET/output/checkpoints"
# Принудительная очистка GPU перед стартом: убиваем зависшие процессы
# предыдущих прогонов (если были), ждём 2 секунды на release CUDA-context.
free_vram() {{
  pkill -9 -f 'ltx-trainer/scripts/process_dataset' 2>/dev/null || true
  pkill -9 -f 'ltx-trainer/scripts/train' 2>/dev/null || true
  # Любые orphan-процессы, всё ещё держащие GPU.
  for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done
  sleep 2
}}
free_vram
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null \
  | awk -F, '{{ printf "VRAM start: %d / %d MiB used\n", $1, $2 }}' || true

# Верифицируем загруженные валидационные картинки. Базовый file + PIL.open
# ловят случай когда юзер выбрал HEIC под видом .jpg, или файл побился при
# base64-передаче. Падать с понятной ошибкой лучше, чем чтобы train.py
# крашился в первой валидации с непонятным python-traceback.
IMG_DIR="$DATASET/input_images"
if [ -d "$IMG_DIR" ] && ls "$IMG_DIR"/img* >/dev/null 2>&1; then
  echo ""
  echo "=== validation images check ==="
  IMG_BAD=0
  for f in "$IMG_DIR"/img*; do
    [ -e "$f" ] || continue
    sz=$(wc -c < "$f" 2>/dev/null || echo 0)
    mime=$(file -b --mime-type "$f" 2>/dev/null || echo "unknown")
    pil_ok=$(python3 - "$f" "{w}" "{h}" <<'PYEOF' 2>/dev/null
import sys
from PIL import Image
try:
    path = sys.argv[1]
    tw, th = int(sys.argv[2]), int(sys.argv[3])
    Image.open(path).verify()
    im = Image.open(path).convert("RGB")
    sw, sh = im.size
    # Center-crop под целевой aspect, потом LANCZOS-resize до video_dims.
    ta = tw / th
    sa = sw / sh
    if sa > ta:
        nw = int(sh * ta)
        x = (sw - nw) // 2
        im = im.crop((x, 0, x + nw, sh))
    elif sa < ta:
        nh = int(sw / ta)
        y = (sh - nh) // 2
        im = im.crop((0, y, sw, y + nh))
    im = im.resize((tw, th), Image.LANCZOS)
    # Сохраняем в исходный формат по расширению; JPEG/PNG/WEBP — PIL знает.
    save_kwargs = {{}}
    if path.lower().endswith((".jpg", ".jpeg")):
        save_kwargs["quality"] = 95
    im.save(path, **save_kwargs)
    print(f"OK -> {{tw}}x{{th}} (was {{sw}}x{{sh}})")
except Exception as e:
    print(f"FAIL {{e}}")
PYEOF
)
    echo "  $(basename "$f"): size=$sz mime=$mime pil=$pil_ok"
    case "$pil_ok" in
      OK*) ;;
      *) IMG_BAD=1 ;;
    esac
    case "$mime" in
      image/*) ;;
      *) IMG_BAD=1 ;;
    esac
  done
  echo "================================"
  if [ "$IMG_BAD" != "0" ]; then
    emit "ERR: image_invalid"
    exit 1
  fi
fi

# ─── PHASE 2: preprocess ─────────────────────────────────────────────────
emit "PHASE: preprocess"
cd /workspace/LTX-2

# rich/tqdm рисуют live-прогресс через `\r` только если stdout — TTY.
# `| tee` делает stdout пайпом → live-режим выключается. Чтобы сохранить
# и анимацию, и захват для grep, пускаем python через `script -qe`,
# который даёт ему фейковую pty. Сам tmux pipe-pane продолжает писать
# весь pty-вывод в $TMUX_LOG, оттуда после exec грепаем счётчики.
TMUX_LOG={state_dir_q}/log
PRE_SCRIPT=/tmp/ltx_preprocess_$$.sh
# quoted heredoc — никакого $-расширения, все аргументы уже shell::escape
# на Rust-стороне (в т.ч. trigger/dataset с пробелами/юникодом).
cat > "$PRE_SCRIPT" <<'INNER_EOF'
#!/bin/bash
exec env PYTHONUNBUFFERED=1 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/process_dataset.py {dataset_captions_q} --resolution-buckets {res_q} --model-path {model_path_q} --text-encoder-path {te_path_q} --lora-trigger {trigger_q} {with_audio_flag} {te_8bit_flag}
INNER_EOF
chmod +x "$PRE_SCRIPT"

# Запоминаем размер лога, чтобы потом грепать только то, что напишет preprocess.
LOG_BEFORE=$(wc -c < "$TMUX_LOG" 2>/dev/null || echo 0)

set +e
script -qe -c "$PRE_SCRIPT" /dev/null
PRE_EC=$?
set -e
rm -f "$PRE_SCRIPT"

# Даём pipe-pane дописать хвост.
sleep 1
PRE_LOG=$(mktemp)
# Стрипаем ANSI escape-коды rich-логгера: иначе grep не находит «Loaded N
# valid media files», потому что цифры обёрнуты в \e[0;36m...\e[0m.
tail -c +$((LOG_BEFORE+1)) "$TMUX_LOG" \
  | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' > "$PRE_LOG"

if [ "$PRE_EC" != "0" ]; then
  echo ""
  echo "=== preprocess output tail (exit=$PRE_EC) ==="
  tail -n 80 "$PRE_LOG"
  echo "=== end preprocess output ==="
  if grep -qiE 'out of memory|CUDA out of memory|OutOfMemoryError' "$PRE_LOG"; then
    emit "ERR: oom"
  else
    emit "ERR: preprocess"
  fi
  exit 1
fi

GOT=$(grep -oE 'Loaded [0-9]+ valid media files' "$PRE_LOG" | grep -oE '[0-9]+' | tail -1 || true)
if [ -z "$GOT" ]; then GOT=0; fi
echo "media check: got=$GOT expected=$EXPECTED_CLIPS"
if [ "$GOT" != "$EXPECTED_CLIPS" ]; then
  emit "ERR: media_mismatch"
  exit 1
fi

# ─── PHASE 3: vram_clear ─────────────────────────────────────────────────
emit "PHASE: vram_clear"
# CUDA-driver автоматически освобождает VRAM при выходе процесса. Но
# если preprocess нагенерил dataloader-воркеров и кто-то из них завис —
# они продолжают держать GPU. Принудительно убиваем их, ждём release.
free_vram
echo "VRAM after preprocess:"
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null \
  | awk -F, '{{ printf "  %d / %d MiB used\n", $1, $2 }}' || true
echo "Active GPU processes (should be empty):"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null \
  | sed 's/^/  /' || true

# ─── PHASE 4: train ──────────────────────────────────────────────────────
emit "PHASE: train"
TRAIN_SCRIPT=/tmp/ltx_train_$$.sh
cat > "$TRAIN_SCRIPT" <<'INNER_EOF'
#!/bin/bash
exec env PYTHONUNBUFFERED=1 stdbuf -oL -eL uv run python packages/ltx-trainer/scripts/train.py {config_q}
INNER_EOF
chmod +x "$TRAIN_SCRIPT"

TR_TYPESCRIPT=/tmp/ltx_train_ts_$$.txt
: > "$TR_TYPESCRIPT"
set +e
# script -fe: -e возвращает exit-код дочерней команды, -f flush'ит после
# каждой записи, чтобы typescript-файл был полным даже при быстром падении.
script -qfe -c "$TRAIN_SCRIPT" "$TR_TYPESCRIPT"
TR_EC=$?
set -e
rm -f "$TRAIN_SCRIPT"

TR_LOG=$(mktemp)
TR_TS_SIZE=$(wc -c < "$TR_TYPESCRIPT" 2>/dev/null || echo 0)
sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$TR_TYPESCRIPT" > "$TR_LOG" 2>/dev/null || true
rm -f "$TR_TYPESCRIPT"

# Всегда печатаем хвост (или диагностику если пусто) — даже на успехе он
# не помешает увидеть финальную сводку trainer'а.
echo ""
echo "=== trainer output tail (exit=$TR_EC, typescript=$TR_TS_SIZE bytes) ==="
if [ -s "$TR_LOG" ]; then
  tail -n 80 "$TR_LOG"
else
  echo "(typescript is empty — script(1) либо trainer завершились без вывода)"
fi
echo "=== end trainer output ==="

if [ "$TR_EC" != "0" ]; then
  if grep -qiE 'out of memory|CUDA out of memory|OutOfMemoryError' "$TR_LOG"; then
    emit "ERR: oom"
  else
    emit "ERR: train"
  fi
  exit 1
fi

# Финальная зачистка процессов и снимок VRAM (необязательно для UI, но
# полезно при дальнейших прогонах: в логе видно, что GPU свободен).
free_vram

emit "PHASE: done"
"#,
        path = PATH_SETUP,
        expandable = expandable,
        dataset_q = shell::escape(&dataset),
        dataset_captions_q = shell::escape(&format!("{}/captions.json", dataset)),
        trigger_q = shell::escape(&trigger),
        state_dir_q = shell::escape(&state_dir),
        res_human = format!(
            "{}x{}x{}{}",
            args.buckets[0][0],
            args.buckets[0][1],
            args.buckets[0][2],
            if args.buckets.len() > 1 {
                format!(" (+{} more buckets)", args.buckets.len() - 1)
            } else {
                String::new()
            }
        ),
        res_q = shell::escape(&buckets_csv(&args.buckets)),
        config_q = shell::escape(&format!("{}/config.yaml", dataset)),
        w = args.buckets[0][0],
        h = args.buckets[0][1],
        expected = args.clip_count,
        model_path_q = shell::escape(MODEL_PATH),
        te_path_q = shell::escape(TEXT_ENCODER_PATH),
        with_audio_flag = with_audio_flag,
        te_8bit_flag = te_8bit_flag,
    )
}

#[tauri::command]
pub async fn check_training_state(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<TrainingState, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let task = project_task(&project_name);
    let st = task.state(&host, port, &keys).await?;

    // Кумулятивные маркеры (фаза, ошибки, законченные валидации) живут весь
    // прогон, но в 64-KiB tail могут не попасть на длинном логе. Грепаем
    // их из ВСЕГО лога — таких строк всего пара десятков, дёшево.
    let state_dir =
        format!("{}/{}", STATE_DIR_BASE, shell::safe_name(&project_name));
    let cumul = collect_persistent_markers(&host, port, &keys, &state_dir).await?;

    // Live-прогресс (Training/Sampling/Processing) — только из последних
    // 64 KiB, прогресс-бары пишутся постоянно, ничего не теряем.
    let tail = task
        .tail(&host, port, &keys, st.log_size.saturating_sub(64 * 1024))
        .await?;
    let mut state = TrainingState {
        state: st.state.clone(),
        log_size: st.log_size,
        exit_code: st.exit_code,
        phase: cumul.phase,
        validations_done: cumul.validations_done,
        error: cumul.error,
        error_kind: cumul.error_kind,
        ..Default::default()
    };
    parse_markers(&tail.content, &mut state);
    Ok(state)
}

struct PersistentMarkers {
    phase: Option<String>,
    validations_done: Vec<u32>,
    error: Option<String>,
    error_kind: Option<String>,
}

async fn collect_persistent_markers(
    host: &str,
    port: u16,
    keys: &[std::path::PathBuf],
    state_dir: &str,
) -> Result<PersistentMarkers, String> {
    let script = format!(
        r#"set +e
LOG="{d}/log"
[ -f "$LOG" ] || exit 0
sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOG" \
  | grep -E '^LTX_|Validation samples for step '
"#,
        d = state_dir
    );
    let out = exec_remote(host, port, "root", keys, &script).await?;

    use std::collections::BTreeSet;
    let mut phase = None;
    let mut error = None;
    let mut error_kind = None;
    let mut vals: BTreeSet<u32> = BTreeSet::new();

    for raw in out.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("LTX_PHASE: ") {
            phase = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("LTX_ERR: ") {
            let kind = rest.trim();
            error_kind = Some(kind.to_string());
            error = Some(format!("ERR: {}", kind));
        } else if let Some(rest) = line.strip_prefix("LTX_VAL_DONE: ") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                vals.insert(n);
            }
        } else if let Some(idx) = line.find("Validation samples for step ") {
            let rest = &line[idx + "Validation samples for step ".len()..];
            let end = rest.find(' ').unwrap_or(rest.len());
            if let Ok(n) = rest[..end].parse::<u32>() {
                vals.insert(n);
            }
        }
    }

    Ok(PersistentMarkers {
        phase,
        validations_done: vals.into_iter().collect(),
        error,
        error_kind,
    })
}

fn parse_markers(log: &str, out: &mut TrainingState) {
    use std::collections::BTreeSet;
    // Стартовое множество — то, что уже собрано из полного лога.
    let mut vals: BTreeSet<u32> = out.validations_done.iter().copied().collect();
    let mut current_val: Option<u32> = None;

    // Tracking last-seen progress: какая из строк (Training / Sampling /
    // Processing captions / Processing videos) встретилась позже в логе —
    // та и активна сейчас.
    let mut last_train: Option<TrainingLineData> = None;
    let mut last_sampling: Option<ValidationProgress> = None;
    let mut last_preprocess: Option<PreprocessProgress> = None;
    let mut last_progress_kind: Option<&'static str> = None;

    for raw in log.lines() {
        let stripped = strip_ansi(raw);
        let line = stripped.trim();

        // ── Наши маркеры ────────────────────────────────────────────────
        if let Some(rest) = line.strip_prefix("LTX_PHASE: ") {
            let v = rest.trim();
            out.phase = Some(v.to_string());
            if v == "train" {
                out.step = None;
                out.total_steps = None;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("LTX_STEP: ") {
            if let Some((a, b)) = rest.split_once('/') {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                    out.step = Some(a);
                    out.total_steps = Some(b);
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("LTX_VAL_START: ") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                current_val = Some(n);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("LTX_VAL_DONE: ") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                vals.insert(n);
                if current_val == Some(n) {
                    current_val = None;
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("LTX_ERR: ") {
            let kind = rest.trim();
            out.error_kind = Some(kind.to_string());
            out.error = Some(format!("ERR: {}", kind));
            continue;
        }

        // ── Логи trainer'а LTX-2 ────────────────────────────────────────
        // "INFO     🎥 Validation samples for step N saved in samples"
        if let Some(idx) = line.find("Validation samples for step ") {
            let rest = &line[idx + "Validation samples for step ".len()..];
            let end = rest.find(' ').unwrap_or(rest.len());
            if let Ok(n) = rest[..end].parse::<u32>() {
                vals.insert(n);
            }
        }

        // "Training X/Y ... Loss: F | LR: f.fE-NN | T.Ts/step ... ETA: H:MM:SS"
        if line.contains("Training ") {
            if let Some(d) = parse_training_line(&line) {
                last_train = Some(d);
                last_progress_kind = Some("train");
            }
        }

        // "Sampling K/M ... step X/Y ... ETA: MM:SS"
        if line.contains("Sampling ") {
            if let Some(p) = parse_sampling_line(&line) {
                last_sampling = Some(p);
                last_progress_kind = Some("sampling");
            }
        }

        // "Processing captions ━━ NN% X/Y H:MM:SS H:MM:SS" /
        // "Processing videos   ━━ NN% X/Y H:MM:SS H:MM:SS"
        let prep_kind = if line.contains("Processing captions") {
            Some("captions")
        } else if line.contains("Processing videos") {
            Some("videos")
        } else {
            None
        };
        if let Some(kind) = prep_kind {
            if let Some((done, total)) = parse_processing_count(&line) {
                last_preprocess = Some(PreprocessProgress {
                    kind: kind.to_string(),
                    done,
                    total,
                });
                last_progress_kind = Some("preprocess");
            }
        }
    }

    // Применяем training-данные всегда (показываем последний известный шаг
    // даже когда идёт валидация).
    if let Some(d) = last_train {
        out.step = Some(d.step);
        out.total_steps = Some(d.total);
        out.eta = d.eta;
        out.loss = d.loss;
        out.lr = d.lr;
        out.step_time = d.step_time;
    }
    // Validation-прогресс — только если сейчас активна (последняя progress-
    // строка в логе именно sampling).
    if last_progress_kind == Some("sampling") {
        out.validation_progress = last_sampling;
    }
    // Preprocess-прогресс показываем во время фазы preprocess. Если позже
    // в логе появятся Training/Sampling — мы и phase сменили, и эту
    // информацию убирать не надо: фронт смотрит на phase.
    if last_progress_kind == Some("preprocess") || out.phase.as_deref() == Some("preprocess") {
        out.preprocess_progress = last_preprocess;
    }

    out.validations_done = vals.into_iter().collect();
    out.current_validation = current_val;
}

struct TrainingLineData {
    step: u32,
    total: u32,
    loss: Option<f32>,
    lr: Option<String>,
    step_time: Option<String>,
    eta: Option<String>,
}

fn parse_training_line(line: &str) -> Option<TrainingLineData> {
    let idx = line.find("Training ")?;
    let after = &line[idx + "Training ".len()..];
    let space = after.find(|c: char| c.is_whitespace())?;
    let nm = &after[..space];
    let (n_str, m_str) = nm.split_once('/')?;
    let step: u32 = n_str.parse().ok()?;
    let total: u32 = m_str.parse().ok()?;
    Some(TrainingLineData {
        step,
        total,
        loss: extract_value(line, "Loss: ").and_then(|s| s.parse().ok()),
        lr: extract_value(line, "LR: "),
        step_time: extract_step_time(line),
        eta: extract_value(line, "ETA: "),
    })
}

fn parse_sampling_line(line: &str) -> Option<ValidationProgress> {
    let idx = line.find("Sampling ")?;
    let after = &line[idx + "Sampling ".len()..];
    let space = after.find(|c: char| c.is_whitespace())?;
    let nm = &after[..space];
    let (s_str, st_str) = nm.split_once('/')?;
    let sample: u32 = s_str.parse().ok()?;
    let samples_total: u32 = st_str.parse().ok()?;

    let step_idx = line.find("step ")?;
    let after_step = &line[step_idx + "step ".len()..];
    let xy_end = after_step
        .find(|c: char| c.is_whitespace())
        .unwrap_or(after_step.len());
    let xy = &after_step[..xy_end];
    let (x_str, y_str) = xy.split_once('/')?;
    let inf_step: u32 = x_str.parse().ok()?;
    let inf_total: u32 = y_str.parse().ok()?;

    Some(ValidationProgress {
        sample,
        samples_total,
        inf_step,
        inf_total,
        eta: extract_value(line, "ETA: "),
    })
}

/// Находит первое вхождение `<digits>/<digits>` в строке. Используется для
/// парсинга rich-прогрессбаров вида `... 51% 43/85 0:00:08 0:00:07`.
fn parse_processing_count(line: &str) -> Option<(u32, u32)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            // Должен быть знак '/' (а не ':' и не '%')
            if i < bytes.len() && bytes[i] == b'/' {
                let mid = i;
                i += 1;
                let total_start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > total_start {
                    let done = line[start..mid].parse().ok()?;
                    let total = line[total_start..i].parse().ok()?;
                    return Some((done, total));
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Берёт значение после `prefix` до следующего пробела/разделителя `|`.
fn extract_value(line: &str, prefix: &str) -> Option<String> {
    let idx = line.find(prefix)?;
    let rest = &line[idx + prefix.len()..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(rest.len());
    let v = rest[..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// "2.62s/step" — берёт число + "s/step".
fn extract_step_time(line: &str) -> Option<String> {
    let idx = line.find("s/step")?;
    let before = &line[..idx];
    let start = before
        .rfind(|c: char| !c.is_ascii_digit() && c != '.')
        .map(|i| i + 1)
        .unwrap_or(0);
    let s = &line[start..idx + "s/step".len()];
    if s == "s/step" {
        None
    } else {
        Some(s.to_string())
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'[' {
                i += 2;
                while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
                continue;
            } else {
                i += 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[derive(Serialize)]
pub struct TrainingTail {
    pub total: u64,
    pub content: String,
}

#[tauri::command]
pub async fn tail_training_log(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    since: u64,
) -> Result<TrainingTail, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let chunk = project_task(&project_name)
        .tail(&host, port, &keys, since)
        .await?;
    Ok(TrainingTail {
        total: chunk.total,
        content: chunk.content,
    })
}

#[tauri::command]
pub async fn reset_training(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    project_task(&project_name).reset(&host, port, &keys).await
}

// ──────────────────────────────────────────────────────────────────────────
// Validation viewer commands
// ──────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_validation_steps(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
) -> Result<Vec<u32>, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let sd = samples_dir(&project_name);
    // Trainer кладёт `output/samples/step_NNNNNN_K.mp4`. Достаём уникальные
    // step-номера. Step 0 включён, validation на нулевом шаге легитимна
    // (skip_initial_validation: false).
    let script = format!(
        r#"set +e
if [ ! -d "{d}" ]; then exit 0; fi
ls "{d}" 2>/dev/null
"#,
        d = sd
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    use std::collections::BTreeSet;
    let mut steps: BTreeSet<u32> = BTreeSet::new();
    for raw in out.lines() {
        if let Some((step, _)) = parse_sample_filename(raw.trim()) {
            steps.insert(step);
        }
    }
    Ok(steps.into_iter().collect())
}

/// `step_000200_3.mp4` → (200, 3). Возвращает None для не-сэмплов.
fn parse_sample_filename(name: &str) -> Option<(u32, u32)> {
    let stem = name.strip_suffix(".mp4")?;
    let mut parts = stem.splitn(3, '_');
    if parts.next()? != "step" {
        return None;
    }
    let step: u32 = parts.next()?.parse().ok()?;
    let sample: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((step, sample))
}

/// `img3.jpg` → 3. None для остальных.
fn parse_image_filename(name: &str) -> Option<u32> {
    let dot = name.rfind('.')?;
    let stem = &name[..dot];
    stem.strip_prefix("img")?.parse().ok()
}

#[derive(Serialize)]
pub struct ValidationItem {
    /// 1-based индекс сэмпла (как в имени файла `step_NNNNNN_K.mp4`).
    pub index: u32,
    /// Имя видео-файла в `output/samples/`.
    pub video: Option<String>,
    /// Имя картинки в `input_images/` (если i2v и есть совпадение по индексу).
    pub image: Option<String>,
    /// Промпт берёт фронтенд из cfg по индексу.
    pub prompt: Option<String>,
}

#[tauri::command]
pub async fn list_validation_files(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
) -> Result<Vec<ValidationItem>, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let sd = samples_dir(&project_name);
    let id = input_images_dir(&project_name);
    let script = format!(
        r#"set +e
echo "<<SAMPLES>>"
ls "{sd}" 2>/dev/null
echo "<<IMAGES>>"
ls "{id}" 2>/dev/null
"#,
        sd = sd,
        id = id,
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;

    let mut samples: Vec<(u32, String)> = Vec::new();
    let mut images = std::collections::HashMap::<u32, String>::new();
    let mut section = "";
    for raw in out.lines() {
        let line = raw.trim();
        if line == "<<SAMPLES>>" {
            section = "s";
            continue;
        }
        if line == "<<IMAGES>>" {
            section = "i";
            continue;
        }
        if line.is_empty() {
            continue;
        }
        match section {
            "s" => {
                if let Some((s, k)) = parse_sample_filename(line) {
                    if s == step {
                        samples.push((k, line.to_string()));
                    }
                }
            }
            "i" => {
                if let Some(k) = parse_image_filename(line) {
                    images.insert(k, line.to_string());
                }
            }
            _ => {}
        }
    }
    samples.sort_by_key(|(k, _)| *k);
    let items: Vec<ValidationItem> = samples
        .into_iter()
        .map(|(k, video)| ValidationItem {
            index: k,
            video: Some(video),
            image: images.get(&k).cloned(),
            prompt: None,
        })
        .collect();
    Ok(items)
}

#[derive(Serialize)]
pub struct ValidationFile {
    pub mime: String,
    pub b64: String,
    pub size: usize,
}

#[tauri::command]
pub async fn read_validation_file(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
    filename: String,
) -> Result<ValidationFile, String> {
    if filename.contains('/') || filename.contains("..") {
        return Err("invalid filename".into());
    }
    let _ = step; // step нужен для сигнатуры, но путь уникален и без него
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    // Видео живут в output/samples, картинки — в input_images.
    let path = if filename.starts_with("step_") {
        format!("{}/{}", samples_dir(&project_name), filename)
    } else if filename.starts_with("img") {
        format!("{}/{}", input_images_dir(&project_name), filename)
    } else {
        return Err("invalid filename".into());
    };
    let script = format!(
        r#"set -eu
if [ ! -f "{p}" ]; then echo "not found"; exit 1; fi
base64 -w 0 "{p}"
"#,
        p = path
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let b64: String = out.chars().filter(|c| !c.is_whitespace()).collect();
    let lower = filename.to_lowercase();
    let mime = if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
    .to_string();
    Ok(ValidationFile {
        size: (b64.len() / 4) * 3,
        mime,
        b64,
    })
}

#[derive(Serialize)]
pub struct CheckpointInfo {
    pub step: u32,
    pub size_bytes: u64,
    pub path: String,
}

#[tauri::command]
pub async fn checkpoint_info(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
) -> Result<Option<CheckpointInfo>, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    // Trainer пишет `lora_weights_step_NNNNN.safetensors` (5 цифр).
    let path = format!(
        "{}/lora_weights_step_{:05}.safetensors",
        checkpoints_dir(&project_name),
        step
    );
    let script = format!(
        r#"set +e
if [ -f "{p}" ]; then
  wc -c < "{p}" | tr -d ' '
else
  echo NONE
fi
"#,
        p = path
    );
    let out = exec_remote(&host, port, "root", &keys, &script).await?;
    let line = out.lines().last().unwrap_or("").trim();
    if line == "NONE" || line.is_empty() {
        return Ok(None);
    }
    let size = line.parse::<u64>().unwrap_or(0);
    Ok(Some(CheckpointInfo {
        step,
        size_bytes: size,
        path,
    }))
}

// ──────────────────────────────────────────────────────────────────────────
// Скачивание чекпоинта по runpodctl: pod-сторона держит `runpodctl send`
// в tmux, отдаёт код. Дальше пользователь:
//   • «Сохранить в загрузки» — мы локально запускаем `runpodctl receive`,
//   • «Скопировать»          — фронт кладёт код в буфер обмена.
// ──────────────────────────────────────────────────────────────────────────

const SEND_STATE_DIR_BASE: &str = "/workspace/.ltx-ckpt-send";

fn send_task(project: &str, step: u32) -> TmuxTask {
    let safe = shell::safe_name(project);
    TmuxTask::new(
        format!("ltx_send_{}_{}", safe, step),
        format!("{}/{}_{}", SEND_STATE_DIR_BASE, safe, step),
    )
}

#[tauri::command]
pub async fn checkpoint_send_start(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
) -> Result<(), String> {
    let ckpt_path = format!(
        "{}/lora_weights_step_{:05}.safetensors",
        checkpoints_dir(&project_name),
        step
    );
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);

    // Sanity: убедиться что чекпоинт существует.
    let check = format!(
        r#"set +e
if [ -f "{p}" ]; then echo OK; else echo MISSING; fi
"#,
        p = ckpt_path
    );
    let out = exec_remote(&host, port, "root", &keys, &check).await?;
    if !out.contains("OK") {
        return Err(format!("checkpoint not found: {}", ckpt_path));
    }

    // Tmux уже даёт нам pty (см. tmux_task.rs `-x 250 -y 50`), так что
    // runpodctl видит свой stdout как терминал и сразу пишет «Code is: …».
    // Никакая обёртка `script` не нужна.
    let inner = format!(
        r#"set -eu
runpodctl send {p}
"#,
        p = shell::escape(&ckpt_path)
    );
    send_task(&project_name, step)
        .start(&host, port, &keys, &inner)
        .await
}

#[derive(Serialize)]
pub struct CheckpointSendState {
    pub state: String, // pending | running | done | failed
    pub log_size: u64,
    pub code: Option<String>,
    pub log_tail: String,
}

#[tauri::command]
pub async fn checkpoint_send_state(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
) -> Result<CheckpointSendState, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let task = send_task(&project_name, step);
    let st = task.state(&host, port, &keys).await?;
    let tail = task.tail(&host, port, &keys, 0).await?;
    let cleaned = strip_ansi(&tail.content);
    let code = parse_runpodctl_code(&cleaned);
    Ok(CheckpointSendState {
        state: st.state,
        log_size: st.log_size,
        code,
        log_tail: cleaned,
    })
}

#[tauri::command]
pub async fn checkpoint_send_stop(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
    project_name: String,
    step: u32,
) -> Result<(), String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    send_task(&project_name, step).reset(&host, port, &keys).await
}

fn parse_runpodctl_code(s: &str) -> Option<String> {
    let lower = s.to_lowercase();
    let idx = lower.find("code is:")?;
    let rest = &s[idx + "code is:".len()..];
    let token = rest.split_whitespace().next()?.trim();
    if token.contains('-') {
        Some(token.to_string())
    } else {
        None
    }
}

fn downloads_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join("Downloads"))
}

#[tauri::command]
pub async fn runpodctl_receive_local(
    app: tauri::AppHandle,
    code: String,
) -> Result<String, String> {
    let runpodctl = find_executable("runpodctl")
        .ok_or_else(|| "runpodctl не установлен локально".to_string())?;
    let downloads =
        downloads_dir().ok_or_else(|| "не нашёл папку Downloads".to_string())?;
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    // Запускаем runpodctl receive напрямую. macOS BSD `script` имеет другой
    // синтаксис чем util-linux'овский — pty-обёртка тут не нужна, прогресс
    // увидим line-buffered, финальное «Received» придёт.
    let mut cmd = Command::new(&runpodctl);
    cmd.arg("receive")
        .arg(&code)
        .current_dir(&downloads)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let app1 = app.clone();
    let app2 = app.clone();
    let h1 = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app1.emit("ckpt_receive:log", json!({ "line": line }));
        }
    });
    let h2 = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app2.emit("ckpt_receive:log", json!({ "line": line }));
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = h1.await;
    let _ = h2.await;
    if !status.success() {
        return Err(format!("runpodctl receive exit: {}", status));
    }
    Ok(downloads.to_string_lossy().to_string())
}

