use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://api.runpod.io/graphql";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client")
}

pub(crate) async fn graphql(api_key: &str, body: Value) -> Result<Value, String> {
    let url = format!("{ENDPOINT}?api_key={api_key}");
    let resp = client()
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("bad JSON ({status}): {e} — {text}"))?;
    if let Some(err) = v.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(v)
}

#[derive(Serialize)]
pub struct Pod {
    pub id: String,
    pub name: String,
    pub desired_status: String,
    pub cost_per_hr: Option<f64>,
    pub gpu_count: Option<i64>,
    pub gpu_display_name: Option<String>,
    pub image_name: Option<String>,
}

#[tauri::command]
pub async fn list_pods(api_key: String) -> Result<Vec<Pod>, String> {
    let q = json!({
        "query": "query { myself { pods { id name desiredStatus costPerHr gpuCount imageName machine { gpuDisplayName } } } }"
    });
    let v = graphql(&api_key, q).await?;
    let arr = v
        .pointer("/data/myself/pods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .into_iter()
        .map(|p| Pod {
            id: p.get("id").and_then(Value::as_str).unwrap_or("").into(),
            name: p.get("name").and_then(Value::as_str).unwrap_or("").into(),
            desired_status: p
                .get("desiredStatus")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            cost_per_hr: p.get("costPerHr").and_then(Value::as_f64),
            gpu_count: p.get("gpuCount").and_then(Value::as_i64),
            gpu_display_name: p
                .pointer("/machine/gpuDisplayName")
                .and_then(Value::as_str)
                .map(String::from),
            image_name: p.get("imageName").and_then(Value::as_str).map(String::from),
        })
        .collect())
}

#[derive(Deserialize)]
pub struct PodActionArgs {
    pub api_key: String,
    pub pod_id: String,
    pub action: String,
}

#[tauri::command]
pub async fn pod_action(args: PodActionArgs) -> Result<(), String> {
    match args.action.as_str() {
        "start" => {
            let q = json!({
                "query": "mutation($id: String!) { podResume(input: { podId: $id, gpuCount: 1 }) { id desiredStatus } }",
                "variables": { "id": args.pod_id }
            });
            graphql(&args.api_key, q).await?;
        }
        "stop" => {
            let q = json!({
                "query": "mutation($id: String!) { podStop(input: { podId: $id }) { id desiredStatus } }",
                "variables": { "id": args.pod_id }
            });
            graphql(&args.api_key, q).await?;
        }
        "restart" => {
            let q1 = json!({
                "query": "mutation($id: String!) { podStop(input: { podId: $id }) { id desiredStatus } }",
                "variables": { "id": args.pod_id }
            });
            graphql(&args.api_key, q1).await?;
            let q2 = json!({
                "query": "mutation($id: String!) { podResume(input: { podId: $id, gpuCount: 1 }) { id desiredStatus } }",
                "variables": { "id": args.pod_id }
            });
            graphql(&args.api_key, q2).await?;
        }
        "remove" => {
            let q = json!({
                "query": "mutation($id: String!) { podTerminate(input: { podId: $id }) }",
                "variables": { "id": args.pod_id }
            });
            graphql(&args.api_key, q).await?;
        }
        other => return Err(format!("unknown action: {other}")),
    }
    Ok(())
}

#[derive(Serialize)]
pub struct GpuType {
    pub id: String,
    pub display_name: String,
    pub memory_in_gb: Option<i64>,
    /// Secure cloud on-demand цена.
    pub price_per_hr: Option<f64>,
    /// Community cloud on-demand цена (дешевле, без SLA).
    pub community_price_per_hr: Option<f64>,
    pub stock_status: Option<String>,
    pub community_stock_status: Option<String>,
    pub available: bool,
    pub community_available: bool,
    pub secure_cloud: bool,
    pub community_cloud: bool,
    /// "recommended" | "not_recommended" | null
    pub tag: Option<String>,
}

const ALLOWED_SUBSTR: &[&str] = &["H100", "H200", "B200", "B300"];

fn has_pro_6000(upper: &str) -> bool {
    // "RTX PRO 6000", "RTX 6000 Pro Blackwell" и т.п. — Blackwell-десктоп с 96GB.
    let toks: Vec<&str> = upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let has_pro = toks.iter().any(|t| *t == "PRO");
    let has_6000 = toks.iter().any(|t| *t == "6000");
    has_pro && has_6000
}

fn is_allowed(upper: &str) -> bool {
    if ALLOWED_SUBSTR.iter().any(|p| upper.contains(p)) {
        return true;
    }
    if has_pro_6000(upper) {
        return true;
    }
    // L4 как отдельное слово, чтобы не зацепить L40 / L40S
    upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|t| t == "L4")
}

fn classify(upper: &str) -> Option<String> {
    if upper.contains("H200") && upper.contains("SXM") {
        return Some("recommended".into());
    }
    if has_pro_6000(upper) {
        return Some("recommended".into());
    }
    if upper.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| t == "L4") {
        return Some("not_recommended".into());
    }
    None
}

#[derive(Deserialize)]
pub struct DeployArgs {
    pub api_key: String,
    pub gpu_type_id: String,
    pub name: String,
    /// "SECURE" | "COMMUNITY". Если не задано — SECURE.
    #[serde(default)]
    pub cloud_type: Option<String>,
}

