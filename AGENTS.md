# PLC Collector / AASX Studio

이 저장소는 PLC 수집기를 바탕으로 **설비 정보 → AASX 생성/업로드 → 통신·신호 매핑 → 현장 검증 → 데이터 수집**을 연결하는 서비스다. 비전과 실제 구현 범위를 혼동하지 않는다.

작업을 시작할 때 `docs/PRODUCT.md`, `docs/HANDOFF.md`, `docs/DECISIONS.md`를 먼저 읽는다. 최신 Git 상태와 실제 코드를 확인하고 인계 문서의 미완료 항목에서 이어간다.

## 구현 원칙

- 한국어 현장 담당자를 위한 구체적인 설명, 수정 가능한 초안, 단계별 점검을 유지한다.
- PLC 주소·타입·단위·스케일·모듈 호환성을 추측해서 검증된 정보처럼 저장하지 않는다.
- AASX 가져오기/저장은 네트워크 접속 또는 수집 시작을 유발하지 않는다. 설정 적용은 미리보기 후 명시적 동작으로 수행한다.
- 기본 프로토콜은 읽기 전용 Modbus TCP / LS XGT다. 기존 수집 엔진과 화면을 유지한다.
- 앱 전용 프로필과 IDTA 공식 서브모델 템플릿을 명확히 구분한다. 스키마 검사 통과를 실기기 검증이나 전체 표준 적합성으로 표현하지 않는다.
- 장비 추천에는 이유·제약·구매 전 확인 사항·제조사 출처가 필요하다. CPU 형번 없이 특정 통신 모듈 호환을 단정하지 않는다.
- 외부 입력은 텍스트 노드로 표시한다. 업로드 파일을 디스크에 풀거나 외부 참조를 자동 요청하지 않는다.
- 런타임은 Python 표준 라이브러리와 buildless JavaScript를 우선한다. 추가 의존성은 필요성과 실행 방법을 문서화한다.
- `data/`, 실제 설비 IP/일련번호, 고객 AASX, 자격 증명을 Git에 넣지 않는다. 예제는 가상 정보만 사용한다.

## 검증과 인계

```text
python -m unittest discover -s tests -v
python -m compileall -q aas_service.py server.py
node --check web/studio.js
```

내보내기 구조를 바꾸면 `pip install -r requirements-dev.txt` 후 `python tools/validate_aas_schema.py`로 고정한 IDTA 스키마와 대조한다. 네트워크가 없으면 이전에 받은 스키마를 `--schema`로 전달한다. Windows 샌드박스가 소켓/원자적 파일 교체를 차단할 경우 제품 오류와 환경 제약을 구분한다.

화면 변경은 브라우저에서 입력·복원·검토·실패 상태를 확인한다. 작업 종료 전 `docs/HANDOFF.md`에 목적, 실제 변경, 검증 증거, 한계, 다음 작업을 갱신한다. 설계 방향을 바꾸면 `docs/DECISIONS.md`에 이유를 남긴다. 사용자 요청으로 GitHub에 동기화할 때 `codex/` 작업 브랜치를 사용하고 고객 데이터가 포함되지 않았는지 확인한다.
