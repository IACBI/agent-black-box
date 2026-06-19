# Agent Black Box

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<a id="english"></a>

Agent Black Box is a local-first CLI for recording and explaining observable repository changes during AI-assisted coding sessions.

It helps developers review what changed while using tools such as Codex, Claude Code, Cursor, Cline, and similar coding agents. It does not integrate with those tools directly, inspect hidden reasoning, or send repository data anywhere. It records evidence from the repository: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values, and rollback hints.

## Languages

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

## Full Documentation In Other Languages

<a id="turkce"></a>
### Türkçe

Agent Black Box, yapay zeka destekli kodlama oturumları sırasında depoda gözlemlenebilir değişiklikleri kaydeden ve açıklayan yerel öncelikli bir CLI aracıdır.

Codex, Claude Code, Cursor, Cline ve benzeri kodlama ajanlarıyla çalışırken neyin değiştiğini incelemenize yardımcı olur. Bu araçlar ile doğrudan entegre olmaz, gizli model akıl yürütmesini incelemez ve depo verisini herhangi bir yere göndermez. Depodan kanıt toplar: dosya olayları, Git durumu, diff çıktıları, isteğe bağlı komut metadata kayıtları, riskli dosya değişiklikleri, olası secret benzeri değerler ve rollback ipuçları.

#### Neden Kullanılır

AI kodlama ajanları hızlı hareket edebilir. Agent Black Box commit atmadan önce sakin ve incelenebilir bir audit trail sağlar:

- Oturum sırasında hangi dosyaların değiştiğini görün.
- Env dosyaları, CI/CD, bağımlılıklar, auth, security, migration ve config gibi riskli alanları inceleyin.
- Olası secret benzeri değerleri redakte edilmiş raporlarla tespit edin.
- Özellikle çalıştırdığınız komutları `abb run` üzerinden metadata olarak kaydedin.
- Git workflow'ları yanında saklanabilecek Markdown ve JSON raporları üretin.
- Çalışmayı otomatik silmeden rollback önerileri alın.

#### Hızlı Başlangıç

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Kayıt oturumu başlatın:

```sh
pnpm dev -- start
```

Başka bir terminalde metadata kaydetmek istediğiniz komutları Agent Black Box üzerinden çalıştırın:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Oturumu durdurup raporları oluşturun:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Raporlar şu dizine yazılır:

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI Komutları

| Komut | Amaç |
| --- | --- |
| `abb init` | `.agentblackbox.json` oluşturur. |
| `abb config validate` | Config schema, version ve normalize edilmiş değerleri doğrular. |
| `abb config migrate` | Config dosyasını mevcut schema version ile yeniden yazar. |
| `abb start` | Mevcut Git deposunda foreground kayıt oturumu başlatır. |
| `abb doctor` | Yerel gereksinimleri, repo durumunu, config'i ve session sağlığını kontrol eder. |
| `abb run -- <command>` | Komutu çalıştırır ve aktif oturum için redakte edilmiş komut metadata'sı kaydeder. `--group` ve `--phase` destekler. |
| `abb stop` | Aktif oturumu durdurur ve raporları üretir. |
| `abb status` | Oturumun active, stale veya absent olup olmadığını gösterir. |
| `abb report` | En son `session.json` çıktısını yazdırır. |
| `abb summary` | En son insan okunabilir oturum özetini yazdırır. |
| `abb commands` | En son oturumda kaydedilen komutları yazdırır. |
| `abb timeline` | En son kronolojik timeline raporunu yazdırır. |
| `abb risks` | Riskli değişiklikleri ve olası secret bulgularını, isteğe bağlı filtrelerle yazdırır. |
| `abb export` | En son oturumu birleşik Markdown veya yapılandırılmış JSON olarak dışa aktarır. |
| `abb rollback` | Güvenli manuel rollback önerilerini yazdırır. |

Ayrıntılı kullanım: [docs/USAGE.md](docs/USAGE.md)

#### Ne Üretilir

Her oturum şunları üretir:

- `session.json`: metadata, events, commands, Git snapshot, risks ve possible secrets içeren yapılandırılmış çıktı.
- `summary.md`: inceleme öncelikli kısa oturum özeti.
- `commands.md`: `abb run` ile kaydedilen komut metadata'sı.
- `timeline.md`: dosya ve komut olaylarının kronolojik akışı.
- `diff-summary.md`: Git durumu, değişen dosyalar, mümkün olduğunda satır sayıları ve dikkat çeken kategoriler.
- `risks.md`: riskli dosyalar, olası secrets, dependency/config değişiklikleri, CI/CD değişiklikleri ve inceleme checklist'i.
- `rollback.md`: manuel inceleme ve rollback önerileri.

`session.json` ayrıca deterministic risk summary, mevcutsa dosya türü ve boyut metadata'sı, line-stat source detayları ve bozuk session kayıtları için integrity metadata içerir.

Rapor ayrıntıları: [docs/REPORTS.md](docs/REPORTS.md)

#### Gizlilik ve Güvenlik Modeli

Agent Black Box özel depolar için tasarlanmıştır:

- Varsayılan olarak local-first çalışır.
- Telemetri yoktur.
- Harici AI API yoktur.
- Repo yüklemesi yoktur.
- Terminal çıktısı yakalanmaz.
- Olası secret değerleri raporlarda redakte edilir.
- Rollback sadece öneri verir; otomatik ve yıkıcı işlem yapmaz.

Komut yakalama isteğe bağlıdır. Yalnızca `abb run -- <command>` ile çalıştırılan komutlar kaydedilir ve hassas görünen argümanlar diske yazılmadan önce redakte edilir.

#### Neyi Göremez

Agent Black Box yalnızca gözlemlenebilir kanıtları raporlar. Şunları göremez:

- Bir AI ajanının gizli akıl yürütmesi.
- Prompt'lar veya özel model durumu.
- Editor durumu.
- Browser durumu.
- `abb run` üzerinden çalıştırılmayan komutların shell history'si.
- Bir değişikliğin neden yapıldığı.

Raporlar özellikle "possible", "likely" ve "detected from repository changes" gibi temkinli ifadeler kullanır.

#### Proje Kalitesi

- TypeScript strict mode.
- Core behavior için Vitest test coverage.
- Typecheck, build ve testler için GitHub Actions CI.
- CodeQL analizi.
- Patch/minor bakım için Dependabot.
- Tag tabanlı release workflow.
- `.agentblackbox.json` için versioned JSON Schema.
- MIT license.
- Security reporting guide.
- Contribution guide.

Mimari notları: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Geliştirme

```sh
pnpm install
pnpm check
```

CLI'yi yerelde çalıştırma:

```sh
pnpm dev -- --help
```

Build sonrası:

```sh
node dist/cli.js --help
```

#### Yol Haritası

Yakın vadeli geliştirmeler:

- İsteğe bağlı TUI tarzı rapor gezgini.
- npm publish hazırlığı.
- Daha fazla dil ekosistemi için repository fixture suite.

MVP kapsamı dışında:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Özel agent API entegrasyonları.
- Otomatik yıkıcı rollback.
- Ücretli AI özellikleri.

#### Maintainer

𝓐.𝓒.𝓑

#### License

MIT. Bkz. [LICENSE](LICENSE).

<a id="espanol"></a>
### Español

Agent Black Box es una CLI local-first para registrar y explicar cambios observables del repositorio durante sesiones de programación asistidas por IA.

Ayuda a los desarrolladores a revisar qué cambió mientras usan herramientas como Codex, Claude Code, Cursor, Cline y agentes de programación similares. No se integra directamente con esas herramientas, no inspecciona razonamiento oculto y no envía datos del repositorio a ningún lugar. Registra evidencia del repositorio: eventos de archivos, estado de Git, diffs, metadatos de comandos opt-in, cambios de archivos riesgosos, posibles valores similares a secretos y pistas de rollback.

#### Por Qué Usarlo

Los agentes de IA pueden moverse rápido. Agent Black Box ofrece una pista de auditoría tranquila antes de hacer commit:

