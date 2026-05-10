#[tauri::command]
pub async fn notify(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape(&body),
            escape(&title),
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .status()
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
