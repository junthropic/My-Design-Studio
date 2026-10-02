# Production Signing 준비와 최종 EXE 검증

4551의 원인은 이미 확정된 Smart App Control입니다. 보안 정책을 변경하지 않습니다. 현재 production credential이 없으며 **실제 서명은 시도하지 않았습니다**. Mock 통과는 production 서명이나 최종 EXE 실행 성공을 뜻하지 않습니다.

## 공통 처리 구조

`signing-providers.mjs`의 인터페이스는 `id`, `mode`, `preflight()`, `sign(file)`입니다. Azure Artifact Signing과 RSA OV Code Signing 모두 같은 broker·manifest·검증 경로를 사용합니다.

1. 읽기 전용 대상 manifest 생성 → mock 통합 검사 → production 자격·도구 사전검사.
2. 내부 파일 검사 → 유효한 기존 서명 보존 / 허용된 미서명 파일만 서명.
3. 늦게 복사되는 elevate.exe까지 포함해 내부 파일 전부 검증하고 목록 고정.
4. NSIS 제거 프로그램을 바이트로 추출 → 제거 프로그램 서명·검증.
5. 최종 installer 생성 → installer 서명·검증 → 전체 해시·서명 재검사.
6. 동일 EXE 실행·출력·정상 종료·재시작 검증.

기존 Microsoft/Apple/제3자 유효 서명은 **재서명하지 않습니다**. 보존 파일의 서명 전후 SHA256은 같아야 합니다. 과거 서명의 알고리즘·timestamp를 새 서명 정책에 맞추기 위해 바꾸지 않습니다. 현재 유효 vendor 파일 4개는 `signUnsigned:false`이므로 서명이 사라진 교체 파일도 서명하지 않고 중단합니다.

자사 배포 앱, 번들 종속 파일, vendor 파일, 생성 installer/uninstaller를 구분합니다. `signing-ownership.json`은 정확한 상대 경로·출처·목적·라이선스 증거를 기록합니다. Electron·Chromium·Remotion·Sharp·NSIS 코드를 자사 소유라고 주장하지 않습니다. 알 수 없는 경로와 예상 밖 확장자의 PE도 발견하고 차단합니다. 이 목록은 외부 재배포 라이선스 심사를 대신하지 않습니다.

## Production 서명·검증 정책

새 서명은 **RSA + SHA256 파일/CMS digest + RFC3161 timestamp + SHA256 timestamp digest**만 허용합니다. OV 저장소 인증서는 RSA 3072비트 이상, 유효 기간, Code Signing EKU, 개인키 존재, 지정 게시자를 검사합니다.

`Get-AuthenticodeSignature`와 `SignTool verify /pa /all /v /tw` 모두 유효해야 합니다. SignTool 종료 코드 2(경고)도 실패입니다. PE의 SignedCms에서 실제 파일 digest·서명 digest·RFC3161 토큰·timestamp 해시·원서명과의 결합을 읽고 검증합니다. 인증서 서명 알고리즘만으로 파일 SHA256을 추정하지 않습니다.

서명·timestamp·chain 오류, 도구 부재, 서명 후 파일 변경, 알 수 없는 대상, 순서 위반 중 하나라도 있으면 release를 실패시킵니다. 부분 서명 파일이 남더라도 성공으로 표시하지 않으며 최종 실행에 진입하지 않습니다.

Manifest에는 파일별 `beforeSHA256`과 `afterSHA256`, 분류·조치·검사 결과·상태를 따로 기록합니다. 준비 단계의 `afterSHA256`은 `null`입니다. 실패 시도 뒤 파일이 남아 있으면 그 해시도 남깁니다. 임시 uninstaller는 포함 전 검사·해시를 기록하며, 설치된 복사본 검사는 별도입니다.

## 공급자 설정

공통 공개 설정:

| 변수                       | 값                                      |
| -------------------------- | --------------------------------------- |
| `STUDIO_SIGNING_MODE`      | `store` 또는 `azure`                    |
| `STUDIO_SIGNING_PUBLISHER` | 인증서의 정확한 게시자 이름             |
| `STUDIO_SIGNTOOL_PATH`     | 신뢰된 Microsoft x64 SignTool 절대 경로 |

SignTool 버전은 10.0.22621.755 이상이 필요합니다. 도구·관련 DLL의 Microsoft 서명을 검사하고, 사전검사 후 도구 해시 변경을 거부합니다. 준비 작업에서 공식 NuGet `Microsoft.Windows.SDK.BuildTools` 10.0.26100.7175를 `work/signing-tools/`에만 풀었습니다. 시스템 설치와 전역 PATH 변경은 없습니다.

### RSA OV

| 변수                       | 값                                      |
| -------------------------- | --------------------------------------- |
| `STUDIO_SIGNING_MODE`      | `store`                                 |
| `STUDIO_CERTIFICATE_SHA1`  | 인증서 선택용 40자리 지문               |
| `STUDIO_CERTIFICATE_STORE` | `CurrentUser`(기본) 또는 `LocalMachine` |

