<a id="top"></a>

# Agent Black Box

Local-first CLI for reviewing repository changes and risk signals during AI-assisted coding.

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Read this in:** [English](#english) · [Türkçe](#turkce)

---

<a id="english"></a>

## English

### Overview

Agent Black Box records file events, Git evidence, and the commands you run through it, then writes reports you can review before committing. It never reads agent prompts, uploads repository data, or captures terminal output.

### Features

- Session recording with a Git baseline; pre-existing changes are kept apart from new ones.
- Redacted command history through `abb run`.
- Risk and possible-secret findings, plus watcherless and staged analysis with text, JSON, and SARIF output.
- CI policies (`new-secrets`, `complete-review`) that compare staged content against a fixed commit.
- Session history, comparison, integrity verification, verified archives, and guarded pruning and rollback.

### Requirements

Node.js 22 or newer, Git on PATH, and pnpm.

### Installation

```sh
pnpm install --frozen-lockfile
pnpm build
```

The examples use `abb`; substitute `pnpm dev` (source) or `node dist/cli.js` (after `pnpm build`).

### Usage

```sh
pnpm dev init # Optional: writes .agentblackbox.json; built-in defaults apply without it
pnpm dev start
```

Leave the watcher running. In another terminal:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

| Purpose               | Commands                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Setup and diagnostics | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                                             |
| Recording             | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                                                  |
| Independent analysis  | `abb analyze`                                                                                                                   |
| History               | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>`, `abb sessions verify` |
| Retention             | `abb sessions archive`, `abb sessions prune`                                                                                    |
| Reports               | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`                          |

Completed sessions are stored in `.agent-black-box/sessions/<session-id>/` as `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md`, and `rollback.md`. Select one with `--session <id>` using a full ID, a unique prefix, or `latest`. Reports separate pre-existing changes, watcher observations, and final Git evidence, including commits made between the starting and ending HEAD.

For a SARIF review of staged content against a fixed commit in CI:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets` fails on newly detected possible secrets; `complete-review` also fails when required content could not be scanned. Both require `--staged --baseline`.

Secret detection and command redaction are heuristic, so review reports before sharing them. Commands run outside `abb run` are not recorded. Archive, prune, and rollback preview first and need an interactive terminal with typed confirmation.

### Configuration

Optional `.agentblackbox.json`, validated by [`schema/agentblackbox.schema.json`](schema/agentblackbox.schema.json). Settings and defaults are in [Usage](docs/USAGE.md#setup-and-configuration).

Further reading: [Usage](docs/USAGE.md), [Reports](docs/REPORTS.md), [Architecture](docs/ARCHITECTURE.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md).

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm check` runs formatting, lint, types, dead-code checks, build, and coverage tests.

### License

[MIT](LICENSE) © 𝓐.𝓒.𝓑

[⬆ Back to top](#top)

---

<a id="turkce"></a>

## Türkçe

### Genel Bakış

Agent Black Box; dosya olaylarını, Git verilerini ve kendi üzerinden çalıştırdığınız komutları kaydeder, commit öncesi inceleyebileceğiniz raporlar üretir. Ajan istemlerini okumaz, depo verisini dışarı göndermez, terminal çıktısını kaydetmez.

### Özellikler

- Git başlangıç durumunu esas alan oturum kaydı; önceden var olan değişiklikler yenilerden ayrı tutulur.
- `abb run` ile maskelenmiş komut geçmişi.
- Risk ve olası gizli değer bulguları; izleyicisiz ve staged analiz (metin, JSON, SARIF çıktısı).
- Staged içeriği sabit bir commit ile karşılaştıran CI politikaları (`new-secrets`, `complete-review`).
- Oturum geçmişi, karşılaştırma, bütünlük doğrulaması, doğrulanmış arşiv ile onaylı silme ve geri alma.

### Gereksinimler

Node.js 22 veya üzeri, PATH üzerinde Git ve pnpm.

### Kurulum

```sh
pnpm install --frozen-lockfile
pnpm build
```

Örneklerde `abb` kullanılır; yerine `pnpm dev` (kaynak) veya `node dist/cli.js` (`pnpm build` sonrası) yazabilirsiniz.

### Kullanım

```sh
pnpm dev init # İsteğe bağlı: .agentblackbox.json yazar; dosya yoksa yerleşik varsayılanlar geçerlidir
pnpm dev start
```

İzleyiciyi açık bırakın. Başka bir terminalde:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

| Amaç                | Komutlar                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Kurulum ve tanılama | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                                             |
| Kayıt               | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                                                  |
| Bağımsız analiz     | `abb analyze`                                                                                                                   |
| Geçmiş              | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>`, `abb sessions verify` |
| Saklama             | `abb sessions archive`, `abb sessions prune`                                                                                    |
| Raporlar            | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`                          |

Tamamlanan oturumlar `.agent-black-box/sessions/<session-id>/` altında `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md` ve `rollback.md` dosyalarıyla saklanır. Birini seçmek için `--session <id>` ile tam kimlik, benzersiz ön ek veya `latest` kullanın. Raporlar önceden var olan değişiklikleri, izleyici gözlemlerini ve son Git verilerini ayırır; başlangıç ile bitiş HEAD arasında yapılan commit'leri de gösterir.

CI'da staged içeriği sabit bir commit ile karşılaştırıp SARIF çıktısı almak için:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets`, yeni saptanan olası gizli değerlerde başarısız olur; `complete-review` ayrıca gerekli içerik taranamadığında da başarısız olur. İkisi de `--staged --baseline` gerektirir.

Gizli değer tespiti ve komut maskeleme sezgiseldir; raporları paylaşmadan önce gözden geçirin. `abb run` dışında çalıştırılan komutlar kaydedilmez. Arşivleme, silme ve geri alma önce önizleme gösterir; etkileşimli terminal ve yazılı onay ister.

### Yapılandırma

İsteğe bağlı `.agentblackbox.json`; [`schema/agentblackbox.schema.json`](schema/agentblackbox.schema.json) ile doğrulanır. Ayarlar ve varsayılanlar [Usage](docs/USAGE.md#setup-and-configuration) belgesindedir.

Devamı: [Usage](docs/USAGE.md), [Reports](docs/REPORTS.md), [Architecture](docs/ARCHITECTURE.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md).

### Katkı

[CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın. `pnpm check` biçimlendirme, lint, tür denetimi, kullanılmayan kod kontrolü, derleme ve kapsam testlerini çalıştırır.

### Lisans

[MIT](LICENSE) © 𝓐.𝓒.𝓑

[⬆ Başa Dön](#top)