- Ver qué archivos cambiaron durante una sesión.
- Revisar áreas sensibles como archivos env, CI/CD, dependencias, auth, security, migrations y config.
- Detectar posibles valores similares a secretos con reportes redactados.
- Registrar comandos ejecutados explícitamente mediante `abb run`.
- Generar reportes Markdown y JSON seguros para acompañar flujos de Git.
- Obtener sugerencias de rollback sin descartar trabajo automáticamente.

#### Inicio Rápido

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Iniciar una sesión de registro:

```sh
pnpm dev -- start
```

En otra terminal, ejecutar comandos mediante Agent Black Box cuando se quiera registrar metadata:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Detener y generar reportes:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Los reportes se escriben en:

```text
.agent-black-box/sessions/<session-id>/
```

#### Comandos CLI

| Comando | Propósito |
| --- | --- |
| `abb init` | Crea `.agentblackbox.json`. |
| `abb config validate` | Valida schema, version y valores normalizados de configuración. |
| `abb config migrate` | Reescribe la configuración con la versión actual del schema. |
| `abb start` | Inicia una sesión foreground en el repositorio Git actual. |
| `abb doctor` | Revisa requisitos locales, estado del repo, config y salud de sesión. |
| `abb run -- <command>` | Ejecuta un comando y registra metadata redactada para la sesión activa. Soporta `--group` y `--phase`. |
| `abb stop` | Detiene la sesión activa y genera reportes. |
| `abb status` | Muestra si la sesión está active, stale o absent. |
| `abb report` | Imprime el último `session.json`. |
| `abb summary` | Imprime el resumen humano más reciente. |
| `abb commands` | Imprime comandos registrados en la última sesión. |
| `abb timeline` | Imprime la última línea temporal cronológica. |
| `abb risks` | Imprime cambios riesgosos y posibles secretos con filtros opcionales. |
| `abb export` | Exporta la última sesión como Markdown combinado o JSON estructurado. |
| `abb rollback` | Imprime sugerencias seguras de rollback manual. |

Uso detallado: [docs/USAGE.md](docs/USAGE.md)

#### Qué Se Genera

Cada sesión produce:

- `session.json`: metadata estructurada, events, commands, Git snapshot, risks y possible secrets.
- `summary.md`: resumen breve orientado a revisión.
- `commands.md`: metadata de comandos registrada mediante `abb run`.
- `timeline.md`: timeline cronológico de archivos y comandos.
- `diff-summary.md`: estado Git, archivos cambiados, conteos de líneas cuando existen y categorías destacadas.
- `risks.md`: archivos riesgosos, posibles secretos, cambios dependency/config, cambios CI/CD y checklist de revisión.
- `rollback.md`: sugerencias de revisión manual y rollback.

`session.json` también incluye resumen de riesgo determinístico, metadata de tipo y tamaño de archivo cuando está disponible, detalles de origen de estadísticas de líneas e integrity metadata para registros corruptos omitidos durante recuperación.

Detalles de reportes: [docs/REPORTS.md](docs/REPORTS.md)

#### Privacidad y Seguridad

Agent Black Box está diseñado para repositorios privados:

- Local-first por defecto.
- Sin telemetría.
- Sin API externa de IA.
- Sin subida del repositorio.
- Sin captura de salida de terminal.
- Posibles secretos se redactan en reportes.
- Rollback es solo orientativo y nunca automático.

La captura de comandos es opt-in. Solo se registran comandos ejecutados con `abb run -- <command>`, y los argumentos sensibles se redactan antes de escribirse.

#### Qué No Puede Observar

Agent Black Box solo reporta evidencia observable. No puede ver:

- Razonamiento oculto de un agente de IA.
- Prompts o estado privado del modelo.
- Estado del editor.
- Estado del navegador.
- Historial de shell de comandos no ejecutados mediante `abb run`.
- Por qué ocurrió un cambio.

Los reportes usan lenguaje prudente como "possible", "likely" y "detected from repository changes".

#### Calidad Del Proyecto

- TypeScript strict mode.
- Cobertura Vitest para comportamiento central.
- GitHub Actions CI para typecheck, build y tests.
- Análisis CodeQL.
- Dependabot para mantenimiento patch/minor.
- Workflow de releases por tags.
- JSON Schema versionado para `.agentblackbox.json`.
- Licencia MIT.
- Guía de reporte de seguridad.
- Guía de contribución.

Notas de arquitectura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Desarrollo

```sh
pnpm install
pnpm check
```

Ejecutar la CLI localmente:

```sh
pnpm dev -- --help
```

Después de compilar:

```sh
node dist/cli.js --help
```

#### Hoja De Ruta

Mejoras cercanas:

- Navegador de reportes opcional estilo TUI.
- Preparación para publicación en npm.
- Suite de fixtures de repositorio para más ecosistemas de lenguajes.

Fuera del alcance del MVP:

- Dashboard web.
- Extensión de VS Code.
- Sincronización cloud.
- Integraciones privadas con APIs de agentes.
- Rollback destructivo automático.
- Funciones de IA de pago.

#### Mantenedor

𝓐.𝓒.𝓑

#### Licencia

MIT. Ver [LICENSE](LICENSE).

<a id="deutsch"></a>
### Deutsch

Agent Black Box ist ein local-first CLI zum Aufzeichnen und Erklären beobachtbarer Repository-Änderungen während KI-gestützter Coding-Sitzungen.

Es hilft Entwicklern zu prüfen, was sich bei der Nutzung von Codex, Claude Code, Cursor, Cline und ähnlichen Coding-Agenten geändert hat. Es integriert sich nicht direkt in diese Tools, liest keine verborgenen Reasoning-Daten aus und sendet keine Repository-Daten irgendwohin. Es zeichnet Repository-Evidence auf: Datei-Events, Git-Status, Diffs, opt-in Befehlsmetadaten, riskante Dateiänderungen, mögliche secret-ähnliche Werte und Rollback-Hinweise.

#### Warum Nutzen

KI-Coding-Agenten können sehr schnell Änderungen erzeugen. Agent Black Box gibt vor dem Commit eine ruhige Audit-Spur:

- Erkennen, welche Dateien in einer Sitzung geändert wurden.
- Riskante Bereiche wie env-Dateien, CI/CD, Dependencies, Auth, Security, Migrations und Config prüfen.
- Mögliche secret-ähnliche Werte mit redigierten Reports erkennen.
- Befehle explizit über `abb run` als Metadaten aufzeichnen.
- Markdown- und JSON-Reports erzeugen, die gut neben Git-Workflows liegen.
- Rollback-Vorschläge erhalten, ohne Arbeit automatisch zu verwerfen.

#### Schnellstart

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Aufzeichnung starten:

```sh
pnpm dev -- start
```

In einem zweiten Terminal Befehle über Agent Black Box ausführen, wenn Metadaten aufgezeichnet werden sollen:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Stoppen und Reports erzeugen:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Reports werden hier geschrieben:

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI-Befehle

| Befehl | Zweck |
| --- | --- |
| `abb init` | Erstellt `.agentblackbox.json`. |
| `abb config validate` | Prüft Config-Schema, Version und normalisierte Werte. |
| `abb config migrate` | Schreibt die Config mit der aktuellen Schema-Version neu. |
| `abb start` | Startet eine Foreground-Aufzeichnung im aktuellen Git-Repository. |
| `abb doctor` | Prüft lokale Voraussetzungen, Repository-Status, Config und Session-Gesundheit. |
| `abb run -- <command>` | Führt einen Befehl aus und speichert redigierte Metadaten für die aktive Session. Unterstützt `--group` und `--phase`. |
| `abb stop` | Stoppt die aktive Session und erzeugt Reports. |
| `abb status` | Zeigt, ob eine Session active, stale oder absent ist. |
| `abb report` | Gibt das neueste `session.json` aus. |
| `abb summary` | Gibt die neueste menschenlesbare Session-Zusammenfassung aus. |
| `abb commands` | Gibt die in der letzten Session aufgezeichneten Befehle aus. |
| `abb timeline` | Gibt die neueste chronologische Timeline aus. |
| `abb risks` | Gibt riskante Änderungen und mögliche Secret-Funde mit optionalen Filtern aus. |
| `abb export` | Exportiert die letzte Session als gebündeltes Markdown oder strukturiertes JSON. |
| `abb rollback` | Gibt sichere manuelle Rollback-Hinweise aus. |

