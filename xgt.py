"""LS ELECTRIC XGT 전용 프로토콜(FEnet 전용 서비스, TCP 2004) 클라이언트 + 테스트용 가상 서버

프레임 구조 (여러 바이트 값은 little-endian)
  Application Header 20바이트
     0~9   Company ID  "LSIS-XGT" + 00 00
    10~11  PLC Info
    12     CPU Info          (요청 시 0xA0)
    13     Source of Frame   (요청 0x33, 응답 0x11)
    14~15  Invoke ID         (요청마다 증가, 응답에 그대로 돌아옴)
    16~17  Length            (Application Instruction 길이)
    18     FEnet Position    (슬롯/베이스, 보통 0)
    19     BCC               (헤더 0~18바이트 합의 하위 1바이트)
  Application Instruction
     읽기 요청 : 명령 0x0054, 데이터타입(2), 예약(2), 블록수(2), 블록별 [변수길이(2) 변수이름(ASCII)]
                 연속읽기(데이터타입 0x0014)는 블록 뒤에 [읽을 바이트 수(2)]가 붙음
     읽기 응답 : 명령 0x0055, 데이터타입(2), 예약(2), 에러상태(2), (정상) 블록수(2) + 블록별 [크기(2) 데이터]
                                                          (에러) 에러코드(2)

이 모듈의 읽기 동작
  - 워드 변수(%DW100 등): 연속 읽기(%DB200처럼 바이트 주소 = 워드주소 x 2). PLC가 거부하면 개별 읽기로 자동 전환
  - 비트 변수(%MX10 등) : 개별 읽기 (한 요청에 최대 16개)
  - 쓰기는 지원하지 않음(읽기 전용)

주의: 헤더 구조와 0x0054/0x0055 명령, 16개/1400바이트 제한은 공개 자료로 확인했지만, 데이터타입 코드와 연속 읽기의
세부 형식은 실제 PLC로 검증되지 않았다. 형식 상수는 이 파일 맨 위에 모아 두었으므로 현장에서 다르면 이곳만 고치면 된다.
"""
import os
import re
import socket
import socketserver
import struct
import threading

# ---- 형식 상수 (현장에서 다르면 여기만 수정) ----
COMPANY_ID = b"LSIS-XGT\x00\x00"
SRC_REQUEST, SRC_RESPONSE = 0x33, 0x11
CMD_READ_REQ, CMD_READ_RESP = 0x0054, 0x0055
DT_BIT, DT_BYTE, DT_WORD, DT_DWORD, DT_LWORD, DT_BLOCK = 0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0014
SIZE_BYTES = {"B": 1, "W": 2, "D": 4, "L": 8}
DT_BY_SIZE = {"X": DT_BIT, "B": DT_BYTE, "W": DT_WORD, "D": DT_DWORD, "L": DT_LWORD}
MAX_VARS_PER_FRAME = 16
MAX_BLOCK_BYTES = 1400
HEADER_LEN = 20


class XgtError(Exception):
    """통신/프레임 오류 (연결 문제, XGT 프로토콜이 아닌 응답 등)"""


