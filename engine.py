"""수집 엔진

설정 파일(JSON/YAML)만 바꾸면 '무엇을(tags) / 어디서(devices) / 언제(jobs)'가 바뀐다.
지원 프로토콜(driver): modbus_tcp, xgt(LS XGT 전용). 새 프로토콜은 DRIVERS 와 make_client()에 추가하면 된다.
"""
import copy
import csv
import json
import os
import re
import threading
import time
from collections import namedtuple
from datetime import datetime

from modbus_tcp import ModbusTcpClient
from tagcodec import Tag
from xgt import XgtClient

DRIVERS = ("modbus_tcp", "xgt")
DEFAULT_PORT = {"modbus_tcp": 502, "xgt": 2004}

Reading = namedtuple("Reading", "value quality")   # quality: OK / RANGE / COMM
_print_lock = threading.Lock()
LOG_HOOKS = []          # 웹 서버가 로그를 화면으로 보내기 위해 등록
INTERVAL_LOG = True     # False면 주기 수집의 매 행 로그를 남기지 않음(웹 서버 모드)
_NAME_RE = re.compile(r"^[^\s,\"'\\/:*?<>|]+$")


class ConfigError(Exception):
    pass


def log(msg):
    with _print_lock:
        try:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)
        except Exception:
            pass
    for hook in list(LOG_HOOKS):
        try:
            hook(msg)
        except Exception:
            pass


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, float):
        return round(v, 4)
    return v


def _uniq(seq):
    return list(dict.fromkeys(seq))


# --------------------------------------------------------------------------
# 설정
# --------------------------------------------------------------------------
def job_tags(spec):
    """작업이 참조하는 모든 태그 이름"""
    t = spec.get("type")
    names = []
    if t == "interval":
        names += spec.get("tags", [])
    else:
        if t == "cycle":
            names += [spec["start"]["tag"], spec["end"]["tag"]]
            names += spec.get("start_snapshot", []) + spec.get("end_snapshot", [])
            names += list(spec.get("diff", {}).values())
        for ev in spec.get("events", []):
            names += [ev["tag"]] + ev.get("snapshot", [])
    return _uniq(names)


