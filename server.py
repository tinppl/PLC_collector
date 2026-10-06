"""PLC 데이터 수집기 - 웹 서버

    python server.py                 브라우저가 자동으로 열립니다 (http://127.0.0.1:8765)
    python server.py --port 9000     포트 변경
    python server.py --host 0.0.0.0 --password 비밀번호    다른 PC에서도 접속 허용(비밀번호 필수 권장)

표준 라이브러리만 사용합니다. 설정/결과는 data/ 폴더에 저장됩니다.
"""
import argparse
import base64
import copy
import csv
import hmac
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

import engine
from engine import ConfigError, Reader, Runner, build_config, make_client
from modbus_tcp import ModbusError
from simulator import FAULT_DEFS, Simulator
from tagcodec import BIT_AREAS, Tag
from xgt import XgtError, XgtPlcError

VERSION = "0.3"
ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "output")
BACKUP = os.path.join(DATA, "backups")
CONFIG = os.path.join(DATA, "config.json")
EXAMPLE = os.path.join(ROOT, "config.example.json")
FILE_RE = re.compile(r"^[\w\-.가-힣]+\.csv$")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MIME = {".html": "text/html", ".css": "text/css", ".js": "application/javascript",
        ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.msg, self.code = msg, code


def explain(ex, driver="modbus_tcp"):
    """통신 예외를 현장 담당자가 이해할 수 있는 문장으로"""
    if isinstance(ex, (socket.timeout, TimeoutError)):
        msg = "응답이 없습니다(시간 초과). IP 주소, 장치 전원, 케이블/네트워크, 방화벽을 확인하세요."
        if driver == "xgt":
            msg += " 포트가 XGT 전용 서비스(기본 2004)가 아닌 다른 서비스(예: Modbus 502)를 가리켜도 같은 증상이 나옵니다."
        return msg
    if isinstance(ex, ConnectionRefusedError):
        if driver == "xgt":
            return ("연결이 거부되었습니다. 포트(기본 2004)와, XG5000 통신 설정에서 해당 이더넷 모듈의 "
                    "전용 서비스(XGT 서버) 사용 여부를 확인하세요.")
        return "연결이 거부되었습니다. 포트 번호와 장치의 Modbus 서버 사용 설정을 확인하세요."
    if isinstance(ex, socket.gaierror):
        return "주소를 찾을 수 없습니다. IP 주소를 다시 확인하세요."
    if isinstance(ex, ConnectionError):
        return "연결이 끊어졌습니다. 장치가 연결을 닫았습니다."
    if isinstance(ex, (ModbusError, XgtError)):
        return str(ex)
    if isinstance(ex, OSError):
        return f"네트워크 오류: {ex.strerror or ex}"
    return str(ex)


def num(v):
    """JSON에 넣을 수 없는 nan/inf 제거"""
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    return round(v, 4) if isinstance(v, float) else v


# --------------------------------------------------------------------------
# 앱 상태
# --------------------------------------------------------------------------
class State:
    def __init__(self):
        self.lock = threading.RLock()
        self.raw = None
        self.cfg = None
        self.runner = None
        self.sim = None
        self.logs = deque(maxlen=500)
        self.log_id = 0
        self.live_lock = threading.Lock()
        self.live_cache = (0.0, None)
        self.live_reader = None
        self.live_cfg = None
        self.loopback = True

    # ---- 로그 ----
    def add_log(self, msg):
        with self.lock:
            self.log_id += 1
            self.logs.append({"id": self.log_id, "t": datetime.now().strftime("%H:%M:%S"), "msg": msg})

    # ---- 설정 ----
    def load(self):
        for d in (DATA, OUT, BACKUP):
            os.makedirs(d, exist_ok=True)
        if not os.path.exists(CONFIG):
            shutil.copyfile(EXAMPLE, CONFIG)
        with open(CONFIG, "r", encoding="utf-8-sig") as f:
            self.raw = json.load(f)
        self.cfg = build_config(self.raw)

    def save(self, body):
        with self.lock:
            raw = copy.deepcopy(self.raw)
            for k in ("devices", "tags", "jobs"):
                if k in body:
                    if not isinstance(body[k], dict):
                        raise ApiError(f"'{k}' 형식이 올바르지 않습니다")
                    raw[k] = body[k]
            try:
                cfg = build_config(raw)
            except ConfigError as e:
                raise ApiError(str(e))
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            if os.path.exists(CONFIG):
                shutil.copyfile(CONFIG, os.path.join(BACKUP, f"config_{stamp}.json"))
                old = sorted(os.listdir(BACKUP))
                for f in old[:-30]:
                    try:
                        os.remove(os.path.join(BACKUP, f))
                    except OSError:
                        pass
            tmp = CONFIG + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False, indent=2)
            os.replace(tmp, CONFIG)
            self.raw, self.cfg = raw, cfg
            return self.runner is not None and self.runner.running

    # ---- 실시간 읽기 (0.6초 캐시) ----
    def live(self):
        with self.live_lock:
            now = time.time()
            ts, cached = self.live_cache
            if cached is not None and now - ts < 0.6 and self.live_cfg is self.cfg:
                return cached
            cfg = self.cfg
            if self.live_reader is None or self.live_cfg is not cfg:
                if self.live_reader:
                    self.live_reader.close()
                self.live_reader = Reader(cfg)
                self.live_cfg = cfg
            names = list(cfg["_tags"])
            res = self.live_reader.read(names) if names else {}
            values = {n: {"v": num(r.value), "q": r.quality} for n, r in res.items()}
            devices = {}
            for dname in cfg["devices"]:
                qs = [res[n].quality for n, t in cfg["_tags"].items() if t.device == dname]
                if qs:
                    devices[dname] = "ok" if any(q != "COMM" for q in qs) else "fail"
            payload = {"time": datetime.now().strftime("%H:%M:%S"), "values": values,
                       "devices": devices, "errors": dict(self.live_reader.errors)}
            self.live_cache = (now, payload)
            return payload

    # ---- 수집 상태 ----
    def status(self):
        with self.lock:
            r = self.runner
            jobs = []
            running = False
            elapsed = 0
            if r:
                running = r.running
                if not running:
                    r.stop()      # 모든 작업이 스스로 끝난 경우 정리
                end = r.stopped_at or time.time()
                elapsed = (end - r.started_at) if r.started_at else 0
                for j in r.jobs:
                    jobs.append({"name": j.jname, "type": j.spec["type"],
                                 "state": "error" if j.error else ("running" if j.is_alive() else "stopped"),
                                 "records": j.records, "last_time": j.last_time,
                                 "file": os.path.basename(j.path), "error": j.error,
                                 "last_row": {k: num(v) for k, v in (j.last_row or {}).items()}})
            sim_avail = any(s.get("sim") for s in self.cfg["devices"].values())
            return {"running": running, "elapsed": round(elapsed, 1), "duration": r.duration if r else None,
                    "jobs": jobs, "version": VERSION, "loopback": self.loopback,
                    "sim": {"available": sim_avail, "running": bool(self.sim and self.sim.running)}}

    def run(self, body):
        with self.lock:
            if self.runner and self.runner.running:
                raise ApiError("이미 수집 중입니다. 먼저 중지하세요.", 409)
            names = body.get("jobs") or []
            if not names:
                raise ApiError("실행할 작업을 선택하세요")
            for n in names:
                if n not in self.cfg["jobs"]:
                    raise ApiError(f"작업 '{n}'을 찾을 수 없습니다")
            period = body.get("period_ms")
            if period is not None:
                period = int(period)
                if period < 10 or period > 3600000:
                    raise ApiError("수집 주기는 10ms ~ 1시간 사이로 입력하세요")
            duration = body.get("duration_s")
            if duration is not None:
                duration = float(duration)
                if duration <= 0:
                    duration = None
            self.runner = Runner(self.cfg, names, period, duration, OUT)
            self.runner.start()
            engine.log(f"수집 시작: {', '.join(names)}" + (f" (주기 {period}ms)" if period else ""))

    def stop(self):
        with self.lock:
            r = self.runner
        if r:
            r.stop()
            engine.log("수집 중지")

    def set_sim(self, on):
        with self.lock:
            if on:
                if self.sim and self.sim.running:
                    return
                sim = Simulator(self.cfg, engine.log)
                try:
                    sim.start()
                except RuntimeError as e:
                    raise ApiError(str(e))
                self.sim = sim
            elif self.sim:
                self.sim.stop()
                engine.log("데모 장치 중지")
                self.sim = None

    # ---- 장애 재현 ----
    def faults_info(self):
        with self.lock:
            sim = self.sim if (self.sim and self.sim.running) else None
            return {"defs": FAULT_DEFS, "running": sim is not None,
                    "devices": sim.fault_devices() if sim else [],
                    "state": sim.faults.snapshot() if sim else {}}

    def fault_control(self, body):
        with self.lock:
            sim = self.sim if (self.sim and self.sim.running) else None
            if sim is None:
                raise ApiError("데모 장치가 꺼져 있습니다. 먼저 데모 장치를 켜세요.", 409)
            dev, fid = body.get("device"), body.get("id")
            try:
                if body.get("action"):
                    sim.run_action(dev, fid)
                    engine.log(f"[장애 재현] {dev}: {fid} 실행")
                else:
                    on = bool(body.get("on"))
                    sim.set_fault(dev, fid, on, body.get("params"))
                    engine.log(f"[장애 재현] {dev}: {fid} " + ("켜짐" if on else "꺼짐"))
            except ValueError as e:
                raise ApiError(str(e))

    def shutdown(self):
        try:
            self.stop()
            self.set_sim(False)
        except Exception:
            pass