class XgtPlcError(XgtError):
    """PLC가 오류 코드로 응답함 (연결과 프로토콜은 정상)"""
    def __init__(self, code):
        super().__init__(f"PLC 오류 응답 (코드 0x{code:04X}): 변수 이름, 영역, 주소 범위를 확인하세요.")
        self.code = code


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
class XgtClient:
    def __init__(self, host, port=2004, timeout=2.0, cpu_info=0xA0, position=0, bcc="sum", block_read=True):
        self.host, self.port, self.timeout = host, int(port), float(timeout)
        self.cpu_info, self.position = int(cpu_info), int(position)
        self.bcc, self.block_read = bcc, bool(block_read)
        self._sock = None
        self._invoke = 0
        self._lock = threading.Lock()
        self.trace = {"tx": "", "rx": ""}      # 마지막 송수신 프레임(16진수), 문제 진단용

    # ---- Reader 연동용 ----
    @staticmethod
    def is_bit(area):
        return area.endswith("X")

    def limits(self, area, cfg_gap):
        """(허용 간격, 한 번에 묶을 최대 개수)"""
        return (cfg_gap, 64) if self.is_bit(area) else (cfg_gap, 120)

    # ---- 연결 ----
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

    # ---- 프레임 ----
    def _header(self, instr_len):
        self._invoke = (self._invoke + 1) & 0xFFFF
        h = COMPANY_ID + struct.pack("<HBBHHB", 0, self.cpu_info, SRC_REQUEST, self._invoke, instr_len, self.position)
        bcc = (sum(h) & 0xFF) if self.bcc == "sum" else 0
        return h + bytes([bcc])

    def _transact(self, instr):
        with self._lock:
            if self._sock is None:
                self.connect()
            req = self._header(len(instr)) + instr
            self.trace = {"tx": _hex(req), "rx": ""}
            try:
                self._sock.sendall(req)
                hdr = _recv_exact(self._sock, HEADER_LEN)
                length = struct.unpack_from("<H", hdr, 16)[0]
                body = _recv_exact(self._sock, length)
            except OSError:
                self.close()
                raise
            self.trace["rx"] = _hex(hdr + body)
            if not hdr.startswith(b"LSIS-XGT"):
                self.close()
                raise XgtError("XGT 프로토콜 응답이 아닙니다. 포트(기본 2004)와 장치 종류를 확인하세요. (Modbus 장치에 연결했을 수 있습니다)")
            if hdr[13] != SRC_RESPONSE or struct.unpack_from("<H", hdr, 14)[0] != self._invoke:
                self.close()
                raise XgtError("응답 프레임의 방향/Invoke ID가 요청과 맞지 않습니다")
        if len(body) < 10:
            raise XgtError("응답 길이가 너무 짧습니다")
        cmd, _dt, _res, err = struct.unpack_from("<HHHH", body, 0)
        if cmd != CMD_READ_RESP:
            raise XgtError(f"예상하지 못한 응답 명령 0x{cmd:04X}")
        if err != 0:
            code = struct.unpack_from("<H", body, 8)[0] if len(body) >= 10 else err
            raise XgtPlcError(code)
        return body

    @staticmethod
    def _blocks(body, expect):
        n = struct.unpack_from("<H", body, 8)[0]
        if n != expect:
            raise XgtError(f"응답 블록 수가 요청과 다릅니다 ({n} != {expect})")
        off, out = 10, []
        for _ in range(n):
            if off + 2 > len(body):
                raise XgtError("응답 프레임이 잘렸습니다")
            size = struct.unpack_from("<H", body, off)[0]
            off += 2
            data = body[off:off + size]
            if len(data) != size:
                raise XgtError("응답 프레임이 잘렸습니다")
            out.append(data)
            off += size
        return out

    # ---- 읽기 ----
    def _read_vars(self, names, dtype):
        """개별 읽기: 변수 이름 목록(최대 16개) -> 블록별 바이트열"""
        instr = struct.pack("<HHHH", CMD_READ_REQ, dtype, 0, len(names))
        for nm in names:
            b = nm.encode("ascii")
            instr += struct.pack("<H", len(b)) + b
        return self._blocks(self._transact(instr), len(names))

    def _read_block(self, name, nbytes):
        """연속 읽기: 변수(바이트 주소) + 바이트 수"""
        b = name.encode("ascii")
        instr = struct.pack("<HHHH", CMD_READ_REQ, DT_BLOCK, 0, 1) + struct.pack("<H", len(b)) + b + struct.pack("<H", nbytes)
        blocks = self._blocks(self._transact(instr), 1)
        if len(blocks[0]) != nbytes:
            raise XgtError(f"연속 읽기 크기 불일치 ({len(blocks[0])} != {nbytes})")
        return blocks[0]

    def read(self, area, address, count):
        """area: 'D','M' ...(워드) 또는 'DX','MX' ...(비트). 워드는 u16 리스트, 비트는 bool 리스트"""
        if self.is_bit(area):
            letter, out = area[0], []
            for i in range(0, count, MAX_VARS_PER_FRAME):
                names = [f"%{letter}X{address + i + k}" for k in range(min(MAX_VARS_PER_FRAME, count - i))]
                out += [bool(b[0]) if b else False for b in self._read_vars(names, DT_BIT)]
            return out
        letter = area
        if self.block_read:
            try:
                data = self._read_block(f"%{letter}B{address * 2}", count * 2)
                return list(struct.unpack("<%dH" % count, data))
            except XgtPlcError:
                self.block_read = False       # 이 PLC는 연속 읽기를 거부 -> 개별 읽기로 전환
        out = []
        for i in range(0, count, MAX_VARS_PER_FRAME):
            names = [f"%{letter}W{address + i + k}" for k in range(min(MAX_VARS_PER_FRAME, count - i))]
            for b in self._read_vars(names, DT_WORD):
                if len(b) != 2:
                    raise XgtError("워드 응답 크기가 올바르지 않습니다")
                out.append(struct.unpack("<H", b)[0])
        return out


