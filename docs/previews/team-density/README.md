# 긴 팀 화면 설계 예시

직원별 한 행 요약과 상세 패널을 비교하는 독립 HTML 생성기다. 운영 UI 구현 파일은 변경하지 않는다. 설계는 `docs/superpowers/specs/2026-11-18-team-density-design.md`에 있다.

실제 직원·업무 기록은 Git 밖 private 경로에 둔다. `build.ts`는 그 스냅샷을 입력받아 외부 요청 없이 열리는 `index.html`과 모든 직원·업무 관계를 담은 `README.md`를 저장소 밖에 생성한다. 운영 접속 코드와 원문 대화는 입력에 넣지 않는다.

```sh
bun docs/previews/team-density/build.ts '/absolute/private/source.json' '/absolute/private/preview'
```

입력 필드는 `capturedAt`, `sourceSha`, `project`, `members`, `tasks`, `workflow`다. 운영 API에서 필요한 화면 메타데이터만 추출한 스냅샷을 사용한다. `project`는 ID와 이름, `members`는 ID·이름·역할·관측 상태, `tasks`는 ID·제목·부모 ID·단계·시각을 포함한다. `workflow`는 서버가 만든 노드와 연결을 그대로 사용한다.

기존 `tokens.css`, `glass.css`, `Glass`, `GlassButton`, `AuroraField`를 재사용한다. 상단 집계와 요약 분류는 기존 `workflow-view.ts`를 사용한다. 실행 중 표시·완료·막힘의 의미를 예시에서 다시 판정하지 않는다.

1440×1000 및 390×1000 브라우저에서 오프라인 실행, 가로 넘침, 직원 전체 수, 담당별 전체 목록, 미배정 목록, 검색, 우클릭 집중·복원, Escape 닫기·초점 복원을 검증한다. 실제 검증 결과와 스크린샷은 해당 private 산출물 옆에 기록한다. 문서 자체를 운영 적용 영수증으로 사용하지 않는다.