Detaillierte Nutzung: [docs/USAGE.md](docs/USAGE.md)

#### Was Erzeugt Wird

Jede Session erzeugt:

- `session.json`: strukturierte Metadaten, Events, Commands, Git Snapshot, Risks und Possible Secrets.
- `summary.md`: kurze Review-first Zusammenfassung.
- `commands.md`: über `abb run` aufgezeichnete Befehlsmetadaten.
- `timeline.md`: chronologische Datei- und Befehlstimeline.
- `diff-summary.md`: Git-Status, geänderte Dateien, verfügbare Zeilenzahlen und auffällige Kategorien.
- `risks.md`: riskante Dateien, mögliche Secrets, Dependency/Config-Änderungen, CI/CD-Änderungen und Review-Checkliste.
- `rollback.md`: manuelle Review- und Rollback-Vorschläge.

`session.json` enthält außerdem deterministische Risiko-Zusammenfassung, Dateityp- und Größenmetadaten, Details zur Quelle der Zeilenstatistiken und Integrity-Metadaten für fehlerhafte Session Records.

Report-Details: [docs/REPORTS.md](docs/REPORTS.md)

#### Datenschutz- Und Sicherheitsmodell

Agent Black Box ist für private Repositories ausgelegt:

- Standardmäßig local-first.
- Keine Telemetrie.
- Keine externe KI-API.
- Kein Repository-Upload.
- Keine Erfassung von Terminalausgaben.
- Mögliche Secret-Werte werden in Reports redigiert.
- Rollback ist nur advisory und nie automatisch.

Befehlserfassung ist opt-in. Nur Befehle über `abb run -- <command>` werden aufgezeichnet; sensibel wirkende Argumente werden vor dem Schreiben redigiert.

#### Was Es Nicht Beobachten Kann

Agent Black Box berichtet nur beobachtbare Evidence. Es kann nicht sehen:

- Verborgenes Reasoning eines KI-Agenten.
- Prompts oder privaten Modellzustand.
- Editor-Zustand.
- Browser-Zustand.
- Shell History von Befehlen, die nicht über `abb run` laufen.
- Warum eine Änderung entstanden ist.

Reports verwenden absichtlich vorsichtige Sprache wie "possible", "likely" und "detected from repository changes".

#### Projektqualität

- TypeScript strict mode.
- Vitest-Coverage für Kernverhalten.
- GitHub Actions CI für Typecheck, Build und Tests.
- CodeQL-Analyse.
- Dependabot für Patch/Minor-Wartung.
- Tag-getriebener Release-Workflow.
- Versioniertes JSON Schema für `.agentblackbox.json`.
- MIT-Lizenz.
- Security Reporting Guide.
- Contribution Guide.

Architekturhinweise: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Entwicklung

```sh
pnpm install
pnpm check
```

CLI lokal ausführen:

```sh
pnpm dev -- --help
```

Nach dem Build:

```sh
node dist/cli.js --help
```

#### Roadmap

Nahe Verbesserungen:

- Optionaler TUI-artiger Report-Browser.
- Vorbereitung für npm publishing.
- Repository-Fixture-Suite für weitere Sprachökosysteme.

Außerhalb des MVP-Scopes:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Private Agent-API-Integrationen.
- Automatischer destruktiver Rollback.
- Bezahlte KI-Funktionen.

#### Maintainer

𝓐.𝓒.𝓑

#### Lizenz

MIT. Siehe [LICENSE](LICENSE).

<a id="francais"></a>
### Français

Agent Black Box est une CLI local-first pour enregistrer et expliquer les changements observables du dépôt pendant les sessions de développement assistées par IA.

Elle aide les développeurs à revoir ce qui a changé lors de l'utilisation d'outils comme Codex, Claude Code, Cursor, Cline et des agents similaires. Elle ne s'intègre pas directement à ces outils, n'inspecte pas le raisonnement caché et n'envoie pas les données du dépôt ailleurs. Elle enregistre des preuves issues du dépôt : événements de fichiers, état Git, diffs, métadonnées de commandes opt-in, changements de fichiers risqués, valeurs possibles de type secret et indications de rollback.

#### Pourquoi L'utiliser

Les agents de codage IA peuvent aller vite. Agent Black Box fournit une piste d'audit claire avant le commit :

- Voir quels fichiers ont changé pendant une session.
- Examiner les zones sensibles comme env, CI/CD, dépendances, auth, security, migrations et config.
- Détecter des valeurs possibles de type secret avec des rapports masqués.
- Enregistrer explicitement des commandes via `abb run`.
- Générer des rapports Markdown et JSON adaptés aux workflows Git.
- Obtenir des suggestions de rollback sans supprimer automatiquement le travail.

#### Démarrage Rapide

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Démarrer une session :

```sh
pnpm dev -- start
```

Dans un autre terminal, exécuter les commandes via Agent Black Box quand les métadonnées doivent être enregistrées :

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Arrêter et générer les rapports :

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Les rapports sont écrits dans :

```text
.agent-black-box/sessions/<session-id>/
```

#### Commandes CLI

| Commande | Objectif |
| --- | --- |
| `abb init` | Crée `.agentblackbox.json`. |
| `abb config validate` | Valide le schema, la version et les valeurs normalisées. |
| `abb config migrate` | Réécrit la configuration avec la version actuelle du schema. |
| `abb start` | Démarre une session foreground dans le dépôt Git courant. |
| `abb doctor` | Vérifie les prérequis locaux, l'état du dépôt, la config et la santé de session. |
| `abb run -- <command>` | Exécute une commande et enregistre des métadonnées masquées pour la session active. Supporte `--group` et `--phase`. |
| `abb stop` | Arrête la session active et génère les rapports. |
| `abb status` | Indique si une session est active, stale ou absent. |
| `abb report` | Affiche le dernier `session.json`. |
| `abb summary` | Affiche le dernier résumé lisible. |
| `abb commands` | Affiche les commandes enregistrées dans la dernière session. |
| `abb timeline` | Affiche la dernière timeline chronologique. |
| `abb risks` | Affiche les changements risqués et secrets possibles avec filtres optionnels. |
| `abb export` | Exporte la dernière session en Markdown groupé ou JSON structuré. |
| `abb rollback` | Affiche des suggestions sûres de rollback manuel. |

Utilisation détaillée : [docs/USAGE.md](docs/USAGE.md)

#### Ce Qui Est Généré

Chaque session produit :

- `session.json` : métadonnées structurées, events, commands, Git snapshot, risks et possible secrets.
- `summary.md` : résumé concis orienté revue.
- `commands.md` : métadonnées de commandes enregistrées via `abb run`.
- `timeline.md` : chronologie des fichiers et commandes.
- `diff-summary.md` : état Git, fichiers changés, lignes disponibles et catégories notables.
- `risks.md` : fichiers risqués, secrets possibles, changements dependency/config, CI/CD et checklist de revue.
- `rollback.md` : suggestions de revue manuelle et rollback.

`session.json` inclut aussi un résumé déterministe du risque, les métadonnées de type et taille de fichier, l'origine des statistiques de lignes et les métadonnées d'intégrité pour les enregistrements corrompus ignorés.

Détails des rapports : [docs/REPORTS.md](docs/REPORTS.md)

#### Confidentialité Et Sécurité

Agent Black Box est conçu pour les dépôts privés :

- Local-first par défaut.
- Pas de télémétrie.
- Pas d'API IA externe.
- Pas d'envoi du dépôt.
- Pas de capture de sortie terminal.
- Les valeurs possibles de secrets sont masquées.
- Le rollback est uniquement indicatif et jamais automatique.

La capture de commandes est opt-in. Seules les commandes exécutées via `abb run -- <command>` sont enregistrées, et les arguments sensibles sont masqués avant écriture.

#### Ce Qui N'est Pas Observable

Agent Black Box ne rapporte que des preuves observables. Il ne peut pas voir :

- Le raisonnement caché d'un agent IA.
- Les prompts ou l'état privé du modèle.
- L'état de l'éditeur.
- L'état du navigateur.
- L'historique shell des commandes non exécutées via `abb run`.
- Pourquoi un changement a eu lieu.

Les rapports utilisent volontairement un langage prudent comme "possible", "likely" et "detected from repository changes".

