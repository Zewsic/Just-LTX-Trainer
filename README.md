# Just LTX Trainer

Десктопное приложение (macOS / Windows) для управления удалённым обучением:
- запуск команд по SSH (`russh`, чистый Rust);
- HTTP-запросы к API;
- локальное хранилище настроек (`tauri-plugin-store`);
- нативные уведомления (`tauri-plugin-notification`);
- передача файлов через `runpodctl` / `croc`.

Стек: **Tauri 2 + React + TypeScript + Vite + Tailwind**, i18n: **en / ru**.

## Требования
- Node 18+, pnpm
- Rust (stable) + `cargo`
- macOS: Xcode CLT. Windows: WebView2 + MSVC build tools.

## Запуск
```bash
pnpm install
pnpm tauri dev
```

## Сборка
```bash
pnpm tauri build
```

## Структура
- `src/` — фронтенд (React)
- `src/i18n/` — переводы en / ru
- `src-tauri/src/ssh.rs` — SSH-клиент (russh)
- `src-tauri/src/http.rs` — HTTP-клиент (reqwest)
- `src-tauri/src/transfer.rs` — обёртка над `runpodctl` / `croc`
