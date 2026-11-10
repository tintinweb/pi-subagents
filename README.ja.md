# @tintinweb/pi-subagents

<!-- full-readme: README.md · https://github.com/tintinweb/pi-subagents/blob/master/README.md -->

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a>
</p>

> これは英語版 README の一部を翻訳したものです（機械翻訳のため、誤りのご指摘を歓迎します）。概要、機能、インストール、クイックスタート、`/agents` コマンドのみを収録しています。UI、カスタムエージェント、ツールのパラメーター、設定とデフォルト値、イベント、RPC などその他の内容は英語版でのみ提供しています。全文は [英語版 README（完全版）](README.md) を参照してください。
>
> *Partial translation of the English README. Full reference: [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-dark.svg">
    <img src="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-light.svg" alt="@tintinweb/pi-subagents" width="520">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/v/@tintinweb/pi-subagents?color=cb3837&logo=npm" alt="npm バージョン"></a>
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/dm/@tintinweb/pi-subagents" alt="npm ダウンロード数"></a>
  <a href="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml"><img src="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@tintinweb/pi-subagents" alt="ライセンス: MIT"></a>
</p>
<p align="center">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%E2%89%A5%201.1.0-6f42c1" alt="pi >= 1.1.0 が必要"></a>
  <a href="https://pi.dev/packages/@tintinweb/pi-subagents"><img src="https://img.shields.io/badge/pi.dev-package-5b5bd6" alt="pi.dev パッケージ"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-compatible%20tools%20%26%20workflows-d97757" alt="Claude Code 互換">
  <a href="https://github.com/tintinweb/pi-subagents/commits/master"><img src="https://img.shields.io/github/last-commit/tintinweb/pi-subagents" alt="最終コミット"></a>
</p>

<h3 align="center">pi のための Claude Code スタイルのサブエージェントとワークフローオーケストレーション。</h3>

<p align="center">
  <a href="#インストール"><b>インストール</b></a> ·
  <a href="#クイックスタート"><b>クイックスタート</b></a> ·
  <a href="README.md#ui"><b>UI (EN)</b></a> ·
  <a href="README.md#custom-agents"><b>カスタムエージェント (EN)</b></a> ·
  <a href="README.md#tools"><b>ツール (EN)</b></a> ·
  <a href="README.md#persistent-settings"><b>設定 (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md"><b>ワークフロー (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/CHANGELOG.md"><b>変更履歴 (EN)</b></a>
</p>

<p align="center"><code>pi install npm:@tintinweb/pi-subagents</code></p>

**Claude Code スタイルの自律型サブエージェントとワークフローオーケストレーション**を実現する [pi](https://pi.dev) 拡張機能です。独立したセッションで動く専用エージェントを起動でき、各エージェントはそれぞれ独自のツール、システムプロンプト、モデル、思考レベルを持ちます。バックグラウンドで実行する（デフォルト）ことも、完了までブロックすることもできます。実行中にステアリング（指示を送って軌道修正）したり、完了したセッションを再開したり、独自のエージェントタイプを定義したりできます。オーケストレーションをその場の判断に任せるべきでない場合は、決定論的な JavaScript スクリプトを `SubagentWorkflow` ツールに渡します（`agent()`、`parallel()`、`pipeline()`）。Claude Code の `Workflow` ツール向けに書かれたスクリプトは、ここでも変更なしで動きます。

<img width="600" alt="pi-subagents のスクリーンショット" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## 機能

- **Claude Code と同じ見た目と操作感**：ツール名、呼び出し規約、UI パターン（`Agent`、`get_subagent_result`、`steer_subagent`）が同じで、ネイティブ機能のように感じられます
- **並列バックグラウンドエージェント**：複数のエージェントを同時に実行でき、自動でキューイングされます（同時実行数の上限は設定可能、デフォルトは 10）。完了通知は親エージェントの次のターンの切れ目で届き、同時に完了した場合はまとめて届きます
- **ライブウィジェット UI**：エディターの上に常駐するウィジェットで、アニメーションするスピナー、ツールの動作状況のリアルタイム表示、トークン数、色付きのステータスアイコンを表示します。`/agents → Settings → Widget` で設定できます：`all`（すべてのエージェント）、`background`（デフォルト。フォアグラウンド実行は `Agent` ツールの結果としてすでにインライン表示されるため非表示）、`off`
- **FleetView**：エディターの下に表示される、Claude Code スタイルの操作可能なリストで、`main` と実行中のすべてのサブエージェントが並びます（起動が早い順）。空のプロンプトで `↓`（または `←`）を押すとリストにフォーカスが移り、`↑`/`↓` で選択を移動、`Enter` で選択したエージェントの会話を開き（リアルタイムで自動更新されます）、`Esc` で戻ります。完了したエージェントは少しの間残ってから消えます。ビューアーは完了後も開いたままなので、最終出力を読めます。`/agents → Settings → Fleet view` で切り替えます
- **会話ビューアー**：`/agents` で任意のエージェントを選ぶと、その会話全体をリアルタイムでスクロール表示するオーバーレイが開きます（新しい内容に自動で追従し、上にスクロールすると一時停止）。pi のフルスクリーンモードでは、枠なしで端末全体を使う、マウス対応の観察画面になります。`Enter` で入力欄を開き、入力して `Enter` で送信すると、実行中のエージェントをその場でステアリングできます（`Esc` または空のまま送信で戻ります）。メッセージはユーザーメッセージとして表示され、エージェントは現在のツール呼び出しを終えた後、その指示に沿って方向を変えます。実行中のフォアグラウンド `Agent` 呼び出しで `b` を押すと、その実行をバックグラウンドに移せます（[フォアグラウンドのエージェントをバックグラウンドに移す](#フォアグラウンドのエージェントをバックグラウンドに移す)を参照）。まだ実行中のエージェントは `x` を押す（確認のためもう一度 `x`）と停止できます。ステアリングと停止はバックグラウンドのエージェントにも使えます。ツール呼び出しは、エージェントのセッションに登録されたレンダラーを通じて、pi 自身のトランスクリプトと同じように表示されます：bash 呼び出しはコマンドと出力、`read` は行番号、`edit` は差分、拡張機能のツールは独自のレンダラーで表示され、レンダラーのないツールは引数と長さ制限付きの出力プレビューにフォールバックします。`ctrl+o`（または `app.tools.expand` に割り当てたキー）で省略されたツール出力を展開します。アシスタントのテキストは Markdown として描画され、`m` で「オフ」「アシスタントのみ」「すべて」の 3 つを切り替えます（[Viewer markdown](README.md#persistent-settings) を参照）
- **カスタムエージェントタイプ**：`.pi/agents/<name>.md` または `.agents/agents/<name>.md`（プロジェクト）、あるいはグローバルにエージェントを定義します。YAML frontmatter で、システムプロンプト、モデル選択、思考レベル、ツール制限、Claude Code 互換の色付き名前バッジを指定できます
- **パッケージ同梱のエージェント**：pi パッケージは `package.json` に `"pi": { "subagents": { "agents": ["./agents"] } }` と書くことで、独自のサブエージェント（とワークフロースクリプト）を宣言できます。`pi install` だけでセットアップが完了し、マシンごとやコンテナ起動のたびに `.pi/agents/` へファイルをコピーする必要はありません。読み込むのは pi が実際にインストールしたパッケージだけで（`node_modules` は決して読みません）、パッケージの定義はユーザーが定義したどのエージェントよりも優先度が低く、`/agents` では読み取り専用で表示され、Eject と Disable が使えます。`packageAgents` / `packageWorkflows` で対象を絞り込んだり、無効にしたりできます。**[詳細ガイド](https://github.com/tintinweb/pi-subagents/blob/master/docs/packages.md)**
- **ネストしたサブエージェント**：デフォルトでは無効で、明示的に有効化して使う委任機能です。`allowed_subagents` を設定したカスタムエージェントは、自身の子エージェントだけを対象とする独自の `Agent`、`get_subagent_result`、`steer_subagent` ツールを持ち、メインセッションからの深さには上限があります（デフォルトは 2）。操作できるのは自分の子エージェントだけで、自分が終了すると子エージェントは停止され、子のトランスクリプトとトークン消費は親に集計されます。この許可リストは権限の境界です。子エージェントは自身のツールで動くため、`tools:` そのものと同じくらい慎重に選んでください
- **エージェントメンション**：サブエージェントはファーストクラスの存在です。プロンプトで `@explore also check the RPC path` と入力すると、その内容はメインモデルではなくそのエージェントに届き、メインの会話には一切残りません。1 つの構文でライフサイクル全体を扱えます：実行中のエージェントにメッセージを送る、完了したエージェントを再開する、ずっと後になってからディスク上のセッションを開き直す、一度も実行されていなければ起動する。実行中でないエージェントをメンションすると、画面外で複製した会話を通じて起動されるため、Claude Code と同じように文脈を踏まえて書かれたプロンプトと本物の `Agent` ツール呼び出しが得られ、やはりメインの会話には一切残りません。`direct` モードでは、モデルを一切呼ばずに、入力したテキストからその場で起動します。オーケストレーターがエージェントに `name` を付ければ `@auth-audit` のように呼びかけられ、その名前は `steer_subagent`/`get_subagent_result` でも使えます。`@` を入力すると、pi のファイル補完に加えて、実行中のエージェント、再開可能なエージェント、起動可能なタイプが補完候補に表示されます。`@main` を付けると、テキストを強制的にメインモデルへ戻します。`/agents → Settings → Agent mentions` で切り替えます
- **スクリプトによるワークフロー**：`SubagentWorkflow` ツールは、多数のサブエージェントをオーケストレーションする決定論的な JavaScript スクリプトを実行します：`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`、`args` を使い、純粋なリテラルの `meta` ブロックでフェーズを宣言します。`pipeline()` にはステージ間のバリアがないため、ある項目が後のステージに進んでいる間に、別の項目がまだ最初のステージにあることもあります。これに対し `parallel()` は、最も遅いエージェントが終わるまで速いエージェントをすべて待たせます。ワークフローはライブカード付きでバックグラウンド実行され、`/agents → Workflows` または FleetView で実行を選ぶと中身を確認できます。`agent()` は `gate: "npm test"` も受け付け、別のモデルに尋ねる代わりにコマンドを実行して（分離されている場合はその worktree 内で）子エージェントを検証します。`resume: "<label>"` を使えば、コンテキストのコストを払い直さずに子エージェントを続行できます。スクリプトはワーカースレッド上の `node:vm` サンドボックスで実行され、そこでは `Date.now()`、`Math.random()`、`eval` は例外を投げます。デフォルトで有効ですが、競合する拡張機能がある場合は自動的に譲ります：別の拡張機能がすでに `Workflow` または `SubagentWorkflow` ツールを提供している場合、モデルに 2 つのオーケストレーターを見せる代わりに、警告を出してそのセッションでは自身を無効にします。`subagents.json` の `"workflowsEnabled"` か `/agents → Settings → Workflows` で、有効・無効のどちらかに固定できます。Claude Code の `Workflow` ツール向けに書かれたスクリプトは変更なしで動きます：グローバル変数は同じで、`schema` は Claude Code とまったく同じく検証済みのオブジェクトを返します。`budget` は存在しますが、常に「トークン目標なし」を返します（pi にはそのような指示がないため）。そのため `budget.total` で分岐するパターンも、作者が意図したとおりの分岐を通ります。ネストした `workflow()` で、保存済みのワークフローを 1 階層まで組み合わせられます。**[詳細ガイド](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md)**
- **実行中のステアリング**：実行中のエージェントにメッセージを差し込み、再起動せずに作業の方向を変えます
- **セッションの再開**：会話のコンテキストをすべて保ったまま、エージェントが止まったところから続けます。デフォルトではバックグラウンドで再開し、新しく起動したときと同じく完了時に通知します。`run_in_background: false` を渡すとブロックして結果をインラインで受け取ります
- **穏やかなターン制限**：エージェントは強制中断の前に「まとめに入る」よう警告を受けるため、途中で切れた出力ではなく、きれいな部分結果を返します
- **大文字小文字を区別しないエージェントタイプ**：`"explore"`、`"Explore"`、`"EXPLORE"` のいずれも使えます。タイプが**有効な**エージェントのちょうど 1 つに解決されない場合（不明、無効化済み、または大文字小文字だけが違う 2 つのエージェントで曖昧な場合）は、注記付きで general-purpose にフォールバックするか、[`fallbackSubagent: none`](README.md#persistent-settings) の場合は拒否されます
- **あいまいなモデル指定**：完全な ID の代わりに名前（`"haiku"`、`"sonnet"`）でモデルを指定でき、利用可能・設定済みのモデルだけに自動で絞り込まれます
- **コンテキストの継承**：必要に応じて親の会話をサブエージェントにフォークし、それまでの議論を把握させます
- **永続的なエージェントメモリ**：3 つのスコープ（project、local、user）があり、書き込みツールを持たないエージェントでは自動的に読み取り専用にフォールバックします
- **Git worktree による分離**：分離されたリポジトリのコピーでエージェントを実行します。完了時に変更はブランチへ自動コミットされます
- **スキルのプリロード**：名前を指定したスキルをエージェントのシステムプロンプトに注入します。スキルは `.pi/skills/`、`.agents/skills/` とグローバルな場所から検出されます（pi 標準の `<name>/SKILL.md` ディレクトリ構成に対応）
- **ツールの拒否リスト**：`disallowed_tools` frontmatter で特定のツールをブロックします
- **スタイル付きの完了通知**：バックグラウンドエージェントの結果は、生の XML ではなく、テーマに沿ったコンパクトな通知ボックス（アイコン、統計、結果のプレビュー）として描画されます。展開すると完全な出力を表示します。まとめて完了した場合も、エージェントごとに個別に描画されます
- **イベントバス**：ライフサイクルイベント（`subagents:created`、`started`、`completed`、`failed`、`steered`、`compacted`）とメッセージごとの消費記録（`subagents:usage`）を `pi.events` 経由で発行し、他の拡張機能がサブエージェントの動きに反応できるようにします
- **拡張機能間 RPC**：他の pi 拡張機能は、`pi.events` イベントバス（`subagents:rpc:ping`、`subagents:rpc:spawn`、`subagents:rpc:stop`、`subagents:rpc:consume`、`subagents:rpc:steer`）を通じて、サブエージェントの起動、停止、ステアリング、完了待ち（join）ができます。応答エンベロープは標準化されており、プロトコルはバージョン管理されています。セッション開始時に `subagents:ready` を発行します。**[詳細リファレンス](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md)**
- **サブエージェントのスケジュール実行**：`Agent` ツールに `schedule` を渡すと、cron、一定間隔、または 1 回限りで起動します。ジョブはセッション単位で、PID ロック付きで永続化されます。結果は手動で起動したバックグラウンドエージェントと同じ完了通知として届きます。`/agents → Scheduled jobs` で管理します
- **モデル範囲の強制**：明示的に有効化して使う検証機能で、サブエージェントが選ぶモデルが pi の `enabledModels` 許可リストの範囲内に収まるようにします（`/scoped-models` から取得し、グローバルとプロジェクトローカルの pi 設定の両方を反映）。呼び出し側が範囲外のモデルを指定した場合はオーケストレーターにハードエラーを返し、frontmatter で範囲外のモデルが固定されている場合は警告を出したうえでそのまま実行します（frontmatter を優先）。`/agents → Settings → Scope models` で切り替えます

## インストール

```bash
pi install npm:@tintinweb/pi-subagents
```

開発時には直接読み込むこともできます：

```bash
pi -e ./src/index.ts
```

pi **1.1.0 以降**が必要です。pi 0.86 と 0.87 でシステムプロンプトと会話履歴がセッションのトランスクリプトに移り、`@handle` による会話の複製とエージェントのトランスクリプトファイルはその仕組みの上に作られています。`peerDependencies` の範囲でこれを宣言しているため、古い pi ではインストール時に npm が警告します。

### その他のホスト

この拡張機能は [pi](https://pi.dev) を対象に開発・テストされています。

サードパーティのアダプターで他の環境でも動くという報告があります。これらは本プロジェクトとは独立して保守されています。本プロジェクトではテストしておらず、CI の対象外で、どのリリースでも互換性が壊れる可能性があります。

- **DeepSeek Harness (`dsh`)**：pi のホスト API をネイティブの DSH エージェントに対応付けるアダプター経由。詳細と報告：[#258](https://github.com/tintinweb/pi-subagents/issues/258)

## クイックスタート

親エージェントは `Agent` ツールでサブエージェントを起動します：

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

エージェントはデフォルトでバックグラウンド実行されます：呼び出しはすぐに ID を返し、完了時に結果のプレビュー付きで通知します（全文は `get_subagent_result` で取得します）。`run_in_background: false` を渡すと、エージェントが終わるまでブロックし、完全な出力をインラインで受け取ります。ブロック中に `ctrl+b` を押すとバックグラウンドに移せます（後述）。

### フォアグラウンドのエージェントをバックグラウンドに移す

フォアグラウンドの `Agent` 呼び出しの実行中に `ctrl+b` を押すと、Claude Code と同じようにバックグラウンドに移せます。同じ実行がそのまま続き（セッション、進行中のターン、トランスクリプト、worktree もそのまま）、ブロックしていた呼び出しは、`run_in_background: true` で起動した場合と同じ結果としてエージェント ID を返します。その後、完了は通常のバックグラウンド通知として届き、通知には元のツール呼び出しが表示されます。2 秒経つと、実行中の呼び出しの行に `(ctrl+b to run in background)` が表示されます。

- `ctrl+b` は、実行中のフォアグラウンド `Agent` 呼び出しをすべて一度に移します。1 つだけ移すには、その会話ビューアー（FleetView または `/agents → Running agents`）で `b` を押します。
- 拡張機能がこのキーを処理するのは、そうした呼び出しが実行中で、かつプロンプトエディターにフォーカスがあるときだけです。それ以外のとき（ダイアログやビューアーのステアリング入力欄の中も含む）、`ctrl+b` は pi のカーソル左移動のままです。FleetView を無効にしていると、拡張機能はどのコンポーネントにフォーカスがあるかを判別できないため、呼び出しが実行中であれば常にこのキーを使います。
- ヒントは並列呼び出しのまとまりごとに 1 つだけ、まだ実行中の最も早い呼び出しに表示されます。
- バックグラウンドに移したエージェントには、親での Esc は届かなくなります。`/agents → Running agents` で `x` を押して停止してください。
- 一方向の操作です：フォアグラウンドに戻す方法はありません。
- 同じアシスタントメッセージ内の他のツール呼び出しは、完了するまでモデルの次のターンを引き続きブロックします。pi は 1 つのメッセージのツール呼び出しを 1 つのバッチとして実行するためです。
- 次の場合は使えません：空きを待ってまだキューにあるフォアグラウンド呼び出し、フォアグラウンドの `resume`、ワークフローのエージェント、ネストした子エージェント。自動タイムアウトはありません。

### スケジュール

`schedule` フィールドを追加すると、今すぐ実行する代わりに、後で起動するようエージェントを登録します：

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

スケジュールの形式：

- **Cron**：6 フィールド（`second minute hour day-of-month month day-of-week`）。例：`"0 0 9 * * 1"` は毎週月曜の午前 9 時、`"0 */15 * * * *"` は 15 分ごと。
- **間隔**：`"5m"`、`"1h"`、`"30s"`、`"2d"`。その間隔で繰り返し起動します。
- **1 回限り（相対時刻）**：`"+10m"`、`"+2h"`、`"+1d"`。その時間が経過した時点で 1 回起動します。
- **1 回限り（絶対時刻）**：完全な ISO タイムスタンプ。例：`"2026-12-25T09:00:00.000Z"`。

スケジュールの時刻になると、エージェントはバックグラウンドで実行され、その完了通知は手動で起動したバックグラウンドエージェントと同じように届きます。親エージェントも同じように結果を踏まえて判断します。

スケジュールは**セッション単位**です：`/new` でリセットされ、`/resume` で復元されます。一覧表示とキャンセルは `/agents → Scheduled jobs` で行います（作成は `Agent` ツールの役割で、手動で作成するウィザードは別途ありません）。保存先は `<cwd>/.pi/subagent-schedules/<sessionId>.json` で、複数インスタンス間で安全に動作するよう PID ベースのファイルロックを使います。

**機能を完全に無効にする**：`/agents → Settings → Scheduling → disabled` で、`Agent` ツールの定義から `schedule` が削除され（LLM のコンテキストを消費しません）、メニュー項目が非表示になり、動作中のスケジューラーが停止します。定義からの削除は次の pi セッションから有効になり、実行時の停止はすぐに有効になります。同じメニューから再度有効にできます。

制限：
- `schedule` は `inherit_context`（起動時点では親の会話が存在しないため）や `resume`（スケジュールは常に新しいエージェントを作るため）と組み合わせられません。
- `run_in_background: false` は拒否されます：スケジュールされたジョブは常にバックグラウンドで実行されます。省略するか `true` を渡すのは問題ありません。
- スケジュールによる起動は `maxConcurrent` のキューを迂回するため、5 分間隔のジョブが長時間実行中の手動エージェントの後ろで待たされることはありません。
- **ヘッドレスの `pi -p` は、スケジュールされたサブエージェントを待ちません。**

## コマンド

| コマンド | 説明 |
|---------|-------------|
| `/agents` | 対話型のエージェント管理メニュー：エージェントタイプ、実行中のエージェント、スケジュールされたジョブ、ワークフローの実行、設定 |

ワークフローのインスペクターや CLI フラグなどの詳細は [英語版 README](README.md#commands) を参照してください。

## 詳細情報（英語）

この翻訳は README の一部のみを対象としています。ここに含まれていない内容については、[英語版 README（完全版）](README.md) を参照してください。

- [UI](README.md#ui)：FleetView、フルスクリーンの会話ビューアー、エージェントメンション
- [デフォルトのエージェントタイプ](README.md#default-agent-types)と[カスタムエージェント](README.md#custom-agents)：frontmatter のフィールド、ネストしたサブエージェント、ツールと拡張機能の範囲
- [ツール](README.md#tools)：`Agent`、`SubagentWorkflow`、`get_subagent_result`、`steer_subagent` のパラメーター表
- [永続設定](README.md#persistent-settings)：すべての設定とデフォルト値
- [イベント](README.md#events)と[拡張機能間 RPC](README.md#cross-extension-rpc)
- [ワークフローガイド](docs/workflows.md)、[RPC ガイド](docs/rpc.md)、[パッケージ同梱エージェント](docs/packages.md)
- [変更履歴](CHANGELOG.md)

## ライセンス

MIT — [tintinweb](https://github.com/tintinweb)

Full README (English): [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md

<!-- source: README.md @ 399f50e -->
