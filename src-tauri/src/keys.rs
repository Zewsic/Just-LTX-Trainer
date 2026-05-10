use serde::Serialize;
use serde_json::json;
use std::time::Duration;

#[derive(Serialize)]
pub struct BalanceInfo {
    pub ok: bool,
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub info: Option<String>,
    pub error: Option<String>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

#[tauri::command]
pub async fn runpod_balance(api_key: String) -> BalanceInfo {
    if api_key.trim().is_empty() {
        return BalanceInfo {
            ok: false,
            balance: None,
            currency: None,
            info: None,
            error: Some("empty key".into()),
        };
    }
    let url = format!("https://api.runpod.io/graphql?api_key={}", api_key);
    let body = json!({ "query": "query { myself { id clientBalance } }" });
    match client().post(&url).json(&body).send().await {
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
            if let Some(bal) = v
                .pointer("/data/myself/clientBalance")
                .and_then(|x| x.as_f64())
            {
                return BalanceInfo {
                    ok: true,
                    balance: Some(bal),
                    currency: Some("USD".into()),
                    info: None,
                    error: None,
                };
            }
            let err = v
                .pointer("/errors/0/message")
                .and_then(|x| x.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("HTTP {}", status));
            BalanceInfo {
                ok: false,
                balance: None,
                currency: None,
                info: None,
                error: Some(err),
            }
        }
        Err(e) => BalanceInfo {
            ok: false,
            balance: None,
            currency: None,
            info: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn gemini_check(api_key: String) -> BalanceInfo {
    if api_key.trim().is_empty() {
        return BalanceInfo {
            ok: false,
            balance: None,
            currency: None,
            info: None,
            error: Some("empty key".into()),
        };
    }
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}",
        api_key
    );
    match client().get(&url).send().await {
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            if status.is_success() {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
                let count = v
                    .get("models")
                    .and_then(|m| m.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                BalanceInfo {
                    ok: true,
                    balance: None,
                    currency: None,
                    info: Some(format!("{} models available", count)),
                    error: None,
                }
            } else {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
                let err = v
                    .pointer("/error/message")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("HTTP {}", status));
                BalanceInfo {
                    ok: false,
                    balance: None,
                    currency: None,
                    info: None,
                    error: Some(err),
                }
            }
        }
        Err(e) => BalanceInfo {
            ok: false,
            balance: None,
            currency: None,
            info: None,
            error: Some(e.to_string()),
        },
    }
}
