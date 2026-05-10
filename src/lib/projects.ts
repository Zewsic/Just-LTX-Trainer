import { invoke } from "@tauri-apps/api/core";

export interface VideoEntry {
  path: string;
  prompt?: string | null;
}

export interface Project {
  name: string;
  local_setup_done: boolean;
  videos: VideoEntry[];
  aspect_ratio: string; // "16:9" | "4:3" | "1:1" | "3:4" | "9:16"
  length_seconds: number; // 3.7 | 5.0
  overlap: boolean;
  audio: boolean;
  last_build_hash: string | null;
  last_build_zip: string | null;
  last_build_at: number;
  last_build_clips: Record<string, number>;
  last_uploads: Record<string, { hash: string; at: number }>;
  training: TrainingConfig;
  created_at: number;
  updated_at: number;
}

export interface TrainingConfig {
  pretrain_signature: string | null;
  pretrain_done_at: number;
  rank: number | null;
  mode: "t2v" | "i2v" | "both" | null;
  steps: number | null;
  validation_prompts: string[];
  validation_images: string[];
  enable_gradient_checkpointing: boolean | null;
  load_text_encoder_in_8bit: boolean | null;
}

/** Дефолтные параметры обучения исходя из количества клипов и GPU */
export function defaultTrainingConfig(opts: {
  clips: number;
  gpu_name?: string | null;
}): TrainingConfig {
  const { clips, gpu_name } = opts;
  const rank = clips < 50 ? 32 : 64;
  // 1500 + 500 за каждые 50 клипов сверх 30 (округление в большую группу)
  // 30→1500, 51→2000, 99→2000, 101→2500
  const steps = Math.min(
    5000,
    Math.max(1000, 1500 + Math.floor(Math.max(0, clips - 1) / 50) * 500),
  );
  const isHopperOrNewer = !!gpu_name && /\b(H100|H200|B200|B300)\b/i.test(gpu_name);
  return {
    pretrain_signature: null,
    pretrain_done_at: 0,
    rank,
    mode: "both",
    steps,
    validation_prompts: [],
    validation_images: [],
    enable_gradient_checkpointing: isHopperOrNewer,
    load_text_encoder_in_8bit: isHopperOrNewer,
  };
}

export const RANK_OPTIONS = [16, 32, 64, 128, 256] as const;
export const STEPS_MIN = 1000;
export const STEPS_MAX = 5000;
export const STEPS_STEP = 250;

/**
 * Хэш всех входов сборки. Меняется при любом изменении видео/промпта/параметров.
 */
export async function buildSnapshotHash(p: Project): Promise<string> {
  const sig = JSON.stringify({
    aspect: p.aspect_ratio,
    length: p.length_seconds,
    overlap: p.overlap,
    audio: !!p.audio,
    videos: [...p.videos]
      .map((v) => [v.path, v.prompt ?? ""])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  });
  const buf = new TextEncoder().encode(sig);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface LocalTools {
  os: string;
  has_brew: boolean;
  has_ffmpeg: boolean;
  has_runpodctl: boolean;
  brew_path: string | null;
  ffmpeg_path: string | null;
  runpodctl_path: string | null;
}

export const ASPECT_OPTIONS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const LENGTH_OPTIONS = [3.7, 5] as const;

export const listProjects = () => invoke<string[]>("list_projects");
export const loadProject = (name: string) => invoke<Project>("load_project", { name });
export const saveProject = (project: Project) =>
  invoke<Project>("save_project", { project });
export const createProject = (name: string) =>
  invoke<Project>("create_project", { name });
export const deleteProject = (name: string) =>
  invoke<void>("delete_project", { name });

export const checkLocalTools = () => invoke<LocalTools>("check_local_tools");
export const installFfmpeg = () => invoke<string>("install_ffmpeg");
export const installRunpodctl = () => invoke<string>("install_runpodctl");

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
