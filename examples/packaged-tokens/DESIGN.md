# 설치본 · 독립 실행 검증 — DESIGN

브랜드: Junho Studio
매체: web
글꼴: Pretendard (포함하지 않음)

## 토큰 적용 순서

스타일 → 브랜드 → 매체 → 보기 → 프로젝트 변경 → 접근성 → 파생 대비 보정.

DTCG typography.lineHeight는 글자 크기에 대한 배수이며 dimension 단위는 px, duration 단위는 ms입니다. 다크와 라이트 값은 따로 저장합니다.

| 토큰 | 라이트 | 다크 |
|---|---|---|
| font.family | Pretendard | Pretendard |
| font.title | 40 | 40 |
| font.body | 16 | 16 |
| font.lineHeight | 1.55 | 1.55 |
| font.tracking | 0 | 0 |
| radius.card | 20 | 20 |
| space.base | 24 | 24 |
| effect.blur | 20 | 20 |
| effect.glow | 0.45 | 0.45 |
| effect.decor | 1 | 1 |
| motion.duration | 500 | 500 |
| color.success | #51c9a5 | #51c9a5 |
| color.danger | #ff758c | #ff758c |
| color.onAccent | #ffffff | #10131a |
| color.bg | #eff2fc | #0e1220 |
| color.surface | #ffffff | #1a2033 |
| color.text | #172244 | #f1f4ff |
| color.muted | #52617d | #a9b1cb |
| color.border | #bbc5df | #35405b |
| color.accent | #6b759e | #adbcff |

대비는 불투명한 토큰 쌍에 대한 계산입니다. 이미지·유리 표면·영상 위 텍스트는 대상 화면에서 직접 검사하세요. 매체별 스케일, 변환 한계는 각각의 export manifest.json에 기록합니다.