ST = State()
PASSWORD = None


# --------------------------------------------------------------------------
# API 구현
# --------------------------------------------------------------------------
def _trace(client):
    t = getattr(client, "trace", None) or {}
    return {"tx": t.get("tx", ""), "rx": t.get("rx", "")}


def test_device(spec):
    host = str(spec.get("host", "")).strip()
    if not host:
        raise ApiError("주소(host)를 입력하세요")
    driver = spec.get("driver", "modbus_tcp")
    if driver not in engine.DRIVERS:
        raise ApiError(f"지원하지 않는 프로토콜입니다: {driver}")
    xgt = driver == "xgt"
    try:
        spec = dict(spec, host=host, port=int(spec.get("port", engine.DEFAULT_PORT[driver])),
                    timeout_s=min(float(spec.get("timeout_s", 2.0)), 5.0))
        if xgt:
            spec["position"] = int(spec.get("position", 0))
        else:
            spec["unit"] = int(spec.get("unit", 1))
    except (TypeError, ValueError):
        raise ApiError("포트/국번/모듈 위치/시간 초과 값이 숫자가 아닙니다")
    client = make_client(spec)
    probe = ("D", 0, 1) if xgt else ("holding", 0, 1)     # 가장 흔한 영역의 첫 주소를 한 번 읽어 본다
    probe_name = "%DW0" if xgt else "0번 주소"
    t0 = time.time()
    try:
        client.read(*probe)
        return {"ok": True, "ms": int((time.time() - t0) * 1000), "message": "연결되었습니다.", **_trace(client)}
    except (ModbusError, XgtPlcError) as e:
        return {"ok": True, "ms": int((time.time() - t0) * 1000), **_trace(client),
                "message": f"장치가 응답했습니다. ({probe_name} 읽기는 거부됨: {e})"}
    except Exception as e:
        return {"ok": False, "message": explain(e, driver), **_trace(client)}
    finally:
        client.close()


