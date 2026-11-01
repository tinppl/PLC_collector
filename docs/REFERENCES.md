# 확인한 출처와 검증 범위

확인일: 2026-11-01 (Asia/Seoul). 구현자가 다시 확인할 수 있는 원문을 남긴다.

- [IDTA AASX Package File Format 원문](https://github.com/admin-shell-io/aas-specs-aasx/blob/main/documentation/IDTA-01005/modules/ROOT/pages/aasx.adoc): OPC 구조, aasx-origin/aas-spec 관계, 파일 MIME `application/aas+zip`의 근거. 네임스페이스는 `http://admin-shell.io/aasx/relationships/`, OPC XML 네임스페이스는 `http://schemas.openxmlformats.org/package/2006/relationships`를 사용한다.
- [IDTA AAS 메타모델 JSON 스키마](https://github.com/admin-shell-io/aas-specs-metamodel/blob/master/schemas/json/aas.json): 확인한 제목 `IDTA-01001-3-2 AAS JSON Schema`. 검사 도구는 Git blob `4aaed6e9e2f00a21e6e50390fc19335250b6f7c2`를 고정하고 Git blob digest를 대조한다. 라이선스는 원 저장소의 CC-BY-4.0을 따른다. 이 저장소에 스키마 원문을 재배포하지 않는다.
- [Advantech ADAM-6017 제조사 자료](https://buy.advantech.com/Buy-Online/bymodel-ADAM-6017.htm): 8 AI, 전압/전류 범위, Modbus TCP 등 확인. 제품 가격은 서비스 규칙에 복사하지 않는다. 실제 모델 세대와 펌웨어는 구매/현장 사용 전 별도 확인한다.
- [Advantech ADAM-6000 사용자 매뉴얼](https://advdownload.advantech.com/productfile/Downloadfile4/1-2B6FKTG/ADAM-6000_User_Manaul_Ed.12-FINAL.pdf): ADAM-6017 입력 형식, 배선 및 레지스터 맵을 확인할 때 참고한다. 이 버전에서 자동 채널 주소 생성은 구현하지 않았다.
- [LS ELECTRIC XGT Ethernet 모듈 매뉴얼](https://sol.ls-electric.com/ww/en/product/document/2895): FEnet 모듈/전용 통신 검토 근거. 특정 CPU-모듈 조합에 대한 호환성을 자동 확정하지 않는다.
- [OpenAI 공식 Codex 작업 인계 예시](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex): Codex가 읽는 `AGENTS.md`와 Git 안의 문서로 의도/진행 기록을 유지하는 방법의 근거. 다른 문서 파일의 이름과 역할은 이 프로젝트가 정한 규칙이다.

JSON 스키마 검사는 구조 검증이며 semanticId의 실제 사전 등재, IDTA 템플릿 카디널리티, 메타모델의 모든 의미 제약, 전자서명, 타 도구 호환성 또는 실설비 정확성을 검증하지 않는다. 업로드 API는 전체 스키마 검사를 수행하지 않고 패키지·필수 구조·앱 프로필을 검사한다.
