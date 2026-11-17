# 긴 팀 화면 설계 예시

직원별 한 행 요약과 상세 패널을 비교하는 독립 HTML 생성기다. 운영 UI 구현 파일은 변경하지 않는다. 설계는 `docs/superpowers/specs/2026-11-18-team-density-design.md`에 있다.

실제 직원·업무 기록은 Git 밖 private 경로에 둔다. `build.ts`는 그 스냅샷을 입력받아 외부 요청 없이 열리는 `index.html`과 모든 직원·업무 관계를 담은 `README.md`를 저장소 밖에 생성한다. 운영 접속 코드와 원문 대화는 입력에 넣지 않는다.

```sh
bun docs/previews/team-density/build.ts '/absolute/private/source.json' '/absolute/private/preview'
```

입력 필드는 `capturedAt`, `sourceSha`, `project`, `members`, `tasks`, `workflow`다. 운영 API에서 필요한 화면 메타데이터만 추출한 스냅샷을 사용한다. `project`는 ID와 이름, `members`는 ID·이름·역할·관측 상태, `tasks`는 ID·제목·부모 ID·단계·시각을 포함한다. `workflow`는 서버가 만든 노드와 연결을 그대로 사용한다.

기존 `tokens.css`, `glass.css`, `Glass`, `GlassButton`, `AuroraField`를 재사용한다. 상단 집계와 요약 분류는 기존 `workflow-view.ts`를 사용한다. 실행 중 표시·완료·막힘의 의미를 예시에서 다시 판정하지 않는다.

1440×1000 및 390×1000 브라우저에서 오프라인 실행, 가로 넘침, 직원 전체 수, 담당별 전체 목록, 미배정 목록, 검색, 우클릭 집중·복원, Escape 닫기·초점 복원을 검증한다. 실제 검증 결과와 스크린샷은 해당 private 산출물 옆에 기록한다. 문서 자체를 운영 적용 영수증으로 사용하지 않는다.

2차 예시는 직원 상세를 요약·업무·활동·실행/설정으로 통합하고 실제 부모 관계의 묶음 지도를 제공한다. `map-model.ts`는 고유 업무를 빠짐없이 묶고 원본 연결을 유지하며, `MapExplorer.tsx`는 축척·직원 강조·실제 관계 목록·직접 연결을 표현한다. `Inspector.tsx`의 입력과 실행 조작은 비활성 예시이고 운영 API를 호출하지 않는다. `#map`으로 열면 전체 지도에서 시작한다.

2차 스냅샷에는 직원의 역할·관측 상태·문맥·입력 대기·최근 보고·실행 설정 메타데이터를 선택적으로 포함한다. 직원 활동 탭은 수집한 업무의 마지막 기록만 재현한다. 터미널, 전체 로그, 개발 기억, 독립 진행판의 원문은 수집하지 않는다. 실제 운영 적용 시 기존 MemberDetail과 API 보호를 재사용하도록 설계했으며 이 독립 파일은 제품 코드를 대신하지 않는다.
