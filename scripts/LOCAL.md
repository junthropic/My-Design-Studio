# 개인 PC용 LOCAL Release

기본 `npm run release`는 LOCAL이다. 기존 Production 서명 경로는 수정하지 않았다.

| 명령 | 동작 |
| --- | --- |
| `npm run build:local` | 타입 검사 → 전체 테스트 → UI·서버·Electron·Remotion 빌드 → unpacked EXE → 구성요소·서명·SHA256 검사 |
| `npm run release:local` | LOCAL 빌드 후 동일 EXE 실행·내보내기·재시작 검사 |
| `npm run verify:local` | 가장 최근 성공한 LOCAL 빌드를 다시 검사 |
| `npm run build:production` | 기존 `signing-config.mjs --package` 실행, Production 자격 필수 |
| `npm run signing:release` | 기존 Production 서명·Final Verification 경로, 변경 없음 |
| `npm run verify:production` | 기존 `verify-windows-release.mjs` 실행 |

Node와 설치된 개발 의존성은 **소스 빌드에만** 필요하다. 실행 결과물은 `outputs/local/builds/<빌드 ID>/win-unpacked/Design Studio.exe` 및 같은 폴더의 런타임 전체다. EXE만 따로 복사하지 않는다. LOCAL은 NSIS나 설치 프로그램을 만들지 않는다. 최초 의존성·Electron 다운로드에는 네트워크가 필요할 수 있다.

새 소스 폴더에서도 unit/integration 검사를 먼저 수행하고, UI acceptance 검사는 그 실행에서 새로 생성한 `dist`에 대해 수행한다. 기존 Production NSIS 회귀 검사를 건너뛰지 않기 위해 Microsoft 서명 도구와 별개로 NSIS 테스트용 컴파일러가 필요하다. 이 작업 공간의 기존 캐시를 자동 사용하며 다른 환경에서는 `STUDIO_NSIS_FIXTURE_COMPILER`에 준비된 `makensis.exe` 경로를 지정한다. 이는 테스트 fixture 생성용이며 LOCAL 설치 프로그램을 만드는 단계가 아니다.

LOCAL의 미서명 허용은 Windows 정책 변경을 의미하지 않는다. 앱과 검증기는 SAC·Defender·SmartScreen·Firewall·인증서 신뢰 저장소를 수정하지 않는다. SAC 값은 Get-ItemProperty로 읽기만 한다. ON 상태의 미서명 EXE는 새 실행을 시도하지 않고 `BLOCKED_BY_SMART_APP_CONTROL` / 4551을 **사전검사 결과**로 기록한다. OFF이면 실제 EXE 검증을 진행한다. UNKNOWN이면 일반 실행을 시도하고 그 결과를 기록한다. 다른 Windows 정책이 실행을 막으면 해당 실패를 그대로 보고한다.

`build:local`은 빌드 성공 시 0, 빌드 실패 시 1이다. `release:local`과 `verify:local`은 전체 검증 성공 시 0, 검증 실패 시 1, SAC에 의한 실행 차단 시 3이다. 종료 코드 3이어도 `build-report.json`의 Build PASS는 유지된다.

## 검사와 증거

- `local-inventory.json`: 전체 배포 파일의 크기·SHA256, PE 구조, 소유 구분, Authenticode 상태, 유지/미서명 허용 결정, 전후 해시.
- `build-report.json`, `tests.json`: 각 빌드 단계 및 전체 검사 결과. 기존 122개 Production 테스트가 하나라도 실패하거나 건너뛰면 빌드를 중단한다.
- `local-verification.json`: 현재 SAC 상태, 실행 여부, 무결성, 내보내기·재시작 결과, 동일 EXE 전후 SHA256.
- `work/verification-*/`: 독립 검증 데이터, UI ready·스크린샷, 실제 내보내기 파일 및 런타임 보고서. 검증이 사용자의 일반 프로젝트 저장소를 사용하지 않는다.
- `../production-baseline.json`: 기존 Production 코드·테스트·보호 산출물의 변경 전 SHA256. 실행 전후 기준선을 대조한다.