#### Qualité Du Projet

- TypeScript strict mode.
- Couverture Vitest pour le comportement central.
- CI GitHub Actions pour typecheck, build et tests.
- Analyse CodeQL.
- Dependabot pour la maintenance patch/minor.
- Workflow de release par tags.
- JSON Schema versionné pour `.agentblackbox.json`.
- Licence MIT.
- Guide de signalement de sécurité.
- Guide de contribution.

Notes d'architecture : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Développement

```sh
pnpm install
pnpm check
```

Exécuter la CLI localement :

```sh
pnpm dev -- --help
```

Après build :

```sh
node dist/cli.js --help
```

#### Feuille De Route

Améliorations à court terme :

- Navigateur de rapports optionnel de style TUI.
- Préparation de la publication npm.
- Suite de fixtures de dépôt pour davantage d'écosystèmes de langages.

Hors périmètre du MVP :

- Dashboard web.
- Extension VS Code.
- Cloud sync.
- Intégrations privées d'API d'agents.
- Rollback destructif automatique.
- Fonctionnalités IA payantes.

#### Mainteneur

𝓐.𝓒.𝓑

#### Licence

MIT. Voir [LICENSE](LICENSE).

<a id="portugues"></a>
### Português

Agent Black Box é uma CLI local-first para registrar e explicar mudanças observáveis no repositório durante sessões de programação assistidas por IA.

Ela ajuda desenvolvedores a revisar o que mudou ao usar ferramentas como Codex, Claude Code, Cursor, Cline e agentes semelhantes. Ela não se integra diretamente a essas ferramentas, não inspeciona raciocínio oculto e não envia dados do repositório para lugar algum. Ela registra evidências do repositório: eventos de arquivos, status Git, diffs, metadados de comandos opt-in, mudanças de arquivos arriscados, possíveis valores semelhantes a segredos e dicas de rollback.

#### Por Que Usar

Agentes de codificação com IA podem se mover rapidamente. Agent Black Box fornece uma trilha de auditoria clara antes do commit:

- Ver quais arquivos mudaram durante uma sessão.
- Revisar áreas sensíveis como arquivos env, CI/CD, dependências, auth, security, migrations e config.
- Detectar possíveis valores semelhantes a segredos com relatórios mascarados.
- Registrar comandos explicitamente executados por `abb run`.
- Gerar relatórios Markdown e JSON seguros para workflows Git.
- Obter sugestões de rollback sem descartar trabalho automaticamente.

#### Início Rápido

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Iniciar uma sessão:

```sh
pnpm dev -- start
```

Em outro terminal, execute comandos pelo Agent Black Box quando quiser registrar metadados:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Parar e gerar relatórios:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Os relatórios são gravados em:

```text
.agent-black-box/sessions/<session-id>/
```

#### Comandos CLI

| Comando | Finalidade |
| --- | --- |
| `abb init` | Cria `.agentblackbox.json`. |
| `abb config validate` | Valida schema, versão e valores normalizados. |
| `abb config migrate` | Reescreve a configuração usando a versão atual do schema. |
| `abb start` | Inicia uma sessão foreground no repositório Git atual. |
| `abb doctor` | Verifica pré-requisitos locais, estado do repositório, config e saúde da sessão. |
| `abb run -- <command>` | Executa um comando e registra metadados mascarados para a sessão ativa. Suporta `--group` e `--phase`. |
| `abb stop` | Para a sessão ativa e gera relatórios. |
| `abb status` | Mostra se a sessão está active, stale ou absent. |
| `abb report` | Imprime o último `session.json`. |
| `abb summary` | Imprime o último resumo legível. |
| `abb commands` | Imprime comandos registrados na última sessão. |
| `abb timeline` | Imprime a última timeline cronológica. |
| `abb risks` | Imprime mudanças arriscadas e possíveis segredos com filtros opcionais. |
| `abb export` | Exporta a última sessão como Markdown agrupado ou JSON estruturado. |
| `abb rollback` | Imprime sugestões seguras de rollback manual. |

Uso detalhado: [docs/USAGE.md](docs/USAGE.md)

#### O Que É Gerado

Cada sessão produz:

- `session.json`: metadados estruturados, events, commands, Git snapshot, risks e possible secrets.
- `summary.md`: resumo curto orientado à revisão.
- `commands.md`: metadados de comandos registrados via `abb run`.
- `timeline.md`: linha do tempo cronológica de arquivos e comandos.
- `diff-summary.md`: status Git, arquivos alterados, contagens de linhas quando disponíveis e categorias notáveis.
- `risks.md`: arquivos arriscados, possíveis segredos, mudanças dependency/config, CI/CD e checklist de revisão.
- `rollback.md`: sugestões de revisão manual e rollback.

`session.json` também inclui resumo determinístico de risco, metadados de tipo e tamanho de arquivo, fonte das estatísticas de linhas e metadados de integridade para registros corrompidos ignorados.

Detalhes dos relatórios: [docs/REPORTS.md](docs/REPORTS.md)

#### Privacidade E Segurança

Agent Black Box é projetado para repositórios privados:

- Local-first por padrão.
- Sem telemetria.
- Sem API externa de IA.
- Sem upload do repositório.
- Sem captura da saída do terminal.
- Possíveis segredos são mascarados nos relatórios.
- Rollback é apenas consultivo e nunca automático.

A captura de comandos é opt-in. Apenas comandos executados por `abb run -- <command>` são registrados, e argumentos sensíveis são mascarados antes de serem gravados.

#### O Que Não Pode Observar

Agent Black Box relata apenas evidências observáveis. Ele não consegue ver:

- Raciocínio oculto de um agente de IA.
- Prompts ou estado privado do modelo.
- Estado do editor.
- Estado do navegador.
- Histórico shell de comandos não executados via `abb run`.
- Por que uma mudança aconteceu.

Os relatórios usam linguagem cautelosa como "possible", "likely" e "detected from repository changes".

#### Qualidade Do Projeto

- TypeScript strict mode.
- Cobertura Vitest para comportamento central.
- GitHub Actions CI para typecheck, build e testes.
- Análise CodeQL.
- Dependabot para manutenção patch/minor.
- Workflow de release baseado em tags.
- JSON Schema versionado para `.agentblackbox.json`.
- Licença MIT.
- Guia de reporte de segurança.
- Guia de contribuição.

Notas de arquitetura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Desenvolvimento

```sh
pnpm install
pnpm check
```

Executar a CLI localmente:

```sh
pnpm dev -- --help
```

Após build:

```sh
node dist/cli.js --help
```

#### Roadmap

Melhorias de curto prazo:

- Navegador de relatórios opcional em estilo TUI.
- Preparação para publicação npm.
- Suite de fixtures de repositório para mais ecossistemas de linguagens.

Fora do escopo do MVP:

- Web dashboard.
- Extensão VS Code.
- Cloud sync.
- Integrações privadas com APIs de agentes.
- Rollback destrutivo automático.
- Recursos pagos de IA.

#### Mantenedor

𝓐.𝓒.𝓑

#### Licença

MIT. Consulte [LICENSE](LICENSE).

<a id="zhongwen"></a>
### 中文

Agent Black Box 是一个本地优先的 CLI，用于在 AI 辅助编码会话中记录并解释仓库层面可观察到的变更。

它帮助开发者在使用 Codex、Claude Code、Cursor、Cline 以及类似编码代理时审查发生了什么变化。它不会直接集成这些工具，不会查看隐藏推理，也不会把仓库数据发送到任何地方。它只记录来自仓库的证据：文件事件、Git 状态、diff、选择性命令元数据、风险文件变更、可能类似 secret 的值以及 rollback 提示。

#### 为什么使用

AI 编码代理可能很快地产生变更。Agent Black Box 在 commit 前提供一条清晰的审计轨迹：

- 查看一次会话中哪些文件发生了变化。
- 审查 env 文件、CI/CD、依赖、auth、security、migrations 和 config 等风险区域。
- 通过已脱敏的报告检测可能类似 secret 的值。
- 通过 `abb run` 显式记录你运行的命令。
- 生成适合 Git 工作流保存的 Markdown 和 JSON 报告。
- 获取 rollback 建议，而不会自动丢弃你的工作。