async fn fetch_account_pubkey(api_key: &str) -> String {
    let q = json!({ "query": "query { myself { pubKey } }" });
    match graphql(api_key, q).await {
        Ok(v) => v
            .pointer("/data/myself/pubKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        Err(_) => String::new(),
    }
}

#[derive(Serialize)]
pub struct DeployResult {
    pub id: String,
    pub name: String,
    pub desired_status: String,
    pub image_name: Option<String>,
}

#[tauri::command]
pub async fn deploy_pod(
    app: tauri::AppHandle,
    args: DeployArgs,
) -> Result<DeployResult, String> {
    // Гарантируем наличие нашего ключа в аккаунте RunPod, чтобы start.sh поднял sshd.
    if let Err(e) = crate::ssh_key::setup_runpod_ssh_key(app.clone(), args.api_key.clone()).await {
        eprintln!("ssh key setup before deploy failed: {e}");
    }
    let pubkey_env = fetch_account_pubkey(&args.api_key).await;

    let cloud_type = match args.cloud_type.as_deref() {
        Some("COMMUNITY") | Some("community") => "COMMUNITY",
        _ => "SECURE",
    };
    let input = json!({
        "cloudType": cloud_type,
        "gpuCount": 1,
        "volumeInGb": 350,
        "containerDiskInGb": 30,
        "minVcpuCount": 1,
        "minMemoryInGb": 1,
        "gpuTypeId": args.gpu_type_id,
        "name": args.name,
        "imageName": "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
        "ports": "8888/http,22/tcp",
        "volumeMountPath": "/workspace",
        "env": [
            { "key": "PUBLIC_KEY", "value": pubkey_env },
            { "key": "JUPYTER_PASSWORD", "value": "" }
        ],
    });
    let q = json!({
        "query": "mutation Deploy($input: PodFindAndDeployOnDemandInput!) { podFindAndDeployOnDemand(input: $input) { id name desiredStatus imageName } }",
        "variables": { "input": input }
    });
    let v = graphql(&args.api_key, q).await?;
    let p = v
        .pointer("/data/podFindAndDeployOnDemand")
        .ok_or_else(|| "no pod returned".to_string())?;
    if p.is_null() {
        return Err("RunPod returned null — likely no capacity for the selected GPU".into());
    }
    Ok(DeployResult {
        id: p.get("id").and_then(Value::as_str).unwrap_or("").into(),
        name: p.get("name").and_then(Value::as_str).unwrap_or("").into(),
        desired_status: p
            .get("desiredStatus")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        image_name: p.get("imageName").and_then(Value::as_str).map(String::from),
    })
}

#[tauri::command]
pub async fn list_gpu_types(api_key: String) -> Result<Vec<GpuType>, String> {
    // Запрашиваем обе on-demand цены (secure + community) одной выборкой —
    // используем GraphQL-алиасы, чтобы RunPod вернул два разных lowestPrice.
    let q = json!({
        "query": "query { gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice secure: lowestPrice(input:{gpuCount:1, secureCloud:true}) { uninterruptablePrice stockStatus } community: lowestPrice(input:{gpuCount:1, secureCloud:false}) { uninterruptablePrice stockStatus } } }"
    });
    let v = graphql(&api_key, q).await?;
    let arr = v
        .pointer("/data/gpuTypes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out: Vec<GpuType> = arr
        .into_iter()
        .filter_map(|g| {
            let display = g.get("displayName").and_then(Value::as_str)?.to_string();
            let upper = display.to_uppercase();
            if !is_allowed(&upper) {
                return None;
            }
            let tag = classify(&upper);
            let secure_stock = g
                .pointer("/secure/stockStatus")
                .and_then(Value::as_str)
                .map(String::from);
            let community_stock = g
                .pointer("/community/stockStatus")
                .and_then(Value::as_str)
                .map(String::from);
            // Предпочтительно: lowestPrice → прямое поле как фолбэк.
            let secure_price = g
                .pointer("/secure/uninterruptablePrice")
                .and_then(Value::as_f64)
                .or_else(|| g.get("securePrice").and_then(Value::as_f64));
            let community_price = g
                .pointer("/community/uninterruptablePrice")
                .and_then(Value::as_f64)
                .or_else(|| g.get("communityPrice").and_then(Value::as_f64));
            let secure_available = matches!(
                secure_stock.as_deref(),
                Some("High") | Some("Medium") | Some("Low")
            ) && secure_price.is_some();
            let community_available = matches!(
                community_stock.as_deref(),
                Some("High") | Some("Medium") | Some("Low")
            ) && community_price.is_some();
            // GPU попадает в список, если доступен хотя бы в одном из облаков.
            if !secure_available && !community_available {
                return None;
            }
            Some(GpuType {
                id: g.get("id").and_then(Value::as_str).unwrap_or("").into(),
                display_name: display,
                memory_in_gb: g.get("memoryInGb").and_then(Value::as_i64),
                price_per_hr: secure_price,
                community_price_per_hr: community_price,
                stock_status: secure_stock,
                community_stock_status: community_stock,
                available: secure_available,
                community_available,
                secure_cloud: g
                    .get("secureCloud")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                community_cloud: g
                    .get("communityCloud")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                tag,
            })
        })
        .collect();

    out.sort_by(|a, b| {
        b.price_per_hr
            .unwrap_or(0.0)
            .partial_cmp(&a.price_per_hr.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}
