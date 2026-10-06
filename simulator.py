"""가상 장치 시뮬레이터 - 실기기 없이 설정 파일/수집 로직을 검증하는 용도

설정에서 device에 "sim": true 를 주고, 태그에 "sim" 항목을 주면 해당 값이 자동 생성된다.
  {"kind": "pulse", "period_s": 20, "at_s": 2, "width_s": 1}      주기마다 일정 시간 ON (이벤트 신호)
  {"kind": "wave",  "min": 250, "max": 320, "period_s": 20, "noise": 2}   사인파 + 노이즈 (온도/유량)
  {"kind": "ramp",  "start": 1250, "rate_per_s": 1.9}              일정 속도로 증가 (적산 유량)
  {"kind": "const", "value": 1}
"""
import math
import random
import threading
import time

from modbus_tcp import DataStore, ModbusTcpServer
from xgt import XgtServer


# ----------------------------------------------------------------------
# 장애 재현 (ADAM-4571 + FC-5000 구간에서 실기기 연결 때 겪을 문제를 미리 겪어 보기 위한 스위치)
#   kind: toggle(켜고 끄기) / timed(지정한 시간 동안만 켜짐) / action(한 번 실행)
#   주의: 실제 장비가 오류를 어떤 형태로 돌려주는지는 추정이다 (예: 무응답인지 예외 응답인지)
# ----------------------------------------------------------------------
FAULT_DEFS = [
    {"id": "gateway_off", "code": "P1", "kind": "toggle", "params": [],
     "title": "게이트웨이 모드 꺼짐",
     "desc": "TCP 연결은 되지만 읽기 요청에 응답이 없습니다. (4571이 Modbus TCP↔RTU 변환 모드가 아닐 때)"},
    {"id": "unit_wrong", "code": "P2", "kind": "toggle",
     "params": [{"key": "unit", "label": "실제 국번", "default": 2, "min": 0, "max": 247}],
     "title": "국번(Unit ID) 불일치",
     "desc": "설정한 국번과 다른 국번으로 요청하면 응답이 없습니다. (FC-5000의 실제 국번이 다를 때)"},
    {"id": "addr_offset", "code": "P3", "kind": "toggle",
     "params": [{"key": "offset", "label": "어긋남(칸)", "default": 1, "min": -8, "max": 8}],
     "title": "주소 어긋남",
     "desc": "값이 문서 주소보다 N칸 뒤에 있습니다. 주소 탐색으로 오프셋을 찾아야 합니다."},
    {"id": "word_swap", "code": "P4", "kind": "toggle", "params": [],
     "title": "32비트 워드 순서 반대",
     "desc": "float 값의 상위·하위 워드가 뒤바뀌어 엉뚱한 값이 읽힙니다."},
    {"id": "unstable", "code": "P5", "kind": "toggle",
     "params": [{"key": "delay_ms", "label": "응답 지연(ms)", "default": 1000, "min": 0, "max": 10000},
                {"key": "drop_pct", "label": "무응답 확률(%)", "default": 20, "min": 0, "max": 100}],
     "title": "응답 지연 · 간헐적 시간 초과",
     "desc": "응답이 느리고 가끔 아예 오지 않습니다. 수집기 시간 초과 기본값은 2초입니다."},
    {"id": "conn_drop", "code": "P6", "kind": "timed",
     "params": [{"key": "seconds", "label": "지속 시간(초)", "default": 30, "min": 1, "max": 600}],
     "title": "연결 끊김 후 복구",
     "desc": "연결을 받자마자 닫는 상태가 지정한 시간 동안 이어진 뒤 자동으로 복귀합니다."},
    {"id": "total_reset", "code": "P7", "kind": "action", "params": [],
     "title": "적산값 리셋",
     "desc": "누를 때마다 적산값(Total)이 0으로 돌아간 뒤 다시 증가합니다."},
    {"id": "total_freeze", "code": "P8", "kind": "toggle", "params": [],
     "title": "적산값 정지",
     "desc": "적산값이 변하지 않습니다. 해제하면 멈춘 값에서 이어서 증가합니다."},
]
_FAULT_BY_ID = {d["id"]: d for d in FAULT_DEFS}