#### 快速开始

```sh
pnpm install
pnpm build
pnpm dev -- init
```

启动记录会话：

```sh
pnpm dev -- start
```

在另一个终端中，当你希望记录命令元数据时，通过 Agent Black Box 运行命令：

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

停止并生成报告：

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

报告写入：

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI 命令

| 命令 | 用途 |
| --- | --- |
| `abb init` | 创建 `.agentblackbox.json`。 |
| `abb config validate` | 验证配置 schema、版本和规范化值。 |
| `abb config migrate` | 使用当前 schema 版本重写配置。 |
| `abb start` | 在当前 Git 仓库启动前台记录会话。 |
| `abb doctor` | 检查本地前置条件、仓库状态、配置和会话健康。 |
| `abb run -- <command>` | 运行命令，并为活动会话记录已脱敏的命令元数据。支持 `--group` 和 `--phase`。 |
| `abb stop` | 停止活动会话并生成报告。 |
| `abb status` | 显示会话是 active、stale 还是 absent。 |
| `abb report` | 打印最新的 `session.json`。 |
| `abb summary` | 打印最新的人类可读会话摘要。 |
| `abb commands` | 打印最新会话中记录的命令。 |
| `abb timeline` | 打印最新的时间线报告。 |
| `abb risks` | 打印风险变更和可能的 secret 发现，支持可选过滤。 |
| `abb export` | 将最新会话导出为合并 Markdown 或结构化 JSON。 |
| `abb rollback` | 打印安全的手动 rollback 建议。 |

详细用法：[docs/USAGE.md](docs/USAGE.md)

#### 会生成什么

每个会话会生成：

- `session.json`：结构化元数据、events、commands、Git snapshot、risks 和 possible secrets。
- `summary.md`：以审查为中心的简短摘要。
- `commands.md`：通过 `abb run` 记录的命令元数据。
- `timeline.md`：文件和命令的时间线。
- `diff-summary.md`：Git 状态、变更文件、可用的行数统计以及重要类别。
- `risks.md`：风险文件、可能的 secrets、dependency/config 变更、CI/CD 变更和审查清单。
- `rollback.md`：手动审查和 rollback 建议。

`session.json` 还包含确定性的风险摘要、可用时的文件类型和大小元数据、行统计来源详情，以及恢复时跳过的损坏记录的完整性元数据。

报告详情：[docs/REPORTS.md](docs/REPORTS.md)

#### 隐私和安全模型

Agent Black Box 为私有仓库设计：

- 默认 local-first。
- 无遥测。
- 不使用外部 AI API。
- 不上传仓库。
- 不捕获终端输出。
- 报告中会脱敏可能的 secret 值。
- Rollback 仅提供建议，绝不自动执行。

命令捕获是 opt-in。只有通过 `abb run -- <command>` 运行的命令会被记录，敏感参数会在写入前脱敏。

#### 它不能观察什么

Agent Black Box 只报告可观察证据。它不能看到：

- AI 代理的隐藏推理。
- Prompt 或私有模型状态。
- 编辑器状态。
- 浏览器状态。
- 未通过 `abb run` 运行的 shell history。
- 变更发生的原因。

报告会刻意使用谨慎措辞，例如 "possible"、"likely" 和 "detected from repository changes"。

#### 项目质量

- TypeScript strict mode。
- 核心行为的 Vitest 测试覆盖。
- GitHub Actions CI 运行 typecheck、build 和 tests。
- CodeQL 分析。
- Dependabot 用于 patch/minor 维护。
- 基于 tag 的 release workflow。
- `.agentblackbox.json` 的版本化 JSON Schema。
- MIT license。
- Security reporting guide。
- Contribution guide。

架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### 开发

```sh
pnpm install
pnpm check
```

本地运行 CLI：

```sh
pnpm dev -- --help
```

构建后：

```sh
node dist/cli.js --help
```

#### 路线图

近期改进：

- 可选的 TUI 风格报告浏览器。
- npm publish 准备。
- 面向更多语言生态的 repository fixture suite。

MVP 范围之外：

- Web dashboard。
- VS Code extension。
- Cloud sync。
- 私有 agent API 集成。
- 自动破坏性 rollback。
- 付费 AI 功能。

#### 维护者

𝓐.𝓒.𝓑

#### 许可证

MIT。参见 [LICENSE](LICENSE)。

<a id="hindi"></a>
### हिन्दी

Agent Black Box एक local-first CLI है जो AI-assisted coding sessions के दौरान repository में observable changes को record और explain करता है।

यह developers को Codex, Claude Code, Cursor, Cline और similar coding agents का उपयोग करते समय हुए बदलावों को review करने में मदद करता है। यह इन tools से direct integration नहीं करता, hidden reasoning inspect नहीं करता, और repository data कहीं भेजता नहीं है। यह repository से evidence record करता है: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values, और rollback hints।

#### क्यों उपयोग करें

AI coding agents तेजी से बदलाव कर सकते हैं। Agent Black Box commit से पहले calm audit trail देता है:

- Session के दौरान कौन से files बदले, यह देखें।
- env files, CI/CD, dependencies, auth, security, migrations और config जैसे risky areas review करें।
- Redacted reporting के साथ possible secret-like values detect करें।
- जिन commands को आप explicit रूप से `abb run` से चलाते हैं उन्हें record करें।
- Git workflows के साथ रखने योग्य Markdown और JSON reports generate करें।
- Work automatically discard किए बिना rollback suggestions पाएं।

#### Quick Start

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Recording session start करें:

```sh
pnpm dev -- start
```

दूसरे terminal में, command metadata record करने के लिए Agent Black Box से command चलाएं:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Session stop करके reports generate करें:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Reports यहां लिखे जाते हैं:

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI Commands

| Command | Purpose |
| --- | --- |
| `abb init` | `.agentblackbox.json` बनाता है। |
| `abb config validate` | config schema, version और normalized values validate करता है। |
| `abb config migrate` | config को current schema version से rewrite करता है। |
| `abb start` | current Git repository में foreground recording session start करता है। |
| `abb doctor` | local prerequisites, repository state, config और session health check करता है। |
| `abb run -- <command>` | command चलाता है और active session के लिए redacted command metadata record करता है। `--group` और `--phase` support करता है। |
| `abb stop` | active session stop करता है और reports generate करता है। |
| `abb status` | session active, stale या absent है यह दिखाता है। |
| `abb report` | latest `session.json` print करता है। |
| `abb summary` | latest human-readable session summary print करता है। |
| `abb commands` | latest session में recorded commands print करता है। |
| `abb timeline` | latest chronological timeline print करता है। |
| `abb risks` | risky changes और possible secret findings optional filters के साथ print करता है। |
| `abb export` | latest session को bundled Markdown या structured JSON में export करता है। |
| `abb rollback` | safe manual rollback suggestions print करता है। |

Detailed usage: [docs/USAGE.md](docs/USAGE.md)

#### क्या Generate होता है

हर session ये files produce करता है:

- `session.json`: structured metadata, events, commands, Git snapshot, risks और possible secrets।
- `summary.md`: concise review-first session summary।
- `commands.md`: `abb run` से recorded command metadata।
- `timeline.md`: chronological file और command timeline।
- `diff-summary.md`: Git status, changed files, available line counts और notable categories।
- `risks.md`: risky files, possible secrets, dependency/config changes, CI/CD changes और review checklist।
- `rollback.md`: manual review और rollback suggestions।

`session.json` deterministic risk summary, file kind और size metadata, line-stat source details, और malformed session records के लिए integrity metadata भी include करता है।

Report details: [docs/REPORTS.md](docs/REPORTS.md)

#### Privacy और Safety Model

Agent Black Box private repositories के लिए design किया गया है:

- Default local-first।
- No telemetry।
- No external AI API।
- No repository upload।
- No terminal output capture।
- Possible secret values reports में redacted होते हैं।
- Rollback advisory-only है और automatic नहीं है।

Command capture opt-in है। केवल `abb run -- <command>` से चलाए गए commands record होते हैं, और sensitive-looking arguments लिखने से पहले redact किए जाते हैं।

#### यह क्या Observe नहीं कर सकता

