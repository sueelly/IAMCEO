# 실행 복구 수정의 운영 반영

2026-11-18 사용자가 전역 동시 실행 한도 20을 유지하며 운영 배포하도록 승인했다. 작업 워크트리는 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/repair-delivery-recovery-01a1ea1e`, 브랜치는 `fix-repair-delivery-recovery-01a1ea1e`다.

완료 조건은 최신 main 통합 검사, Bun 1.3.14 컴파일·서명·격리 실행 검사, 작업 브랜치와 main 일반 푸시 및 SHA 일치, 해당 커밋의 운영 릴리스, 로컬과 기존 Tailscale 주소의 정상 응답이다. 설정 변경 API를 호출하지 않고 운영 DB·API의 전역 한도가 20인지 이주 전후에 대조한다. v40까지의 배포 이력은 보존하고 오류 기록 열을 v41로 추가한다.

활성화 전 SQLite의 일관된 백업, 서비스 plist·인증 설정·Tailscale 경로와 core 터미널 PID·직원 대화 세대를 private 경로에 기록한다. 원격 main과 현재 서비스 경로가 준비 시점과 같을 때만 검증한 바이너리로 `com.iamceo.server` 웹 서비스를 정상 재시작한다. core 서비스나 직원 프로세스에 종료 명령을 보내지 않고 실제 입력 전달·승인 응답도 검증 목적으로 호출하지 않는다.

배포 후 기존 프로젝트·직원·메시지·파일·업무·결재·할 일·납품 ID, 활성 터미널 PID와 세대, 인증 설정, 전역 한도와 기존 Tailscale 경로를 대조한다. 자연스러운 실행 종료, 같은 대화를 사용하는 idle 규칙 갱신, 확정된 대화 부재의 복구는 활동 근거를 확인하여 구분한다. 서비스 실패 시 운영 DB를 과거 백업으로 자동 교체하지 않는다.

실제 검사·빌드·배포 영수증과 백업은 Git 밖 `/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/private/delivery-recovery-rollout-20261118-01a1ea1e/`에 기록한다. 기존 누적 오류·새 오류의 수치를 구분하며, 관측하지 않은 자동 복구 완료를 배포 성공으로 추정하지 않는다.
