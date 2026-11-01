# 다음 PC / 다음 Codex를 위한 인계

갱신일: 2026-11-01 (Asia/Seoul)

## 먼저 알아야 하는 목적

사용자는 기존 PLC 수집기를 ‘쉽게 AASX를 작성·업로드하고 DX 구축과 수집으로 연결하는 서비스’로 확장하고 싶다. 장비 구성이 부족하면 PLC 통신 모듈 또는 ADAM 등의 조건부 구성 제안을 원한다. 접근성·실수 방지·이어하기가 중요하다. 상세 방향은 `PRODUCT.md`, 이유는 `DECISIONS.md`에 있다.

## 저장소와 실행

- 원격: `https://github.com/tinppl/PLC_collector`
- 현재 개발 브랜치: `codex/aasx-dx-studio`
- 출발점: `f74342e` (main, 오류 판별 수정 적용 1)
- `python server.py` 또는 Windows `start.bat`. 첫 화면이 AASX 스튜디오다. 기존 수집 화면은 상단 메뉴로 이동한다.
- 기본 접속: `http://127.0.0.1:8765`; 점유 중이면 실행 로그의 포트를 사용한다.

## 구현된 것

- 설비/연결/신호/검토 4단계, 새 설비, 가상 FC-5000 예제, 자동 저장과 복원, 창 간 revision 충돌 감지.
- 식별자 유지, 자료형/주소/워드 순서/배율/보정/단위/선택적 의미 식별자.
- OPC AASX ZIP 생성과 관계 기반 JSON 가져오기. 앱 프로필이 있으면 수집 매핑 복원. 외부 AAS의 식별자 선택 후 직접 매핑 시작.
- 입력/수집 준비 검사, 누락 수정 이동, 증거 수준에 따른 하드웨어 검토 후보와 제조사 자료 링크.
- 수집 설정 미리보기와 명시적 추가. 기존 설정/작업 유지, 백업, 중복·설정 변경 충돌·수집 중 적용 차단.
- 크기/경로/중복 ZIP/외부 참조/NaN·Infinity/프로필 ID 불일치 검사. 업로드로 자동 네트워크 접속하지 않음.
- Python stdlib 회귀 검사, 독립된 공식 JSON 스키마 검사 도구, GitHub Actions 검사 정의.

## 코드 지도

| 경로 | 역할 |
|---|---|
| `aas_service.py` | 프로젝트 계약, 준비 검사, 추천 규칙, AAS Environment/OPC 내보내기, 업로드 분석, 설정 생성, 로컬 초안 저장 |
| `server.py` | `/api/aas/project`, `assess`, `import`, `export`, `plan`, `apply`; 기존 엔진 통합 |
| `web/studio.js`, `web/studio.css` | 스튜디오 화면과 상태 흐름 |
| `tests/test_aas_service.py` | 왕복/불량 입력/설정 보존/충돌 등의 회귀 검사 |
| `tools/validate_aas_schema.py` | 고정 IDTA 3.2 JSON 스키마로 생성된 Environment 검사 |

## 검증 상태

Windows Python 3.12에서 회귀 28개 통과(HTTP 파일 왕복/요청 차단 및 잘못된 Unicode 검사 포함), Python 컴파일과 JavaScript 구문 검사 통과. 부분 입력/Modbus/XGT 예제의 생성 결과가 고정 IDTA 3.2 JSON 스키마의 구조 검사에 통과했다.

브라우저에서 예제 생성 → 자동 저장 → 새로고침 복원 → 검토 → 미리보기 → 설정 추가 → 기존 3장치 보존 확인 → AASX 다운로드 → 재업로드로 AAS 1개/서브모델 3개/수집 프로필 인식을 확인했다. 모바일 폭에서 문서 가로 넘침이 없었고, 데스크톱 화면의 브라우저 오류/경고 로그도 없었다.

