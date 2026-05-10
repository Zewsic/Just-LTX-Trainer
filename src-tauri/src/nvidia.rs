use crate::ssh::{collect_keys, exec_remote, resolve_pod_ssh_endpoint};
use serde::Serialize;

#[derive(Serialize, Default)]
pub struct NvidiaGpu {
    pub index: u32,
    pub name: String,
    pub driver_version: String,
    pub memory_used_mb: f64,
    pub memory_total_mb: f64,
    pub power_draw_w: Option<f64>,
    pub power_limit_w: Option<f64>,
    pub temperature_c: Option<f64>,
    pub utilization_pct: Option<f64>,
    pub perf_state: String,
}

#[derive(Serialize, Default)]
pub struct NvidiaInfo {
    pub driver_version: String,
    pub cuda_version: String,
    pub gpus: Vec<NvidiaGpu>,
    pub raw: String,
}

const SEP: &str = "---NVSMI---";
const QUERY_FIELDS: &str = "index,name,driver_version,memory.used,memory.total,power.draw,power.limit,temperature.gpu,utilization.gpu,pstate";

#[tauri::command]
pub async fn pod_nvidia_smi(
    app: tauri::AppHandle,
    api_key: String,
    pod_id: String,
) -> Result<NvidiaInfo, String> {
    let (host, port) = resolve_pod_ssh_endpoint(&api_key, &pod_id).await?;
    let keys = collect_keys(&app);
    let cmd = format!(
        "nvidia-smi --version && echo '{SEP}' && nvidia-smi --query-gpu={QUERY_FIELDS} --format=csv,noheader,nounits"
    );
    let out = exec_remote(&host, port, "root", &keys, &cmd).await?;
    Ok(parse(&out))
}

fn parse(out: &str) -> NvidiaInfo {
    let mut info = NvidiaInfo {
        raw: out.to_string(),
        ..Default::default()
    };
    let (version_block, gpu_block) = match out.split_once(SEP) {
        Some(parts) => parts,
        None => ("", out),
    };

    for line in version_block.lines() {
        let line = line.trim();
        if let Some(v) = strip_kv(line, "CUDA Version") {
            info.cuda_version = v;
        } else if let Some(v) = strip_kv(line, "DRIVER version") {
            info.driver_version = v;
        }
    }

    for line in gpu_block.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if cols.len() < 10 {
            continue;
        }
        let f = |s: &str| s.parse::<f64>().ok();
        let opt = |s: &str| {
            if s.eq_ignore_ascii_case("[N/A]") || s.eq_ignore_ascii_case("N/A") {
                None
            } else {
                f(s)
            }
        };
        info.gpus.push(NvidiaGpu {
            index: cols[0].parse().unwrap_or(0),
            name: cols[1].to_string(),
            driver_version: cols[2].to_string(),
            memory_used_mb: f(cols[3]).unwrap_or(0.0),
            memory_total_mb: f(cols[4]).unwrap_or(0.0),
            power_draw_w: opt(cols[5]),
            power_limit_w: opt(cols[6]),
            temperature_c: opt(cols[7]),
            utilization_pct: opt(cols[8]),
            perf_state: cols[9].to_string(),
        });
    }
    if info.driver_version.is_empty() {
        if let Some(g) = info.gpus.first() {
            info.driver_version = g.driver_version.clone();
        }
    }
    info
}

fn strip_kv(line: &str, key: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix(key) {
        let rest = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
        if !rest.is_empty() {
            return Some(rest.to_string());
        }
    }
    None
}