Agent Black Box केवल observable evidence report करता है। यह नहीं देख सकता:

- AI agent की hidden reasoning।
- Prompts या private model state।
- Editor state।
- Browser state।
- `abb run` से न चलाए गए commands की shell history।
- Change क्यों हुआ।

Reports जानबूझकर cautious language जैसे "possible", "likely", और "detected from repository changes" use करते हैं।

#### Project Quality

- TypeScript strict mode।
- Core behavior के लिए Vitest test coverage।
- typecheck, build और tests के लिए GitHub Actions CI।
- CodeQL analysis।
- patch/minor maintenance के लिए Dependabot।
- Tag-driven release workflow।
- `.agentblackbox.json` के लिए versioned JSON Schema।
- MIT license।
- Security reporting guide।
- Contribution guide।

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Development

```sh
pnpm install
pnpm check
```

CLI locally चलाएं:

```sh
pnpm dev -- --help
```

Build के बाद:

```sh
node dist/cli.js --help
```

#### Roadmap

Near-term improvements:

- Optional TUI-style report browser।
- npm publish preparation।
- More language ecosystems के लिए repository fixture suite।

MVP scope से बाहर:

- Web dashboard।
- VS Code extension।
- Cloud sync।
- Private agent API integrations।
- Automatic destructive rollback।
- Paid AI features।

#### Maintainer

𝓐.𝓒.𝓑

#### License

MIT. [LICENSE](LICENSE) देखें।

<a id="arabic"></a>
### العربية

Agent Black Box هو أداة CLI محلية أولا لتسجيل وشرح تغييرات المستودع القابلة للملاحظة أثناء جلسات البرمجة بمساعدة الذكاء الاصطناعي.

يساعد المطورين على مراجعة ما تغيّر عند استخدام أدوات مثل Codex و Claude Code و Cursor و Cline ووكلاء البرمجة المشابهين. لا يتكامل مباشرة مع هذه الأدوات، ولا يفحص التفكير المخفي، ولا يرسل بيانات المستودع إلى أي مكان. يسجل أدلة من المستودع: أحداث الملفات، حالة Git، الفروقات، بيانات الأوامر الاختيارية، تغييرات الملفات عالية المخاطر، القيم المحتملة المشابهة للأسرار، وتلميحات rollback.

#### لماذا تستخدمه

قد تتحرك وكلاء البرمجة بالذكاء الاصطناعي بسرعة. يمنحك Agent Black Box سجل تدقيق واضحا قبل commit:

- رؤية الملفات التي تغيرت أثناء الجلسة.
- مراجعة مناطق حساسة مثل env files و CI/CD و dependencies و auth و security و migrations و config.
- اكتشاف قيم محتملة شبيهة بالأسرار مع تقارير مخفية القيم.
- تسجيل الأوامر التي تشغلها صراحة عبر `abb run`.
- إنشاء تقارير Markdown و JSON مناسبة بجانب Git workflows.
- الحصول على اقتراحات rollback دون حذف العمل تلقائيا.

#### البدء السريع

```sh
pnpm install
pnpm build
pnpm dev -- init
```

ابدأ جلسة تسجيل:

```sh
pnpm dev -- start
```

في طرفية أخرى، شغّل الأوامر عبر Agent Black Box عندما تريد تسجيل بياناتها:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

أوقف الجلسة وأنشئ التقارير:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

تكتب التقارير في:

```text
.agent-black-box/sessions/<session-id>/
```

#### أوامر CLI

| الأمر | الغرض |
| --- | --- |
| `abb init` | ينشئ `.agentblackbox.json`. |
| `abb config validate` | يتحقق من schema والإصدار والقيم المعيارية. |
| `abb config migrate` | يعيد كتابة config باستخدام الإصدار الحالي من schema. |
| `abb start` | يبدأ جلسة تسجيل foreground في مستودع Git الحالي. |
| `abb doctor` | يفحص المتطلبات المحلية وحالة المستودع و config وصحة الجلسة. |
| `abb run -- <command>` | يشغل الأمر ويسجل بيانات أوامر مخفية القيم للجلسة النشطة. يدعم `--group` و `--phase`. |
| `abb stop` | يوقف الجلسة النشطة وينشئ التقارير. |
| `abb status` | يعرض ما إذا كانت الجلسة active أو stale أو absent. |
| `abb report` | يطبع أحدث `session.json`. |
| `abb summary` | يطبع أحدث ملخص قابل للقراءة. |
| `abb commands` | يطبع الأوامر المسجلة في أحدث جلسة. |
| `abb timeline` | يطبع أحدث timeline زمني. |
| `abb risks` | يطبع التغييرات الخطرة والأسرار المحتملة مع فلاتر اختيارية. |
| `abb export` | يصدر أحدث جلسة كـ Markdown مجمع أو JSON منظم. |
| `abb rollback` | يطبع اقتراحات rollback يدوية آمنة. |

الاستخدام التفصيلي: [docs/USAGE.md](docs/USAGE.md)

#### ما الذي يتم توليده

كل جلسة تنتج:

- `session.json`: metadata منظمة، events، commands، Git snapshot، risks و possible secrets.
- `summary.md`: ملخص مختصر موجه للمراجعة.
- `commands.md`: بيانات الأوامر المسجلة عبر `abb run`.
- `timeline.md`: تسلسل زمني للملفات والأوامر.
- `diff-summary.md`: حالة Git والملفات المتغيرة وعدد الأسطر عند توفره والفئات المهمة.
- `risks.md`: الملفات الخطرة والأسرار المحتملة وتغييرات dependency/config و CI/CD وقائمة مراجعة.
- `rollback.md`: اقتراحات مراجعة يدوية و rollback.

يتضمن `session.json` أيضا ملخصا حتميا للمخاطر، metadata لنوع وحجم الملفات عند توفرها، تفاصيل مصدر إحصاءات الأسطر، وبيانات integrity للسجلات التالفة التي تم تجاهلها أثناء الاسترداد.

تفاصيل التقارير: [docs/REPORTS.md](docs/REPORTS.md)

#### نموذج الخصوصية والسلامة

صمم Agent Black Box للمستودعات الخاصة:

- Local-first افتراضيا.
- لا توجد telemetry.
- لا توجد API ذكاء اصطناعي خارجية.
- لا رفع للمستودع.
- لا التقاط لمخرجات الطرفية.
- يتم إخفاء قيم الأسرار المحتملة في التقارير.
- rollback إرشادي فقط وليس تلقائيا.

التقاط الأوامر اختياري. لا تسجل إلا الأوامر التي تعمل عبر `abb run -- <command>`، ويتم إخفاء الوسائط الحساسة قبل كتابتها.

#### ما لا يمكنه ملاحظته

Agent Black Box يبلغ فقط عن الأدلة القابلة للملاحظة. لا يمكنه رؤية:

- التفكير المخفي لوكيل الذكاء الاصطناعي.
- Prompts أو حالة النموذج الخاصة.
- حالة المحرر.
- حالة المتصفح.
- سجل shell للأوامر التي لم تعمل عبر `abb run`.
- سبب حدوث التغيير.

تستخدم التقارير لغة حذرة مثل "possible" و "likely" و "detected from repository changes".

#### جودة المشروع

- TypeScript strict mode.
- تغطية Vitest للسلوك الأساسي.
- GitHub Actions CI من أجل typecheck و build و tests.
- تحليل CodeQL.
- Dependabot لصيانة patch/minor.
- سير release قائم على tags.
- JSON Schema بإصدارات لـ `.agentblackbox.json`.
- ترخيص MIT.
- دليل الإبلاغ الأمني.
- دليل المساهمة.

ملاحظات المعمارية: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### التطوير

```sh
pnpm install
pnpm check
```

تشغيل CLI محليا:

```sh
pnpm dev -- --help
```

بعد البناء:

```sh
node dist/cli.js --help
```

#### خارطة الطريق

تحسينات قريبة:

- متصفح تقارير اختياري بأسلوب TUI.
- التحضير للنشر على npm.
- مجموعة repository fixtures لمزيد من أنظمة اللغات.

خارج نطاق MVP:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- تكاملات API خاصة للوكلاء.
- rollback تلقائي تدميري.
- ميزات AI مدفوعة.

