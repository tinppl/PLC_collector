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
from tagcodec import BIT_AREAS


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


def _write_tag(store, tag, value):
    if tag.area in BIT_AREAS:
        store.set(tag.area, tag.address, [bool(value)])
    elif tag.dtype == "bool" and tag.bit is not None:
        cur = store.get(tag.area, tag.address, 1)[0]
        mask = 1 << int(tag.bit)
        store.set(tag.area, tag.address, [(cur | mask) if value else (cur & ~mask)])
    else:
        store.set(tag.area, tag.address, tag.encode(value))


class Simulator:
    """설정의 sim 장치를 가상 Modbus 서버로 띄우고 값을 계속 갱신 (웹/CLI 공용)"""

    def __init__(self, cfg, log):
        self.cfg, self.log = cfg, log
        self.stores, self.servers = {}, []
        self.stop_ev = threading.Event()
        self.thread = None

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        for dname, spec in self.cfg["devices"].items():
            if not spec.get("sim"):
                continue
            store = DataStore()
            bind = spec.get("sim_bind", "127.0.0.1")
            port = int(spec.get("port", 502))
            try:
                srv = ModbusTcpServer((bind, port), store)
            except OSError as e:
                self.stop()
                raise RuntimeError(f"데모 장치 '{dname}'의 포트 {port}를 열 수 없습니다. "
                                   f"이미 실행 중이거나 다른 프로그램이 사용 중일 수 있습니다. ({e})")
            srv.start()
            self.servers.append(srv)
            self.stores[dname] = store
            self.log(f"데모 장치 '{dname}' 시작: {bind}:{port}")
        if not self.stores:
            raise RuntimeError("설정에 데모(sim) 장치가 없습니다")
        self.stop_ev.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        tags = [t for t in self.cfg["_tags"].values() if t.sim and t.device in self.stores]
        t0 = time.time()
        while not self.stop_ev.is_set():
            t = time.time() - t0
            for tag in tags:
                _write_tag(self.stores[tag.device], tag, sim_value(tag.sim, t))
            self.stop_ev.wait(0.05)

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
