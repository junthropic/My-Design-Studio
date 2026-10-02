# 소스와 다운로드를 함께 업데이트하기

저장소: https://github.com/junthropic/My-Design-Studio

사용자는 프로그램 변경 후 검증·커밋·푸시·다운로드 갱신을 계속 수행하도록 승인했다. 이 지침은 루트 `AGENTS.md`에도 보존한다. 자동으로 주기적인 소스 수정을 시작하는 기능은 아니며, 이후 이 프로젝트의 수정 작업에 적용된다.

1. 변경 내용을 구현하고 관련 검사와 문서를 갱신한다.
2. Git diff와 비밀정보 포함 여부를 확인하고 main에 커밋한다. 다른 작업자의 변경이나 원격 기록을 덮어쓰지 않는다.
3. Windows에서 `npm run publish:local -- --tag v0.1.0-local.YYYYMMDD.N`을 실행한다. 날짜와 순번이 같은 태그를 재사용하지 않는다.
4. 명령이 타입 검사·unit/integration·최신 UI 검사·unpacked 빌드·실제 동일 EXE 9종 출력·종료/재시작·무결성을 검사한다. 기존 Production 122개가 하나라도 건너뛰거나 실패하면 중단한다.
5. 성공한 clean 소스 커밋을 origin/main으로 푸시하고 그 커밋의 소스 ZIP과 검증한 런타임 ZIP을 만든다. 커밋이나 작업 트리가 빌드 중 바뀌면 게시하지 않는다.
6. GitHub **draft** Release에 파일을 올리고 원격 크기·SHA256을 확인한 뒤에만 공개하고 latest로 지정한다. 업로드가 실패하면 이전 latest를 유지한다. 실패한 draft는 검토 후 수동으로 처리하며 기존 공개 파일을 덮어쓰지 않는다.

필수 환경: Windows, 프로젝트의 Node/npm 의존성, 인증된 `gh`, Git, 기존 NSIS 회귀 검사용 `STUDIO_NSIS_FIXTURE_COMPILER` 또는 이 작업 공간의 캐시. 공개 서명 인증서/Azure 자격은 LOCAL 게시에 필요하지 않다. API 토큰은 gh의 기존 로그인 또는 프로세스 환경변수로만 사용하며 저장소나 보고서에 기록하지 않는다.

## 매 릴리스 다운로드

- `Design-Studio-Windows-x64-LOCAL.zip`: EXE + 런타임 전체. ZIP 해제 후 실행.
- `Design-Studio-source.zip`: 릴리스가 가리키는 정확한 Git 커밋의 추적 파일.
- `verification.json`: 실제 빌드·실행·출력·재시작 결과. PC별 절대 경로는 치환.
- `local-inventory.json`: 전체 런타임 파일 SHA256, PE 분류와 기존 서명 상태.
- `release-manifest.json`: Git SHA, 태그, 모드, EXE SHA256, 자산 SHA256.
- `SHA256SUMS.txt`: 다운로드 파일 해시 목록.

README의 `/releases/latest/download/...` 링크는 같은 자산 이름을 사용하는 새 최신 릴리스로 자동 연결된다. 이전 태그와 다운로드를 보존하므로 과거 버전을 다시 받을 수 있다. 앱이 사용자 몰래 설치 파일을 바꾸거나 자체 업데이트하지는 않는다.

## LOCAL과 Production

`release`, `build:local`, `release:local`, `verify:local`은 LOCAL이다. `publish:local`은 LOCAL 전체 검증 후 GitHub 게시까지 수행한다. `build:production`, `signing:release`, `verify:production`의 기존 의미는 유지한다.

Production 서명 준비와 RSA/SHA256/RFC3161·Authenticode/SignTool·안전한 NSIS 추출은 그대로 보존한다. 실제 Production 자격이 없으므로 Production 서명·검증 완료를 주장하지 않는다. Windows 정책 우회·보안 기능 변경도 하지 않는다.

`docs/verification`의 초기 기록은 기준선이다. 매 업데이트의 최신 실행 증거는 해당 Release의 검증 파일에서 확인한다. 개발 의존성·개인 DB·API 키·캐시·실패 빌드·오래된 설치 프로그램은 Git 또는 최신 다운로드에 포함하지 않는다.