#### المشرف

𝓐.𝓒.𝓑

#### الترخيص

MIT. راجع [LICENSE](LICENSE).

<a id="russkiy"></a>
### Русский

Agent Black Box — local-first CLI для записи и объяснения наблюдаемых изменений репозитория во время сессий разработки с ИИ.

Он помогает разработчикам проверить, что изменилось при использовании Codex, Claude Code, Cursor, Cline и похожих coding agents. Он не интегрируется с этими инструментами напрямую, не читает скрытое рассуждение модели и не отправляет данные репозитория куда-либо. Он фиксирует evidence из репозитория: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values и rollback hints.

#### Зачем Использовать

AI coding agents могут быстро менять код. Agent Black Box дает спокойный audit trail перед commit:

- Посмотреть, какие файлы изменились за session.
- Проверить рискованные области: env files, CI/CD, dependencies, auth, security, migrations и config.
- Найти possible secret-like values с редактированными отчетами.
- Записать команды, которые явно запускаются через `abb run`.
- Создать Markdown и JSON отчеты, удобные рядом с Git workflows.
- Получить rollback suggestions без автоматического удаления работы.

#### Быстрый Старт

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Запустить запись:

```sh
pnpm dev -- start
```

В другом терминале запускайте команды через Agent Black Box, когда нужно записать metadata:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Остановить и создать отчеты:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Отчеты записываются в:

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI Команды

| Команда | Назначение |
| --- | --- |
| `abb init` | Создает `.agentblackbox.json`. |
| `abb config validate` | Проверяет schema, version и normalized values. |
| `abb config migrate` | Перезаписывает config текущей версией schema. |
| `abb start` | Запускает foreground recording session в текущем Git repository. |
| `abb doctor` | Проверяет local prerequisites, repository state, config и session health. |
| `abb run -- <command>` | Запускает команду и пишет redacted command metadata для active session. Поддерживает `--group` и `--phase`. |
| `abb stop` | Останавливает active session и генерирует reports. |
| `abb status` | Показывает, является ли session active, stale или absent. |
| `abb report` | Печатает последний `session.json`. |
| `abb summary` | Печатает последний human-readable summary. |
| `abb commands` | Печатает команды, записанные в последней session. |
| `abb timeline` | Печатает последнюю chronological timeline. |
| `abb risks` | Печатает risky changes и possible secret findings с optional filters. |
| `abb export` | Экспортирует последнюю session как bundled Markdown или structured JSON. |
| `abb rollback` | Печатает safe manual rollback suggestions. |

Подробное использование: [docs/USAGE.md](docs/USAGE.md)

#### Что Генерируется

Каждая session создает:

- `session.json`: structured metadata, events, commands, Git snapshot, risks и possible secrets.
- `summary.md`: краткий review-first summary.
- `commands.md`: command metadata, записанная через `abb run`.
- `timeline.md`: chronological file and command timeline.
- `diff-summary.md`: Git status, changed files, line counts где доступны и notable categories.
- `risks.md`: risky files, possible secrets, dependency/config changes, CI/CD changes и review checklist.
- `rollback.md`: manual review и rollback suggestions.

`session.json` также включает deterministic risk summary, metadata типа и размера файла, line-stat source details и integrity metadata для malformed session records, пропущенных при recovery.

Детали отчетов: [docs/REPORTS.md](docs/REPORTS.md)

#### Privacy And Safety Model

Agent Black Box рассчитан на private repositories:

- Local-first по умолчанию.
- Нет telemetry.
- Нет external AI API.
- Нет repository upload.
- Нет terminal output capture.
- Possible secret values редактируются в reports.
- Rollback advisory-only и никогда не automatic.

Command capture является opt-in. Записываются только команды через `abb run -- <command>`, а sensitive-looking arguments редактируются перед записью.

#### Что Он Не Может Видеть

Agent Black Box сообщает только observable evidence. Он не может видеть:

- Hidden reasoning AI agent.
- Prompts или private model state.
- Editor state.
- Browser state.
- Shell history команд, не запущенных через `abb run`.
- Почему изменение произошло.

Reports намеренно используют осторожные формулировки: "possible", "likely" и "detected from repository changes".

#### Качество Проекта

- TypeScript strict mode.
- Vitest coverage для core behavior.
- GitHub Actions CI для typecheck, build и tests.
- CodeQL analysis.
- Dependabot для patch/minor maintenance.
- Tag-driven release workflow.
- Versioned JSON Schema для `.agentblackbox.json`.
- MIT license.
- Security reporting guide.
- Contribution guide.

Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Разработка

```sh
pnpm install
pnpm check
```

Запустить CLI локально:

```sh
pnpm dev -- --help
```

После build:

```sh
node dist/cli.js --help
```

#### Дорожная Карта

Ближайшие улучшения:

- Опциональный TUI-style report browser.
- Подготовка к npm publish.
- Repository fixture suite для большего числа языковых экосистем.

Вне области MVP:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Private agent API integrations.
- Automatic destructive rollback.
- Paid AI features.

#### Maintainer

𝓐.𝓒.𝓑

#### License

MIT. См. [LICENSE](LICENSE).

<a id="nihongo"></a>
### 日本語

Agent Black Box は、AI 支援コーディング中にリポジトリで観測できる変更を記録し説明する local-first CLI です。

Codex、Claude Code、Cursor、Cline などの coding agent を使うときに、何が変わったかをレビューしやすくします。これらのツールへ直接統合せず、隠れた reasoning を検査せず、リポジトリデータを外部へ送信しません。記録するのはリポジトリから得られる evidence です: file events、Git status、diffs、opt-in command metadata、risky file changes、possible secret-like values、rollback hints。

#### なぜ使うか

AI coding agents は素早く変更を加えることがあります。Agent Black Box は commit 前に落ち着いて確認できる audit trail を提供します:

- セッション中にどのファイルが変わったかを確認できます。
- env files、CI/CD、dependencies、auth、security、migrations、config などのリスク領域を確認できます。
- 可能性のある secret-like values を redacted reports で検出できます。
- `abb run` 経由で明示的に実行した commands を記録できます。
- Git workflows と一緒に保存しやすい Markdown と JSON reports を生成できます。
- 作業を自動的に破棄せず rollback suggestions を得られます。

#### クイックスタート

```sh
pnpm install
pnpm build
pnpm dev -- init
```

記録セッションを開始:

```sh
pnpm dev -- start
```

別の terminal で、metadata を記録したい command を Agent Black Box 経由で実行:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

停止して reports を生成:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Reports は以下に書き込まれます:

```text
.agent-black-box/sessions/<session-id>/
```

#### CLI コマンド

| コマンド | 目的 |
| --- | --- |
| `abb init` | `.agentblackbox.json` を作成します。 |
| `abb config validate` | config schema、version、normalized values を検証します。 |
| `abb config migrate` | config を現在の schema version で書き直します。 |
| `abb start` | 現在の Git repository で foreground recording session を開始します。 |
| `abb doctor` | local prerequisites、repository state、config、session health を確認します。 |
| `abb run -- <command>` | command を実行し、active session の redacted command metadata を記録します。`--group` と `--phase` をサポートします。 |
| `abb stop` | active session を停止し reports を生成します。 |
| `abb status` | session が active、stale、absent のどれかを表示します。 |
| `abb report` | 最新の `session.json` を表示します。 |
| `abb summary` | 最新の人間向け summary を表示します。 |
| `abb commands` | 最新 session に記録された commands を表示します。 |
| `abb timeline` | 最新の chronological timeline を表示します。 |
| `abb risks` | risky changes と possible secret findings を optional filters 付きで表示します。 |
| `abb export` | 最新 session を bundled Markdown または structured JSON として export します。 |
| `abb rollback` | safe manual rollback suggestions を表示します。 |

詳細な使い方: [docs/USAGE.md](docs/USAGE.md)

#### 生成されるもの

各 session は以下を生成します:

- `session.json`: structured metadata、events、commands、Git snapshot、risks、possible secrets。
- `summary.md`: review-first の短い session summary。
- `commands.md`: `abb run` で記録された command metadata。
- `timeline.md`: file と command の chronological timeline。
- `diff-summary.md`: Git status、changed files、利用可能な line counts、notable categories。
- `risks.md`: risky files、possible secrets、dependency/config changes、CI/CD changes、review checklist。
- `rollback.md`: manual review と rollback suggestions。

