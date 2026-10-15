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
- Redacted command history through `abb run`, with `--private` to withhold all command text and user labels.
- Risk and possible-secret findings, plus watcherless and staged analysis with text, JSON, and SARIF output.
- CI policies (`new-secrets`, `complete-review`) that compare staged content against a fixed commit.
- A managed Git pre-commit hook (`abb hook install`) with explicit first-commit policy and external-storage options.
- Your own secret patterns and a documented allowlist in `.agentblackbox.json`, applied to both detectors and to command redaction.
- Session history, comparison, integrity verification, verified archives, guarded pruning and rollback, and recovery with optional record/wait limits and an observed RSS threshold.
- Possible-secret location comparisons, explicit derived-index repair, verified archive resume, and optional aggregate analysis budgets.
- Optional `pnpm audit:isolated` with kernel-enforced memory, read-only source access and no network; see [isolation guidance](docs/USAGE.md#os-isolated-analysis).
- Pull request comments (`abb pr-comment`) and SARIF export for recorded sessions.

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
| Git hook              | `abb hook install`, `abb hook uninstall`, `abb hook status`                                                                     |
| History               | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>`, `abb sessions verify` |
| Retention             | `abb sessions archive`, `abb sessions prune`                                                                                    |
| Reports               | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb pr-comment`, `abb rollback`        |

Optional evidence sealing: `abb sessions sign`. See [Evidence security](docs/EVIDENCE-SECURITY.md) for independently trusted keys and verification limits.

Completed sessions are stored in `.agent-black-box/sessions/<session-id>/` as `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md`, and `rollback.md`. Select one with `--session <id>` using a full ID, a unique prefix, or `latest`. Reports separate pre-existing changes, watcher observations, and final Git evidence, including commits made between the starting and ending HEAD.

For a SARIF review of staged content against a fixed commit in CI:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets` fails on newly detected possible secrets; `complete-review` also fails when required content could not be scanned. Both require `--staged` with `--baseline`, or explicit `--initial` before the first commit. History commands also support opt-in encoded-input budgets; see [Usage](docs/USAGE.md#history-and-retention).

Install the managed hook for staged reviews (foreign hooks require an explicit replacement with backup). Its first commit defaults to a high-severity gate; opt into the selected policy with `--first-commit policy`:

```sh
abb hook install
```

To share a recorded session, print a pull request comment or export it for code scanning. Neither command uploads anything; posting is your own command:

```sh
abb pr-comment | gh pr comment --body-file -
abb export --format sarif --output session.sarif
```

Add your own patterns, and documented exceptions, to `.agentblackbox.json`:

```json
{
  "secretPatterns": [{ "name": "Internal token", "pattern": "corp_[a-z0-9]{16}" }],
  "secretAllowlist": [{ "path": "tests/fixtures", "reason": "synthetic credentials" }]
}
```

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
- `abb run` ile maskelenmiş komut geçmişi; `--private` ile komut metni ve kullanıcı etiketlerini tamamen kayıttan çıkarma.
- Risk ve olası gizli değer bulguları; izleyicisiz ve staged analiz (metin, JSON, SARIF çıktısı).
- Staged içeriği sabit bir commit ile karşılaştıran CI politikaları (`new-secrets`, `complete-review`).
- İlk commit politikası ve harici depolama için açık seçenekleri olan yönetilen bir Git pre-commit hook'u (`abb hook install`).
- `.agentblackbox.json` içinde kendi gizli değer desenleriniz ve gerekçeli bir izin listesi; iki dedektöre ve komut maskelemeye de uygulanır.
- Oturum geçmişi, karşılaştırma, bütünlük doğrulaması, doğrulanmış arşiv, onaylı silme ve geri alma; isteğe bağlı kayıt/bekleme sınırları ve gözlemlenen RSS eşiğiyle kurtarma.
- Olası gizli değer konumlarını karşılaştırma, açık seçimle türetilmiş indeks onarımı, doğrulanmış arşive devam etme ve isteğe bağlı toplam analiz bütçesi.
- Kernel bellek sınırı, salt okunur kaynak erişimi ve kapalı ağ ile isteğe bağlı `pnpm audit:isolated`; [izolasyon rehberine](docs/USAGE.md#os-isolated-analysis) bakın.
- Pull request yorumları (`abb pr-comment`) ve kayıtlı oturumlar için SARIF dışa aktarımı.

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
| Git hook'u          | `abb hook install`, `abb hook uninstall`, `abb hook status`                                                                     |
| Geçmiş              | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>`, `abb sessions verify` |
| Saklama             | `abb sessions archive`, `abb sessions prune`                                                                                    |
| Raporlar            | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb pr-comment`, `abb rollback`        |

İsteğe bağlı kanıt imzalama: `abb sessions sign`. Bağımsız güvenilen anahtarlar ve doğrulama sınırları için [Kanıt güvenliği](docs/EVIDENCE-SECURITY.md) belgesine bakın.

Tamamlanan oturumlar `.agent-black-box/sessions/<session-id>/` altında `session.json`, `session-metadata.json`, `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md` ve `rollback.md` dosyalarıyla saklanır. Birini seçmek için `--session <id>` ile tam kimlik, benzersiz ön ek veya `latest` kullanın. Raporlar önceden var olan değişiklikleri, izleyici gözlemlerini ve son Git verilerini ayırır; başlangıç ile bitiş HEAD arasında yapılan commit'leri de gösterir.

CI'da staged içeriği sabit bir commit ile karşılaştırıp SARIF çıktısı almak için:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets`, yeni saptanan olası gizli değerlerde başarısız olur; `complete-review` ayrıca gerekli içerik taranamadığında da başarısız olur. İkisi de `--staged` ile `--baseline` veya ilk commit öncesinde açık `--initial` seçeneği gerektirir. Geçmiş komutlarında isteğe bağlı kodlanmış girdi bütçeleri de kullanılabilir; ayrıntılar [Kullanım](docs/USAGE.md#history-and-retention) belgesindedir.

Staged inceleme için yönetilen hook'u kurun (yabancı hook'u değiştirmek açık seçim ve yedek gerektirir). İlk commit varsayılan olarak yüksek önem eşiğini kullanır; seçilen politikayı uygulamak için `--first-commit policy` seçeneğini ekleyin:

```sh
abb hook install
```

Kaydedilen bir oturumu paylaşmak için pull request yorumu üretin veya kod taraması için dışa aktarın. İki komut da hiçbir şey yüklemez; göndermek sizin komutunuzdur:

```sh
abb pr-comment | gh pr comment --body-file -
abb export --format sarif --output session.sarif
```

Kendi desenlerinizi ve gerekçeli istisnalarınızı `.agentblackbox.json` içine ekleyin:

```json
{
  "secretPatterns": [{ "name": "Internal token", "pattern": "corp_[a-z0-9]{16}" }],
  "secretAllowlist": [{ "path": "tests/fixtures", "reason": "synthetic credentials" }]
}
```

Gizli değer tespiti ve komut maskeleme sezgiseldir; raporları paylaşmadan önce gözden geçirin. `abb run` dışında çalıştırılan komutlar kaydedilmez. Arşivleme, silme ve geri alma önce önizleme gösterir; etkileşimli terminal ve yazılı onay ister.

### Yapılandırma

İsteğe bağlı `.agentblackbox.json`; [`schema/agentblackbox.schema.json`](schema/agentblackbox.schema.json) ile doğrulanır. Ayarlar ve varsayılanlar [Usage](docs/USAGE.md#setup-and-configuration) belgesindedir.

Devamı: [Usage](docs/USAGE.md), [Reports](docs/REPORTS.md), [Architecture](docs/ARCHITECTURE.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md).

### Katkı

[CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın. `pnpm check` biçimlendirme, lint, tür denetimi, kullanılmayan kod kontrolü, derleme ve kapsam testlerini çalıştırır.

### Lisans

[MIT](LICENSE) © 𝓐.𝓒.𝓑

[⬆ Başa Dön](#top)