def load_config(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            text = f.read()
    except OSError as e:
        raise ConfigError(f"설정 파일을 열 수 없습니다: {e}")
    try:
        if path.lower().endswith((".yaml", ".yml")):
            import yaml  # 선택 기능: pip install pyyaml
            raw = yaml.safe_load(text)
        else:
            raw = json.loads(text)
    except Exception as e:
        raise ConfigError(f"설정 파일 형식 오류: {e}")
    return build_config(raw)


def build_config(raw):
    """딕셔너리 설정을 검증하고 실행용 설정(cfg)으로 만든다. 오류는 ConfigError"""
    cfg = copy.deepcopy(raw)

    def clean(d):
        return {k: v for k, v in (d or {}).items() if not str(k).startswith("_")}

    cfg["devices"] = clean(cfg.get("devices"))
    cfg["jobs"] = clean(cfg.get("jobs"))
    raw_tags = clean(cfg.get("tags"))
    for kind, names in (("장치", cfg["devices"]), ("변수", raw_tags), ("작업", cfg["jobs"])):
        for n in names:
            if not _NAME_RE.match(str(n)):
                raise ConfigError(f"{kind} 이름 '{n}'에 공백이나 , \" ' / \\ : * ? < > | 문자는 쓸 수 없습니다")
    for n, s in cfg["devices"].items():
        if s.get("driver", "modbus_tcp") not in DRIVERS:
            raise ConfigError(f"장치 '{n}': 지원하지 않는 프로토콜 '{s.get('driver')}' (사용 가능: {', '.join(DRIVERS)})")
        if not str(s.get("host", "")).strip():
            raise ConfigError(f"장치 '{n}': 주소(host)가 없습니다")
    tags = {}
    for n, s in raw_tags.items():
        try:
            dev = s["device"]
            if dev not in cfg["devices"]:
                raise ConfigError(f"변수 '{n}'가 등록되지 않은 장치 '{dev}'를 사용합니다")
            tags[n] = Tag(n, s, cfg["devices"][dev].get("driver", "modbus_tcp"))
        except (KeyError, ValueError, TypeError) as e:
            raise ConfigError(f"변수 '{n}' 설정 오류: {e}")
    cfg["_tags"] = tags
    for n, s in cfg["jobs"].items():
        if s.get("type") not in ("interval", "event", "cycle"):
            raise ConfigError(f"작업 '{n}': 종류는 interval/event/cycle 중 하나여야 합니다")
        try:
            refs = job_tags(s)
        except (KeyError, TypeError) as e:
            raise ConfigError(f"작업 '{n}': 필수 항목 {e} 가 없습니다")
        for r in refs:
            if r not in cfg["_tags"]:
                raise ConfigError(f"작업 '{n}': 등록되지 않은 변수 '{r}'")
        if s["type"] == "interval":
            if not s.get("tags"):
                raise ConfigError(f"작업 '{n}': 읽을 변수를 하나 이상 선택하세요")
            if not s.get("period_ms") or s["period_ms"] < 10:
                raise ConfigError(f"작업 '{n}': 수집 주기는 10ms 이상이어야 합니다")
        if s["type"] == "event" and not s.get("events"):
            raise ConfigError(f"작업 '{n}': 이벤트를 하나 이상 추가하세요")
        if s["type"] in ("event", "cycle"):
            for ev in s.get("events", []):
                if not str(ev.get("name", "")).strip():
                    raise ConfigError(f"작업 '{n}': 이름이 없는 이벤트가 있습니다")
    return cfg


def make_client(spec):
    """장치 설정 -> 통신 클라이언트. 모든 클라이언트는 read(area, addr, count) / close() /
    is_bit(area) / limits(area, gap) / trace 를 제공한다."""
    driver = spec.get("driver", "modbus_tcp")
    if driver == "modbus_tcp":
        return ModbusTcpClient(spec["host"], spec.get("port", DEFAULT_PORT[driver]),
                               spec.get("unit", 1), spec.get("timeout_s", 2.0))
    if driver == "xgt":
        return XgtClient(spec["host"], spec.get("port", DEFAULT_PORT[driver]), spec.get("timeout_s", 2.0),
                         cpu_info=spec.get("cpu_info", 0xA0), position=spec.get("position", 0),
                         bcc=spec.get("bcc", "sum"), block_read=spec.get("block_read", True))
    raise ConfigError(f"지원하지 않는 driver: {driver}")


# --------------------------------------------------------------------------
# 태그 읽기 (같은 장치/영역의 가까운 주소는 한 번의 요청으로 묶어서 읽음)
# --------------------------------------------------------------------------
class Reader:
    def __init__(self, cfg):
        self.cfg = cfg
        self.tags = cfg["_tags"]
        self._clients = {}
        self._lock = threading.Lock()
        self.errors = {}          # device -> 마지막 통신 오류 메시지
        self.last_error = ""

    def _client(self, dev):
        with self._lock:
            if dev not in self._clients:
                self._clients[dev] = make_client(self.cfg["devices"][dev])
            return self._clients[dev]

    def close(self):
        for c in self._clients.values():
            c.close()

    def read(self, names):
        out = {}
        groups = {}
        for n in _uniq(names):
            t = self.tags[n]
            groups.setdefault((t.device, t.area), []).append(t)
        for (dev, area), tags in groups.items():
            client = self._client(dev)
            max_gap, limit = client.limits(area, self.cfg["devices"][dev].get("max_gap", 4))
            tags.sort(key=lambda t: t.address)
            blocks = []   # [start, end(exclusive), [tags]]
            for t in tags:
                s, e = t.address, t.address + t.words
                if blocks and s - blocks[-1][1] <= max_gap and e - blocks[-1][0] <= limit:
                    blocks[-1][1] = max(blocks[-1][1], e)
                    blocks[-1][2].append(t)
                else:
                    blocks.append([s, e, [t]])
            failed = False
            for s, e, ts in blocks:
                if failed:
                    for t in ts:
                        out[t.name] = Reading(None, "COMM")
                    continue
                try:
                    raw = client.read(area, s, e - s)
                except Exception as ex:
                    failed = True
                    client.close()
                    for t in ts:
                        out[t.name] = Reading(None, "COMM")
                    self.last_error = f"{dev}: {ex}"
                    self.errors[dev] = str(ex)
                    continue
                self.errors.pop(dev, None)
                for t in ts:
                    seg = raw[t.address - s: t.address - s + t.words]
                    v = t.decode(seg)
                    q = "OK"
                    if t.valid and not (t.valid[0] <= v <= t.valid[1]):
                        q = "RANGE"
                    out[t.name] = Reading(v, q)
        return out


def quality_str(readings):
    bad = [f"{n}:{r.quality}" for n, r in readings.items() if r.quality != "OK"]
    return "OK" if not bad else ";".join(bad)


class Edge:
    def __init__(self):
        self.prev = None

    def update(self, v):
        cur = bool(v)
        e = None
        if self.prev is not None:
            if cur and not self.prev:
                e = "rising"
            elif self.prev and not cur:
                e = "falling"
        self.prev = cur
        return e


class CsvSink:
    def __init__(self, path, columns):
        self.columns = columns
        self.f = open(path, "w", newline="", encoding="utf-8-sig")
        self.w = csv.writer(self.f)
        self.w.writerow(columns)
        self.f.flush()

    def write(self, row):
        self.w.writerow([_fmt(row.get(c)) for c in self.columns])
        self.f.flush()

    def close(self):
        self.f.close()


# --------------------------------------------------------------------------
# 작업(Job)
# --------------------------------------------------------------------------
class BaseJob(threading.Thread):
    def __init__(self, name, spec, reader, out_dir, stop, override_ms, stamp):
        super().__init__(name=name, daemon=True)
        self.jname, self.spec, self.reader, self.stop_ev = name, spec, reader, stop
        self.override_ms = override_ms
        self.path = os.path.join(out_dir, f"{name}_{stamp}.csv")
        self.records = 0
        self.last_row = None
        self.last_time = None
        self.error = None
        self._comm_lost = False
        self.sink = None

    def _open(self, columns):
        self.sink = CsvSink(self.path, columns)

    def ticks(self, period_s):
        nxt = time.monotonic()
        while not self.stop_ev.is_set():
            yield
            nxt += period_s
            d = nxt - time.monotonic()
            if d < 0:                       # 읽기가 주기보다 오래 걸리면 따라잡지 않고 재정렬
                nxt, d = time.monotonic(), 0
            if self.stop_ev.wait(d):
                break

    def comm_watch(self, readings):
        lost = any(r.quality == "COMM" for r in readings.values())
        if lost and not self._comm_lost:
            log(f"[{self.jname}] 통신 실패 감지: {getattr(self.reader, 'last_error', '')}")
        elif not lost and self._comm_lost:
            log(f"[{self.jname}] 통신 복구")
        self._comm_lost = lost

    def write(self, row):
        self.sink.write(row)
        self.records += 1
        self.last_row = {k: row.get(k) for k in self.sink.columns}
        self.last_time = datetime.now().isoformat(timespec="seconds")

    def run(self):
        try:
            self.loop()
        except Exception as e:
            self.error = str(e) or repr(e)
            log(f"[{self.jname}] 오류로 중지: {e!r}")
        finally:
            if self.sink:
                self.sink.close()


class IntervalJob(BaseJob):
    """일정 주기로 지정한 태그를 읽어 한 줄씩 저장"""
    def __init__(self, *a):
        super().__init__(*a)
        self.tags = self.spec["tags"]
        self.period = (self.override_ms or self.spec["period_ms"]) / 1000.0
        self._open(["time"] + self.tags + ["quality"])

    def loop(self):
        for _ in self.ticks(self.period):
            r = self.reader.read(self.tags)
            self.comm_watch(r)
            row = {"time": datetime.now().isoformat(timespec="milliseconds"),
                   "quality": quality_str(r)}
            row.update({t: r[t].value for t in self.tags})
            self.write(row)
            if INTERVAL_LOG:
                log(f"[{self.jname}] " + " ".join(f"{t}={_fmt(r[t].value)}" for t in self.tags))


class EventJob(BaseJob):
    """트리거 태그의 에지(rising/falling)가 발생하면 지정 태그를 스냅샷으로 저장"""
    def __init__(self, *a):
        super().__init__(*a)
        self.events = self.spec["events"]
        self.poll = (self.override_ms or self.spec.get("poll_ms", 100)) / 1000.0
        self.det = {ev["tag"]: Edge() for ev in self.events}
        snap_cols = _uniq([t for ev in self.events for t in ev.get("snapshot", [])])
        self._open(["time", "event"] + snap_cols + ["quality"])

    def loop(self):
        trig = list(self.det)
        for _ in self.ticks(self.poll):
            r = self.reader.read(trig)
            self.comm_watch(r)
            edges = {t: self.det[t].update(r[t].value) for t in trig if r[t].quality != "COMM"}
            for ev in self.events:
                if edges.get(ev["tag"]) != ev.get("edge", "rising"):
                    continue
                if ev.get("delay_ms") and self.stop_ev.wait(ev["delay_ms"] / 1000.0):
                    return
                snap = self.reader.read(ev.get("snapshot", []))
                row = {"time": datetime.now().isoformat(timespec="milliseconds"),
                       "event": ev["name"], "quality": quality_str(snap)}
                row.update({t: snap[t].value for t in snap})
                self.write(row)
                log(f"[{self.jname}] 이벤트 {ev['name']}: " +
                    " ".join(f"{t}={_fmt(snap[t].value)}" for t in snap))


class CycleJob(BaseJob):
    """start 에지로 Cycle 시작 -> 중간 events 기록 -> end 에지로 종료 시 한 줄 저장
       diff: 시작/종료 시점 값의 차이(예: 적산 유량 Total_End - Total_Start)"""
    def __init__(self, *a):
        super().__init__(*a)
        s = self.spec
        self.start_cfg, self.end_cfg = s["start"], s["end"]
        self.events = s.get("events", [])
        self.start_snap, self.end_snap = s.get("start_snapshot", []), s.get("end_snapshot", [])
        self.diff = s.get("diff", {})
        self.poll = (self.override_ms or s.get("poll_ms", 100)) / 1000.0
        trig = [self.start_cfg["tag"], self.end_cfg["tag"]] + [e["tag"] for e in self.events]
        self.trig = _uniq(trig)
        self.det = {t: Edge() for t in self.trig}
        self.cid = 0
        self.cyc = None
        cols = ["cycle_id", "status", "start_time", "end_time", "duration_s"]
        cols += ["start_" + t for t in self.start_snap]
        for ev in self.events:
            cols += [ev["name"] + "_time"] + [f"{ev['name']}_{t}" for t in ev.get("snapshot", [])]
        cols += ["end_" + t for t in self.end_snap] + list(self.diff) + ["quality"]
        self._open(cols)

    def _open_cycle(self):
        self.cid += 1
        names = _uniq(self.start_snap + list(self.diff.values()))
        r = self.reader.read(names)
        self.cyc = {"id": self.cid, "t0": datetime.now(), "start": r, "events": {}, "bad": set()}
        self.cyc["bad"].update(f"{n}:{x.quality}" for n, x in r.items() if x.quality != "OK")
        log(f"[{self.jname}] Cycle {self.cid} 시작")

    def _close_cycle(self, status):
        c = self.cyc
        t1 = datetime.now()
        r = self.reader.read(_uniq(self.end_snap + list(self.diff.values())))
        bad = set(c["bad"]) | {f"{n}:{x.quality}" for n, x in r.items() if x.quality != "OK"}
        row = {"cycle_id": c["id"], "status": status,
               "start_time": c["t0"].isoformat(timespec="milliseconds"),
               "end_time": t1.isoformat(timespec="milliseconds"),
               "duration_s": (t1 - c["t0"]).total_seconds()}
        for t in self.start_snap:
            row["start_" + t] = c["start"][t].value
        for ev in self.events:
            got = c["events"].get(ev["name"])
            if got:
                row[ev["name"] + "_time"] = got["time"]
                for t, v in got["vals"].items():
                    row[f"{ev['name']}_{t}"] = v
        for t in self.end_snap:
            row["end_" + t] = r[t].value
        for dname, tname in self.diff.items():
            a, b = c["start"][tname].value, r[tname].value
            if a is not None and b is not None:
                row[dname] = b - a
                if b - a < 0:
                    bad.add(f"{dname}:TOTAL_RESET")
        row["quality"] = "OK" if not bad else ";".join(sorted(bad))
        self.write(row)
        extra = " ".join(f"{k}={_fmt(row[k])}" for k in self.diff if k in row)
        log(f"[{self.jname}] Cycle {c['id']} 종료({status}) {row['duration_s']:.1f}s {extra}")
        self.cyc = None

    def loop(self):
        for _ in self.ticks(self.poll):
            r = self.reader.read(self.trig)
            self.comm_watch(r)
            edges = {t: self.det[t].update(r[t].value) for t in self.trig if r[t].quality != "COMM"}
            # 1) 진행 중인 Cycle의 중간 이벤트
            if self.cyc:
                for ev in self.events:
                    if edges.get(ev["tag"]) == ev.get("edge", "rising"):
                        if ev.get("delay_ms") and self.stop_ev.wait(ev["delay_ms"] / 1000.0):
                            return
                        snap = self.reader.read(ev.get("snapshot", []))
                        self.cyc["events"][ev["name"]] = {
                            "time": datetime.now().isoformat(timespec="milliseconds"),
                            "vals": {t: snap[t].value for t in snap}}
                        self.cyc["bad"].update(f"{n}:{x.quality}" for n, x in snap.items() if x.quality != "OK")
                        log(f"[{self.jname}] Cycle {self.cyc['id']} 이벤트 {ev['name']}: " +
                            " ".join(f"{t}={_fmt(snap[t].value)}" for t in snap))
            # 2) 종료
            if self.cyc and edges.get(self.end_cfg["tag"]) == self.end_cfg.get("edge", "rising"):
                self._close_cycle("COMPLETE")
            # 3) 시작 (종료 없이 새 시작이 오면 이전 Cycle은 INCOMPLETE로 저장)
            if edges.get(self.start_cfg["tag"]) == self.start_cfg.get("edge", "rising"):
                if self.cyc:
                    self._close_cycle("INCOMPLETE")
                self._open_cycle()


_JOB_TYPES = {"interval": IntervalJob, "event": EventJob, "cycle": CycleJob}


class Runner:
    """선택한 작업들을 백그라운드 스레드로 실행/중지 (CLI와 웹 서버가 함께 사용)"""

    def __init__(self, cfg, job_names, override_ms=None, duration=None, out_dir="output"):
        os.makedirs(out_dir, exist_ok=True)
        self.cfg = cfg
        self.reader = Reader(cfg)
        self.stop_ev = threading.Event()
        self.duration = duration
        self.started_at = None
        self.stopped_at = None
        self._done = False
        self._stop_lock = threading.Lock()
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.jobs = [_JOB_TYPES[cfg["jobs"][n]["type"]](n, cfg["jobs"][n], self.reader, out_dir,
                                                        self.stop_ev, override_ms, stamp)
                     for n in job_names]

    def start(self):
        self.started_at = time.time()
        for j in self.jobs:
            j.start()
        if self.duration:
            threading.Thread(target=self._timer, daemon=True).start()

    def _timer(self):
        if not self.stop_ev.wait(self.duration):
            self.stop()

    @property
    def running(self):
        return not self._done and any(j.is_alive() for j in self.jobs)

    def stop(self):
        with self._stop_lock:
            if self._done:
                return
            self.stop_ev.set()
            for j in self.jobs:
                j.join(timeout=5)
            self.reader.close()
            self.stopped_at = time.time()
            self._done = True


def run_jobs(cfg, job_names, override_ms=None, duration=None, out_dir="output"):
    r = Runner(cfg, job_names, override_ms, duration, out_dir)
    r.start()
    log("수집 시작 (중지: Ctrl+C)" + (f", {duration}초 후 자동 종료" if duration else ""))
    try:
        while r.running:
            time.sleep(0.2)
    except KeyboardInterrupt:
        log("중지 요청")
    r.stop()
    return r.jobs
