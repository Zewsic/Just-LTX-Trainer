import { LazyStore } from "@tauri-apps/plugin-store";

export const store = new LazyStore("settings.json");

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
