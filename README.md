# Agent Black Box

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agent Black Box is a local-first CLI for recording and explaining observable repository changes during AI-assisted coding sessions.

It helps developers review what changed while using tools such as Codex, Claude Code, Cursor, Cline, and similar coding agents. It does not integrate with those tools directly, inspect hidden reasoning, or send repository data anywhere. It records evidence from the repository: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values, and rollback hints.

## Languages

These links stay inside this README.

[English](#english) · [Türkçe](#turkce) · [Español](#espanol) · [Deutsch](#deutsch) · [Français](#francais) · [Português](#portugues) · [中文](#zhongwen) · [हिन्दी](#hindi) · [العربية](#arabic) · [Русский](#russkiy) · [日本語](#nihongo) · [Bahasa Indonesia](#bahasa-indonesia)

## Why Use It

AI coding agents can move quickly. Agent Black Box gives you a calm audit trail before you commit:

- See which files changed during a session.
- Review risky areas such as env files, CI/CD, dependencies, auth, security, migrations, and config.
- Detect possible secret-like values with redacted reporting.
- Record commands you explicitly run through `abb run`.
- Generate Markdown and JSON reports that are safe to keep beside Git workflows.
- Get rollback suggestions without automatically discarding work.

## Quick Start

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Start a recording session:

```sh
pnpm dev -- start
```

In another terminal, run commands through Agent Black Box when you want command metadata recorded:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Stop and generate reports:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Reports are written to:

```text
.agent-black-box/sessions/<session-id>/
```

## CLI Commands

| Command | Purpose |
| --- | --- |
| `abb init` | Create `.agentblackbox.json`. |
| `abb config validate` | Validate config schema, version, and normalized values. |
| `abb config migrate` | Rewrite config using the current schema version. |
| `abb start` | Start a foreground recording session in the current Git repository. |
| `abb doctor` | Check local prerequisites, repository state, config, and session health. |
| `abb run -- <command>` | Run a command and record redacted command metadata for the active session. Supports `--group` and `--phase`. |
| `abb stop` | Stop the active session and generate reports. |
| `abb status` | Show whether a session is active, stale, or absent. |
| `abb report` | Print the latest `session.json`. |
| `abb summary` | Print the latest human-readable session summary. |
| `abb commands` | Print commands recorded in the latest session. |
| `abb timeline` | Print the latest chronological timeline. |
| `abb risks` | Print risky changes and possible secret findings, with optional filters. |
| `abb export` | Export the latest session as bundled Markdown or structured JSON. |
| `abb rollback` | Print safe manual rollback suggestions. |

Detailed usage: [docs/USAGE.md](docs/USAGE.md)

## What Gets Generated

Each session produces:

- `session.json`: structured metadata, events, commands, Git snapshot, risks, and possible secrets.
- `summary.md`: concise review-first session summary.
- `commands.md`: command metadata recorded through `abb run`.
- `timeline.md`: chronological file and command timeline.
- `diff-summary.md`: Git status, changed files, line counts where available, and notable categories.
- `risks.md`: risky files, possible secrets, dependency/config changes, CI/CD changes, and review checklist.
- `rollback.md`: manual review and rollback suggestions.

`session.json` also includes deterministic risk summary, file kind and size metadata where available, line-stat source details, and integrity metadata for malformed session records skipped during recovery.

Report details: [docs/REPORTS.md](docs/REPORTS.md)

## Privacy And Safety Model

Agent Black Box is designed for private repositories:

- Local-first by default.
- No telemetry.
- No external AI API.
- No repository upload.
- No terminal output capture.
- Possible secret values are redacted in reports.
- Rollback is advisory only and never automatic.

Command capture is opt-in. Only commands run through `abb run -- <command>` are recorded, and sensitive-looking arguments are redacted before they are written.

## What It Cannot Observe

Agent Black Box reports observable evidence only. It cannot see:

- An AI agent's hidden reasoning.
- Prompts or private model state.
- Editor state.
- Browser state.
- Shell history for commands not run through `abb run`.
- Why a change happened.

Reports intentionally use cautious language such as "possible", "likely", and "detected from repository changes".

## Project Quality

- TypeScript strict mode.
- Vitest test coverage for core behavior.
- GitHub Actions CI for typecheck, build, and tests.
- CodeQL analysis.
- Dependabot for patch/minor maintenance.
- Tag-driven release workflow.
- Versioned JSON Schema for `.agentblackbox.json`.
- MIT license.
- Security reporting guide.
- Contribution guide.

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Development

```sh
pnpm install
pnpm check
```

Run the CLI locally:

```sh
pnpm dev -- --help
```

After building:

```sh
node dist/cli.js --help
```

## Localized Quick Guides

<a id="english"></a>
### English

Agent Black Box is a local-first CLI that records observable repository changes during AI-assisted coding sessions.

- Install from source: `pnpm install && pnpm build`
- Initialize config: `pnpm dev -- init`
- Start recording: `pnpm dev -- start`
- Record command metadata: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Stop and review: `pnpm dev -- stop && pnpm dev -- summary`
- Privacy model: no telemetry, no repository upload, no terminal output capture, and possible secrets are redacted.

<a id="turkce"></a>
### Türkçe

Agent Black Box, yapay zeka destekli kodlama oturumlarında depoda gözlemlenebilir değişiklikleri yerel olarak kaydeden bir CLI aracıdır.

- Kaynaktan kurulum: `pnpm install && pnpm build`
- Config oluşturma: `pnpm dev -- init`
- Kaydı başlatma: `pnpm dev -- start`
- Komut metadata kaydı: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Durdurma ve inceleme: `pnpm dev -- stop && pnpm dev -- summary`
- Gizlilik modeli: telemetri yok, repo yükleme yok, terminal çıktısı yakalama yok, olası sırlar redakte edilir.

<a id="espanol"></a>
### Español

Agent Black Box es una CLI local-first que registra cambios observables del repositorio durante sesiones de programación asistidas por IA.

- Instalar desde el código fuente: `pnpm install && pnpm build`
- Crear configuración: `pnpm dev -- init`
- Iniciar grabación: `pnpm dev -- start`
- Registrar metadatos de comandos: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Detener y revisar: `pnpm dev -- stop && pnpm dev -- summary`
- Modelo de privacidad: sin telemetría, sin subida del repositorio, sin captura de salida de terminal y posibles secretos redactados.

<a id="deutsch"></a>
### Deutsch

Agent Black Box ist ein lokales CLI-Tool, das beobachtbare Repository-Änderungen während KI-gestützter Coding-Sitzungen aufzeichnet.

- Aus dem Quellcode installieren: `pnpm install && pnpm build`
- Konfiguration erstellen: `pnpm dev -- init`
- Aufzeichnung starten: `pnpm dev -- start`
- Befehlsmetadaten erfassen: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Stoppen und prüfen: `pnpm dev -- stop && pnpm dev -- summary`
- Datenschutzmodell: keine Telemetrie, kein Repository-Upload, keine Terminalausgabe-Erfassung und mögliche Secrets werden redigiert.

<a id="francais"></a>
### Français

Agent Black Box est une CLI locale qui enregistre les changements observables du dépôt pendant les sessions de développement assistées par IA.

- Installer depuis les sources : `pnpm install && pnpm build`
- Créer la configuration : `pnpm dev -- init`
- Démarrer l'enregistrement : `pnpm dev -- start`
- Enregistrer les métadonnées de commande : `pnpm dev -- run --group validation --phase test -- pnpm test`
- Arrêter et examiner : `pnpm dev -- stop && pnpm dev -- summary`
- Modèle de confidentialité : pas de télémétrie, pas d'envoi du dépôt, pas de capture de sortie terminal et les secrets possibles sont masqués.

<a id="portugues"></a>
### Português

Agent Black Box é uma CLI local-first que registra mudanças observáveis do repositório durante sessões de programação assistidas por IA.

- Instalar a partir do código-fonte: `pnpm install && pnpm build`
- Criar configuração: `pnpm dev -- init`
- Iniciar gravação: `pnpm dev -- start`
- Registrar metadados de comandos: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Parar e revisar: `pnpm dev -- stop && pnpm dev -- summary`
- Modelo de privacidade: sem telemetria, sem upload do repositório, sem captura da saída do terminal e possíveis segredos são mascarados.

<a id="zhongwen"></a>
### 中文

Agent Black Box 是一个本地优先的 CLI，用于在 AI 辅助编码会话中记录仓库层面可观察到的变更。

- 从源码安装：`pnpm install && pnpm build`
- 创建配置：`pnpm dev -- init`
- 开始记录：`pnpm dev -- start`
- 记录命令元数据：`pnpm dev -- run --group validation --phase test -- pnpm test`
- 停止并查看报告：`pnpm dev -- stop && pnpm dev -- summary`
- 隐私模型：无遥测、不会上传仓库、不捕获终端输出，并会隐藏可能的密钥值。

<a id="hindi"></a>
### हिन्दी

Agent Black Box एक local-first CLI है जो AI-assisted coding sessions के दौरान repository में दिखने वाले बदलावों को रिकॉर्ड करता है।

- source से install करें: `pnpm install && pnpm build`
- config बनाएं: `pnpm dev -- init`
- recording शुरू करें: `pnpm dev -- start`
- command metadata रिकॉर्ड करें: `pnpm dev -- run --group validation --phase test -- pnpm test`
- रोकें और review करें: `pnpm dev -- stop && pnpm dev -- summary`
- privacy model: telemetry नहीं, repository upload नहीं, terminal output capture नहीं, और possible secrets redact किए जाते हैं।

<a id="arabic"></a>
### العربية

Agent Black Box هو CLI يعمل محليا أولا لتسجيل تغييرات المستودع القابلة للملاحظة أثناء جلسات البرمجة بمساعدة الذكاء الاصطناعي.

- التثبيت من المصدر: `pnpm install && pnpm build`
- إنشاء الإعدادات: `pnpm dev -- init`
- بدء التسجيل: `pnpm dev -- start`
- تسجيل بيانات الأوامر: `pnpm dev -- run --group validation --phase test -- pnpm test`
- الإيقاف والمراجعة: `pnpm dev -- stop && pnpm dev -- summary`
- نموذج الخصوصية: لا توجد قياسات عن بعد، لا رفع للمستودع، لا التقاط لمخرجات الطرفية، ويتم إخفاء القيم السرية المحتملة.

<a id="russkiy"></a>
### Русский

Agent Black Box — локальный CLI-инструмент, который записывает наблюдаемые изменения репозитория во время сессий разработки с ИИ.

- Установить из исходников: `pnpm install && pnpm build`
- Создать конфигурацию: `pnpm dev -- init`
- Начать запись: `pnpm dev -- start`
- Записать метаданные команды: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Остановить и проверить: `pnpm dev -- stop && pnpm dev -- summary`
- Модель приватности: нет телеметрии, нет загрузки репозитория, нет захвата вывода терминала, возможные секреты скрываются.

<a id="nihongo"></a>
### 日本語

Agent Black Box は、AI 支援コーディング中にリポジトリで観測できる変更を記録するローカルファーストの CLI です。

- ソースからインストール: `pnpm install && pnpm build`
- 設定を作成: `pnpm dev -- init`
- 記録を開始: `pnpm dev -- start`
- コマンドメタデータを記録: `pnpm dev -- run --group validation --phase test -- pnpm test`
- 停止して確認: `pnpm dev -- stop && pnpm dev -- summary`
- プライバシーモデル: テレメトリなし、リポジトリ送信なし、端末出力の取得なし、可能性のある secret はマスクされます。

<a id="bahasa-indonesia"></a>
### Bahasa Indonesia

Agent Black Box adalah CLI local-first untuk merekam perubahan repositori yang dapat diamati selama sesi coding berbantuan AI.

- Instal dari source: `pnpm install && pnpm build`
- Buat konfigurasi: `pnpm dev -- init`
- Mulai perekaman: `pnpm dev -- start`
- Rekam metadata command: `pnpm dev -- run --group validation --phase test -- pnpm test`
- Hentikan dan tinjau: `pnpm dev -- stop && pnpm dev -- summary`
- Model privasi: tanpa telemetry, tanpa upload repositori, tanpa menangkap output terminal, dan kemungkinan secret akan disamarkan.

## Roadmap

Near-term improvements:

- Optional TUI-style report browser.
- npm publish preparation.
- Repository fixture suite for more language ecosystems.

Out of scope for the MVP:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Private agent API integrations.
- Automatic destructive rollback.
- Paid AI features.

## Maintainer

𝓐.𝓒.𝓑

## License

MIT. See [LICENSE](LICENSE).