class FaultBoard:
    """장치별로 켜진 장애를 보관한다. 서버 스레드와 화면 요청이 함께 접근하므로 잠금을 쓴다."""

    def __init__(self):
        self._lock = threading.Lock()
        self._st = {}       # (장치, 장애 id) -> {"params": {...}, "until": 종료 시각 또는 None}

    def set(self, device, fid, on, params=None):
        d = _FAULT_BY_ID.get(fid)
        if d is None or d["kind"] == "action":
            raise ValueError(f"켜고 끌 수 없는 장애입니다: {fid}")
        with self._lock:
            if not on:
                self._st.pop((device, fid), None)
                return
            p = {"on": True}
            for spec in d["params"]:
                v = (params or {}).get(spec["key"], spec["default"])
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    raise ValueError(f"{spec['label']}에는 숫자를 입력하세요")
                p[spec["key"]] = max(spec["min"], min(spec["max"], v))
            until = time.time() + p["seconds"] if d["kind"] == "timed" else None
            self._st[(device, fid)] = {"params": p, "until": until}

    def get(self, device, fid):
        """켜져 있으면 파라미터 dict(항상 비어 있지 않음), 아니면 None"""
        with self._lock:
            s = self._st.get((device, fid))
            if s is None:
                return None
            if s["until"] is not None and time.time() >= s["until"]:
                del self._st[(device, fid)]
                return None
            return s["params"]

    def snapshot(self):
        now, out = time.time(), {}
        with self._lock:
            for (dev, fid), s in list(self._st.items()):
                if s["until"] is not None and now >= s["until"]:
                    del self._st[(dev, fid)]
                    continue
                out.setdefault(dev, {})[fid] = {
                    "params": {k: v for k, v in s["params"].items() if k != "on"},
                    "remaining_s": None if s["until"] is None else round(s["until"] - now, 1)}
        return out


def sim_value(spec, t):
    kind = spec.get("kind", "const")
    if kind == "pulse":
        phase = (t - spec.get("at_s", 0)) % spec["period_s"]
        return 0 <= phase < spec.get("width_s", 1)
    if kind == "wave":
        mid = (spec["min"] + spec["max"]) / 2
        amp = (spec["max"] - spec["min"]) / 2
        v = mid + amp * math.sin(2 * math.pi * t / spec.get("period_s", 20))
        return v + random.uniform(-1, 1) * spec.get("noise", 0)
    if kind == "ramp":
        return spec.get("start", 0) + spec.get("rate_per_s", 1) * t
    return spec.get("value", 0)


def _write_tag(store, tag, value, swap=False):
    if tag.is_bit:
        store.set(tag.area, tag.address, [bool(value)])
    elif tag.dtype == "bool" and tag.bit is not None:
        cur = store.get(tag.area, tag.address, 1)[0]
        mask = 1 << int(tag.bit)
        store.set(tag.area, tag.address, [(cur | mask) if value else (cur & ~mask)])
    else:
        words = tag.encode(value)
        if swap and len(words) == 2:        # P4: 32비트 값의 워드 순서를 뒤집어 저장
            words = words[::-1]
        store.set(tag.area, tag.address, words)


