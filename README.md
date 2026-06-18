# Just LTX Trainer

[![CI](https://github.com/zewsic/just-ltx-trainer/actions/workflows/ci.yml/badge.svg)](https://github.com/zewsic/just-ltx-trainer/actions/workflows/ci.yml)
[![Release](https://github.com/zewsic/just-ltx-trainer/actions/workflows/release.yml/badge.svg)](https://github.com/zewsic/just-ltx-trainer/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Десктопное приложение для тренировки LoRA на [LTX-2](https://github.com/Lightricks/LTX-2) с удалёнными GPU-подами RunPod. Полный пайплайн от загрузки видео до запуска обучения с валидацией и просмотром результатов — без терминала.

**Стек:** Tauri 2 (Rust) + React 18 + TypeScript + Vite + Tailwind. i18n: en / ru.

## Возможности

- Управление GPU-подами RunPod: создание / запуск / остановка / удаление.
- Автоматическая инициализация LTX-2 на поде по SSH (5 шагов: пакеты, env, веса, encoder, проверка).
- Подготовка датасета: drag-n-drop видео, нарезка ffmpeg'ом по aspect/length/overlap/audio, авто-захэширование сборки.
- Загрузка датасета на под через `runpodctl` с лайв-прогрессом.
- Авто-кэптионирование клипов (Qwen Omni локально или Gemini Flash) с тестовым прогоном.
- Обучение LoRA: ранг, режим (t2v / i2v / both), trigger-word, валидационные промпты+картинки, оптимизации VRAM.
- Просмотр результатов валидации по чекпоинтам прямо в приложении (видео + reference image + промпт).
- Все долгие задачи живут в `tmux` на поде — закрыл приложение, открыл — UI подхватил то же состояние.

## Загрузка

Готовые бинарники появляются на [Releases](https://github.com/zewsic/just-ltx-trainer/releases) после публикации тега.

- **macOS**: универсальный `.dmg` (Intel + Apple Silicon). Без подписи Apple — при первом запуске:
  ```sh
  xattr -dr com.apple.quarantine "/Applications/Just LTX Trainer.app"
  ```
  или ПКМ → «Открыть».
- **Windows**: `.msi` x64. SmartScreen → «Подробнее» → «Выполнить в любом случае».

## Запуск из исходников

### Требования
- **Node.js** 20+
- **pnpm** 9+ (`npm i -g pnpm`)
- **Rust** stable + cargo
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: WebView2 runtime (обычно есть) + Microsoft C++ Build Tools

### Dev-режим
```sh
pnpm install
pnpm tauri dev
```

### Сборка
```sh
pnpm tauri build
# macOS universal:
pnpm tauri build --target universal-apple-darwin
```

## Auto-build

CI: каждый push в `main` и каждый PR прогоняет `tsc --noEmit` + `cargo check` на Linux / macOS / Windows.

Release: пуш тега `vX.Y.Z` запускает [release workflow](.github/workflows/release.yml) — `tauri-action` собирает универсальный macOS-бандл и Windows x64 MSI, прикрепляет к GitHub Release как draft.

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Структура

```
src/                          фронтенд
  components/ui.tsx             общие UI-примитивы (ProgressBar, StatusIcon, …)
  components/                   AutoCaptionBlock, BuildProgress, LtxInitProgress, …
  lib/tasks.tsx                 TasksProvider — единый источник pod/ssh/projects/training-state
  lib/projects.ts               типы и API проектов
  lib/pods.ts                   Pod / ManagedPod / SshProbe / Nvidia
  views/                        Servers / ServerDetail / Datasets / Training / Settings
  views/training/               TrainingActive + ValidationBlock
  i18n/{en,ru}.json             переводы
src-tauri/src/                Rust-backend
  shell.rs                      escape + safe_name
  tmux_task.rs                  обёртка над tmux-задачами на поде (start/state/tail/reset)
  ssh.rs                        russh-клиент
  servers.rs / keys.rs          RunPod API
  init.rs                       5 шагов настройки LTX-2 на поде
  caption.rs                    caption-задачи + тестовый прогон
  dataset_build.rs              локальная сборка ffmpeg'ом
  dataset_upload.rs             заливка через runpodctl
  training.rs                   обучение LoRA + валидация + чекпоинты
  projects.rs                   хранилище проектов на диске
```

## Лицензия

[MIT](LICENSE).
