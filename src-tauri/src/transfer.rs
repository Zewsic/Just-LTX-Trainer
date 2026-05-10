use serde::Deserialize;
use tokio::process::Command;

#[derive(Debug, Deserialize)]
pub struct TransferCmd {
    pub tool: String,
    pub mode: String,
    pub path: String,
    pub code: Option<String>,
}

#[tauri::command]
pub async fn transfer_run(cmd: TransferCmd) -> Result<String, String> {
    let (program, args) = match (cmd.tool.as_str(), cmd.mode.as_str()) {
        ("runpodctl", "send") => ("runpodctl", vec!["send".into(), cmd.path]),
        ("runpodctl", "receive") => (
            "runpodctl",
            vec!["receive".into(), cmd.code.unwrap_or_default()],
        ),
        ("croc", "send") => ("croc", vec!["send".into(), cmd.path]),
        ("croc", "receive") => (
            "croc",
            vec!["--yes".into(), cmd.code.unwrap_or_default()],
        ),
        _ => return Err(format!("unsupported: {} {}", cmd.tool, cmd.mode)),
    };

    let output = Command::new(program)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("failed to spawn {}: {}", program, e))?;

    let mut s = String::new();
    s.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        s.push_str("\n--- stderr ---\n");
        s.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Ok(s)
}
