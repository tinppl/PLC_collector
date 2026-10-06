"""PLC/ADAM 범용 수집기 - 명령줄 도구

사용법 (설정 파일 기본값: config.example.json)
  python collector.py sim                      가상 장치 실행 (실기기 없이 테스트)
  python collector.py test                     모든 태그를 한 번씩 읽어 연결/주소/스케일 확인
  python collector.py run                      모든 job 실행
  python collector.py run --jobs monitor --period-ms 500 --duration 60
  python collector.py scan --device plc1 --area holding --start 0 --count 10
"""
import argparse
import struct
import sys
import threading

from engine import ConfigError, Reader, load_config, log, run_jobs
from tagcodec import BIT_AREAS


def cmd_sim(cfg, args):
    from simulator import run_sim
    stop = threading.Event()
    try:
        run_sim(cfg, stop, log)
    except KeyboardInterrupt:
        stop.set()
        log("시뮬레이터 종료")


def cmd_test(cfg, args):
    reader = Reader(cfg)
    names = list(cfg["_tags"])
    res = reader.read(names)
    print(f"{'tag':<16}{'device':<14}{'area/addr':<14}{'type':<6}{'value':>14}  {'unit':<6}quality")
    print("-" * 78)
    for n in names:
        t, r = cfg["_tags"][n], res[n]
        v = "-" if r.value is None else (int(r.value) if isinstance(r.value, bool) else f"{r.value:.4g}")
        print(f"{n:<16}{t.device:<14}{t.area + '/' + str(t.address):<14}{t.dtype:<6}{v:>14}  {t.unit:<6}{r.quality}")
    if any(r.quality == "COMM" for r in res.values()):
        print("\n[COMM] 통신 실패 원인 점검: IP/포트, 방화벽, 국번(unit), 주소 범위, 장치의 Modbus 활성화 여부")
        print("       (ADAM은 Modbus/TCP 포트 502, LS PLC는 Modbus 서버 설정/주소 매핑 필요)")
        print("마지막 오류:", getattr(reader, "last_error", "-"))
    reader.close()


def cmd_scan(cfg, args):
    """주소 범위를 그대로 읽어 u16/i16/hex/32비트 해석을 같이 보여줌 (주소·워드순서 찾기용)"""
    if args.device not in cfg["devices"]:
        raise ConfigError(f"device '{args.device}' 없음. 후보: {list(cfg['devices'])}")
    from engine import make_client
    client = make_client(cfg["devices"][args.device])
    try:
        vals = client.read(args.area, args.start, args.count)
    except Exception as e:
        print("읽기 실패:", e)
        return
    finally:
        client.close()
    if args.area in BIT_AREAS:
        for i, v in enumerate(vals):
            print(f"{args.area}[{args.start + i}] = {int(v)}")
        return
    print(f"{'addr':>6} {'u16':>7} {'i16':>7} {'hex':>6}   {'u32(big)':>11} {'f32(big)':>12} {'f32(little)':>12}")
    for i, v in enumerate(vals):
        s = f"{args.start + i:>6} {v:>7} {v - 65536 if v >= 32768 else v:>7} {v:>#6x}"
        if i + 1 < len(vals):
            hi, lo = v, vals[i + 1]
            u32 = (hi << 16) | lo
            fb = struct.unpack(">f", struct.pack(">HH", hi, lo))[0]
            fl = struct.unpack(">f", struct.pack(">HH", lo, hi))[0]
            s += f"   {u32:>11} {fb:>12.4g} {fl:>12.4g}"
        print(s)


def cmd_run(cfg, args):
    names = args.jobs.split(",") if args.jobs else list(cfg["jobs"])
    for n in names:
        if n not in cfg["jobs"]:
            raise ConfigError(f"job '{n}' 없음. 후보: {list(cfg['jobs'])}")
    jobs = run_jobs(cfg, names, args.period_ms, args.duration, args.out)
    print("\n=== 저장 결과 ===")
    for j in jobs:
        print(f"{j.jname:<16} {j.records:>6}행  {j.path}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description="PLC/ADAM 범용 수집기")
    ap.add_argument("command", choices=["sim", "test", "run", "scan"])
    ap.add_argument("-c", "--config", default="config.example.json", help="설정 파일(json/yaml)")
    ap.add_argument("--jobs", help="실행할 job 이름(쉼표 구분). 기본: 전체")
    ap.add_argument("--period-ms", type=int, help="수집 주기 덮어쓰기(ms). interval은 period_ms, event/cycle은 poll_ms")
    ap.add_argument("--duration", type=float, help="자동 종료까지 시간(초). 기본: Ctrl+C까지")
    ap.add_argument("--out", default="output", help="CSV 저장 폴더")
    ap.add_argument("--device", help="scan 대상 device")
    ap.add_argument("--area", default="holding", choices=["coil", "discrete", "input", "holding"])
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=10)
    args = ap.parse_args()
    try:
        cfg = load_config(args.config)
        {"sim": cmd_sim, "test": cmd_test, "run": cmd_run, "scan": cmd_scan}[args.command](cfg, args)
    except ConfigError as e:
        sys.exit(f"설정 오류: {e}")


if __name__ == "__main__":
    main()
