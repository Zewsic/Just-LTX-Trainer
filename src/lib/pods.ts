import { LazyStore } from "@tauri-apps/plugin-store";

export const store = new LazyStore("settings.json");

/// Если тумблер "Уведомлять о событиях" включён и чат привязан — отдаёт
/// tg_bot_token/tg_chat_id для подмешивания в args команд start_training /
/// start_init_step, иначе пустой объект (сервер просто не шлёт curl).
export async function getTelegramNotifyArgs(): Promise<{
  tg_bot_token?: string;
  tg_chat_id?: string;
}> {
  const enabled = (await store.get<boolean>("tg_events_enabled")) ?? false;
  if (!enabled) return {};
  const token = (await store.get<string>("tg_bot_token")) ?? "";
  const chatId = (await store.get<string>("tg_chat_id")) ?? "";
  if (!token || !chatId) return {};
  return { tg_bot_token: token, tg_chat_id: chatId };
}

/// Аргументы для шага инициализации "telegram_bot_api" и для start_training,
/// когда включена отправка чекпоинтов/генераций (`tg_files_enabled`).
/// Объединяет tg_bot_token/tg_chat_id (нужны и для событий, и для файлов —
/// один и тот же бот/чат) с api_id/api_hash (нужны только серверу
/// telegram-bot-api) и самим флагом.
export async function getTelegramFilesArgs(): Promise<{
  tg_bot_token?: string;
  tg_chat_id?: string;
  tg_files_enabled: boolean;
  tg_api_id?: string;
  tg_api_hash?: string;
}> {
  // Токен/чат не зависят от тумблера "события" — тот же бот используется и
  // для файлов, если тумблер "файлы" включён независимо от "событий".
  const token = (await store.get<string>("tg_bot_token")) ?? "";
  const chatId = (await store.get<string>("tg_chat_id")) ?? "";
  const filesEnabled = (await store.get<boolean>("tg_files_enabled")) ?? false;
  if (!filesEnabled || !token || !chatId) {
    return { tg_files_enabled: false };
  }
  const apiId = (await store.get<string>("tg_api_id")) ?? "";
  const apiHash = (await store.get<string>("tg_api_hash")) ?? "";
  return {
    tg_bot_token: token,
    tg_chat_id: chatId,
    tg_files_enabled: !!(apiId && apiHash),
    tg_api_id: apiId,
    tg_api_hash: apiHash,
  };
}

export interface Pod {
  id: string;
  name: string;
  desired_status: string;
  cost_per_hr: number | null;
  gpu_count: number | null;
  gpu_display_name: string | null;
  image_name: string | null;
}

export interface ManagedPod {
  id: string;
  name: string;
  ltx_state: string;
  created_at: number;
  gpu_type_id?: string;
  /// Установлен и поднят ли на этом поде локальный telegram-bot-api сервер
  /// (шаг инициализации "telegram_bot_api").
  telegram_bot_api_installed?: boolean;
}

export interface SshProbe {
  ok: boolean;
  host: string;
  port: number;
  user: string;
  key_used: string | null;
  error: string | null;
}

export interface NvidiaGpu {
  index: number;
  name: string;
  driver_version: string;
  memory_used_mb: number;
  memory_total_mb: number;
  power_draw_w: number | null;
  power_limit_w: number | null;
  temperature_c: number | null;
  utilization_pct: number | null;
  perf_state: string;
}

export interface NvidiaInfo {
  driver_version: string;
  cuda_version: string;
  gpus: NvidiaGpu[];
  raw: string;
}

export type PodPhase =
  | "provisioning"
  | "needs_setup" // managed + RUNNING + ltx_state == init
  | "ready" // managed + RUNNING + ltx_state != init
  | "running" // not managed by this app, just up
  | "stopped"
  | "unknown";

export function podPhase(
  live: Pod | undefined | null,
  managed: ManagedPod | undefined | null,
): PodPhase {
  const status = live?.desired_status ?? "";
  if (status === "EXITED" || status === "TERMINATED") return "stopped";
  if (status !== "RUNNING") return status ? "provisioning" : "unknown";
  if (!managed) return "running";
  if (managed.ltx_state !== "init") return "ready";
  return "needs_setup";
}

export function migrateManaged(raw: unknown): ManagedPod[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x: any) =>
      typeof x === "string"
        ? { id: x, name: "", ltx_state: "init", created_at: 0 }
        : x?.id
        ? {
            id: x.id,
            name: x.name ?? "",
            ltx_state: x.ltx_state ?? "init",
            created_at: x.created_at ?? 0,
            gpu_type_id: x.gpu_type_id,
            telegram_bot_api_installed: x.telegram_bot_api_installed,
          }
        : null,
    )
    .filter((x): x is ManagedPod => !!x);
}

export async function loadManaged(): Promise<ManagedPod[]> {
  const raw = await store.get("managed_pods");
  const list = migrateManaged(raw);
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

export async function saveManaged(list: ManagedPod[]) {
  await store.set("managed_pods", list);
  await store.save();
}