SHA1 지문은 인증서 **선택자**이고 출력 서명은 SHA256입니다. USB 토큰/HSM의 키가 Windows 저장소와 SignTool에서 접근 가능해야 합니다. 키 공급자 미들웨어와 PIN은 발급기관의 정상 절차로 준비합니다. 앱이 개인키를 내보내거나 PIN을 저장하지 않습니다.

Production의 직접 PFX 서명은 거부합니다. 과거 PFX 형식 사전검사·회귀 테스트는 유지하지만 비밀번호를 SignTool `/p` 인수로 넘기는 경로는 production에 연결하지 않습니다. 발급기관 요건에 맞는 저장소/보안 키 공급자를 사용합니다.

### Azure Artifact Signing

| 변수                                                        | 값                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `STUDIO_SIGNING_MODE`                                       | `azure`                                              |
| `STUDIO_AZURE_ENDPOINT`                                     | 지원 지역의 `https://<region>.codesigning.azure.net` |
| `STUDIO_AZURE_ACCOUNT`, `STUDIO_AZURE_PROFILE`              | 계정과 Public Trust 프로필 이름                      |
| `STUDIO_AZURE_DLIB_PATH`                                    | x64 Azure.CodeSigning.Dlib.dll 절대 경로             |
| `STUDIO_DOTNET_PATH`                                        | 필요하면 x64 dotnet.exe 경로                         |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | 해당 서명 프로세스 환경으로만 전달하는 자격          |

공식 SignTool `/dlib` 인터페이스를 사용합니다. electron-builder 내장 Azure signer의 자동 PowerShell 모듈 설치는 사용하지 않습니다. .NET 8·VC++ x64 런타임을 읽기 전용으로 확인합니다. 서비스의 지원 지역·신원 검증·프로필·서명 권한도 준비되어야 합니다.

이 PC에는 .NET 8·VC++ x64가 확인됐으며, 공식 `Microsoft.ArtifactSigning.Client` 1.0.128도 `work/signing-tools/microsoft.artifactsigning.client/1.0.128/`에 준비했습니다. Dlib은 `bin/x64/Azure.CodeSigning.Dlib.dll`입니다. x64 DLL 40개 모두 기존 Microsoft 서명을 확인했습니다. 도구의 출처·패키지 해시·파일 해시는 해당 `source.json`에 있으며 자격 정보는 포함하지 않습니다.

Azure 임시 JSON에는 endpoint·account·profile·제외할 인증 방식 등 공개 정보만 씁니다. secret·token·password·private key는 넣지 않습니다. 사용 후 정리하며 정리 실패도 release 실패입니다. 다른 공급자나 대화형 로그인으로 자동 전환하지 않습니다.

## 명령

앱 폴더에서 기존 통합 터미널 또는 숨김 비대화형 실행을 사용합니다.

```text
npm run signing:manifest
npm run signing:prepare
```

- `signing:manifest`: 기존 배포본을 읽고 `work/signing-preparation/signing-target-manifest.json` 생성. 서명 없음.
- `signing:prepare`: manifest → 기존·mock 통합 테스트 → production 사전검사. 자격/도구가 없으면 **종료 코드 2**로 중단 상태를 기록합니다. 자격이 있어도 이 명령은 실제 서명을 하지 않습니다.

자격과 도구가 준비된 뒤:

```text
npm run signing:check
npm run signing:release
```

`signing:release`는 production signing → installer → final EXE verification을 연결합니다. 공급자는 설정으로 선택하며 코드 구조 변경이 필요 없습니다. 결과는 `release-signed/`와 `work/signed-release-verification-*/`에 남습니다. 기존 `release/`는 보존합니다.

분리 실행은 `npm run package:win:signed`와 `npm run verify:win`입니다. 후자는 production manifest·현재 해시·이중 서명 검사를 통과해야 EXE를 실행합니다. `--check`를 붙이면 실제 앱 실행은 생략합니다.

## 비밀정보·프로세스·검증 범위

비밀은 저장소·로그·JSON·환경설정 파일·명령 인수에 기록하지 않습니다. 도구 오류는 고정 코드로 바꾸고 원시 출력은 로그로 복사하지 않습니다. 검사와 최종 앱 프로세스에는 서명 자격을 전달하지 않습니다.

빌드 전용 `hidden-build.cjs`는 중첩 하위 도구에도 `windowsHide:true`를 적용합니다. 사용자 셸이나 전역 실행 정책은 바꾸지 않습니다. NSIS 어댑터는 검증된 electron-builder 26.15.3 소스 해시에만 적용하며 node_modules를 디스크에서 수정하지 않습니다. 임시 미서명 EXE를 실행하지 않고 upstream 바이트 추출기를 사용합니다. 추출 실패 시 실행 fallback은 없습니다.

현재 검증은 준비 코드·mock 흐름·기존 파일의 읽기 전용 이중 서명 검사·NSIS 추출입니다. **Production 서명·timestamp 서비스 호출·서명된 최종 EXE 실행·실제 설치/제거는 미실행**입니다. 자격의 실제 서비스 권한과 최종 허용은 production 실행 결과로 확정합니다.

공식 근거: [Artifact Signing 통합](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations), [SignTool 검증](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool), [SAC 코드서명](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control).
