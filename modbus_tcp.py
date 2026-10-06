"""Modbus TCP 클라이언트 + 테스트용 가상 서버 (표준 라이브러리만 사용, 설치 불필요)

지원 기능코드: 01(Coil) 02(Discrete) 03(Holding) 04(Input) 읽기
              (서버는 05, 06 쓰기도 처리)
"""
import socket
import os
import socketserver
import struct
import threading

FUNC_CODE = {"coil": 1, "discrete": 2, "holding": 3, "input": 4}
_FC_TO_AREA = {1: "coil", 2: "discrete", 3: "holding", 4: "input"}
_EXC = {
    1: "ILLEGAL_FUNCTION(지원하지 않는 기능코드)",
    2: "ILLEGAL_DATA_ADDRESS(주소 범위 오류 - 주소/오프셋 확인)",
    3: "ILLEGAL_DATA_VALUE(개수 등 값 오류)",
    4: "SERVER_DEVICE_FAILURE",
    6: "SERVER_DEVICE_BUSY",
}


class ModbusError(Exception):
    pass


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("상대측이 연결을 닫았습니다")
        buf += chunk
    return buf


def _hex(b):
    return " ".join(f"{x:02X}" for x in b)


# --------------------------------------------------------------------------
# 클라이언트
# --------------------------------------------------------------------------
class ModbusTcpClient:
    def __init__(self, host, port=502, unit=1, timeout=2.0):
        self.host, self.port, self.unit, self.timeout = host, int(port), int(unit), float(timeout)
        self._sock = None
        self._tid = 0
        self._lock = threading.Lock()
        self.trace = {"tx": "", "rx": ""}      # 마지막 송수신 프레임(16진수), 문제 진단용

    @staticmethod
    def is_bit(area):
        return area in ("coil", "discrete")

    def limits(self, area, cfg_gap):
        """(허용 간격, 한 번에 묶을 최대 개수)"""
        return cfg_gap, (1000 if self.is_bit(area) else 120)

    def connect(self):
        self.close()
        self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _transact(self, pdu):
        with self._lock:
            if self._sock is None:
                self.connect()
            self._tid = (self._tid + 1) & 0xFFFF
            req = struct.pack(">HHHB", self._tid, 0, len(pdu) + 1, self.unit) + pdu
            self.trace = {"tx": _hex(req), "rx": ""}
            try:
                self._sock.sendall(req)
                hdr = _recv_exact(self._sock, 7)
                tid, _pid, length, _unit = struct.unpack(">HHHB", hdr)
                body = _recv_exact(self._sock, length - 1)
            except OSError:
                self.close()
                raise
            self.trace["rx"] = _hex(hdr + body)
            if tid != self._tid:
                self.close()
                raise ModbusError("트랜잭션 ID 불일치")
        if body[0] & 0x80:
            code = body[1] if len(body) > 1 else 0
            raise ModbusError(f"예외 응답 {code}: {_EXC.get(code, '알 수 없음')}")
        return body

    def read(self, area, address, count):
        """area: coil/discrete/holding/input. 비트 영역은 bool 리스트, 레지스터는 int 리스트"""
        fc = FUNC_CODE[area]
        body = self._transact(struct.pack(">BHH", fc, address, count))
        nbytes = body[1]
        data = body[2:2 + nbytes]
        if area in ("coil", "discrete"):
            return [bool((data[i // 8] >> (i % 8)) & 1) for i in range(count)]
        return list(struct.unpack(">%dH" % count, data))


# --------------------------------------------------------------------------
# 가상 서버 (실기기 없이 테스트용)
# --------------------------------------------------------------------------
class DataStore:
    def __init__(self):
        self.d = {}                      # 영역 이름 -> {주소: 값}  (Modbus 4영역, XGT 'D'/'MX' 등)
        self.lock = threading.Lock()

    def get(self, area, addr, count):
        with self.lock:
            mem = self.d.get(area, {})
            return [mem.get(addr + i, 0) for i in range(count)]

    def set(self, area, addr, values):
        with self.lock:
            mem = self.d.setdefault(area, {})
            for i, v in enumerate(values):
                mem[addr + i] = v


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        sock, store = self.request, self.server.store
        try:
            while True:
                hdr = _recv_exact(sock, 7)
                tid, _pid, length, unit = struct.unpack(">HHHB", hdr)
                pdu = _recv_exact(sock, length - 1)
                resp = self._process(pdu, store)
                sock.sendall(struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)
        except OSError:
            return

    @staticmethod
    def _process(pdu, store):
        fc = pdu[0]
        try:
            if fc in (1, 2, 3, 4):
                addr, count = struct.unpack(">HH", pdu[1:5])
                is_bit = fc in (1, 2)
                if count < 1 or count > (2000 if is_bit else 125):
                    return bytes([fc | 0x80, 3])
                vals = store.get(_FC_TO_AREA[fc], addr, count)
                if is_bit:
                    nb = (count + 7) // 8
                    data = bytearray(nb)
                    for i, v in enumerate(vals):
                        if v:
                            data[i // 8] |= 1 << (i % 8)
                    return bytes([fc, nb]) + bytes(data)
                return bytes([fc, count * 2]) + struct.pack(">%dH" % count, *vals)
            if fc == 5:
                addr, val = struct.unpack(">HH", pdu[1:5])
                store.set("coil", addr, [val == 0xFF00])
                return pdu[:5]
            if fc == 6:
                addr, val = struct.unpack(">HH", pdu[1:5])
                store.set("holding", addr, [val])
                return pdu[:5]
        except Exception:
            return bytes([fc | 0x80, 4])
        return bytes([fc | 0x80, 1])


class ModbusTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = os.name != "nt"   # Windows에서는 포트 중복 점유 방지
    daemon_threads = True

    def __init__(self, addr, store):
        super().__init__(addr, _Handler)
        self.store = store

    def start(self):
        t = threading.Thread(target=self.serve_forever, daemon=True)
        t.start()
        return t