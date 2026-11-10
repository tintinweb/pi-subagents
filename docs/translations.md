# README translations

For maintainers updating `README.zh-CN.md`, `README.ja.md` or `README.ko.md`. The translations are condensed: they mirror only the intro, Features, Install, Quick Start and the `/agents` command, and link to the English `README.md` for everything else.

## When to update

A change to a mirrored section of `README.md` updates all three translations in the same change. Each translation ends with `<!-- source: README.md @ <sha> -->`; `git diff <sha> -- README.md` shows what changed since it was last synced. Bump the sha after syncing.

Mirrored sections: the header (tagline, install line), the intro paragraph, `## Features`, `## Install` (with `### Other hosts`), `## Quick Start` (with its two subsections), and the `/agents` row of `## Commands`.

Every translation must also keep the pointers to the full English README, so neither a reader nor an agent mistakes the subset for the whole:

- `<!-- full-readme: README.md · <absolute URL> -->` directly under the `#` title.
- A blockquote right under the language switcher: one line in the target language naming what is covered and saying the rest is English-only, then the English line `Partial translation of the English README. Full reference: …`.
- ` (EN)` on every header nav label that leads to English content.
- A closing "More details (English)" section that opens with a link to the full README.
- `Full README (English): [README.md](README.md) · <absolute URL>` as the last visible line.

The absolute URL is required alongside the relative link, because the relative link breaks wherever the file is read outside the repo, such as on npm, in raw views or in a fetched copy.

## Never translate

- Anything in a code span or code block, including comments inside code blocks.
- Tool names (`Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent`), slash commands, menu paths (`/agents → Settings → Widget`), setting keys, frontmatter fields, file paths, CLI flags, event and RPC channel names, keys and keybindings.
- Product names: pi, Claude Code, FleetView, npm, DeepSeek Harness, Git.
- `worktree`: it stays English, written as plain text, in all three languages.

## Glossary

| English | zh-CN | ja | ko |
|---|---|---|---|
| sub-agent / subagent | 子代理 | サブエージェント | 서브에이전트 |
| agent | 代理 | エージェント | 에이전트 |
| main / parent agent | 主代理 / 父代理 | メイン / 親エージェント | 메인 / 부모 에이전트 |
| workflow | 工作流 | ワークフロー | 워크플로 |
| orchestration | 编排 | オーケストレーション | 오케스트레이션 |
| background / foreground | 后台 / 前台 | バックグラウンド / フォアグラウンド | 백그라운드 / 포그라운드 |
| steer (mid-run) | 引导 | ステアリング (gloss once: 指示を送って軌道修正) | 스티어링 |
| deterministic | 确定性的 | 決定論的 | 결정론적 |
| spawn | 启动 | 起動 | 실행 |
| resume | 恢复 | 再開 | 재개 |
| session | 会话 | セッション | 세션 |
| thinking level | 思考级别 | 思考レベル | 사고 수준 |
| extension | 扩展 | 拡張機能 | 확장 |
| conversation viewer | 对话查看器 | 会話ビューアー | 대화 뷰어 |
| completion notification | 完成通知 | 完了通知 | 완료 알림 |
| Claude Code-style | Claude Code 风格的 | Claude Code スタイルの | Claude Code 스타일의 |
| Claude Code-compatible | 兼容 Claude Code 的 | Claude Code 互換の | Claude Code 호환 |

"-style" means the extension follows Claude Code's conventions; "-compatible" means it works the same way. Keep the two apart: never render "-style" as 兼容 / 互換 / 호환, or "-compatible" as 风格 / スタイル / 스타일.

## Register

- zh-CN: neutral technical prose, 你 rather than 您, full-width punctuation (，。：；（）), a space between Chinese text and Latin text or code.
- ja: です/ます form, full-width 、。：（）around Japanese text, a half-width space between Japanese text and Latin text or code.
- ko: 합니다 form, standard 띄어쓰기, half-width punctuation, particles attached directly to code spans (`Agent` 도구를).

## Verifying an update

1. Every code span and code block in the translation appears verbatim in `README.md`.
2. Every link and `README.md#anchor` resolves.
3. A reviewer reads the translation against the English source sentence by sentence. Pay particular attention to defaults, numbers, negations, conditionals and the "-style" / "-compatible" split.
4. Each file's header says it is machine-translated until a native speaker has reviewed it. Remove that note only after such a review.
