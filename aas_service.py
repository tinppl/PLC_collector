"""AASX authoring and bounded inspection. No network/device operations on import.

The exported AAS 3.x Environment uses application-owned submodels; it does not
claim conformance to the IDTA Digital Nameplate or Asset Interfaces templates.
"""
import base64
import copy
import hashlib
import io
import json
import math
import os
import posixpath
import re
import uuid
import zipfile
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from engine import ConfigError, build_config
from tagcodec import Tag

PROFILE = "urn:plc-collector:aas:connection-profile:1"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
AAS_REL = "http://admin-shell.io/aasx/relationships/"
MAX_UPLOAD = 3 * 1024 * 1024
MAX_EXPANDED = 16 * 1024 * 1024
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
SOURCE_ADAM = "https://buy.advantech.com/Buy-Online/bymodel-ADAM-6017.htm"
SOURCE_LS = "https://sol.ls-electric.com/ww/en/product/document/2895"


class AasError(ValueError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def invalid_unicode(text):
    return any(0xD800 <= ord(c) <= 0xDFFF or ord(c) in (0xFFFE, 0xFFFF) for c in text)


def initial_project():
    key = str(uuid.uuid4())
    return {"schema_version": 1, "asset": {"name": "", "manufacturer": "", "model": "",
            "serial": "", "asset_id": "urn:uuid:" + key, "aas_id": "urn:uuid:" + str(uuid.uuid4()),
            "location": "", "purpose": "설비 상태 모니터링"},
            "connection": {"protocol": "unknown", "host": "", "port": 502, "unit": 1,
                           "ethernet": "unknown", "signal": "unknown", "channels": 1,
                           "period_ms": 1000}, "tags": []}


def normalize(raw):
    """Strict service contract, including drafts. Missing values remain editable."""
    if not isinstance(raw, dict):
        raise AasError("설비 정보는 객체 형식이어야 합니다.")
    if raw.get("schema_version", 1) != 1:
        raise AasError("지원하지 않는 수집 프로필 버전입니다.")
    result = {"schema_version": 1}
    for section, fields in (("asset", ("name", "manufacturer", "model", "serial", "asset_id", "aas_id", "location", "purpose")),
                            ("connection", ("protocol", "host", "ethernet", "signal"))):
        obj = raw.get(section, {})
        if not isinstance(obj, dict):
            raise AasError(f"{section}: 입력 형식을 확인하세요.")
        result[section] = {}
        for field in fields:
            value = obj.get(field, "")
            if not isinstance(value, str) or len(value) > 500 or invalid_unicode(value) or any(ord(c) < 32 for c in value):
                raise AasError(f"{field}: 500자 이내의 텍스트를 입력하세요.")
            result[section][field] = value.strip()
    c = result["connection"]
    for k, lo, hi, default in (("port", 1, 65535, 502), ("unit", 0, 255, 1),
                                ("channels", 1, 1024, 1), ("period_ms", 100, 3600000, 1000)):
        v = raw.get("connection", {}).get(k, default)
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise AasError(f"{k}: {lo}~{hi} 사이의 정수를 입력하세요.")
        c[k] = v
    for k, values in (("protocol", ("unknown", "modbus_tcp", "xgt", "serial", "opcua")),
                      ("ethernet", ("unknown", "yes", "no")),
                      ("signal", ("unknown", "plc", "4-20ma", "0-10v", "rtd", "thermocouple", "digital"))):
        if c[k] not in values:
            raise AasError(f"{k}: 선택 항목을 확인하세요.")
    tags = raw.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 100:
        raise AasError("신호는 최대 100개까지 등록할 수 있습니다.")
    result["tags"] = []
    for i, tag in enumerate(tags):
        if not isinstance(tag, dict):
            raise AasError(f"신호 {i + 1}: 형식을 확인하세요.")
        clean = {}
        for k, default in (("name", ""), ("address", ""), ("type", "u16"), ("unit", ""),
                           ("area", "holding"), ("word_order", "big"), ("semantic_id", "")):
            v = tag.get(k, default)
            if not isinstance(v, str) or len(v) > 500 or invalid_unicode(v) or any(ord(ch) < 32 for ch in v):
                raise AasError(f"신호 {i + 1} {k}: 텍스트 형식을 확인하세요.")
            clean[k] = v.strip()
        for k, default in (("factor", 1), ("offset", 0)):
            v = tag.get(k, default)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise AasError(f"신호 {i + 1} {k}: 유한한 숫자를 입력하세요.")
            clean[k] = v
        result["tags"].append(clean)
    return result


def iri(value):
    return bool(value and re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value) and not re.search(r"\s", value))


