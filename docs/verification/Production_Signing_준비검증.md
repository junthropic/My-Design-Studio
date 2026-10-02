# Production Signing 준비 검증 결과

**추가 구현과 준비 검증 완료. 실제 서명·최종 EXE 실행은 하지 않았습니다.** 4551 진단과 기존 Signing Preparation 결과는 유지하며 보안 정책을 변경하지 않았습니다.

## 확인된 결과

- 기존 16개 테스트를 포함해 **122개 통과**, 실패 0·생략 0. TypeScript·Prettier 검사 통과.
- 실제 준비 명령: manifest → mock 검사 → production 자격 검사에서 **종료 코드 2**로 중단. 서명 자격 전달·실제 서명 호출 없음.
- 현재 파일 44개: 자사 배포 앱 1, 미서명 번들 종속 파일 38, 기존 유효 vendor 파일 4, 미서명 installer 1. 다음 빌드에서 생성할 uninstaller 1개도 별도 명세.
- 기존 파일 44개 SHA256이 앞서 확정된 진단과 모두 일치. vendor 4개는 Authenticode·SignTool 양쪽 Valid.
- 정상 서명된 기존 Node 파일은 엄격 검사 통과. 변조된 작업 사본은 HashMismatch/Invalid, 현재 미서명 앱은 NotSigned/Invalid로 거부.
- 기존 NSIS 컴파일러로 시험 파일을 만들고 EXE를 실행하지 않는 바이트 추출 확인. 실제 production 설치 파일은 만들지 않음.
- Microsoft SignTool 10.0.26100.7175, Azure Artifact Signing Client 1.0.128을 작업 폴더에 준비. x64 .NET 8·VC++ 런타임 확인. 시스템 설치 없음.

## 요청 항목과 구현

| 항목 | 구현·검증 |
|---|---|
| 두 공급자 | 공통 provider 인터페이스와 동일 broker·manifest·검증 흐름 |
| 기존 서명 보존 | Valid 파일에 sign 호출 없음, 전후 해시 동일 강제 |
| 파일 분류 | 정확한 경로·PE 헤더·출처 정책. 제3자 코드를 자사 소유로 분류하지 않음 |
| Manifest | 현재 44개와 생성 예정 uninstaller. 미서명 후 해시는 null |
| 전후 해시 | beforeSHA256·afterSHA256 분리. 변경·실패 시도 추적 |
| 알고리즘 | 새 서명은 RSA·파일/CMS SHA256·RFC3161 SHA256만 허용 |
| 실패 처리 | signing·timestamp·chain·도구·변조 오류 중 하나라도 release 실패 |
| 순서 | 내부 파일/elevate → uninstaller → 최종 installer |
| 이중 검증 | Get-AuthenticodeSignature + SignTool /pa /all /v /tw, 경고도 실패 |
| 회귀·통합 | 기존16 유지, 공급자 mock·builder 연결·보존·순서·오류 검사 추가 |
| credential 부재 | mock 이후 production 시작 전에 exit 2 |
| 비밀정보 | 키·비밀번호·secret·token의 파일/JSON/로그/argv 기록 금지, 최소 자식 환경 |

## 다음 실행

사용할 공급자의 자격과 공개 설정을 연결한 뒤 앱 폴더에서 실행합니다.

```text
npm run signing:check
npm run signing:release
```

두 번째 명령은 Production Signing → Final Verification을 연결합니다. 공급자 선택에 구조 변경은 필요하지 않습니다. OV는 Windows 인증서 저장소/보안 키 공급자, Azure는 Public Trust 프로필·서비스 주체 자격을 사용합니다. 실제 계정 권한·timestamp 서비스·최종 실행 허용은 자격 연결 후 확인하며 현재 통과로 주장하지 않습니다.

[설정과 검증 범위](../design-studio/scripts/SIGNING.md) · [대상 manifest](signing-target-manifest.json) · [122개 테스트](production-signing-tests.json) · [실제 이중 검사](dual-signature-verification.json) · [도구 준비](signing-tooling-readiness.json) · [생산 단계 중단 증거](production-gate-exit.json)
