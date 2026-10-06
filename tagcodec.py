"""태그 정의: 주소 해석, 데이터 타입 변환, 스케일링

설정 파일의 tags 항목 하나가 Tag 객체 하나가 된다.
  address : "40001"  -> Modicon 표기 (5자리 문자열). 0xxxx=Coil, 1xxxx=Discrete,
                        3xxxx=Input Reg, 4xxxx=Holding Reg. 프로토콜 주소는 (번호-1)
            100      -> 프로토콜 주소(0부터) 그대로. 이때 area(기본 holding)를 같이 지정
  type    : bool / u16 / i16 / u32 / i32 / f32
  word_order : 32비트 값의 워드 순서. big(상위워드 먼저, 기본) / little(하위워드 먼저)
  factor, offset : 공학값 = raw * factor + offset
  linear  : [raw_lo, raw_hi, eng_lo, eng_hi]  선형 스케일링 (4~20mA 등)
  valid   : [min, max]  범위를 벗어나면 품질 플래그 RANGE
  bit     : holding 레지스터 안의 비트 번호(0~15)를 bool로 읽을 때

LS XGT 전용 프로토콜 장치(driver = "xgt")의 태그
  address : "%DW100" (D 영역 워드 100번), "%MX10" (M 영역 비트 10번), "D100" (워드 단축 표기)
            워드(W)와 비트(X) 형태만 지원. area 항목은 쓰지 않는다.
  word_order 기본값은 little (PLC 메모리는 하위 워드가 먼저)
"""
import re
import struct

BIT_AREAS = ("coil", "discrete")
AREAS = ("coil", "discrete", "input", "holding")
_MODICON = {0: "coil", 1: "discrete", 3: "input", 4: "holding"}
_WORDS = {"bool": 1, "u16": 1, "i16": 1, "u32": 2, "i32": 2, "f32": 2}
_FMT = {"u32": ">I", "i32": ">i", "f32": ">f"}


_XGT_FULL = re.compile(r"^%([A-Z])([XBWDL])(\d+)$")
_XGT_SHORT = re.compile(r"^([A-Z])(\d+)$")


def parse_xgt_address(addr):
    """XGT 변수 표기 -> (영역문자, 'X'|'W', 번호, 정규화된 이름)"""
    s = str(addr).strip().upper()
    m = _XGT_FULL.match(s)
    if m:
        letter, size, idx = m.group(1), m.group(2), int(m.group(3))
        if size not in ("X", "W"):
            raise ValueError(f"'{addr}': 워드(%DW100)나 비트(%MX10) 형태만 지원합니다")
        return letter, size, idx, s
    m = _XGT_SHORT.match(s)
    if m:
        return m.group(1), "W", int(m.group(2)), f"%{m.group(1)}W{m.group(2)}"
    raise ValueError(f"XGT 주소 형식이 올바르지 않습니다: '{addr}' (예: %DW100, %MX10, D100). I/Q 점(%IX0.0.0) 표기는 지원하지 않습니다")


def parse_address(addr, area=None):
    if isinstance(addr, str):
        s = addr.strip().lower()
        if len(s) == 5 and s.isdigit():
            prefix, num = divmod(int(s), 10000)
            if prefix not in _MODICON or num < 1:
                raise ValueError(f"잘못된 Modicon 주소: {addr}")
            return _MODICON[prefix], num - 1
        addr = int(s, 16) if s.startswith("0x") else int(s)
    area = area or "holding"
    if area not in AREAS:
        raise ValueError(f"area는 {AREAS} 중 하나여야 합니다: {area}")
    return area, int(addr)


class Tag:
    def __init__(self, name, spec, driver="modbus_tcp"):
        self.name = name
        self.device = spec["device"]
        self.driver = driver
        if driver == "xgt":
            letter, size, idx, self.address_text = parse_xgt_address(spec["address"])
            self.is_bit = size == "X"
            self.area = letter + ("X" if self.is_bit else "")
            self.address = idx
            default_word_order = "little"
        else:
            self.area, self.address = parse_address(spec["address"], spec.get("area"))
            self.is_bit = self.area in BIT_AREAS
            self.address_text = str(spec["address"])
            default_word_order = "big"
        self.dtype = spec.get("type", "bool" if self.is_bit else "u16")
        if self.dtype not in _WORDS:
            raise ValueError(f"{name}: 지원하지 않는 type {self.dtype}")
        if self.is_bit and self.dtype != "bool":
            raise ValueError(f"{name}: 비트 주소는 type이 bool이어야 합니다")
        self.words = _WORDS[self.dtype]
        self.word_order = spec.get("word_order", default_word_order)
        self.bit = spec.get("bit")
        self.factor = float(spec.get("factor", 1))
        self.offset = float(spec.get("offset", 0))
        self.linear = spec.get("linear")
        if self.linear is not None:
            if len(self.linear) != 4 or self.linear[0] == self.linear[1] or self.linear[2] == self.linear[3]:
                raise ValueError(f"{name}: linear은 [raw_lo, raw_hi, eng_lo, eng_hi] 형식이며 lo != hi 여야 합니다")
        self.valid = spec.get("valid")
        self.unit = spec.get("unit", "")
        self.sim = spec.get("sim")

    # ----- 스케일링 -----
    def _scale(self, raw):
        if self.linear:
            rlo, rhi, elo, ehi = self.linear
            return elo + (raw - rlo) * (ehi - elo) / (rhi - rlo)
        if self.factor == 1.0 and self.offset == 0.0:
            return raw
        return raw * self.factor + self.offset

    def _unscale(self, eng):
        if self.linear:
            rlo, rhi, elo, ehi = self.linear
            return rlo + (eng - elo) * (rhi - rlo) / (ehi - elo)
        return (eng - self.offset) / self.factor

    # ----- 디코드 / 인코드 -----
    def decode(self, seg):
        if self.dtype == "bool":
            if self.is_bit:
                return bool(seg[0])
            if self.bit is not None:
                return bool((seg[0] >> int(self.bit)) & 1)
            return bool(seg[0])
        if self.words == 1:
            raw = seg[0]
            if self.dtype == "i16" and raw >= 0x8000:
                raw -= 0x10000
        else:
            hi, lo = (seg[0], seg[1]) if self.word_order == "big" else (seg[1], seg[0])
            raw = struct.unpack(_FMT[self.dtype], struct.pack(">HH", hi, lo))[0]
        return self._scale(raw)

    def encode(self, eng):
        """공학값 -> 레지스터 리스트 (시뮬레이터용)"""
        if self.dtype == "bool":
            return [1 if eng else 0]
        raw = self._unscale(eng)
        if self.dtype == "u16":
            return [max(0, min(65535, int(round(raw))))]
        if self.dtype == "i16":
            return [max(-32768, min(32767, int(round(raw)))) & 0xFFFF]
        if self.dtype == "f32":
            b = struct.pack(">f", raw)
        elif self.dtype == "u32":
            b = struct.pack(">I", max(0, min(0xFFFFFFFF, int(round(raw)))))
        else:
            b = struct.pack(">i", int(round(raw)))
        hi, lo = struct.unpack(">HH", b)
        return [hi, lo] if self.word_order == "big" else [lo, hi]