PE/EXE/DLL/NODE 파일은 기존 명시적 소유 목록을 재사용한다. 미등록 네이티브 파일, 잘린 PE, 서명 HashMismatch/NotTrusted/Invalid, 필수 런타임 누락, 파일 누락·추가·변경은 실패한다. 현재 유효한 Microsoft/Apple 등 제3자 파일은 기준 해시와 Valid 상태를 모두 유지해야 한다. 처음부터 미서명이었던 허용 목록의 번들 런타임도 LOCAL에서 허용하되 자사 코드와 별도로 표시한다. 서명을 추가·제거·교체하지 않는다. LOCAL은 SignTool이나 공개 인증서를 요구하지 않는다.

LOCAL 빌드 자식 프로세스에는 필요한 OS 환경만 전달한다. Azure·인증서·비밀번호·토큰·DEBUG 및 사용자 NODE_OPTIONS는 전달하지 않는다. 모든 자식 도구는 창을 표시하지 않는 실행을 사용한다. 기존 `hidden-build.cjs`는 읽기 전용으로 재사용한다.

실제 검증은 같은 EXE에서 프로젝트 생성·저장·로드, PPTX/Web/Tokens/Project/After Effects/Blender/MP4/WebM/PNG sequence의 9종 내보내기, ZIP CRC·JSON·미디어 기본 구조 및 PPT 960×540pt, 정상 종료, 재실행 후 프로젝트와 9개 작업 이력을 확인한다. MP4/WebM 영상 전체 프레임의 미적 품질이나 Office/AE/Blender에서 편집하는 과정은 이 자동 검증의 범위가 아니다.

## Production 보존

Azure Artifact Signing / RSA OV, RSA+SHA256+RFC3161, Authenticode+SignTool, 내부 실행 파일→uninstaller→installer 순서와 안전한 NSIS 추출 경로는 기존 구현 그대로다. LOCAL 설정에는 Production 공급자를 import하거나 호출하는 코드가 없다.

기존 자격 부재 종료 동작도 그대로다. 준비 명령 `signing:prepare`의 mock 이후 자격 게이트는 2, `signing:release`의 자격 부재 실패는 기존대로 1이다. 실제 Production 서명이나 Production EXE 실행 완료를 LOCAL 성공으로 대신 표시하지 않는다.

기존 Production 준비 보고서·target manifest·원본 source ZIP을 덮어쓰지 않는다. 이번 추가 파일은 별도 LOCAL 소스 ZIP에서 제공한다. `tests/ui.test.ts`의 변경은 기존 UI 검사에서 iframe 폭 반영을 기다리는 대기 조건 하나이며, Production 122개 테스트 파일은 변경하지 않았다.

실제 EXE 검증에서 확인한 Windows SQLite 파일 교체의 EPERM 처리를 위해 `server/atomic-file.ts`를 추가했다. 기존 동기식 원자 교체를 유지하며 EPERM/EACCES/EBUSY에 한해서 최대 7회, 총 대기 1.575초 이내로 재시도한다. 기존 DB를 삭제하지 않고 영구 오류·디스크 오류는 그대로 실패시킨다. 이 저장 수정은 Production **서명** 경로의 수정과 구분하며, 별도 4개 회귀 테스트로 검증한다.

Chromium 134의 하위 GPU 프로세스는 환경 변수와 `--log-file`을 지정해도 EXE 옆에 `debug.log`를 썼다. 이 동작은 실제 번들로 재현했다. 따라서 데스크톱 앱은 사용자 데이터의 `renderer-cache/<내용 해시>/`에 번들 브라우저를 복사하고 모든 파일의 SHA256을 대조한 뒤 그 동일 바이트 복사본을 실행한다. 다음 시작에서도 해시를 재검사하며, 변조되거나 알 수 없는 캐시 구성요소가 있으면 실패한다. 캐시 로그만 변경될 수 있고 배포 폴더의 무결성 검사는 완화하지 않는다. LOCAL 패키지에는 과거 개발 실행의 `debug.log`를 넣지 않는다. 캐시 때문에 사용자 데이터에 브라우저 크기만큼 추가 디스크 공간이 필요하다.

UI ready는 초기 로딩 화면이 아니라 9개 탐색 메뉴와 본문이 표시된 시점에 기록한다. 이 런타임 준비 변경은 `electron/main.ts`와 새 `electron/runtime-browser.ts`에 한정되며, 기존 모션 숨김 실행 래퍼는 원래 내용 그대로다. 캐시 복사·재사용·변조·알 수 없는 구성요소 검사를 위한 테스트 3개를 추가했다.