# --------------------------------------------------------------------------
# 테스트용 가상 서버 (실제 PLC가 없을 때 같은 프레임 규칙으로 응답)
# --------------------------------------------------------------------------
_VAR_RE = re.compile(r"^%([A-Z])([XBWDL])(\d+)$")


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        sock, srv = self.request, self.server
        try:
            while True:
                hdr = _recv_exact(sock, HEADER_LEN)
                length = struct.unpack_from("<H", hdr, 16)[0]
                instr = _recv_exact(sock, length)
                resp = self._process(instr, srv)
                h = COMPANY_ID + struct.pack("<HBBHHB", 0, hdr[12], SRC_RESPONSE, struct.unpack_from("<H", hdr, 14)[0], len(resp), hdr[18])
                sock.sendall(h + bytes([sum(h) & 0xFF]) + resp)
        except OSError:
            return

    @staticmethod
    def _error(dt, code):
        return struct.pack("<HHHHH", CMD_READ_RESP, dt, 0, 0xFFFF, code)

    @staticmethod
    def _byte(store, letter, bidx):
        w = store.get(letter, bidx // 2, 1)[0]
        return (w >> (8 * (bidx % 2))) & 0xFF

    def _process(self, instr, srv):
        store = srv.store
        try:
            cmd, dt, _res, nblk = struct.unpack_from("<HHHH", instr, 0)
            if cmd != CMD_READ_REQ:
                return self._error(dt, 0x0001)
            off, blocks = 8, b""
            if dt == DT_BLOCK:
                if srv.reject_block:
                    return self._error(dt, 0x0004)
                vlen = struct.unpack_from("<H", instr, off)[0]
                name = instr[off + 2:off + 2 + vlen].decode("ascii")
                count = struct.unpack_from("<H", instr, off + 2 + vlen)[0]
                m = _VAR_RE.match(name)
                if not m or m.group(2) != "B" or count > MAX_BLOCK_BYTES:
                    return self._error(dt, 0x0003)
                letter, start = m.group(1), int(m.group(3))
                data = bytes(self._byte(store, letter, start + i) for i in range(count))
                blocks = struct.pack("<H", count) + data
                nblk = 1
            else:
                if nblk > MAX_VARS_PER_FRAME:
                    return self._error(dt, 0x0002)
                for _ in range(nblk):
                    vlen = struct.unpack_from("<H", instr, off)[0]
                    name = instr[off + 2:off + 2 + vlen].decode("ascii")
                    off += 2 + vlen
                    m = _VAR_RE.match(name)
                    if not m:
                        return self._error(dt, 0x0003)
                    letter, size, idx = m.group(1), m.group(2), int(m.group(3))
                    if size == "X":
                        v = store.get(letter + "X", idx, 1)[0]
                        data = bytes([1 if v else 0])
                    else:
                        n = SIZE_BYTES[size]
                        data = bytes(self._byte(store, letter, idx * n + i) for i in range(n))
                    blocks += struct.pack("<H", len(data)) + data
            return struct.pack("<HHHHH", CMD_READ_RESP, dt, 0, 0, nblk) + blocks
        except (struct.error, UnicodeDecodeError):
            return self._error(0, 0x0005)


class XgtServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = os.name != "nt"
    daemon_threads = True

    def __init__(self, addr, store, reject_block=False):
        super().__init__(addr, _Handler)
        self.store = store
        self.reject_block = reject_block

    def start(self):
        t = threading.Thread(target=self.serve_forever, daemon=True)
        t.start()
        return t