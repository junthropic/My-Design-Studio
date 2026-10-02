# Design Studio 작업 지침

## 사용자가 승인한 지속적인 업데이트 절차

- 기준 저장소는 `https://github.com/junthropic/My-Design-Studio`이다.
- 사용자는 앞으로 이 프로그램을 수정하거나 업데이트할 때 해당 변경을 커밋하고 이 저장소에 푸시하는 것을 명시적으로 승인했다. 일반적인 검증·커밋·푸시·새 다운로드 릴리스 게시에 매번 승인을 다시 요청하지 않는다.
- 변경 후 적절한 테스트를 수행하고 소스와 문서를 함께 커밋·푸시한다. 다른 사람의 변경을 덮어쓰거나 force push하지 않는다.
- 실행 파일에 영향을 주는 수정은 `npm run publish:local -- --tag <사용하지 않은 버전 태그>`로 새 빌드·실제 EXE 검증·GitHub Release 게시까지 완료한다. 이 명령은 clean Git HEAD를 요구한다.
- 기본 브랜치는 main이다. 브랜치 보호가 생기면 우회하지 않고 PR을 통해 반영한다. 필요하면 `codex/` 접두사를 사용한다.
- 새 GitHub Release는 해당 소스 커밋에 연결하며, portable ZIP·소스 ZIP·SHA256·실행 검증·무결성 목록을 함께 제공한다. 이전 릴리스와 파일을 삭제하거나 덮어쓰지 않는다. README의 latest 다운로드 링크를 유지한다.
- 최종 EXE 실행이 차단되거나 출력·재시작·무결성 검증이 실패하면 새 다운로드를 최신 릴리스로 게시하지 않는다. 소스 커밋과 실행 파일 게시 상태를 구분해 보고한다.
- 자격이 없는 실제 Production 서명은 시도하지 않는다. 기존 Production 서명 파이프라인과 122개 회귀 테스트, NSIS 안전 추출을 보존한다. LOCAL 성공을 Production 서명 완료로 표시하지 않는다.
- API 키, 인증서 개인 키, 비밀번호, client secret, 토큰, 사용자 DB·프로젝트·캐시·실패 빌드를 Git이나 릴리스에 넣지 않는다. 공개 보고서의 PC별 절대 경로는 치환한다.

## Windows 실행

- 별도의 보이는 cmd, PowerShell, Windows Terminal 창을 열지 않는다. 자식 프로세스는 `windowsHide: true`, `shell: false`를 사용한다.
- 사용자가 연 터미널·IDE 연결·PowerPoint·Blender·AE 프로세스를 종료하지 않는다.
- Smart App Control, Defender, SmartScreen, Firewall, Code Integrity, 신뢰 저장소, 전역 실행 정책을 변경하지 않는다.
- SAC는 읽기만 한다. ON+미서명 LOCAL이면 Build PASS와 `BLOCKED_BY_SAC`를 구분한다.
- Git 소유자 확인이 필요한 경우 확인된 이 저장소 경로만 명령별 `-c safe.directory=<절대 경로>`로 지정한다. 전역 예외나 `safe.directory=*`를 만들지 않는다.

## 원본 보존

- `scripts/production-baseline.local.json`에 기록된 Production 원본의 무결성 검사를 유지한다.
- 기존 `Production_Signing_준비검증.md`, `signing-target-manifest.json`, `Design-Studio-0.1.0-source.zip`을 삭제하거나 덮어쓰지 않는다.
- 모든 소스는 정확한 바이트를 유지하도록 `.gitattributes`의 줄바꿈 정책을 따른다. 무관한 파일 전체 포맷 변경은 피한다.