def assess(raw):
    p = normalize(raw)
    a, c = p["asset"], p["connection"]
    issues, checks, recommendations = [], [], []

    def issue(level, field, message, action):
        issues.append({"level": level, "field": field, "message": message, "action": action})

    for k, label in (("name", "설비 이름"), ("manufacturer", "제조사"), ("model", "모델명")):
        if not a[k]:
            issue("error", "asset." + k, label + "이 비어 있습니다.", "설비 명판이나 매뉴얼에서 확인해 입력하세요.")
    for k in ("aas_id", "asset_id"):
        if not iri(a[k]):
            issue("error", "asset." + k, "유효한 고유 식별자가 필요합니다.", "urn:uuid:… 또는 https://… 형식을 사용하세요.")
    if not a["serial"]:
        issue("warning", "asset.serial", "설비 일련번호를 아직 입력하지 않았습니다.", "명판의 일련번호를 확인하면 같은 모델의 설비를 구별하기 쉽습니다.")
    identity_ok = not any(i["level"] == "error" for i in issues)
    supported = c["protocol"] in ("modbus_tcp", "xgt")
    if not supported:
        issue("blocker", "connection.protocol", "현재 통신 방식으로 수집 설정을 만들 수 없습니다.",
              "Modbus TCP 또는 LS XGT를 확인하거나 호환 게이트웨이를 검토하세요.")
    if not c["host"] or not re.fullmatch(r"[A-Za-z0-9_.:-]+", c["host"]):
        issue("blocker", "connection.host", "장치의 IP/호스트 주소가 필요합니다.", "현장 담당자에게 주소를 확인하세요. 파일 업로드 시 자동 접속하지 않습니다.")
    if c["ethernet"] != "yes":
        issue("blocker", "connection.ethernet", "Ethernet 사용 가능 여부가 확인되지 않았습니다.", "CPU 내장 포트와 기존 통신 모듈을 먼저 확인하세요.")
    if not p["tags"]:
        issue("blocker", "tags", "읽을 신호가 없습니다.", "매뉴얼에서 주소·자료형·워드 순서를 확인해 신호를 추가하세요.")
    names = set()
    for i, t in enumerate(p["tags"]):
        prefix = f"tags.{i}"
        if not ID_RE.fullmatch(t["name"]) or t["name"] in names:
            issue("blocker", prefix + ".name", f"신호 {i + 1}: 고유한 영문 이름이 필요합니다.", "영문자로 시작하는 영문·숫자·밑줄 조합을 사용하세요. 예: FlowRate")
        names.add(t["name"])
        if not t["address"]:
            issue("blocker", prefix + ".address", f"신호 {i + 1}: 주소가 비어 있습니다.", "실제 장비의 레지스터 맵을 확인하세요.")
        if t["word_order"] not in ("big", "little"):
            issue("blocker", prefix + ".word_order", f"신호 {i + 1}: 워드 순서가 올바르지 않습니다.", "상위/하위 워드 순서를 선택하세요.")
        if t["semantic_id"] and not iri(t["semantic_id"]):
            issue("error", prefix + ".semantic_id", f"신호 {i + 1}: 의미 식별자 형식이 올바르지 않습니다.", "urn:… 또는 https://… 형태의 IRI를 입력하거나 비워 두세요.")
        if supported and t["address"]:
            try:
                tag = Tag(t["name"], dict(t, device="asset"), c["protocol"])
                if tag.address < 0 or (c["protocol"] == "modbus_tcp" and tag.address + tag.words > 65536):
                    raise ValueError("주소가 허용 범위를 벗어납니다.")
                if c["protocol"] == "xgt" and tag.area.rstrip("X") not in ("D", "M", "K", "L", "F", "P", "R"):
                    raise ValueError("지원하지 않는 XGT 메모리 영역입니다.")
            except (ValueError, KeyError, TypeError) as e:
                issue("blocker", prefix, f"신호 {i + 1}: {e}", "주소와 자료형 조합을 수정하세요.")
    if c["signal"] in ("4-20ma", "0-10v"):
        count = math.ceil(c["channels"] / 8)
        recommendations.append({"title": "아날로그 Ethernet I/O 검토", "status": "조건부 후보",
            "product": "Advantech ADAM-6017", "quantity": count,
            "reason": f"{c['signal']} 신호 {c['channels']}개를 직접 읽으려면 아날로그 입력이 필요합니다. 8입력 기준 최소 {count}대입니다.",
            "verify": ["기존 PLC에서 같은 값을 읽을 수 있는지 먼저 확인", "입력 범위·절연·센서 전원·배선·변환 스케일 확인", "모델 세대와 펌웨어의 Modbus 레지스터 맵 확인", "채널별 요구 샘플링 주기와 전체 샘플링 속도 확인"],
            "source": SOURCE_ADAM})
    elif c["signal"] in ("rtd", "thermocouple", "digital"):
        recommendations.append({"title": "신호 전용 I/O 검토", "status": "사양 확인 필요", "product": "전용 입력 모듈",
            "reason": "RTD·열전대·디지털 입력은 각 신호에 맞는 입력 회로가 필요합니다.",
            "verify": ["센서 형식·배선 수·입력 범위·필요 채널 수 확인", "ADAM-6017 아날로그 전압/전류 입력과 직접 호환된다고 판단하지 않음"], "source": SOURCE_ADAM})
    if c["ethernet"] == "no" and c["signal"] in ("plc", "unknown"):
        recommendations.append({"title": "기존 PLC 통신 확장 검토", "status": "호환성 확인 필요", "product": "CPU 호환 Ethernet 통신 모듈 또는 게이트웨이",
            "reason": "현재 장치에 Ethernet 경로가 없다고 입력했습니다. CPU와 기존 통신 방식을 확인한 뒤 후보를 정해야 합니다.",
            "verify": ["PLC 제조사·CPU 정확한 형번·펌웨어·여유 슬롯 확인", "내장 Ethernet 또는 기존 모듈의 사용 가능 여부 확인", "LS XGT인 경우 FEnet 전용 서비스 지원과 모듈 호환표 확인"], "source": SOURCE_LS})
    if not recommendations:
        recommendations.append({"title": "기존 장비 우선 사용", "status": "추가 구매 미확정", "product": "현장 사양 확인 후 결정",
            "reason": "확인된 정보만으로 추가 장비 구매가 필요하다고 단정할 수 없습니다.",
            "verify": ["CPU/모듈 모델과 지원 프로토콜 확인", "장치 연결 테스트와 신호 값 비교"], "source": SOURCE_LS if c["protocol"] == "xgt" else SOURCE_ADAM})
    checks = [{"label": "설비 기본 정보", "ok": identity_ok}, {"label": "지원 통신 방식", "ok": supported},
              {"label": "수집 매핑", "ok": bool(p["tags"]) and not any(i["level"] == "blocker" for i in issues)},
              {"label": "현장 연결·값 검증", "ok": False}]
    return {"issues": issues, "checks": checks, "recommendations": recommendations,
            "can_export": not any(i["level"] == "error" for i in issues),
            "can_apply": not any(i["level"] in ("error", "blocker") for i in issues),
            "notice": "앱 내부 검사입니다. IDTA 템플릿 인증·실기기 검증을 의미하지 않습니다.",
            "profile": PROFILE}