생성된 AAS 수집 작업 1개를 가상 FC-5000(루프백)에서 500ms 주기/3초로 실행했다. 7행을 저장했고 전체 품질이 `OK`, 작업 오류는 없었다. 검증 종료 후 데모 장치와 수집은 중지했다. 샘플 초안/설정/CSV는 로컬 `data/`에만 남고 Git에 포함하지 않는다.

공식 스키마 직접 다운로드는 이 PC의 Python 인증서 체인 오류로 막혔다. GitHub 커넥터로 가져온 동일 원문의 Git blob digest를 확인하고 `--schema`로 검증했다. TLS 검증을 끄지 않았다. 다른 PC의 네트워크 제한이 있으면 같은 오프라인 경로를 사용한다.

Windows 관리 샌드박스에서는 소켓과 `os.replace()`가 차단될 수 있다. 실제 권한 환경에서 파일 저장/백업 검사는 통과했으므로 이를 제품 저장 실패로 오인하지 않는다. 다른 환경에서도 재검증한다. CI 통과 여부는 GitHub의 실제 결과로 확인한다.

## 명확한 미완료 사항

1. 외부 AAS 도구(AASX Package Explorer / BaSyx 등)와의 교환 검증, XML 직렬화 가져오기, AAS 2.x 마이그레이션.
2. IDTA Digital Nameplate / Asset Interfaces 공식 템플릿과 의미/카디널리티 검증. 현재 앱 전용 서브모델을 공식 템플릿으로 부르지 않는다.
3. 실제 PLC·ADAM 연결 검증. 기존 README의 XGT 실기기 미검증 주의도 여전히 유효하다.
4. 프로젝트 라이브러리와 버전 이력. 현재 PC당 초안 하나, 설정 추가 전용. 파일 교환으로 다른 PC에 초안을 옮길 수 있다.
5. CPU/모듈/펌웨어 호환 카탈로그, 장비 견적/발주, 신뢰할 수 있는 주소 템플릿.
6. 다중 사용자·다중 고객 인증/권한/이력·파일 저장소·현장 에이전트 분리. 현재는 로컬 파일럿 서비스다.

## 다른 데스크톱에서 이어가는 절차

처음 받는 PC:

```text
git clone https://github.com/tinppl/PLC_collector.git
cd PLC_collector
git switch codex/aasx-dx-studio
python -m unittest discover -s tests -v
python server.py
```

이미 받은 PC는 먼저 `git status`로 로컬 변경을 확인한 뒤 `git fetch origin`, 해당 브랜치 전환, `git pull --ff-only`를 수행한다. 로컬 변경이 있으면 보관/커밋한 다음 동기화한다. 강제 초기화로 덮어쓰지 않는다.

Codex에서 **clone한 저장소 폴더 자체**를 프로젝트로 열고 다음 문장을 전달하면 된다:

> AGENTS.md와 docs/PRODUCT.md, docs/DECISIONS.md, docs/HANDOFF.md를 읽고 현재 Git 상태와 검증 결과를 확인해. 이 프로젝트의 의도를 유지하면서 다음 미완료 항목을 구현하고, 작업을 끝낼 때 인계 문서도 갱신해.

코드와 문서는 Git으로 이어간다. 대화 자동 동기화가 프로젝트 인계를 대신한다고 가정하지 않는다. 운영 초안·수집 설정·CSV는 `data/` 아래에 있고 Git에서 제외된다. 같은 초안을 다른 PC에서 쓰려면 AASX로 내보내고 그 PC에서 가져온다. 실제 고객 데이터는 별도의 승인된 비공개 보관 경로를 사용한다.

## 다음 작업 권장 순서

먼저 외부 AAS 도구와 교환 검증을 하여 파일 호환성 근거를 확보한다. 그다음 고정 버전 IDTA 명판 템플릿과 필드별 의미 검증을 추가한다. 실설비 1종을 선정해 통신·스케일·단위와 측정값을 현장에서 대조한 뒤 해당 장비용 검증된 매핑 템플릿을 만든다. 임의의 신규 기능을 늘리기보다 이 순서를 우선한다.