def test_tag(body):
    spec = body.get("tag") or {}
    dev = ST.cfg["devices"].get(spec.get("device"))
    if dev is None:
        raise ApiError("장치를 선택하세요")
    driver = dev.get("driver", "modbus_tcp")
    try:
        tag = Tag("test", spec, driver)
    except (KeyError, ValueError, TypeError) as e:
        raise ApiError(f"변수 설정 오류: {e}")
    client = make_client(dev)
    t0 = time.time()
    try:
        raw = client.read(tag.area, tag.address, tag.words)
        val = tag.decode(raw)
        q = "OK"
        if tag.valid and not (tag.valid[0] <= val <= tag.valid[1]):
            q = "RANGE"
        return {"ok": True, "raw": [int(x) for x in raw], "value": num(val), "quality": q,
                "ms": int((time.time() - t0) * 1000), **_trace(client)}
    except Exception as e:
        return {"ok": False, "message": explain(e, driver), **_trace(client)}
    finally:
        client.close()


_XGT_AREA_RE = re.compile(r"^[A-Z]X?$")      # 워드: D, M ... / 비트: DX, MX ...


def scan(body):
    import struct
    dev = ST.cfg["devices"].get(body.get("device"))
    if dev is None:
        raise ApiError("장치를 선택하세요")
    driver = dev.get("driver", "modbus_tcp")
    xgt = driver == "xgt"
    area = body.get("area", "D" if xgt else "holding")
    if xgt:
        area = str(area).upper()
        if not _XGT_AREA_RE.match(area):
            raise ApiError("영역이 올바르지 않습니다 (예: D, M 은 워드 / DX, MX 는 비트)")
        is_bit, max_start = area.endswith("X"), 262143
    else:
        if area not in ("coil", "discrete", "input", "holding"):
            raise ApiError("영역이 올바르지 않습니다")
        is_bit, max_start = area in BIT_AREAS, 65535
    try:
        start, count = int(body.get("start", 0)), int(body.get("count", 10))
    except (TypeError, ValueError):
        raise ApiError("시작 주소/개수는 숫자로 입력하세요")
    if not (0 <= start <= max_start) or not (1 <= count <= (200 if is_bit else 100)):
        raise ApiError(f"시작 주소는 0~{max_start}, 개수는 워드(레지스터) 100개 / 비트 200개까지 가능합니다")
    client = make_client(dev)
    try:
        vals = client.read(area, start, count)
    except Exception as e:
        return {"ok": False, "message": explain(e, driver), **_trace(client)}
    finally:
        client.close()
    if is_bit:
        return {"ok": True, "bits": True, "rows": [{"addr": start + i, "value": int(v)} for i, v in enumerate(vals)]}
    rows = []
    for i, v in enumerate(vals):
        row = {"addr": start + i, "u16": v, "i16": v - 65536 if v >= 32768 else v, "hex": f"0x{v:04X}"}
        if i + 1 < len(vals):
            hi, lo = v, vals[i + 1]
            row["u32"] = (hi << 16) | lo
            row["u32_little"] = (lo << 16) | hi
            row["f32_big"] = num(struct.unpack(">f", struct.pack(">HH", hi, lo))[0])
            row["f32_little"] = num(struct.unpack(">f", struct.pack(">HH", lo, hi))[0])
        rows.append(row)
    return {"ok": True, "bits": False, "rows": rows}


