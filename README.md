# Agent Black Box

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Languages

[English](#english) · [Türkçe](#turkce)

<a id="english"></a>

## English

Agent Black Box is a local-first CLI for reviewing observable repository changes during AI-assisted coding. It records file events, Git evidence, and commands you explicitly run through it, then produces reports that help you inspect a session before committing.

The tool works alongside coding agents without accessing their prompts or internal state. It does not upload repository data or capture terminal output.

### Get started

Requires Node.js 22 or newer, pnpm, and a Git repository. From a source checkout:

```sh
pnpm install
pnpm dev init
pnpm dev start
```

Leave `start` running. In another terminal, optionally record a command, then stop the session and review its reports:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

Reports are stored in `.agent-black-box/sessions/<session-id>/`. The examples below use `abb`; in a source checkout, use `pnpm dev` instead, or run `pnpm build` and then `node dist/cli.js`.

### What you can do

| Task                      | Commands                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Configure and diagnose    | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                      |
| Record a session          | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                           |
| Analyze without recording | `abb analyze`                                                                                            |
| Explore history           | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>` |
| Manage older sessions     | `abb sessions archive`, `abb sessions prune`                                                             |
| Read and export reports   | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`   |

For a CI review of staged changes, compare index content with a fixed commit:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

The `new-secrets` policy fails on newly detected possible secrets. `complete-review` also fails when required staged or baseline content could not be scanned. Both policies require `--staged --baseline`. Text, JSON, and SARIF output identify skipped files and Git-verified rename sources without printing matched secret values. Findings are review signals, not proof of a vulnerability.

Browse completed sessions interactively with `abb sessions browse`, or select one by full ID, unique prefix, or `latest` with `--session <id>`. Archiving previews and then copies verified sessions; originals remain in place. Pruning previews deletion and requires typed confirmation to apply. Neither runs automatically.

### Reports and boundaries

A completed session contains `session.json`, compact `session-metadata.json`, and human-readable `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md`, and `rollback.md`. Reports distinguish changes already present at session start from activity observed during the session and Git changes found at finalization. Committed changes between the starting and ending HEAD remain visible even when the working tree ends clean.

Command recording is opt-in. Sensitive-looking values are redacted before metadata is written, but detection is heuristic: review reports and archives before sharing them. `abb rollback` gives manual guidance; interactive apply is limited to eligible tracked files from the latest completed session and requires confirmation. The tool cannot infer why a change happened or observe commands it did not run.

### Documentation and development

- [Usage guide](docs/USAGE.md): setup, analysis, history, recovery, and retention.
- [Report reference](docs/REPORTS.md): formats, evidence, and storage limits.
- [Architecture](docs/ARCHITECTURE.md): data flow and safety boundaries.
- [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md), [audit](docs/AUDIT.md), and [changelog](CHANGELOG.md).

Run `pnpm check` for formatting, lint, types, dead-code checks, build, and coverage tests. The project uses the [MIT license](LICENSE).

<a id="turkce"></a>

## Türkçe

Agent Black Box, yapay zekâ destekli kodlama sırasında depoda gözlemlenebilen değişiklikleri incelemek için geliştirilmiş, yerel çalışan bir komut satırı aracıdır. Dosya olaylarını, Git verilerini ve özellikle araç üzerinden çalıştırdığınız komutları kaydeder; commit öncesi inceleyebileceğiniz raporlar üretir.

Kodlama ajanlarıyla birlikte çalışır; ancak onların istemlerine veya iç durumuna erişmez. Depo verilerini dışarı göndermez ve terminal çıktısını kaydetmez.

### Başlangıç

Node.js 22 veya üzeri, pnpm ve bir Git deposu gerekir. Kaynak koddan çalıştırmak için:

```sh
pnpm install
pnpm dev init
pnpm dev start
```

`start` komutunu açık bırakın. Başka bir terminalde isterseniz bir komutu kaydedin; ardından oturumu bitirip raporları inceleyin:

```sh
pnpm dev run -- pnpm test
pnpm dev stop
pnpm dev summary
pnpm dev risks
```

Raporlar `.agent-black-box/sessions/<session-id>/` altında tutulur. Aşağıdaki örneklerde `abb` kullanılır. Kaynak koddan çalışırken bunun yerine `pnpm dev` yazabilir veya `pnpm build` sonrasında `node dist/cli.js` çalıştırabilirsiniz.

### Temel işlemler

| İşlem                           | Komutlar                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Yapılandırma ve tanılama        | `abb init`, `abb config validate`, `abb config migrate`, `abb doctor`, `abb status`                      |
| Oturum kaydı                    | `abb start`, `abb run -- <command>`, `abb stop`, `abb recover`                                           |
| Oturum açmadan analiz           | `abb analyze`                                                                                            |
| Geçmişi inceleme                | `abb sessions list`, `abb sessions browse`, `abb sessions show <id>`, `abb sessions compare <from> <to>` |
| Eski oturumları yönetme         | `abb sessions archive`, `abb sessions prune`                                                             |
| Raporları okuma ve dışa aktarma | `abb report`, `abb summary`, `abb commands`, `abb timeline`, `abb risks`, `abb export`, `abb rollback`   |

CI ortamında Git'e eklenmiş değişiklikleri sabit bir commit ile karşılaştırabilirsiniz:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

`new-secrets`, karşılaştırılan commit'te bulunmayan olası gizli değerler saptandığında işlemi başarısız sayar. `complete-review`, Git'e eklenmiş dosyalar veya karşılaştırma için gereken başlangıç dosyaları taranamadığında da başarısız olur. İki politika da `--staged --baseline` gerektirir. Metin, JSON ve SARIF çıktıları atlanan dosyaları ve Git'in doğruladığı yeniden adlandırma kaynaklarını gösterir; eşleşen gizli değerleri yazdırmaz. Bulgular, kesin güvenlik açığı tespiti değil, inceleme işaretleridir.

Tamamlanmış oturumları `abb sessions browse` ile etkileşimli inceleyebilirsiniz. Tam kimlik, benzersiz ön ek veya `latest` seçimi için `--session <id>` kullanılır. Arşivleme önce önizleme gösterir, ardından doğrulanmış kopyalar oluşturur; asıl oturumları silmez. Eski oturumları silme işlemi de önce önizlenir ve uygulanması için yazılı onay gerekir. Bu işlemler kendiliğinden çalışmaz.

### Raporlar ve sınırlar

Tamamlanan her oturumda yapılandırılmış `session.json`, kısa geçmiş kaydı `session-metadata.json` ve okunabilir `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md` ile `rollback.md` bulunur. Raporlar oturum başında zaten var olan değişiklikleri, oturum sırasında gözlenenleri ve sonlandırma sırasında Git'te bulunanları ayırır. Başlangıç ve bitiş HEAD commit'leri arasındaki değişiklikler, çalışma dizini sonradan temizlense bile görünür.

Komut kaydı isteğe bağlıdır. Hassas görünen değerler komut bilgileri yazılmadan önce maskelenir; yine de bu tespit kusursuz değildir. Raporları veya arşivleri paylaşmadan önce inceleyin. `abb rollback` elle uygulayabileceğiniz öneriler verir. Etkileşimli geri alma yalnızca son tamamlanmış oturumdaki uygun, Git tarafından izlenen dosyalar için kullanılabilir ve onay ister. Araç, bir değişikliğin neden yapıldığını veya kendi üzerinden çalıştırılmayan komutları bilemez.

### Belgeler ve geliştirme

- [Kullanım kılavuzu](docs/USAGE.md): kurulum, analiz, geçmiş, kurtarma ve saklama.
- [Rapor başvurusu](docs/REPORTS.md): biçimler, kanıtlar ve depolama sınırları.
- [Mimari](docs/ARCHITECTURE.md): veri akışı ve güvenlik sınırları.
- [Katkı rehberi](CONTRIBUTING.md), [güvenlik politikası](SECURITY.md), [denetim](docs/AUDIT.md) ve [değişiklik günlüğü](CHANGELOG.md).

Biçimlendirme, lint, tür denetimi, kullanılmayan kod kontrolü, derleme ve kapsam testleri için `pnpm check` çalıştırın. Proje [MIT lisansı](LICENSE) ile sunulur.