class Simulator:
    """설정의 sim 장치를 가상 Modbus 서버로 띄우고 값을 계속 갱신 (웹/CLI 공용)"""

    def __init__(self, cfg, log):
        self.cfg, self.log = cfg, log
        self.stores, self.servers = {}, []
        self.stop_ev = threading.Event()
        self.thread = None
        self.faults = FaultBoard()
        self.t0 = None
        self._shift = {}        # 태그 이름 -> 적산값에서 빼는 양 (P7 리셋, P8 정지 해제 때 갱신)
        self._frozen = {}       # 태그 이름 -> 정지된 값 (P8)

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        for dname, spec in self.cfg["devices"].items():
            if not spec.get("sim"):
                continue
            store = DataStore()
            bind = spec.get("sim_bind", "127.0.0.1")
            xgt = spec.get("driver") == "xgt"
            port = int(spec.get("port", 2004 if xgt else 502))
            try:
                srv = XgtServer((bind, port), store, spec.get("sim_reject_block", False)) if xgt \
                    else ModbusTcpServer((bind, port), store)
            except OSError as e:
                self.stop()
                raise RuntimeError(f"데모 장치 '{dname}'의 포트 {port}를 열 수 없습니다. "
                                   f"이미 실행 중이거나 다른 프로그램이 사용 중일 수 있습니다. ({e})")
            if not xgt:
                srv.fault = (lambda name, _d=dname: self.faults.get(_d, name))
            srv.start()
            self.servers.append(srv)
            self.stores[dname] = store
            self.log(f"데모 장치 '{dname}' 시작: {bind}:{port}" + (" (LS XGT 전용)" if xgt else ""))
        if not self.stores:
            raise RuntimeError("설정에 데모(sim) 장치가 없습니다")
        self.stop_ev.clear()
        self.t0 = time.time()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _value(self, tag, t):
        """태그의 현재 값. 적산(ramp) 태그는 리셋·정지 장애를 반영한다."""
        v = sim_value(tag.sim, t)
        if tag.sim.get("kind") != "ramp":
            return v
        key = tag.name
        v -= self._shift.get(key, 0.0)
        if self.faults.get(tag.device, "total_freeze") is not None:        # P8
            return self._frozen.setdefault(key, v)
        if key in self._frozen:                    # 정지 해제: 멈춘 값에서 이어서 증가
            frozen = self._frozen.pop(key)
            self._shift[key] = self._shift.get(key, 0.0) + (v - frozen)
            return frozen
        return v

    def _loop(self):
        tags = [t for t in self.cfg["_tags"].values() if t.sim and t.device in self.stores]
        while not self.stop_ev.is_set():
            t = time.time() - self.t0
            for tag in tags:
                swap = self.faults.get(tag.device, "word_swap") is not None   # P4
                _write_tag(self.stores[tag.device], tag, self._value(tag, t), swap)
            self.stop_ev.wait(0.05)

    # ---- 장애 제어 (웹 화면/API에서 호출) ----
    def fault_devices(self):
        """장애를 걸 수 있는 장치(Modbus 가상 장치)"""
        return [n for n, s in self.cfg["devices"].items()
                if s.get("sim") and s.get("driver") != "xgt" and n in self.stores]

    def set_fault(self, device, fid, on, params=None):
        if device not in self.fault_devices():
            raise ValueError(f"장애를 걸 수 없는 장치입니다: {device}")
        self.faults.set(device, fid, on, params)

    def run_action(self, device, fid):
        if device not in self.fault_devices():
            raise ValueError(f"장애를 걸 수 없는 장치입니다: {device}")
        if fid != "total_reset":
            raise ValueError(f"실행할 수 없는 동작입니다: {fid}")
        t = time.time() - self.t0
        for tag in self.cfg["_tags"].values():
            if tag.device == device and tag.sim and tag.sim.get("kind") == "ramp":
                self._shift[tag.name] = sim_value(tag.sim, t)       # 지금 값이 0이 되도록
                if tag.name in self._frozen:
                    self._frozen[tag.name] = 0.0

    def stop(self):
        self.stop_ev.set()
        if self.thread:
            self.thread.join(timeout=2)
            self.thread = None
        for s in self.servers:
            try:
                s.shutdown()
                s.server_close()
            except Exception:
                pass
        self.servers, self.stores = [], {}


def run_sim(cfg, stop_event, log):
    sim = Simulator(cfg, log)
    try:
        sim.start()
    except RuntimeError as e:
        raise SystemExit(str(e))
    log("시뮬레이터 동작 중 (중지: Ctrl+C)")
    try:
        while not stop_event.is_set():
            stop_event.wait(0.3)
    finally:
        sim.stop()