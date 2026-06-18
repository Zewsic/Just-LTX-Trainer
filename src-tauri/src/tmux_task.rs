//! Общий паттерн для длинных задач, исполняемых внутри tmux на поде.
//!
//! Жизненный цикл:
//! 1. `start(script)` — записывает `<state_dir>/run.sh`, кикает в detached
//!    tmux-сессию, пишет вывод в `<state_dir>/log` через pipe-pane, по
//!    завершении exit-code попадает в `<state_dir>/exit`.
//! 2. `state()` — читает наличие `exit`/живой сессии и текущий размер лога.
//! 3. `tail(since)` — отдаёт хвост лога с указанной позиции + общий размер.
//! 4. `reset()` — убивает сессию и удаляет exit/log.
//!
//! Имена tmux-сессий и каталогов санируются через [`crate::shell::safe_name`].

use crate::shell;
use crate::ssh::exec_remote;
use serde::Serialize;
use std::path::PathBuf;

pub struct TmuxTask {
    /// `ltx_<id>` — внутри уже sanitized.
    pub session: String,
    /// `/workspace/.ltx-*/<safe>` — внутри уже sanitized.
    pub state_dir: String,
}

impl TmuxTask {
    pub fn new(session: impl Into<String>, state_dir: impl Into<String>) -> Self {
        Self {
            session: session.into(),
            state_dir: state_dir.into(),
        }
    }

    /// Записать скрипт в `<dir>/run.sh` и запустить в tmux.
    /// Если tmux не установлен — поставит через apt-get.
    pub async fn start(
        &self,
        host: &str,
        port: u16,
        keys: &[PathBuf],
        script: &str,
    ) -> Result<(), String> {
        let outer = format!(
            r#"set -eu
mkdir -p {dir}
if ! command -v tmux >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq tmux
fi
cat > {dir}/run.sh <<'LTX_TMUX_TASK_EOF'
{script}
LTX_TMUX_TASK_EOF
chmod +x {dir}/run.sh
rm -f {dir}/exit
: > {dir}/log
tmux kill-session -t {session} 2>/dev/null || true
# -x/-y задают размеры pty внутри tmux. rich/tqdm читают ширину терминала
# через ioctl, env $COLUMNS не помогает — задаём напрямую тут.
tmux new-session -d -s {session} -x 250 -y 50 "bash {dir}/run.sh; echo \$? > {dir}/exit"
tmux pipe-pane -t {session} -o "cat >> {dir}/log"
echo 'started {session}'
"#,
            dir = self.state_dir,
            session = self.session,
            script = script,
        );
        exec_remote(host, port, "root", keys, &outer).await?;
        Ok(())
    }

    /// Читает состояние шага: pending/running/done/failed + log_size.
    pub async fn state(
        &self,
        host: &str,
        port: u16,
        keys: &[PathBuf],
    ) -> Result<TaskState, String> {
        let script = format!(
            r#"set +e
mkdir -p {dir}
log_sz=0
[ -f {dir}/log ] && log_sz=$(wc -c < {dir}/log | tr -d ' ')
if [ -f {dir}/exit ]; then
  ec=$(cat {dir}/exit | tr -d '[:space:]')
  echo "done|$ec|$log_sz"
elif tmux has-session -t {session} 2>/dev/null; then
  echo "running|0|$log_sz"
else
  echo "pending|0|$log_sz"
fi
"#,
            dir = self.state_dir,
            session = self.session,
        );
        let out = exec_remote(host, port, "root", keys, &script).await?;
        let line = out.lines().last().unwrap_or("").trim();
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 3 {
            return Ok(TaskState::default());
        }
        let raw_state = parts[0];
        let ec: Option<i32> = if raw_state == "done" {
            parts[1].parse().ok()
        } else {
            None
        };
        let log_size = parts[2].parse().unwrap_or(0);
        let state = if raw_state == "done" {
            if ec.unwrap_or(0) == 0 {
                "done"
            } else {
                "failed"
            }
        } else {
            raw_state
        };
        Ok(TaskState {
            state: state.to_string(),
            exit_code: ec,
            log_size,
        })
    }

    /// Отдаёт лог с позиции `since`. Первая строка ответа — общий размер.
    pub async fn tail(
        &self,
        host: &str,
        port: u16,
        keys: &[PathBuf],
        since: u64,
    ) -> Result<TailChunk, String> {
        let script = format!(
            r#"set +e
f={dir}/log
if [ ! -f "$f" ]; then
  echo 0
  exit 0
fi
sz=$(wc -c < "$f" | tr -d ' ')
echo "$sz"
if [ "$sz" -gt "{since}" ]; then
  tail -c +$(({since}+1)) "$f"
fi
"#,
            dir = self.state_dir,
            since = since,
        );
        let out = exec_remote(host, port, "root", keys, &script).await?;
        let (first, rest) = match out.split_once('\n') {
            Some((a, b)) => (a, b),
            None => (out.as_str(), ""),
        };
        Ok(TailChunk {
            total: first.trim().parse::<u64>().unwrap_or(0),
            content: rest.to_string(),
        })
    }

    /// Убивает сессию + удаляет exit/log файлы.
    pub async fn reset(
        &self,
        host: &str,
        port: u16,
        keys: &[PathBuf],
    ) -> Result<(), String> {
        let script = format!(
            r#"set +e
tmux kill-session -t {session} 2>/dev/null
rm -f {dir}/exit {dir}/log
echo done
"#,
            dir = self.state_dir,
            session = self.session,
        );
        exec_remote(host, port, "root", keys, &script).await?;
        Ok(())
    }
}

/// Helper: построить TmuxTask с фиксированной базой и id.
pub fn task_at(state_base: &str, session_prefix: &str, id: &str) -> TmuxTask {
    let safe = shell::safe_name(id);
    TmuxTask::new(
        format!("{}{}", session_prefix, safe),
        format!("{}/{}", state_base.trim_end_matches('/'), safe),
    )
}

#[derive(Serialize, Default)]
pub struct TaskState {
    pub state: String, // pending | running | done | failed
    pub exit_code: Option<i32>,
    pub log_size: u64,
}

#[derive(Serialize)]
pub struct TailChunk {
    pub total: u64,
    pub content: String,
}
