# Agent Black Box

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](#english) · [Türkçe](#turkce)

<a id="english"></a>

## English

Agent Black Box is a local CLI for reviewing repository changes during AI-assisted coding. It records file events, Git evidence, and commands explicitly run through it, then creates reports for review before committing. It does not access agent prompts, upload repository data, or capture terminal output.

### Quick start

Requires Node.js 22 or newer, Git on PATH, and pnpm. From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm dev init # Only if .agentblackbox.json does not already exist
pnpm dev start
```

Leave the watcher running. In another terminal:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

The examples below use `abb`; replace it with `pnpm dev`, or with `node dist/cli.js` after `pnpm build`.

### Commands

| Purpose               | Commands                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Setup and diagnostics | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                      |
| Recording             | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                           |
| Independent analysis  | `abb analyze`                                                                                            |
| History               | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>` |
| Retention             | `abb sessions archive`, `abb sessions prune`                                                             |
| Reports               | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`   |

For a SARIF CI review of staged content against a fixed commit:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets` fails on newly detected possible secrets; `complete-review` also fails when required staged or baseline content could not be scanned. Both require `--staged --baseline`.

### Reports and safety

Completed sessions live in `.agent-black-box/sessions/<session-id>/`: `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md`, and `rollback.md`. Select reports by full ID, unique prefix, or `latest` with `--session <id>`.

Reports distinguish pre-existing changes, watcher observations, and final Git evidence, including changes committed between the starting and ending HEAD. Secret detection and command redaction are heuristic; review reports before sharing. Commands outside `abb run` are not recorded.

Archive, prune, and rollback first show a preview. Applying them requires an interactive terminal and typed confirmation. Archives preserve originals; rollback is limited to eligible tracked files from the latest completed session.

### Documentation

- [Usage](docs/USAGE.md): setup, all command options, recovery, and retention.
- [Reports](docs/REPORTS.md): evidence, formats, and limits.
- [Architecture](docs/ARCHITECTURE.md): data flow and trust boundaries.
- [Contributing and releases](CONTRIBUTING.md), [security](SECURITY.md), [audit](docs/AUDIT.md), and [changelog](CHANGELOG.md).

Run `pnpm check` for formatting, lint, types, dead-code checks, build, and coverage tests. Licensed under [MIT](LICENSE).

<a id="turkce"></a>

## Türkçe

Agent Black Box, yapay zekâ destekli kodlama sırasında depodaki değişiklikleri inceleyen yerel bir komut satırı aracıdır. Dosya olaylarını, Git verilerini ve araç üzerinden çalıştırılan komutları kaydeder; commit öncesi inceleme raporları üretir. Ajan istemlerine erişmez, depo verilerini dışarı göndermez ve terminal çıktısını kaydetmez.

### Hızlı başlangıç

Node.js 22 veya üzeri, PATH üzerinde Git ve pnpm gerekir. Kaynak koddan çalıştırmak için:

```sh
pnpm install --frozen-lockfile
pnpm dev init # Yalnızca .agentblackbox.json henüz yoksa
pnpm dev start
```

Dosya izleyiciyi açık bırakın. Başka bir terminalde:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

Aşağıdaki örneklerde `abb` yerine `pnpm dev` veya `pnpm build` sonrasında `node dist/cli.js` kullanabilirsiniz.

### Komutlar

| Amaç                | Komutlar                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Kurulum ve tanılama | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                      |
| Kayıt               | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                           |
| Bağımsız analiz     | `abb analyze`                                                                                            |
| Geçmiş              | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>` |
| Saklama             | `abb sessions archive`, `abb sessions prune`                                                             |
| Raporlar            | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`   |

Git'e eklenen içeriği sabit bir commit ile karşılaştırıp CI için SARIF çıktısı üretin:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets`, yeni olası gizli değerler saptandığında işlemi başarısız sayar. `complete-review`, gerekli eklenmiş veya başlangıç içeriği taranamadığında da başarısız olur. İkisi de `--staged --baseline` gerektirir.

### Raporlar ve güvenlik

Tamamlanan oturumlar `.agent-black-box/sessions/<session-id>/` altında tutulur: `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md` ve `rollback.md`. Rapor seçmek için `--session <id>` ile tam kimlik, benzersiz ön ek veya `latest` kullanın.

Raporlar önceden var olan değişiklikleri, izleyici gözlemlerini ve son Git verilerini ayırır; başlangıç ve bitiş HEAD arasında commit edilen değişiklikleri de gösterir. Gizli değer tespiti ve komut maskeleme sezgiseldir; paylaşmadan önce raporları inceleyin. `abb run` dışında çalıştırılan komutlar kaydedilmez.

Arşivleme, silme ve geri alma önce önizleme gösterir. Uygulama için etkileşimli terminal ve yazılı onay gerekir. Arşivleme asıl oturumları korur; geri alma yalnızca son tamamlanmış oturumdaki uygun, Git tarafından izlenen dosyalara uygulanabilir.

### Belgeler

- [Kullanım](docs/USAGE.md): kurulum, tüm komut seçenekleri, kurtarma ve saklama.
- [Raporlar](docs/REPORTS.md): veriler, biçimler ve sınırlar.
- [Mimari](docs/ARCHITECTURE.md): veri akışı ve güven sınırları.
- [Katkı ve sürüm yayımlama](CONTRIBUTING.md), [güvenlik](SECURITY.md), [denetim](docs/AUDIT.md) ve [değişiklik günlüğü](CHANGELOG.md).

Biçimlendirme, lint, tür denetimi, kullanılmayan kod kontrolü, derleme ve kapsam testleri için `pnpm check` çalıştırın. Proje [MIT](LICENSE) lisanslıdır.