def property_(name, value, dtype="xs:string"):
    return {"modelType": "Property", "idShort": name, "valueType": dtype, "value": str(value)}


def environment(raw):
    p = normalize(raw)
    report = assess(p)
    if not report["can_export"]:
        raise AasError("설비 기본 정보와 식별자 오류를 수정한 뒤 내보내세요.")
    a, c = p["asset"], p["connection"]
    # Stable submodel IDs derived from the shell ID, independent of display names.
    subid = lambda name: "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, a["aas_id"] + "/" + name))
    info = {"modelType": "Submodel", "id": subid("identity"), "idShort": "AssetIdentity", "kind": "Instance",
            "submodelElements": [property_(k, a[v]) for k, v in (("AssetName", "name"), ("Manufacturer", "manufacturer"),
                ("Model", "model"), ("SerialNumber", "serial"), ("Location", "location"), ("Purpose", "purpose")) if a[v]]}
    connection = {"modelType": "Submodel", "id": subid("connection"), "idShort": "CollectorConnection", "kind": "Instance",
        "semanticId": {"type": "ExternalReference", "keys": [{"type": "GlobalReference", "value": PROFILE}]},
        "submodelElements": [property_("ProfileVersion", "1"),
            {"modelType": "Blob", "idShort": "CollectorProject", "contentType": "application/json",
             "value": base64.b64encode(json.dumps(p, ensure_ascii=False, allow_nan=False).encode()).decode()}]}
    signals = {"modelType": "Submodel", "id": subid("signals"), "idShort": "SignalDefinitions", "kind": "Instance",
               "submodelElements": []}
    for i, tag in enumerate(p["tags"]):
        element = {"modelType": "SubmodelElementCollection", "idShort": f"Signal{i + 1}",
                   "value": [property_(k, tag[v]) for k, v in (("Name", "name"), ("Address", "address"),
                       ("DataType", "type"), ("Unit", "unit"), ("WordOrder", "word_order")) if tag[v]]}
        if tag["semantic_id"]:
            element["semanticId"] = {"type": "ExternalReference", "keys": [{"type": "GlobalReference", "value": tag["semantic_id"]}]}
        signals["submodelElements"].append(element)
    submodels = [info, connection, signals]
    if not signals["submodelElements"]:
        del signals["submodelElements"]
    return {"assetAdministrationShells": [{"modelType": "AssetAdministrationShell", "id": a["aas_id"],
        "idShort": "AssetShell", "assetInformation": {"assetKind": "Instance", "globalAssetId": a["asset_id"]},
        "submodels": [{"type": "ModelReference", "keys": [{"type": "Submodel", "value": s["id"]}]} for s in submodels]}],
        "submodels": submodels}


