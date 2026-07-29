//! Настройка Telegram-бота для уведомлений: проверка токена (`getMe`) и
//! привязка чата — пользователь пишет боту `/start`, мы это ловим
//! long-poll'ом `getUpdates` и сохраняем `chat_id`.
//!
//! Сама отправка событийных уведомлений (старт/финиш/ошибка обучения,
//! готовность сервера) идёт не отсюда — это `curl` внутри bash-скриптов,
//! которые выполняются на поде (см. `training.rs`/`init.rs`), чтобы
//! уведомления приходили, даже если приложение закрыто.

use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;

/// Клиент для быстрых запросов (getMe, sendMessage).
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

/// Клиент для long-poll `getUpdates` — таймаут больше, чем `timeout=30` в
/// самом запросе, чтобы успеть получить ответ от Telegram.
fn poll_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .expect("reqwest client")
}

#[derive(Serialize)]
pub struct TelegramBotInfo {
    pub username: Option<String>,
    pub first_name: Option<String>,
}

#[tauri::command]
pub async fn telegram_validate_bot_token(token: String) -> Result<TelegramBotInfo, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Токен не может быть пустым".into());
    }
    let url = format!("https://api.telegram.org/bot{}/getMe", token);
    let r = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if status.is_success() && v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        let result = v.get("result").cloned().unwrap_or(json!({}));
        Ok(TelegramBotInfo {
            username: result
                .get("username")
                .and_then(|s| s.as_str())
                .map(String::from),
            first_name: result
                .get("first_name")
                .and_then(|s| s.as_str())
                .map(String::from),
        })
    } else {
        let err = v
            .get("description")
            .and_then(|s| s.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("HTTP {}", status));
        Err(err)
    }
}

#[derive(Serialize)]
pub struct TelegramChat {
    pub chat_id: i64,
    pub label: String,
}

/// Счётчик поколений: каждый вызов `telegram_start_chat_listen` бампает его.
/// Если во время ожидания стартует более новый вызов (юзер нажал
/// "переназначить" ещё раз) — старый молча завершается, не трогая store.
#[derive(Default)]
pub struct ChatListenGen(pub Mutex<u64>);

fn is_start_command(text: &str) -> bool {
    text.trim_start()
        .split_whitespace()
        .next()
        .map(|w| w == "/start" || w.starts_with("/start@"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn telegram_start_chat_listen(
    state: tauri::State<'_, ChatListenGen>,
    token: String,
) -> Result<TelegramChat, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Токен не может быть пустым".into());
    }

    let my_gen = {
        let mut g = state.0.lock().map_err(|_| "lock poisoned")?;
        *g += 1;
        *g
    };

    let poll = poll_client();

    // Отправную точку берём с последнего уже существующего апдейта, чтобы не
    // подхватить старый /start, присланный до нажатия кнопки.
    let mut offset: i64 = 0;
    {
        let url = format!(
            "https://api.telegram.org/bot{}/getUpdates?offset=-1&limit=1",
            token
        );
        if let Ok(r) = poll.get(&url).send().await {
            if let Ok(v) = r.json::<serde_json::Value>().await {
                if let Some(last) = v.pointer("/result/0/update_id").and_then(|x| x.as_i64()) {
                    offset = last + 1;
                }
            }
        }
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("Не дождались /start за 3 минуты — попробуйте ещё раз".into());
        }
        if *state.0.lock().map_err(|_| "lock poisoned")? != my_gen {
            // Нас обогнал более новый запрос — тихо выходим.
            return Err("cancelled".into());
        }

        let url = format!(
            "https://api.telegram.org/bot{}/getUpdates?offset={}&timeout=30",
            token, offset
        );
        let r = match poll.get(&url).send().await {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        let v: serde_json::Value = match r.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let updates = v
            .get("result")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();

        for u in &updates {
            if let Some(uid) = u.get("update_id").and_then(|x| x.as_i64()) {
                offset = offset.max(uid + 1);
            }
            let text = u
                .pointer("/message/text")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if !is_start_command(text) {
                continue;
            }
            let Some(chat) = u.pointer("/message/chat") else {
                continue;
            };
            let chat_id = chat.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            let label = chat
                .get("title")
                .and_then(|x| x.as_str())
                .or_else(|| chat.get("username").and_then(|x| x.as_str()))
                .or_else(|| chat.get("first_name").and_then(|x| x.as_str()))
                .unwrap_or("chat")
                .to_string();

            if *state.0.lock().map_err(|_| "lock poisoned")? != my_gen {
                return Err("cancelled".into());
            }

            let send_url = format!("https://api.telegram.org/bot{}/sendMessage", token);
            let _ = client()
                .post(&send_url)
                .form(&[
                    ("chat_id", chat_id.to_string()),
                    ("text", "Чат успешно сохранён ✅".to_string()),
                ])
                .send()
                .await;

            return Ok(TelegramChat { chat_id, label });
        }
    }
}