def list_files():
    out = []
    running_files = set()
    r = ST.runner
    if r and r.running:
        running_files = {os.path.basename(j.path) for j in r.jobs}
    for name in os.listdir(OUT):
        if not FILE_RE.match(name):
            continue
        p = os.path.join(OUT, name)
        st = os.stat(p)
        rows = None
        if st.st_size < 30 * 1024 * 1024:
            with open(p, "rb") as f:
                rows = max(sum(1 for _ in f) - 1, 0)
        out.append({"name": name, "size": st.st_size, "rows": rows,
                    "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    "active": name in running_files})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def file_path(name):
    name = unquote(name)
    if not FILE_RE.match(name):
        raise ApiError("파일 이름이 올바르지 않습니다")
    p = os.path.join(OUT, name)
    if not os.path.isfile(p):
        raise ApiError("파일을 찾을 수 없습니다", 404)
    return p


def preview_file(name, limit=200):
    p = file_path(name)
    rows = []
    total = 0
    with open(p, "r", encoding="utf-8-sig", newline="") as f:
        rd = csv.reader(f)
        cols = next(rd, [])
        for r in rd:
            total += 1
            if len(rows) < limit:
                rows.append(r)
    return {"columns": cols, "rows": rows, "total": total, "truncated": total > limit}


def open_folder():
    if not ST.loopback:
        raise ApiError("이 PC에서 직접 접속했을 때만 폴더를 열 수 있습니다", 403)
    try:
        if sys.platform.startswith("win"):
            os.startfile(OUT)  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", OUT])
        else:
            subprocess.Popen(["xdg-open", OUT])
    except Exception as e:
        raise ApiError(f"폴더를 열 수 없습니다: {e}")


def api(method, path, query, body):
    if method == "GET" and path == "/api/config":
        return {"devices": ST.raw.get("devices", {}), "tags": ST.raw.get("tags", {}), "jobs": ST.raw.get("jobs", {})}
    if method == "PUT" and path == "/api/config":
        running = ST.save(body or {})
        return {"ok": True, "running": running}
    if method == "GET" and path == "/api/status":
        return ST.status()
    if method == "GET" and path == "/api/live":
        return ST.live()
    if method == "GET" and path == "/api/logs":
        after = int(query.get("after", ["0"])[0] or 0)
        with ST.lock:
            lines = [l for l in ST.logs if l["id"] > after]
            return {"lines": lines, "last": ST.log_id}
    if method == "POST" and path == "/api/run":
        ST.run(body or {})
        return {"ok": True}
    if method == "POST" and path == "/api/stop":
        ST.stop()
        return {"ok": True}
    if method == "POST" and path == "/api/sim":
        ST.set_sim(bool((body or {}).get("on")))
        return {"ok": True}
    if method == "GET" and path == "/api/sim/faults":
        return ST.faults_info()
    if method == "POST" and path == "/api/sim/faults":
        ST.fault_control(body or {})
        return {"ok": True}
    if method == "POST" and path == "/api/device/test":
        return test_device((body or {}).get("device") or {})
    if method == "POST" and path == "/api/tag/test":
        return test_tag(body or {})
    if method == "POST" and path == "/api/scan":
        return scan(body or {})
    if method == "POST" and path == "/api/open-output":
        open_folder()
        return {"ok": True}
    if method == "GET" and path == "/api/files":
        return {"files": list_files()}
    m = re.match(r"^/api/files/([^/]+)$", path)
    if m:
        if method == "GET":
            return preview_file(m.group(1))
        if method == "DELETE":
            name = unquote(m.group(1))
            p = file_path(name)
            r = ST.runner
            if r and r.running and name in {os.path.basename(j.path) for j in r.jobs}:
                raise ApiError("수집 중인 파일은 삭제할 수 없습니다. 먼저 수집을 중지하세요.", 409)
            os.remove(p)
            return {"ok": True}
    raise ApiError("알 수 없는 요청입니다", 404)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "PLCCollector/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _guard(self, method):
        if PASSWORD:
            ok = False
            h = self.headers.get("Authorization", "")
            if h.startswith("Basic "):
                try:
                    pw = base64.b64decode(h[6:]).decode("utf-8").split(":", 1)[1]
                    ok = hmac.compare_digest(pw.encode(), PASSWORD.encode())
                except Exception:
                    ok = False
            if not ok:
                self._send(401, b"Login required", "text/plain; charset=utf-8",
                           {"WWW-Authenticate": 'Basic realm="PLC Collector"'})
                return False
        if ST.loopback:
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
            if host not in LOOPBACK:
                self._json({"error": "허용되지 않은 접속 주소입니다"}, 403)
                return False
        if method not in ("GET", "HEAD") and self.headers.get("X-Requested-With") != "plc-collector":
            self._json({"error": "잘못된 요청입니다"}, 403)
            return False
        return True

    def _handle(self, method):
        try:
            if not self._guard(method):
                return
            u = urlparse(self.path)
            path = u.path
            if path.startswith("/api/"):
                self._api(method, path, parse_qs(u.query))
            elif method in ("GET", "HEAD"):
                self._static(path)
            else:
                self._json({"error": "허용되지 않는 요청입니다"}, 405)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # 서버가 죽지 않도록
            try:
                self._json({"error": f"서버 오류: {e}"}, 500)
            except Exception:
                pass

    def _api(self, method, path, query):
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            if n > 5 * 1024 * 1024:
                return self._json({"error": "요청이 너무 큽니다"}, 413)
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8"))
            except Exception:
                return self._json({"error": "요청 형식이 올바르지 않습니다"}, 400)
        # 파일 다운로드
        m = re.match(r"^/api/files/([^/]+)/download$", path)
        if m and method == "GET":
            try:
                p = file_path(m.group(1))
            except ApiError as e:
                return self._json({"error": e.msg}, e.code)
            with open(p, "rb") as f:
                data = f.read()
            name = os.path.basename(p)
            return self._send(200, data, "text/csv; charset=utf-8",
                              {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})
        try:
            self._json(api(method, path, query, body))
        except ApiError as e:
            self._json({"error": e.msg}, e.code)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        p = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not p.startswith(WEB + os.sep) or not os.path.isfile(p):
            return self._send(404, b"Not found", "text/plain; charset=utf-8")
        ext = os.path.splitext(p)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(p)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml", "application/json"):
            ctype += "; charset=utf-8"
        with open(p, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self): self._handle("GET")
    def do_HEAD(self): self._handle("HEAD")
    def do_POST(self): self._handle("POST")
    def do_PUT(self): self._handle("PUT")
    def do_DELETE(self): self._handle("DELETE")


def main():
    global PASSWORD
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description="PLC 데이터 수집기 웹 서버")
    ap.add_argument("--host", default="127.0.0.1", help="접속 허용 주소 (기본: 이 PC에서만)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--password", help="접속 비밀번호 (다른 PC 접속을 허용할 때 필수 권장)")
    ap.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = ap.parse_args()

    PASSWORD = args.password
    ST.loopback = args.host in LOOPBACK
    try:
        ST.load()
    except (ConfigError, ValueError, OSError) as e:
        sys.exit(f"설정을 불러올 수 없습니다 ({CONFIG}): {e}\n파일을 고치거나 삭제하면 예시 설정으로 다시 시작합니다.")
    engine.INTERVAL_LOG = False
    engine.LOG_HOOKS.append(ST.add_log)

    srv, port, last_err = None, args.port, None
    for p in range(args.port, args.port + 10):
        try:
            srv = ThreadingHTTPServer((args.host, p), Handler)
            port = p
            break
        except OSError as e:
            last_err = e
    if srv is None:
        sys.exit(f"포트 {args.port}~{args.port + 9}를 열 수 없습니다: {last_err}\n"
                 "이미 수집기가 실행 중이 아닌지 확인하세요. (실행 창이 여러 개 떠 있을 수 있습니다)")
    srv.daemon_threads = True
    url = f"http://{'127.0.0.1' if ST.loopback else args.host}:{port}"
    print("=" * 56)
    print(f"  PLC 데이터 수집기 v{VERSION} 실행 중")
    print(f"  브라우저 주소창에 입력하세요:  {url}")
    if port != args.port:
        print(f"  (포트 {args.port}가 사용 중이라 {port}번으로 열었습니다)")
    print("  종료: 이 창에서 Ctrl+C (창을 닫아도 종료됩니다)")
    print("=" * 56)
    if not ST.loopback and not PASSWORD:
        print("  [주의] 비밀번호 없이 외부 접속을 허용했습니다. --password 사용을 권장합니다.")
    if not args.no_browser:
        def _open():
            try:
                if not webbrowser.open(url):
                    print("  브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 입력하세요.")
            except Exception:
                print("  브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 입력하세요.")
        threading.Timer(0.8, _open).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다...")
    finally:
        ST.shutdown()
        srv.server_close()


if __name__ == "__main__":
    main()