def package(raw):
    env = environment(raw)
    buf = io.BytesIO()
    types = ('<?xml version="1.0" encoding="utf-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="json" ContentType="application/json"/>'
        '<Override PartName="/aasx/aasx-origin" ContentType="text/plain"/></Types>')
    def rel(kind, target):
        root = ET.Element("Relationships", {"xmlns": REL})
        ET.SubElement(root, "Relationship", {"Id": "r1", "Type": AAS_REL + kind, "Target": target})
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rel("aasx-origin", "/aasx/aasx-origin"))
        z.writestr("aasx/aasx-origin", "")
        z.writestr("aasx/_rels/aasx-origin.rels", rel("aas-spec", "/aasx/data.json"))
        z.writestr("aasx/data.json", json.dumps(env, ensure_ascii=False, indent=2, allow_nan=False))
    return buf.getvalue()


def _json(data):
    try:
        def pairs(items):
            result = {}
            for k, v in items:
                if k in result:
                    raise AasError("중복 JSON 키는 허용하지 않습니다.")
                result[k] = v
            return result
        result = json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(AasError("NaN/Infinity는 허용하지 않습니다.")))
        pending = [result]
        while pending:
            item = pending.pop()
            if isinstance(item, str) and (invalid_unicode(item) or any(ord(c) < 32 and c not in "\t\n\r" for c in item)):
                raise AasError("지원하지 않는 유니코드/제어 문자가 포함되어 있습니다.")
            if isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
        return result
    except (ValueError, UnicodeError, RecursionError) as e:
        raise AasError("JSON 형식을 읽을 수 없습니다: " + str(e)) from e


def _xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper() or b"\x00" in data:
        raise AasError("DTD/엔티티 또는 UTF-16 XML은 지원하지 않습니다.")
    try:
        return ET.fromstring(data)
    except ET.ParseError as e:
        raise AasError("패키지 관계 XML을 읽을 수 없습니다.") from e


def _target(source, target):
    u = urlsplit(target)
    decoded = unquote(u.path)
    if u.scheme or u.netloc or u.query or u.fragment or "\\" in decoded:
        raise AasError("외부/잘못된 패키지 경로는 지원하지 않습니다.")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), decoded)) if not decoded.startswith("/") else decoded[1:]
    if resolved.startswith("../") or resolved in (".", ".."):
        raise AasError("패키지 범위를 벗어나는 경로입니다.")
    return resolved


