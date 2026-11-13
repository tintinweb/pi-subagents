# @tintinweb/pi-subagents

<!-- full-readme: README.md · https://github.com/tintinweb/pi-subagents/blob/master/README.md -->

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>한국어</b>
</p>

> 이 문서는 영어 README의 일부만 번역한 것입니다(기계 번역, 오류 제보 환영). 소개, 기능, 설치, 빠른 시작, `/agents` 명령어만 담고 있습니다. UI, 사용자 정의 에이전트, 도구 매개변수, 설정과 기본값, 이벤트, RPC 등 나머지 내용은 영어로만 제공됩니다: [영어 README 전체](README.md).
>
> *Partial translation of the English README. Full reference: [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-dark.svg">
    <img src="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-light.svg" alt="@tintinweb/pi-subagents" width="520">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/v/@tintinweb/pi-subagents?color=cb3837&logo=npm" alt="npm 버전"></a>
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/dm/@tintinweb/pi-subagents" alt="npm 다운로드 수"></a>
  <a href="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml"><img src="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@tintinweb/pi-subagents" alt="라이선스: MIT"></a>
</p>
<p align="center">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%E2%89%A5%201.1.0-6f42c1" alt="pi >= 1.1.0 필요"></a>
  <a href="https://pi.dev/packages/@tintinweb/pi-subagents"><img src="https://img.shields.io/badge/pi.dev-package-5b5bd6" alt="pi.dev 패키지"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-compatible%20tools%20%26%20workflows-d97757" alt="Claude Code 호환">
  <a href="https://github.com/tintinweb/pi-subagents/commits/master"><img src="https://img.shields.io/github/last-commit/tintinweb/pi-subagents" alt="마지막 커밋"></a>
</p>

<h3 align="center">pi를 위한 Claude Code 스타일의 서브에이전트와 워크플로 오케스트레이션.</h3>

<p align="center">
  <a href="#설치"><b>설치</b></a> ·
  <a href="#빠른-시작"><b>빠른 시작</b></a> ·
  <a href="README.md#ui"><b>UI (EN)</b></a> ·
  <a href="README.md#custom-agents"><b>사용자 정의 에이전트 (EN)</b></a> ·
  <a href="README.md#tools"><b>도구 (EN)</b></a> ·
  <a href="README.md#persistent-settings"><b>설정 (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md"><b>워크플로 (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/CHANGELOG.md"><b>변경 이력 (EN)</b></a>
</p>

<p align="center"><code>pi install npm:@tintinweb/pi-subagents</code></p>

pi에 **Claude Code 스타일의 자율 서브에이전트와 워크플로 오케스트레이션**을 제공하는 [pi](https://pi.dev) 확장입니다. 독립된 세션에서 동작하는 전문 에이전트를 실행할 수 있으며, 각 에이전트는 자체 도구, 시스템 프롬프트, 모델, 사고 수준을 가집니다. 에이전트를 백그라운드에서 실행하거나(기본값) 완료될 때까지 기다릴 수 있고, 실행 중에 스티어링하거나, 완료된 세션을 재개하거나, 직접 에이전트 타입을 정의할 수 있습니다. 오케스트레이션을 즉흥적으로 진행하면 안 되는 경우에는 결정론적인 JavaScript 스크립트를 `SubagentWorkflow` 도구에 넘기면 됩니다(`agent()`, `parallel()`, `pipeline()`). Claude Code의 `Workflow` 도구용으로 작성한 스크립트는 여기서도 수정 없이 실행됩니다.

<img width="600" alt="pi-subagents 스크린샷" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## 기능

- **Claude Code와 같은 룩앤필**: 도구 이름, 호출 규칙, UI 패턴(`Agent`, `get_subagent_result`, `steer_subagent`)이 같아서 네이티브 기능처럼 느껴집니다
- **병렬 백그라운드 에이전트**: 여러 에이전트를 동시에 실행하며, 한도를 넘는 에이전트는 자동으로 대기열에 넣습니다(동시 실행 한도는 설정 가능, 기본값 10). 완료 알림은 부모 에이전트의 다음 경계 시점에 도착하며, 여러 에이전트가 함께 완료되면 알림도 한꺼번에 도착합니다
- **실시간 위젯 UI**: 편집기 위에 상주하는 위젯으로, 애니메이션 스피너, 실시간 도구 활동, 토큰 수, 색상 상태 아이콘을 보여 줍니다. `/agents → Settings → Widget`에서 설정합니다: `all`(모든 에이전트), `background`(기본값, 포그라운드 실행은 이미 `Agent` 도구 결과로 인라인 표시되므로 숨김), `off`
- **FleetView**: 편집기 아래에 표시되는 Claude Code 스타일의 탐색 가능한 목록으로, `main`과 실행 중인 모든 서브에이전트가 나옵니다(먼저 실행된 순). 빈 프롬프트에서 `↓`(또는 `←`)를 눌러 목록으로 들어가고, `↑`/`↓`로 선택을 옮기고, `Enter`로 선택한 에이전트의 대화를 실시간 자동 갱신 상태로 열고, `Esc`로 돌아옵니다. 완료된 에이전트는 잠시 남아 있다가 사라지며, 뷰어는 완료 후에도 열려 있으므로 최종 출력을 읽을 수 있습니다. `/agents → Settings → Fleet view`에서 켜고 끕니다
- **대화 뷰어**: `/agents`에서 아무 에이전트나 선택하면 전체 대화를 실시간으로 스크롤해 보여 주는 오버레이가 열립니다(새 내용을 자동으로 따라가며, 위로 스크롤하면 일시 정지). pi의 전체 화면 모드에서는 테두리 없이 터미널 전체를 쓰는, 마우스를 지원하는 관찰 화면이 됩니다. `Enter`로 입력창을 열고 내용을 입력한 뒤 `Enter`로 보내면 실행 중인 에이전트를 그 자리에서 스티어링할 수 있습니다(`Esc` 또는 빈 내용 제출 시 돌아감). 메시지는 사용자 메시지로 표시되며, 에이전트가 현재 도구 실행을 마친 뒤 방향을 바꿉니다. 실행 중인 포그라운드 `Agent` 호출에서 `b`를 누르면 그 실행을 백그라운드로 넘깁니다([포그라운드 에이전트를 백그라운드로 보내기](#포그라운드-에이전트를-백그라운드로-보내기) 참고). 아직 실행 중인 에이전트는 `x`를 누르면(확인을 위해 `x`를 한 번 더) 중지됩니다. 스티어링과 중지는 백그라운드 에이전트에도 동작합니다. 도구 호출은 에이전트 세션에 등록된 렌더러를 통해 pi 자체 트랜스크립트와 같은 방식으로 표시됩니다: bash 호출은 명령과 출력, `read`는 줄 번호, `edit`는 diff, 확장 도구는 자체 렌더러로 표시되고, 렌더러가 없는 도구는 인자와, 길이가 제한된 출력 미리보기로 대체됩니다. `ctrl+o`(또는 `app.tools.expand`에 지정된 키)로 생략된 도구 출력을 펼칩니다. 어시스턴트 텍스트는 Markdown으로 렌더링되며, `m`을 누르면 끄기, 어시스턴트만, 전체 순으로 전환됩니다([Viewer markdown](README.md#persistent-settings) 참고)
- **사용자 정의 에이전트 타입**: `.pi/agents/<name>.md` 또는 `.agents/agents/<name>.md`(프로젝트), 혹은 전역 위치에 에이전트를 정의합니다. YAML frontmatter로 시스템 프롬프트, 모델 선택, 사고 수준, 도구 제한, Claude Code 호환 색상 이름 배지를 지정합니다
- **패키지에 포함된 에이전트**: pi 패키지는 `package.json`에 `"pi": { "subagents": { "agents": ["./agents"] } }`를 넣어 자체 서브에이전트와 워크플로 스크립트를 선언할 수 있으므로, `pi install`만으로 설정이 끝납니다. 머신마다 또는 컨테이너가 시작될 때마다 `.pi/agents/`로 파일을 복사할 필요가 없습니다. pi가 실제로 설치한 패키지만 읽으며(`node_modules`는 절대 읽지 않음), 패키지 정의는 직접 작성한 어떤 에이전트보다도 우선순위가 낮고, `/agents`에서는 읽기 전용으로 표시되며 Eject와 Disable을 쓸 수 있습니다. `packageAgents` / `packageWorkflows`로 범위를 좁히거나 끌 수 있습니다. **[전체 가이드](https://github.com/tintinweb/pi-subagents/blob/master/docs/packages.md)**
- **중첩 서브에이전트**: 명시적으로 켜야 하며 기본값은 꺼져 있는 위임 기능입니다. `allowed_subagents`를 설정한 사용자 정의 에이전트는 소유 범위로 제한된 자체 `Agent`, `get_subagent_result`, `steer_subagent` 도구를 얻으며, 메인 세션 기준 중첩 깊이에 상한이 있습니다(기본값 2). 자기 자식 에이전트만 제어할 수 있고, 자신이 끝나면 자식 에이전트는 중지되며, 자식의 트랜스크립트와 토큰 사용량은 부모에게 합산됩니다. 이 허용 목록은 권한 경계입니다. 자식은 자신의 도구로 실행되므로, 이 목록은 `tools:` 자체만큼 신중하게 고르세요
- **에이전트 멘션**: 서브에이전트를 일급 대상으로 다룹니다. 프롬프트에 `@explore also check the RPC path`를 입력하면 메인 모델 대신 해당 에이전트에 전달되며, 채팅에는 한 글자도 들어가지 않습니다. 하나의 문법으로 전체 생명 주기를 다룹니다: 실행 중일 때 메시지 보내기, 완료된 뒤 재개하기, 한참 뒤에 디스크에서 세션 다시 열기, 한 번도 실행된 적이 없으면 시작하기. 실행 중이 아닌 에이전트를 멘션하면 화면 밖에서 복제한 대화를 통해 실행되므로, Claude Code처럼 컨텍스트를 바탕으로 작성된 프롬프트와 실제 `Agent` 도구 호출을 얻으면서도 채팅에는 한 글자도 들어가지 않습니다. `direct` 모드는 모델을 전혀 호출하지 않고 입력한 텍스트로 그 자리에서 바로 시작합니다. 오케스트레이터가 에이전트에 `name`을 붙이면 `@auth-audit`처럼 부를 수 있고, 이 이름은 `steer_subagent`/`get_subagent_result`에서도 쓸 수 있습니다. `@`은 pi의 파일 자동 완성과 함께 실행 중인 에이전트, 재개 가능한 에이전트, 시작 가능한 타입을 자동 완성합니다. `@main`은 텍스트를 강제로 메인 모델로 보냅니다. `/agents → Settings → Agent mentions`에서 켜고 끕니다
- **스크립트 워크플로**: `SubagentWorkflow` 도구는 여러 서브에이전트를 오케스트레이션하는 결정론적인 JavaScript 스크립트를 실행합니다: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`를 사용하고, 순수 리터럴 `meta` 블록으로 단계(phase)를 선언합니다. `pipeline()`은 스테이지 사이에 배리어가 없으므로, 한 항목이 뒤쪽 스테이지에 있는 동안 다른 항목은 아직 첫 스테이지에 있을 수 있습니다. 반면 `parallel()`은 가장 느린 에이전트가 끝날 때까지 빠른 에이전트를 모두 놀게 합니다. 워크플로는 실시간 카드와 함께 백그라운드에서 실행되며, `/agents → Workflows` 또는 FleetView에서 해당 실행을 선택해 살펴볼 수 있습니다. `agent()`는 `gate: "npm test"`도 받아, 다른 모델에 묻는 대신 명령을 실행해(격리된 경우 해당 worktree 안에서) 자식을 검증합니다. `resume: "<label>"`을 쓰면 컨텍스트 비용을 다시 치르지 않고 자식을 이어서 실행합니다. 스크립트는 워커 스레드의 `node:vm` 샌드박스에서 실행되며, 그 안에서 `Date.now()`, `Math.random()`, `eval`은 예외를 던집니다. 기본적으로 켜져 있지만 다른 확장과 겹치면 물러섭니다: 다른 확장이 이미 `Workflow` 또는 `SubagentWorkflow` 도구를 제공하면, 모델에 오케스트레이터 두 개를 보여 주는 대신 경고를 내고 해당 세션에서 스스로 비활성화됩니다. `subagents.json`의 `"workflowsEnabled"`나 `/agents → Settings → Workflows`로 켜짐 또는 꺼짐 상태로 고정할 수 있습니다. Claude Code의 `Workflow` 도구용으로 작성한 스크립트는 수정 없이 실행됩니다: 전역 객체가 같고, `schema`는 Claude Code에서와 똑같이 검증된 객체를 반환합니다. `budget`은 존재하지만 항상 토큰 목표가 없다고 보고하므로(pi에는 그런 지시가 없음), `budget.total`로 분기하는 패턴도 원래 의도한 분기를 탑니다. 중첩 `workflow()`로 저장된 워크플로를 한 단계 깊이까지 조합할 수 있습니다. **[전체 가이드](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md)**
- **실행 중 스티어링**: 실행 중인 에이전트에 메시지를 넣어 재시작 없이 작업 방향을 바꿉니다
- **세션 재개**: 전체 대화 컨텍스트를 유지한 채 에이전트가 멈춘 지점부터 이어서 진행합니다. 기본적으로 분리된 상태로 재개되며, 새로 실행할 때와 마찬가지로 완료 시 알려 줍니다. `run_in_background: false`를 넘기면 완료될 때까지 기다렸다가 결과를 인라인으로 받습니다
- **소프트 턴 제한**: 에이전트는 강제 중단 전에 "마무리하라"는 경고를 받으므로, 잘린 출력 대신 깔끔한 부분 결과를 냅니다
- **대소문자를 구분하지 않는 에이전트 타입**: `"explore"`, `"Explore"`, `"EXPLORE"` 모두 동작합니다. 타입이 **활성화된** 에이전트 정확히 하나로 결정되지 않으면(알 수 없음, 비활성화됨, 또는 대소문자만 다른 두 에이전트 사이에서 모호함) 안내 메시지와 함께 general-purpose로 대체되거나, [`fallbackSubagent: none`](README.md#persistent-settings)에서는 거부됩니다
- **퍼지(이름 기반) 모델 선택**: 전체 ID 대신 이름(`"haiku"`, `"sonnet"`)으로 모델을 지정하며, 사용 가능하거나 설정된 모델로 자동으로 걸러집니다
- **컨텍스트 상속**: 필요하면 부모 대화를 서브에이전트로 포크해, 지금까지 논의된 내용을 알게 합니다
- **영구 에이전트 메모리**: 세 가지 범위(project, local, user)가 있으며, 쓰기 도구가 없는 에이전트는 자동으로 읽기 전용으로 대체됩니다
- **Git worktree 격리**: 격리된 저장소 사본에서 에이전트를 실행합니다. 완료 시 변경 사항이 브랜치에 자동으로 커밋됩니다
- **스킬 사전 로드**: 이름을 지정한 스킬을 에이전트 시스템 프롬프트에 주입합니다. 스킬은 `.pi/skills/`, `.agents/skills/`, 전역 위치에서 찾습니다(pi 표준 `<name>/SKILL.md` 디렉터리 구조 지원)
- **도구 거부 목록**: `disallowed_tools` frontmatter로 특정 도구를 막습니다
- **스타일이 적용된 완료 알림**: 백그라운드 에이전트 결과는 원시 XML 대신 테마가 적용된 간결한 알림 상자(아이콘, 통계, 결과 미리보기)로 렌더링됩니다. 펼치면 전체 출력을 볼 수 있습니다. 여러 에이전트가 함께 완료되어도 에이전트별로 따로 렌더링됩니다
- **이벤트 버스**: 생명 주기 이벤트(`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`)와 메시지별 사용량 기록(`subagents:usage`)을 `pi.events`로 내보내, 다른 확장이 서브에이전트 활동에 반응할 수 있게 합니다
- **확장 간 RPC**: 다른 pi 확장은 `pi.events` 이벤트 버스(`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`, `subagents:rpc:steer`)를 통해 서브에이전트를 실행, 중지, 스티어링하고 완료를 기다릴(join) 수 있습니다. 응답 엔벌로프는 표준화되어 있고 프로토콜 버전을 관리합니다. 세션이 시작되면 `subagents:ready`를 내보냅니다. **[전체 레퍼런스](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md)**
- **서브에이전트 예약 실행**: `Agent` 도구에 `schedule`을 넘기면 cron, 일정 간격, 또는 1회성으로 실행됩니다. 작업은 세션 범위이며 PID 잠금으로 영속 저장됩니다. 결과는 수동으로 실행한 백그라운드 에이전트와 같은 완료 알림으로 도착합니다. `/agents → Scheduled jobs`에서 관리합니다
- **모델 범위 강제**: 명시적으로 켜는 검증 기능으로, 서브에이전트가 고르는 모델이 pi의 `enabledModels` 허용 목록 안에 있도록 합니다(`/scoped-models`에서 가져오며, 전역 및 프로젝트 로컬 pi 설정을 모두 반영). 호출자가 범위 밖 모델을 지정하면 오케스트레이터에 하드 오류를 반환하고, frontmatter에 범위 밖 모델이 고정되어 있으면 경고를 낸 뒤 그대로 실행합니다(frontmatter 우선). `/agents → Settings → Scope models`에서 켜고 끕니다

## 설치

```bash
pi install npm:@tintinweb/pi-subagents
```

개발 중에는 직접 로드할 수도 있습니다:

```bash
pi -e ./src/index.ts
```

pi **1.1.0 이상**이 필요합니다. pi 0.86과 0.87에서 시스템 프롬프트와 대화 기록이 세션 트랜스크립트로 옮겨졌고, `@handle` 대화 복제와 에이전트 트랜스크립트 파일은 이 모델을 바탕으로 만들어졌습니다. `peerDependencies` 범위에 이를 선언해 두었으므로, 오래된 pi에서는 설치 시 npm이 경고합니다.

### 기타 호스트

이 확장은 [pi](https://pi.dev)를 대상으로 개발하고 테스트합니다.

서드파티 어댑터들이 다른 환경에서 이 확장을 실행한다고 보고합니다. 이 어댑터들은 이 프로젝트와 별개로 유지 관리됩니다: 여기서 테스트하지 않으며, 우리 CI 대상이 아니고, 어느 릴리스에서든 호환성이 깨질 수 있습니다.

- **DeepSeek Harness (`dsh`)**: pi의 호스트 API를 네이티브 DSH 에이전트에 매핑하는 어댑터를 통해 동작합니다. 자세한 내용과 보고: [#258](https://github.com/tintinweb/pi-subagents/issues/258)

## 빠른 시작

부모 에이전트는 `Agent` 도구로 서브에이전트를 실행합니다:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

에이전트는 기본적으로 백그라운드에서 실행됩니다: 호출은 즉시 ID를 반환하고, 완료되면 결과 미리보기와 함께 알려 줍니다(전체 텍스트는 `get_subagent_result`로 가져옵니다). `run_in_background: false`를 넘기면 에이전트가 끝날 때까지 기다렸다가 전체 출력을 인라인으로 받습니다. 기다리는 동안 `ctrl+b`를 누르면 백그라운드로 넘길 수 있습니다(아래 참고).

### 포그라운드 에이전트를 백그라운드로 보내기

포그라운드 `Agent` 호출이 실행 중일 때 `ctrl+b`를 누르면 Claude Code에서처럼 백그라운드로 넘길 수 있습니다. 같은 실행이 그대로 계속되며(세션, 진행 중인 턴, 트랜스크립트, worktree 모두 동일), 기다리던 호출은 `run_in_background: true`로 실행했을 때와 같은 결과로 에이전트 ID를 반환합니다. 이후 완료는 원래의 도구 호출을 명시한 일반 백그라운드 알림으로 도착합니다. 2초가 지나면 실행 중인 호출의 행에 `(ctrl+b to run in background)`가 표시됩니다.

- `ctrl+b`는 실행 중인 모든 포그라운드 `Agent` 호출을 한꺼번에 넘깁니다. 하나만 넘기려면 해당 대화 뷰어(FleetView 또는 `/agents → Running agents`)에서 `b`를 누르세요.
- 이 키는 그런 호출이 실행 중이고 프롬프트 편집기에 포커스가 있을 때만 확장이 가로챕니다. 그 밖의 경우(대화 상자나 뷰어의 스티어링 입력창 안 포함)에는 `ctrl+b`는 여전히 pi의 커서 왼쪽 이동 키로 동작합니다. FleetView를 끄면 확장이 어느 컴포넌트에 포커스가 있는지 알 수 없으므로, 호출이 실행 중이면 항상 이 키를 가로챕니다.
- 힌트는 병렬 호출 배치마다 하나만, 아직 실행 중인 가장 이른 호출에 표시됩니다.
- 백그라운드로 넘긴 에이전트에는 부모에서 누른 Esc가 더 이상 전달되지 않습니다. `/agents → Running agents`에서 `x`로 중지하세요.
- 단방향 작업입니다: 포그라운드로 되돌릴 방법은 없습니다.
- 같은 어시스턴트 메시지 안의 다른 도구 호출은 끝날 때까지 여전히 모델의 다음 턴을 붙잡아 둡니다. pi는 한 메시지의 도구 호출을 하나의 배치로 실행하기 때문입니다.
- 다음 경우에는 제공되지 않습니다: 아직 빈자리를 기다리며 대기열에 있는 포그라운드 호출, 포그라운드 `resume`, 워크플로의 에이전트, 중첩된 자식 에이전트. 자동 타임아웃은 없습니다.

### 예약 실행

`schedule` 필드를 추가하면 에이전트를 지금 실행하지 않고 나중에 실행되도록 등록합니다:

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

예약 형식:

- **Cron**: 6개 필드(`second minute hour day-of-month month day-of-week`). 예: `"0 0 9 * * 1"`은 매주 월요일 오전 9시, `"0 */15 * * * *"`은 15분마다.
- **간격**: `"5m"`, `"1h"`, `"30s"`, `"2d"`. 해당 간격으로 반복 실행됩니다.
- **1회성(상대 시간)**: `"+10m"`, `"+2h"`, `"+1d"`. 그 시간이 지난 시점에 한 번 실행됩니다.
- **1회성(절대 시간)**: 전체 ISO 타임스탬프. 예: `"2026-12-25T09:00:00.000Z"`.

예약이 실행되면 에이전트는 백그라운드에서 실행되고, 완료 알림은 수동으로 실행한 백그라운드 에이전트와 같은 방식으로 도착합니다. 부모 에이전트도 결과를 같은 방식으로 처리합니다.

예약은 **세션 범위**입니다: `/new`에서 초기화되고 `/resume`에서 복원됩니다. 목록 조회와 취소는 `/agents → Scheduled jobs`에서 합니다(생성은 `Agent` 도구가 담당하며, 별도의 수동 생성 마법사는 없습니다). 저장 위치는 `<cwd>/.pi/subagent-schedules/<sessionId>.json`이며, 여러 인스턴스 간 안전을 위해 PID 기반 파일 잠금을 사용합니다.

**기능을 완전히 끄기**: `/agents → Settings → Scheduling → disabled`는 `Agent` 도구 정의에서 `schedule`을 제거하고(LLM 컨텍스트 비용 없음), 메뉴 항목을 숨기고, 활성 스케줄러를 모두 중지합니다. 도구 정의에서의 제거는 다음 pi 세션부터 적용되고, 런타임 중지는 즉시 적용됩니다. 같은 메뉴에서 다시 켤 수 있습니다.

제한 사항:
- `schedule`은 `inherit_context`(실행 시점에 부모 대화가 없음)나 `resume`(예약은 항상 새 에이전트를 만듦)과 함께 쓸 수 없습니다.
- `run_in_background: false`는 거부됩니다: 예약 작업은 항상 백그라운드에서 실행됩니다. 생략하거나 `true`를 넘기는 것은 괜찮습니다.
- 예약 실행은 `maxConcurrent` 대기열을 우회하므로, 5분 간격 작업이 오래 실행되는 수동 에이전트 뒤로 밀리지 않습니다.
- **헤드리스 `pi -p`는 예약된 서브에이전트를 기다리지 않습니다.**

## 명령어

| 명령어 | 설명 |
|---------|-------------|
| `/agents` | 대화형 에이전트 관리 메뉴: 에이전트 타입, 실행 중인 에이전트, 예약 작업, 워크플로 실행, 설정 |

워크플로 인스펙터, CLI 플래그 등 자세한 내용은 [영어 README](README.md#commands)를 참고하세요.

## 자세한 내용(영어)

이 번역은 일부만 다룹니다. 여기에 없는 모든 세부 사항은 [영어 README 전체](README.md)를 참고하세요.

- [UI](README.md#ui): FleetView, 전체 화면 대화 뷰어, 에이전트 멘션
- [기본 에이전트 타입](README.md#default-agent-types)과 [사용자 정의 에이전트](README.md#custom-agents): frontmatter 필드, 중첩 서브에이전트, 도구 및 확장 범위
- [도구](README.md#tools): `Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent` 매개변수 표
- [영구 설정](README.md#persistent-settings): 모든 설정과 기본값
- [이벤트](README.md#events)와 [확장 간 RPC](README.md#cross-extension-rpc)
- [워크플로 가이드](docs/workflows.md), [RPC 가이드](docs/rpc.md), [패키지에 포함된 에이전트](docs/packages.md)
- [변경 이력](CHANGELOG.md)

## 라이선스

MIT — [tintinweb](https://github.com/tintinweb)

Full README (English): [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md

<!-- source: README.md @ 399f50e -->
