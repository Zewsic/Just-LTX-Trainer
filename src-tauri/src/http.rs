use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct ApiRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn http_request(req: ApiRequest) -> Result<ApiResponse, String> {
    inner(req).await.map_err(|e| e.to_string())
}

async fn inner(req: ApiRequest) -> anyhow::Result<ApiResponse> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in req.headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let resp = rb.send().await?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await?;
    Ok(ApiResponse { status, headers, body })
}