def inspect_upload(filename, encoded):
    if not isinstance(filename, str) or not filename.lower().endswith((".aasx", ".json")):
        raise AasError(".aasx 또는 AAS Environment .json 파일을 선택하세요. XML 모델은 아직 지원하지 않습니다.")
    if not isinstance(encoded, str) or len(encoded) > (MAX_UPLOAD * 4 // 3 + 8):
        raise AasError("파일은 최대 3MB까지 업로드할 수 있습니다.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as e:
        raise AasError("파일 인코딩이 올바르지 않습니다.") from e
    if len(data) > MAX_UPLOAD:
        raise AasError("파일은 최대 3MB까지 업로드할 수 있습니다.")
    if filename.lower().endswith(".json"):
        env = _json(data)
    else:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                files = z.infolist()
                if len(files) > 256 or sum(f.file_size for f in files) > MAX_EXPANDED:
                    raise AasError("압축 해제 용량 또는 파일 수 제한을 초과했습니다.")
                names = set()
                for f in files:
                    n = f.filename
                    if (n in names or "\\" in n or n.startswith("/") or ".." in n.split("/")
                            or f.flag_bits & 1 or f.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                        raise AasError("중복·암호화·잘못된 경로/압축 형식이 포함된 패키지입니다.")
                    names.add(n)
                if "[Content_Types].xml" not in names:
                    raise AasError("AASX 콘텐츠 형식 정보가 없습니다.")
                _xml(z.read("[Content_Types].xml"))
                def links(source, kind):
                    relpath = posixpath.join(posixpath.dirname(source), "_rels", posixpath.basename(source) + ".rels") if source else "_rels/.rels"
                    root = _xml(z.read(relpath))
                    found = []
                    for r in root.findall("{" + REL + "}Relationship"):
                        if r.get("Type") in (AAS_REL + kind, AAS_REL.replace("://", "://www.") + kind):
                            if r.get("TargetMode", "Internal") != "Internal":
                                raise AasError("외부 관계를 자동으로 가져오지 않습니다.")
                            found.append(_target(source, r.get("Target", "")))
                    return found
                origins = links("", "aasx-origin")
                if len(origins) != 1 or origins[0] not in names:
                    raise AasError("AASX 시작 관계를 확인할 수 없습니다.")
                specs = links(origins[0], "aas-spec")
                json_specs = [n for n in specs if n.lower().endswith(".json")]
                if len(json_specs) != 1:
                    raise AasError("JSON 모델 1개를 포함한 AASX만 지원합니다. XML/복수 JSON은 변환·분리 후 업로드하세요.")
                env = _json(z.read(json_specs[0]))
        except (zipfile.BadZipFile, KeyError, OSError, RuntimeError, NotImplementedError) as e:
            raise AasError("유효한 AASX 패키지를 읽을 수 없습니다.") from e
    if not isinstance(env, dict) or not isinstance(env.get("assetAdministrationShells"), list) or not env["assetAdministrationShells"]:
        raise AasError("AAS 3.x Environment의 assetAdministrationShells 목록이 필요합니다.")
    shells = env["assetAdministrationShells"]
    subs = env.get("submodels", [])
    if not isinstance(subs, list) or len(subs) > 256 or len(shells) > 100:
        raise AasError("AAS/서브모델 수 또는 형식이 허용 범위를 벗어납니다.")
    if any(not isinstance(x, dict) or not isinstance(x.get("id"), str) or not iri(x["id"]) for x in shells + subs):
        raise AasError("AAS/서브모델 식별자 형식을 확인하세요.")
    for s in shells:
        if s.get("modelType") != "AssetAdministrationShell" or not isinstance(s.get("assetInformation"), dict):
            raise AasError("AAS 3.x 설비 정보 형식을 확인하세요. AAS 2.x는 변환 후 업로드하세요.")
        if not isinstance(s.get("idShort", ""), str) or not isinstance(s["assetInformation"].get("globalAssetId", ""), str):
            raise AasError("AAS 이름과 설비 식별자는 텍스트여야 합니다.")
        if not isinstance(s.get("submodels", []), list):
            raise AasError("AAS 서브모델 참조 형식이 올바르지 않습니다.")
    for sm in subs:
        if sm.get("modelType") != "Submodel":
            raise AasError("서브모델 형식이 올바르지 않습니다.")
    if len({x["id"] for x in shells + subs}) != len(shells + subs):
        raise AasError("중복 AAS/서브모델 식별자가 있습니다.")
    project = None
    for sm in subs:
        keys = sm.get("semanticId", {}).get("keys", []) if isinstance(sm.get("semanticId", {}), dict) else []
        if not isinstance(keys, list):
            raise AasError("서브모델 의미 식별자 형식이 올바르지 않습니다.")
        if any(isinstance(k, dict) and k.get("value") == PROFILE for k in keys):
            if project is not None or len(shells) != 1:
                raise AasError("자동 매핑은 단일 설비·단일 수집 프로필만 지원합니다.")
            elements = sm.get("submodelElements", [])
            if not isinstance(elements, list):
                raise AasError("수집 프로필 요소 형식이 올바르지 않습니다.")
            blobs = [e for e in elements if isinstance(e, dict) and e.get("idShort") == "CollectorProject" and e.get("modelType") == "Blob"]
            if len(blobs) != 1 or not isinstance(blobs[0].get("value"), str):
                raise AasError("수집 프로필 데이터가 없습니다.")
            try:
                project = normalize(_json(base64.b64decode(blobs[0]["value"], validate=True)))
            except (ValueError, TypeError) as e:
                raise AasError("수집 프로필을 읽을 수 없습니다: " + str(e)) from e
            shell = shells[0]
            if project["asset"]["aas_id"] != shell["id"] or project["asset"]["asset_id"] != shell["assetInformation"].get("globalAssetId"):
                raise AasError("AAS 설비 식별자와 수집 프로필의 식별자가 다릅니다.")
            refs = shell.get("submodels", [])
            if not any(isinstance(ref, dict) and isinstance(ref.get("keys"), list) and any(isinstance(k, dict) and k.get("value") == sm["id"] for k in ref["keys"]) for ref in refs):
                raise AasError("수집 프로필이 AAS에서 참조되지 않습니다.")
    return {"filename": os.path.basename(filename), "sha256": hashlib.sha256(data).hexdigest(),
            "shells": [{"id": s["id"], "name": s.get("idShort", s["id"]),
                        "asset_id": (s.get("assetInformation") or {}).get("globalAssetId", "")
                        if isinstance(s.get("assetInformation"), dict) else ""} for s in shells],
            "submodels": [{"id": s["id"], "name": s.get("idShort", s["id"])} for s in subs],
            "project": project, "report": assess(project) if project else None,
            "message": "수집 프로필을 찾았습니다. 아래 매핑을 확인한 뒤 초안으로 가져오세요." if project else
                       "설비 구조를 확인했습니다. 앱 전용 수집 프로필이 없어 PLC 주소는 직접 매핑해야 합니다.",
            "validation": "패키지/프로필 검사만 수행했습니다. 전체 메타모델·IDTA 템플릿 적합성은 미검증입니다."}


def config_plan(raw, existing):
    p = normalize(raw)
    report = assess(p)
    if not report["can_apply"]:
        raise AasError("수집 설정을 적용하기 전에 오류와 매핑 누락을 수정하세요.")
    token = hashlib.sha256(p["asset"]["asset_id"].encode()).hexdigest()[:12]
    device = "aas_" + token
    job = device + "_monitor"
    c = p["connection"]
    devices = {device: {"driver": c["protocol"], "host": c["host"], "port": c["port"], "unit": c["unit"], "timeout_s": 2.0}}
    tags = {}
    for t in p["tags"]:
        name = device + "_" + t["name"]
        tags[name] = {k: t[k] for k in ("address", "type", "unit", "area", "word_order", "factor", "offset")}
        tags[name]["device"] = device
    jobs = {job: {"type": "interval", "period_ms": c["period_ms"], "tags": list(tags)}}
    additions = {"devices": devices, "tags": tags, "jobs": jobs}
    conflicts = [f"{section}/{name}" for section, values in additions.items() for name in values if name in existing.get(section, {})]
    merged = copy.deepcopy(existing)
    for section, values in additions.items():
        merged.setdefault(section, {}).update(values)
    try:
        build_config(merged)
    except (ConfigError, ValueError, TypeError, KeyError) as e:
        raise AasError("수집 설정 검증 실패: " + str(e)) from e
    return {"additions": additions, "conflicts": conflicts, "can_apply": not conflicts,
            "summary": {"devices": len(devices), "tags": len(tags), "jobs": len(jobs)},
            "message": "기존 설정은 유지하고 아래 항목을 추가합니다. 저장 후 장치 연결 테스트를 진행하세요."}


class ProjectStore:
    """Single local workspace draft. The HTTP service serializes access with ST.lock."""
    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "aas", "project.json")

    def load(self):
        if not os.path.exists(self.path):
            return {"project": initial_project(), "revision": None, "updated_at": None}
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def save(self, raw, revision):
        current = self.load()
        if current["revision"] != revision:
            raise AasError("다른 창에서 초안을 변경했습니다. 새로고침 후 다시 저장하세요.")
        doc = {"project": normalize(raw), "revision": str(uuid.uuid4()), "updated_at": stamp()}
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2, allow_nan=False)
        os.replace(tmp, self.path)
        return doc