`session.json` には deterministic risk summary、利用可能な file kind と size metadata、line-stat source details、recovery 中に skipped された malformed session records の integrity metadata も含まれます。

Report details: [docs/REPORTS.md](docs/REPORTS.md)

#### プライバシーと安全モデル

Agent Black Box は private repositories を想定しています:

- デフォルトで local-first。
- Telemetry なし。
- External AI API なし。
- Repository upload なし。
- Terminal output capture なし。
- Possible secret values は reports 内で redacted。
- Rollback は advisory only で自動実行されません。

Command capture は opt-in です。`abb run -- <command>` で実行された commands だけが記録され、sensitive-looking arguments は書き込み前に redacted されます。

#### 観測できないもの

Agent Black Box は observable evidence のみを報告します。以下は見えません:

- AI agent の hidden reasoning。
- Prompts または private model state。
- Editor state。
- Browser state。
- `abb run` 経由でない commands の shell history。
- なぜ変更が起きたか。

Reports は意図的に "possible"、"likely"、"detected from repository changes" のような慎重な表現を使います。

#### プロジェクト品質

- TypeScript strict mode。
- Core behavior の Vitest test coverage。
- typecheck、build、tests の GitHub Actions CI。
- CodeQL analysis。
- patch/minor maintenance の Dependabot。
- Tag-driven release workflow。
- `.agentblackbox.json` の versioned JSON Schema。
- MIT license。
- Security reporting guide。
- Contribution guide。

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### 開発

```sh
pnpm install
pnpm check
```

CLI をローカルで実行:

```sh
pnpm dev -- --help
```

Build 後:

```sh
node dist/cli.js --help
```

#### ロードマップ

近い将来の改善:

- Optional TUI-style report browser。
- npm publish preparation。
- より多くの language ecosystems 向け repository fixture suite。

MVP の範囲外:

- Web dashboard。
- VS Code extension。
- Cloud sync。
- Private agent API integrations。
- Automatic destructive rollback。
- Paid AI features。

#### Maintainer

𝓐.𝓒.𝓑

#### License

MIT。 [LICENSE](LICENSE) を参照してください。

<a id="bahasa-indonesia"></a>
### Bahasa Indonesia

Agent Black Box adalah CLI local-first untuk merekam dan menjelaskan perubahan repositori yang dapat diamati selama sesi coding berbantuan AI.

Alat ini membantu developer meninjau apa yang berubah saat memakai Codex, Claude Code, Cursor, Cline, dan coding agent serupa. Agent Black Box tidak terintegrasi langsung dengan alat tersebut, tidak memeriksa hidden reasoning, dan tidak mengirim data repositori ke mana pun. Ia merekam evidence dari repositori: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values, dan rollback hints.

#### Mengapa Digunakan

AI coding agent dapat bergerak cepat. Agent Black Box memberi audit trail yang tenang sebelum commit:

- Melihat file mana yang berubah selama sesi.
- Meninjau area berisiko seperti env files, CI/CD, dependencies, auth, security, migrations, dan config.
- Mendeteksi possible secret-like values dengan laporan yang sudah disamarkan.
- Merekam command yang eksplisit dijalankan melalui `abb run`.
- Menghasilkan laporan Markdown dan JSON yang aman disimpan bersama workflow Git.
- Mendapat rollback suggestions tanpa otomatis membuang pekerjaan.

#### Quick Start

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Mulai sesi perekaman:

```sh
pnpm dev -- start
```

Di terminal lain, jalankan command melalui Agent Black Box ketika ingin metadata direkam:

```sh
pnpm dev -- run --group validation --phase test -- pnpm test
```

Hentikan dan hasilkan laporan:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- export --output abb-session.md
pnpm dev -- rollback
```

Laporan ditulis ke:

```text
.agent-black-box/sessions/<session-id>/
```

#### Perintah CLI

| Perintah | Tujuan |
| --- | --- |
| `abb init` | Membuat `.agentblackbox.json`. |
| `abb config validate` | Memvalidasi config schema, version, dan normalized values. |
| `abb config migrate` | Menulis ulang config dengan schema version saat ini. |
| `abb start` | Memulai foreground recording session di Git repository saat ini. |
| `abb doctor` | Memeriksa local prerequisites, repository state, config, dan session health. |
| `abb run -- <command>` | Menjalankan command dan merekam redacted command metadata untuk active session. Mendukung `--group` dan `--phase`. |
| `abb stop` | Menghentikan active session dan menghasilkan reports. |
| `abb status` | Menampilkan apakah session active, stale, atau absent. |
| `abb report` | Mencetak `session.json` terbaru. |
| `abb summary` | Mencetak human-readable session summary terbaru. |
| `abb commands` | Mencetak commands yang direkam di session terbaru. |
| `abb timeline` | Mencetak chronological timeline terbaru. |
| `abb risks` | Mencetak risky changes dan possible secret findings dengan filter opsional. |
| `abb export` | Mengekspor session terbaru sebagai bundled Markdown atau structured JSON. |
| `abb rollback` | Mencetak safe manual rollback suggestions. |

Penggunaan detail: [docs/USAGE.md](docs/USAGE.md)

#### Yang Dihasilkan

Setiap session menghasilkan:

- `session.json`: structured metadata, events, commands, Git snapshot, risks, dan possible secrets.
- `summary.md`: ringkasan singkat yang fokus pada review.
- `commands.md`: command metadata yang direkam melalui `abb run`.
- `timeline.md`: chronological file and command timeline.
- `diff-summary.md`: Git status, changed files, line counts jika tersedia, dan notable categories.
- `risks.md`: risky files, possible secrets, dependency/config changes, CI/CD changes, dan review checklist.
- `rollback.md`: manual review dan rollback suggestions.

`session.json` juga mencakup deterministic risk summary, file kind dan size metadata jika tersedia, detail line-stat source, serta integrity metadata untuk malformed session records yang dilewati saat recovery.

Detail laporan: [docs/REPORTS.md](docs/REPORTS.md)

#### Model Privasi Dan Keamanan

Agent Black Box dirancang untuk private repositories:

- Local-first secara default.
- Tidak ada telemetry.
- Tidak ada external AI API.
- Tidak ada repository upload.
- Tidak menangkap terminal output.
- Possible secret values disamarkan di reports.
- Rollback hanya advisory dan tidak pernah otomatis.

Command capture bersifat opt-in. Hanya commands yang dijalankan melalui `abb run -- <command>` yang direkam, dan sensitive-looking arguments disamarkan sebelum ditulis.

#### Yang Tidak Bisa Diamati

Agent Black Box hanya melaporkan observable evidence. Ia tidak bisa melihat:

- Hidden reasoning dari AI agent.
- Prompts atau private model state.
- Editor state.
- Browser state.
- Shell history untuk commands yang tidak dijalankan melalui `abb run`.
- Mengapa perubahan terjadi.

Reports sengaja memakai bahasa hati-hati seperti "possible", "likely", dan "detected from repository changes".

#### Kualitas Proyek

- TypeScript strict mode.
- Vitest test coverage untuk core behavior.
- GitHub Actions CI untuk typecheck, build, dan tests.
- CodeQL analysis.
- Dependabot untuk patch/minor maintenance.
- Tag-driven release workflow.
- Versioned JSON Schema untuk `.agentblackbox.json`.
- MIT license.
- Security reporting guide.
- Contribution guide.

Catatan arsitektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

#### Development

```sh
pnpm install
pnpm check
```

Jalankan CLI secara lokal:

```sh
pnpm dev -- --help
```

Setelah build:

```sh
node dist/cli.js --help
```

#### Roadmap

Peningkatan jangka dekat:

- Browser laporan opsional bergaya TUI.
- Persiapan npm publish.
- Repository fixture suite untuk lebih banyak ekosistem bahasa.

Di luar cakupan MVP:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Integrasi private agent API.
- Automatic destructive rollback.
- Paid AI features.

#### Maintainer

𝓐.𝓒.𝓑

#### License

MIT. Lihat [LICENSE](LICENSE).

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
