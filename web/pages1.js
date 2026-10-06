"use strict";
/* 페이지: 대시보드 / 장치 / 변수 */
(function () {
  const {
    h,
    icon,
    btn,
    badge,
    S,
    api,
    saveCfg,
    toast,
    openModal,
    confirmBox,
    fmtVal,
    fmtDur,
    AREA_LABEL,
    AREA_SHORT,
    TYPE_LABEL,
    TYPE_SHORT,
    parseAddr,
    driverOf,
    DRIVER_LABEL,
    xgtLabel,
    tagType,
    isBool,
    tagConv,
    jobTagRefs,
    validName,
    pageHead,
    panel,
    empty,
    field,
    frameView,
  } = PC;
  const P = (window.PAGES = window.PAGES || {});

  // ======================================================================
  // 대시보드
  // ======================================================================
  function spark(arr) {
    const W = 100,
      Hh = 26,
      ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    svg.setAttribute("class", "spark");
    svg.setAttribute("aria-hidden", "true");
    if (arr.length < 2) return svg;
    let lo = Math.min(...arr),
      hi = Math.max(...arr);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pts = arr
      .map(
        (v, i) =>
          `${((i / (arr.length - 1)) * W).toFixed(1)},${(Hh - 2 - ((v - lo) / (hi - lo)) * (Hh - 4)).toFixed(1)}`,
      )
      .join(" ");
    const pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("points", pts);
    pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", "currentColor");
    pl.setAttribute("stroke-width", "1.6");
    pl.setAttribute("stroke-linejoin", "round");
    svg.append(pl);
    return svg;
  }

  P.dashboard = function (root) {
    const cfg = S.cfg;
    const tagNames = Object.keys(cfg.tags);
    const bools = tagNames.filter((n) => isBool(cfg.tags[n]));
    const nums = tagNames.filter((n) => !isBool(cfg.tags[n]));
    let alive = true,
      liveTimer = null,
      logTimer = null;

    root.append(
      pageHead("대시보드", "장치에서 읽은 현재 값과 수집 상태입니다."),
    );

    // 시작 가이드 (순서가 있는 작업이므로 번호 사용)
    const done = [
      Object.keys(cfg.devices).length > 0,
      tagNames.length > 0,
      Object.keys(cfg.jobs).length > 0,
    ];
    if (!done.every(Boolean)) {
      const steps = [
        ["장치 등록", "PLC·ADAM의 IP와 포트를 입력합니다.", "#/devices"],
        ["변수 등록", "읽어올 값의 이름과 주소를 적습니다.", "#/tags"],
        ["수집 작업 만들기", "언제, 무엇을 저장할지 정합니다.", "#/jobs"],
        ["수집 시작", "화면 오른쪽 위의 시작 버튼을 누릅니다.", null],
      ];
      const nowIdx = done.findIndex((d) => !d);
      root.append(
        h(
          "ol",
          { class: "guide" },
          steps.map((s, i) =>
            h(
              "li",
              { class: (done[i] ? "done" : "") + (i === nowIdx ? " now" : "") },
              h(
                "span",
                { class: "gnum" },
                done[i] ? icon("check", 12) : String(i + 1),
              ),
              h(
                "div",
                null,
                s[2] ? h("a", { href: s[2] }, s[0]) : h("strong", null, s[0]),
                h("div", { class: "gdesc" }, s[1]),
              ),
            ),
          ),
        ),
      );
    }

    // 데모 장치 배너
    const simBox = h("div");
    root.append(simBox);
    function drawSim(st) {
      simBox.replaceChildren();
      if (!st || !st.sim.available) return;
      if (st.sim.running) {
        simBox.append(
          h(
            "div",
            { class: "banner info" },
            icon("bolt"),
            h(
              "span",
              null,
              "데모 장치로 동작 중입니다. 화면의 값은 실제 장치가 아닌 가상 값입니다.",
            ),
            btn("데모 장치 끄기", {
              size: "sm",
              onclick: () => toggleSim(false),
            }),
          ),
        );
      } else {
        simBox.append(
          h(
            "div",
            { class: "banner warn" },
            icon("bolt"),
            h(
              "span",
              null,
              "데모 장치가 꺼져 있어 값을 읽을 수 없습니다. 실제 장치가 없다면 데모 장치를 켜서 사용해 보세요.",
            ),
            btn("데모 장치 켜기", {
              size: "sm",
              kind: "primary",
              onclick: () => toggleSim(true),
            }),
          ),
        );
      }
    }
    async function toggleSim(on) {
      try {
        await api("POST", "/api/sim", { on });
        toast(on ? "데모 장치를 켰습니다." : "데모 장치를 껐습니다.");
        await PC.pollNow();
      } catch (e) {
        toast(e.message, "bad");
      }
    }

    // 신호 램프 / 측정값
    const lampEls = {},
      anEls = {};
    const stamp = h("span", null, "");
    const left = h("div"),
      right = h("div");
    if (!tagNames.length) {
      left.append(
        panel(
          "현재 값",
          empty(
            "읽어올 변수가 없습니다",
            "변수를 등록하면 이곳에 현재 값이 실시간으로 표시됩니다.",
            btn("변수 등록하기", {
              kind: "primary",
              onclick: () => {
                location.hash = "#/tags";
              },
            }),
          ),
        ),
      );
    } else {
      if (bools.length) {
        const grid = h(
          "div",
          { class: "lamps" },
          bools.map((n) => {
            const lamp = h("span", { class: "lamp" });
            const st = h("span", { class: "lamp-state" }, "—");
            const el = h(
              "div",
              {
                class: "lamp-item",
                title: `${cfg.tags[n].device} · ${cfg.tags[n].address}`,
              },
              lamp,
              h("span", { class: "lamp-name" }, n),
              st,
            );
            lampEls[n] = { el, lamp, st };
            return el;
          }),
        );
        left.append(panel("신호 (ON/OFF)", grid, { flush: true, end: stamp }));
      }
      if (nums.length) {
        const rows = nums.map((n) => {
          const spec = cfg.tags[n];
          const val = h("div", { class: "an-val stale" }, "—"),
            sp = h("div", { class: "spark-cell" }),
            bd = h("div", { class: "an-status" });
          const unit = h("span", { class: "unit" }, spec.unit || "");
          val.append(unit);
          const row = h(
            "div",
            { class: "analog" },
            h(
              "div",
              { class: "an-name" },
              n,
              h("span", { class: "an-dev" }, spec.device),
            ),
            sp,
            val,
            bd,
          );
          anEls[n] = { val, sp, bd, unit };
          return row;
        });
        left.append(
          panel("측정값", rows, {
            flush: true,
            end: bools.length ? null : stamp,
          }),
        );
      }
    }

    // 작업 상태 / 로그
    const jobsBody = h("div", { class: "scroll-x" });
    right.append(panel("수집 작업 상태", jobsBody, { flush: true }));
    function drawJobs(st) {
      jobsBody.replaceChildren();
      if (!st || !st.jobs.length) {
        jobsBody.append(
          empty(
            "아직 수집 기록이 없습니다",
            "오른쪽 위의 수집 시작 버튼을 누르면 작업별 진행 상황이 여기에 표시됩니다.",
          ),
        );
        return;
      }
      jobsBody.append(
        h(
          "table",
          { class: "tbl" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["작업", "상태", "저장 행", "마지막 저장"].map((t) =>
                h("th", { class: t === "저장 행" ? "num" : "" }, t),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            st.jobs.map((j) =>
              h(
                "tr",
                null,
                h(
                  "td",
                  { class: "name" },
                  j.name,
                  h(
                    "div",
                    {
                      class: "dim",
                      style: { fontWeight: 400, fontSize: "12px" },
                    },
                    PC.JOB_LABEL[j.type],
                  ),
                ),
                h(
                  "td",
                  { class: "wrap" },
                  j.state === "error"
                    ? badge("오류", "bad")
                    : j.state === "running"
                      ? badge("수집 중", "ok")
                      : badge("중지됨", "mute"),
                  j.error
                    ? h(
                        "div",
                        { class: "cell-bad", style: { fontSize: "12px" } },
                        j.error,
                      )
                    : null,
                ),
                h("td", { class: "num" }, String(j.records)),
                h(
                  "td",
                  { class: "dim" },
                  j.last_time ? j.last_time.slice(11) : "—",
                ),
              ),
            ),
          ),
        ),
      );
    }

    const logBox = h("div", { class: "log" });
    right.append(panel("최근 기록", logBox, { flush: true }));
    function logLine(l) {
      const bad = /오류|실패|끊김/.test(l.msg);
      return h(
        "div",
        { class: "log-line" + (bad ? " bad" : "") },
        h("span", { class: "t" }, l.t),
        h("span", { class: "m" }, l.msg),
      );
    }
    S.logs.slice(-200).forEach((l) => logBox.append(logLine(l)));
    if (!S.logs.length)
      logBox.append(
        h(
          "div",
          { class: "log-line" },
          h("span", { class: "t" }, ""),
          h(
            "span",
            { class: "m dim" },
            "수집을 시작하면 이벤트와 오류가 여기에 기록됩니다.",
          ),
        ),
      );
    logBox.scrollTop = logBox.scrollHeight;
    async function pollLogs() {
      if (!alive) return;
      try {
        const d = await api("GET", "/api/logs?after=" + S.logLast);
        if (d.last < S.logLast) {
          S.logLast = 0;
          S.logs = [];
        } else if (d.lines.length) {
          if (!S.logs.length) logBox.replaceChildren();
          const near =
            logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
          d.lines.forEach((l) => {
            S.logs.push(l);
            logBox.append(logLine(l));
          });
          S.logs = S.logs.slice(-300);
          while (logBox.children.length > 200) logBox.firstChild.remove();
          if (near) logBox.scrollTop = logBox.scrollHeight;
          S.logLast = d.last;
        } else S.logLast = d.last;
      } catch (e) {
        /* 상단 표시줄이 연결 상태를 알려줌 */
      }
      if (alive) logTimer = setTimeout(pollLogs, 1500);
    }

    root.append(h("div", { class: "dash-grid" }, left, right));

    // 실시간 값 반영
    function applyLive(d) {
      stamp.textContent = "갱신 " + d.time;
      for (const n of bools) {
        const v = d.values[n],
          e = lampEls[n];
        if (!v || !e) continue;
        const comm = v.q === "COMM";
        e.lamp.className = "lamp" + (comm ? " comm" : v.v ? " on" : "");
        e.el.classList.toggle("is-on", !comm && !!v.v);
        e.st.textContent = comm ? "통신 끊김" : v.v ? "ON" : "OFF";
      }
      for (const n of nums) {
        const v = d.values[n],
          e = anEls[n];
        if (!v || !e) continue;
        const h2 = (S.hist[n] = S.hist[n] || []);
        if (v.q !== "COMM" && v.v !== null) {
          h2.push(v.v);
          if (h2.length > 60) h2.shift();
        }
        e.val.className = "an-val" + (v.q === "COMM" ? " stale" : "");
        e.val.replaceChildren(v.q === "COMM" ? "—" : fmtVal(v.v), e.unit);
        e.sp.replaceChildren(spark(h2));
        e.bd.replaceChildren(
          v.q === "COMM"
            ? badge("통신 끊김", "bad")
            : v.q === "RANGE"
              ? badge("범위 밖", "warn")
              : "",
        );
      }
    }
    async function tick() {
      if (!alive) return;
      if (tagNames.length) {
        try {
          const d = await api("GET", "/api/live");
          if (!alive) return;
          S.live = d;
          applyLive(d);
        } catch (e) {
          if (!alive) return;
          stamp.textContent = "읽기 실패";
        }
      }
      if (alive) liveTimer = setTimeout(tick, 1000);
    }

    const onStatus = (st) => {
      drawSim(st);
      drawJobs(st);
    };
    PC.statusListeners.add(onStatus);
    onStatus(S.status);
    tick();
    pollLogs();
    return () => {
      alive = false;
      clearTimeout(liveTimer);
      clearTimeout(logTimer);
      PC.statusListeners.delete(onStatus);
    };
  };

  // ======================================================================
  // 장치
  // ======================================================================
  function deviceStatus(name) {
    const t = S.devTest[name];
    if (t)
      return t.ok
        ? badge(`연결됨 · ${t.ms}ms`, "ok")
        : h("span", { title: t.message }, badge("연결 실패", "bad"));
    const l = S.live && S.live.devices && S.live.devices[name];
    if (l === "ok") return badge("통신 중", "ok");
    if (l === "fail") return badge("통신 실패", "bad");
    return badge("확인 전", "mute");
  }

  async function runDeviceTest(name) {
    const d = S.cfg.devices[name];
    try {
      S.devTest[name] = await api("POST", "/api/device/test", { device: d });
    } catch (e) {
      S.devTest[name] = { ok: false, message: e.message };
    }
    return S.devTest[name];
  }

  P.devices = function (root) {
    const devs = Object.entries(S.cfg.devices);
    root.append(
      pageHead(
        "장치",
        "PLC, ADAM 같은 데이터를 읽어올 장치를 등록합니다.",
        devs.length
          ? btn("전체 연결 테스트", {
              icon: "plug",
              onclick: async () => {
                for (const [n] of devs) await runDeviceTest(n);
                PC.refresh();
              },
            })
          : null,
        btn("장치 추가", {
          kind: "primary",
          icon: "plus",
          onclick: () => openDevice(null),
        }),
      ),
    );

    if (!devs.length) {
      root.append(
        panel(
          null,
          empty(
            "등록된 장치가 없습니다",
            "읽어올 PLC나 ADAM의 IP 주소를 등록하면 시작할 수 있습니다.",
            btn("장치 추가", {
              kind: "primary",
              icon: "plus",
              onclick: () => openDevice(null),
            }),
          ),
        ),
      );
      return;
    }
    const rows = devs.map(([n, d]) => {
      const used = Object.values(S.cfg.tags).filter(
        (t) => t.device === n,
      ).length;
      return h(
        "tr",
        null,
        h(
          "td",
          { class: "name" },
          n,
          d.sim
            ? h("span", { style: { marginLeft: "8px" } }, badge("데모", "info"))
            : null,
        ),
        h("td", null, DRIVER_LABEL[d.driver || "modbus_tcp"] || d.driver),
        h(
          "td",
          { class: "mono" },
          `${d.host}:${d.port ?? (d.driver === "xgt" ? 2004 : 502)}`,
        ),
        h(
          "td",
          { class: "dim" },
          d.driver === "xgt" ? "—" : String(d.unit ?? 1),
        ),
        h("td", null, `${used}개`),
        h("td", null, deviceStatus(n)),
        h(
          "td",
          { class: "act" },
          btn("연결 테스트", {
            size: "sm",
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              const r = await runDeviceTest(n);
              toast(
                r.ok ? `${n}: ${r.message}` : `${n}: ${r.message}`,
                r.ok ? undefined : "bad",
              );
              PC.refresh();
            },
          }),
          btn("편집", { size: "sm", onclick: () => openDevice(n) }),
          btn("삭제", {
            size: "sm",
            kind: "danger",
            onclick: () => delDevice(n),
          }),
        ),
      );
    });
    root.append(
      panel(
        null,
        h(
          "div",
          { class: "scroll-x" },
          h(
            "table",
            { class: "tbl" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                [
                  "이름",
                  "프로토콜",
                  "주소",
                  "국번",
                  "연결된 변수",
                  "상태",
                  "",
                ].map((t) => h("th", null, t)),
              ),
            ),
            h("tbody", null, rows),
          ),
        ),
        { flush: true },
      ),
    );
  };

  async function delDevice(n) {
    const used = Object.entries(S.cfg.tags)
      .filter(([, t]) => t.device === n)
      .map(([k]) => k);
    if (used.length)
      return toast(
        `변수 ${used.length}개(${used.slice(0, 3).join(", ")}${used.length > 3 ? " …" : ""})가 이 장치를 사용 중입니다. 변수를 먼저 삭제하거나 다른 장치로 바꾸세요.`,
        "bad",
      );
    if (
      !(await confirmBox(`장치 '${n}'을(를) 삭제할까요?`, {
        ok: "삭제",
        danger: true,
      }))
    )
      return;
    if (
      await saveCfg((c) => {
        delete c.devices[n];
      }, "장치를 삭제했습니다.")
    ) {
      delete S.devTest[n];
      PC.refresh();
    }
  }

  function openDevice(name) {
    const old = name ? S.cfg.devices[name] : null;
    const f = {
      name: h("input", {
        type: "text",
        value: name || "",
        readonly: !!name,
        placeholder: "예: plc1, adam6017",
      }),
      proto: h(
        "select",
        null,
        h(
          "option",
          { value: "xgt", selected: !!(old && old.driver === "xgt") },
          "LS XGT 전용 프로토콜 (LS PLC 이더넷)",
        ),
        h(
          "option",
          { value: "modbus_tcp", selected: !(old && old.driver === "xgt") },
          "Modbus TCP (ADAM, 타사 장치 등)",
        ),
      ),
      host: h("input", {
        type: "text",
        value: old ? old.host : "",
        placeholder: "예: 192.168.0.10",
      }),
      port: h("input", {
        type: "number",
        value: old ? (old.port ?? 502) : 502,
        min: 1,
        max: 65535,
      }),
      unit: h("input", {
        type: "number",
        value: old ? (old.unit ?? 1) : 1,
        min: 0,
        max: 255,
      }),
      timeout: h("input", {
        type: "number",
        value: old ? (old.timeout_s ?? 2) : 2,
        min: 0.2,
        max: 30,
        step: 0.5,
      }),
      gap: h("input", {
        type: "number",
        value: old ? (old.max_gap ?? 4) : 4,
        min: 0,
        max: 50,
      }),
      pos: h("input", {
        type: "number",
        value: old ? (old.position ?? 0) : 0,
        min: 0,
        max: 255,
      }),
      sim: h("input", { type: "checkbox", checked: !!(old && old.sim) }),
    };
    const result = h("div");
    const spec = () => {
      const o = Object.assign({}, old || {});
      o.driver = f.proto.value;
      o.host = f.host.value.trim();
      o.port = parseInt(f.port.value, 10) || (o.driver === "xgt" ? 2004 : 502);
      if (o.driver === "xgt") {
        delete o.unit;
        const p = parseInt(f.pos.value, 10);
        o.position = isNaN(p) ? 0 : p;
      } else {
        delete o.position;
        o.unit = parseInt(f.unit.value, 10);
        if (isNaN(o.unit)) o.unit = 1;
      }
      o.timeout_s = parseFloat(f.timeout.value) || 2;
      o.max_gap = parseInt(f.gap.value, 10);
      if (isNaN(o.max_gap)) o.max_gap = 4;
      if (f.sim.checked) o.sim = true;
      else delete o.sim;
      return o;
    };
    const testBtn = btn("연결 테스트", {
      icon: "plug",
      onclick: async () => {
        const s = spec();
        if (!s.host) {
          result.replaceChildren(
            h("div", { class: "result-box bad" }, "주소를 입력하세요."),
          );
          return;
        }
        testBtn.disabled = true;
        result.replaceChildren(h("div", { class: "result-box" }, "연결 중…"));
        try {
          const r = await api("POST", "/api/device/test", { device: s });
          result.replaceChildren(
            h(
              "div",
              { class: "result-box " + (r.ok ? "ok" : "bad") },
              r.message + (r.ok ? ` (${r.ms}ms)` : ""),
              frameView(r),
            ),
          );
        } catch (e) {
          result.replaceChildren(
            h("div", { class: "result-box bad" }, e.message),
          );
        }
        testBtn.disabled = false;
      },
    });
    const protoHint = h("p", { class: "hint" });
    const portHint = h("p", { class: "hint" });
    const unitField = field("국번 (Unit ID)", f.unit, "대부분 1");
    const posField = field(
      "통신 모듈 위치 (FEnet Position)",
      f.pos,
      "보통 0입니다. 통신 모듈이 CPU와 다른 슬롯/베이스에 있을 때만 바꿉니다.",
    );
    const syncProto = (changed) => {
      const xgt = f.proto.value === "xgt";
      protoHint.textContent = xgt
        ? "LS PLC의 이더넷(FEnet) 전용 서비스로 읽습니다. XG5000에서 해당 통신 모듈의 전용 서비스(XGT 서버)가 켜져 있어야 합니다."
        : "ADAM-6000 시리즈나 Modbus TCP 서버가 켜진 장치는 이 방식으로 읽습니다.";
      portHint.textContent = xgt
        ? "전용 서비스 기본 포트는 2004입니다."
        : "보통 502입니다.";
      if (changed) {
        const p = f.port.value;
        if (p === "502" || p === "2004") f.port.value = xgt ? 2004 : 502;
      }
      unitField.hidden = xgt;
      posField.hidden = !xgt;
    };
    f.proto.addEventListener("change", () => syncProto(true));
    const m = openModal({
      title: name ? `장치 편집 · ${name}` : "장치 추가",
      body: [
        field(
          "이름",
          f.name,
          name
            ? "이름은 변수가 참조하고 있어 바꿀 수 없습니다."
            : "공백 없이 입력하세요. 변수 등록 화면에서 이 이름으로 선택합니다.",
        ),
        field("프로토콜", f.proto, protoHint),
        h(
          "div",
          { class: "row" },
          field("IP 주소", f.host),
          field("포트", f.port, portHint),
        ),
        h(
          "div",
          { class: "row" },
          unitField,
          field("응답 대기 (초)", f.timeout),
        ),
        posField,
        h("div", { class: "sectionline" }, "고급 설정"),
        field(
          "주소 묶음 간격",
          f.gap,
          "가까운 주소는 한 번에 묶어 읽어 속도를 높입니다. 떨어진 주소가 읽기 오류를 낸다면 0으로 줄이세요.",
        ),
        h(
          "label",
          { class: "inline-check" },
          f.sim,
          h("span", null, "데모용 가상 장치로 사용 (실제 장치가 아님)"),
        ),
        result,
      ],
      footer: [
        testBtn,
        h("span", { class: "grow" }),
        btn("취소", { onclick: () => m.close() }),
        btn("저장", {
          kind: "primary",
          onclick: async () => {
            const n = f.name.value.trim();
            if (!n) return toast("이름을 입력하세요.", "bad");
            if (!name && !validName(n))
              return toast(
                "이름에는 공백과 , \" ' / \\ : * ? < > | 문자를 쓸 수 없고 _ 로 시작할 수 없습니다.",
                "bad",
              );
            if (!name && S.cfg.devices[n])
              return toast("같은 이름의 장치가 이미 있습니다.", "bad");
            const s = spec();
            if (!s.host) return toast("IP 주소를 입력하세요.", "bad");
            if (
              await saveCfg((c) => {
                c.devices[n] = s;
              }, "장치를 저장했습니다.")
            ) {
              delete S.devTest[n];
              m.close();
              PC.refresh();
            }
          },
        }),
      ],
    });
    syncProto(false);
  }

  // ======================================================================
  // 변수
  // ======================================================================
  const CSV_COLS = [
    ["name", "이름"],
    ["device", "장치"],
    ["address", "주소"],
    ["area", "영역"],
    ["type", "타입"],
    ["unit", "단위"],
    ["factor", "배율"],
    ["offset", "보정"],
    ["rlo", "읽은값_하한"],
    ["rhi", "읽은값_상한"],
    ["elo", "실제값_하한"],
    ["ehi", "실제값_상한"],
    ["vmin", "정상_최소"],
    ["vmax", "정상_최대"],
    ["word_order", "워드순서"],
  ];
  const HEADER_ALIAS = {
    name: ["name", "이름", "변수", "변수명"],
    device: ["device", "장치"],
    address: ["address", "주소"],
    area: ["area", "영역"],
    type: ["type", "타입", "데이터타입"],
    unit: ["unit", "단위"],
    factor: ["factor", "배율"],
    offset: ["offset", "보정", "오프셋"],
    rlo: ["읽은값_하한"],
    rhi: ["읽은값_상한"],
    elo: ["실제값_하한"],
    ehi: ["실제값_상한"],
    vmin: ["정상_최소", "min", "최소"],
    vmax: ["정상_최대", "max", "최대"],
    word_order: ["워드순서", "word_order"],
  };
  const TYPE_ALIAS = {
    bool: "bool",
    bit: "bool",
    u16: "u16",
    uint: "u16",
    word: "u16",
    i16: "i16",
    int: "i16",
    u32: "u32",
    udint: "u32",
    dword: "u32",
    i32: "i32",
    dint: "i32",
    f32: "f32",
    float: "f32",
    real: "f32",
  };
  const AREA_ALIAS = {
    holding: "holding",
    "4x": "holding",
    input: "input",
    "3x": "input",
    coil: "coil",
    "0x": "coil",
    discrete: "discrete",
    "1x": "discrete",
  };

  function specToRow(n, s) {
    const l = s.linear || [];
    const a = parseAddr(s.address, s.area, driverOf(s));
    return {
      name: n,
      device: s.device,
      address: s.address,
      area: a && !a.xgt ? a.area : "",
      type: tagType(s),
      unit: s.unit || "",
      factor: s.factor ?? "",
      offset: s.offset ?? "",
      rlo: l[0] ?? "",
      rhi: l[1] ?? "",
      elo: l[2] ?? "",
      ehi: l[3] ?? "",
      vmin: s.valid ? s.valid[0] : "",
      vmax: s.valid ? s.valid[1] : "",
      word_order: s.word_order || "",
    };
  }

  function parseTable(text) {
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((l) => l.trim());
    if (!lines.length) return [];
    const delim = lines[0].includes("\t") ? "\t" : ",";
    const split = (l) => {
      if (delim === "\t") return l.split("\t").map((x) => x.trim());
      const out = [];
      let cur = "",
        q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          out.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    let cols = CSV_COLS.slice(0, 9).map((c) => c[0]),
      start = 0;
    const first = split(lines[0]).map((x) => x.toLowerCase());
    const known = (x) =>
      Object.entries(HEADER_ALIAS).find(([, al]) => al.includes(x));
    if (
      first.some((x) => known(x)) &&
      first.filter((x) => known(x)).length >= 2
    ) {
      cols = first.map((x) => {
        const k = known(x);
        return k ? k[0] : null;
      });
      start = 1;
    }
    return lines.slice(start).map((l, i) => {
      const cells = split(l),
        r = {};
      cols.forEach((c, j) => {
        if (c && cells[j] !== undefined && cells[j] !== "") r[c] = cells[j];
      });
      return rowToSpec(r, start + i + 1);
    });
  }

  function rowToSpec(r, line) {
    const errs = [],
      n = (r.name || "").trim();
    if (!validName(n))
      errs.push("이름이 비었거나 사용할 수 없는 문자가 있습니다");
    let device = r.device;
    if (!device && Object.keys(S.cfg.devices).length === 1)
      device = Object.keys(S.cfg.devices)[0];
    if (!device || !S.cfg.devices[device])
      errs.push(`장치 '${device || ""}'가 등록되어 있지 않습니다`);
    const spec = { device };
    let areaV;
    if (r.area) {
      areaV = AREA_ALIAS[r.area.toLowerCase()];
      if (!areaV) errs.push("영역을 알 수 없습니다");
    }
    const addrRaw = (r.address || "").trim();
    const drv = (S.cfg.devices[device] || {}).driver || "modbus_tcp";
    const pa = parseAddr(addrRaw, areaV, drv);
    if (!pa) errs.push("주소 형식이 올바르지 않습니다");
    else if (pa.xgt) spec.address = pa.norm;
    else if (pa.modicon) spec.address = addrRaw;
    else {
      spec.address = pa.addr;
      spec.area = pa.area;
    }
    if (r.type) {
      const t = TYPE_ALIAS[r.type.toLowerCase()];
      if (!t) errs.push(`타입 '${r.type}'을 알 수 없습니다`);
      else spec.type = t;
    }
    if (r.unit) spec.unit = r.unit;
    const nn = (k) => {
      if (r[k] === undefined) return undefined;
      const v = Number(r[k]);
      if (isNaN(v)) {
        errs.push(`'${r[k]}'는 숫자가 아닙니다`);
        return undefined;
      }
      return v;
    };
    const rl = [nn("rlo"), nn("rhi"), nn("elo"), nn("ehi")];
    if (rl.every((v) => v !== undefined)) {
      if (rl[0] === rl[1] || rl[2] === rl[3])
        errs.push("범위 변환의 하한과 상한이 같습니다");
      else spec.linear = rl;
    } else {
      const f = nn("factor"),
        o = nn("offset");
      if (f !== undefined && f !== 1) spec.factor = f;
      if (o !== undefined && o !== 0) spec.offset = o;
    }
    const vmin = nn("vmin"),
      vmax = nn("vmax");
    if (vmin !== undefined && vmax !== undefined) spec.valid = [vmin, vmax];
    if (r.word_order && ["big", "little"].includes(r.word_order.toLowerCase()))
      spec.word_order = r.word_order.toLowerCase();
    return { line, name: n, spec, errs, exists: !!S.cfg.tags[n] };
  }

  function csvEscape(v) {
    v = String(v ?? "");
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCsv() {
    const lines = [CSV_COLS.map((c) => c[1]).join(",")];
    Object.entries(S.cfg.tags).forEach(([n, s]) => {
      const r = specToRow(n, s);
      lines.push(CSV_COLS.map((c) => csvEscape(r[c[0]])).join(","));
    });
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = h("a", { href: URL.createObjectURL(blob), download: "tags.csv" });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function openImport(initial) {
    const ta = h("textarea", {
      placeholder:
        "엑셀에서 복사한 표를 붙여넣으세요.\n첫 줄에 열 이름이 있으면 자동으로 인식합니다.",
      spellcheck: "false",
    });
    if (initial) ta.value = initial;
    const preview = h("div");
    let parsed = [];
    const apply = btn("가져오기", { kind: "primary", disabled: true });
    function draw() {
      parsed = parseTable(ta.value);
      preview.replaceChildren();
      apply.disabled = true;
      if (!parsed.length) return;
      const okRows = parsed.filter((r) => !r.errs.length);
      preview.append(
        h(
          "div",
          { class: "sectionline" },
          `미리보기: 가져올 수 있는 변수 ${okRows.length}개` +
            (parsed.length - okRows.length
              ? `, 오류 ${parsed.length - okRows.length}개 (오류 줄은 건너뜁니다)`
              : ""),
        ),
        h(
          "div",
          {
            class: "scroll-x",
            style: {
              maxHeight: "260px",
              overflow: "auto",
              border: "1px solid var(--line)",
              borderRadius: "4px",
            },
          },
          h(
            "table",
            { class: "tbl" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ["줄", "이름", "장치", "주소", "결과"].map((t) =>
                  h("th", null, t),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              parsed.map((r) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "dim" }, String(r.line)),
                  h("td", { class: "name" }, r.name),
                  h("td", null, r.spec.device || ""),
                  h("td", { class: "mono" }, String(r.spec.address ?? "")),
                  h(
                    "td",
                    { class: "wrap" },
                    r.errs.length
                      ? h("span", { class: "cell-bad" }, r.errs.join(" / "))
                      : badge(
                          r.exists ? "덮어쓰기" : "새 변수",
                          r.exists ? "warn" : "ok",
                        ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      apply.disabled = !okRows.length;
    }
    ta.addEventListener("input", draw);
    const header = CSV_COLS.slice(0, 9)
      .map((c) => c[1])
      .join("\t");
    const dev0 = Object.keys(S.cfg.devices)[0] || "plc1";
    const m = openModal({
      title: "엑셀·CSV에서 변수 가져오기",
      size: "wide",
      body: [
        h(
          "p",
          { class: "hint", style: { marginTop: 0, marginBottom: "10px" } },
          "엑셀에서 셀을 복사해 아래에 붙여넣거나, CSV 파일을 선택하세요. 같은 이름의 변수는 덮어씁니다.",
        ),
        h(
          "div",
          { class: "toolbar" },
          btn("양식 복사", {
            size: "sm",
            icon: "copy",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(
                  header + `\n온도1\t${dev0}\t40001\tu16\tC\t0.1\t0`,
                );
                toast("양식을 복사했습니다. 엑셀에 붙여넣어 작성하세요.");
              } catch (e) {
                toast("복사에 실패했습니다.", "bad");
              }
            },
          }),
          h(
            "label",
            { class: "btn sm" },
            icon("upload", 13),
            h("span", null, "CSV 파일 선택"),
            h("input", {
              type: "file",
              accept: ".csv,.txt",
              hidden: true,
              onchange: async (e) => {
                const fl = e.target.files[0];
                if (!fl) return;
                ta.value = (await fl.text()).replace(/^\ufeff/, "");
                draw();
              },
            }),
          ),
        ),
        ta,
        h(
          "p",
          { class: "hint" },
          `열 순서: ${CSV_COLS.slice(0, 9)
            .map((c) => c[1])
            .join(" · ")} (이름·장치·주소만 필수)`,
        ),
        preview,
      ],
      footer: [
        h("span", { class: "grow" }),
        btn("취소", { onclick: () => m.close() }),
        apply,
      ],
    });
    apply.addEventListener("click", async () => {
      const ok = parsed.filter((r) => !r.errs.length);
      if (
        await saveCfg((c) => {
          ok.forEach((r) => {
            const prev = c.tags[r.name];
            c.tags[r.name] =
              prev && prev.sim
                ? Object.assign({ sim: prev.sim }, r.spec)
                : r.spec;
          });
        }, `변수 ${ok.length}개를 가져왔습니다.`)
      ) {
        m.close();
        PC.refresh();
      }
    });
    draw();
  }

  P.tags = function (root) {
    const entries = Object.entries(S.cfg.tags);
    let q = "",
      dev = "";
    root.append(
      pageHead(
        "변수",
        "PLC·ADAM에서 읽어올 값에 이름을 붙이고 주소를 지정합니다.",
        btn("엑셀·CSV 가져오기", {
          icon: "paste",
          onclick: () => openImport(),
        }),
        btn("CSV 내보내기", {
          icon: "download",
          disabled: !entries.length,
          onclick: exportCsv,
        }),
        btn("변수 추가", {
          kind: "primary",
          icon: "plus",
          onclick: () => openTag(null),
        }),
      ),
    );

    if (!Object.keys(S.cfg.devices).length) {
      root.append(
        panel(
          null,
          empty(
            "먼저 장치를 등록하세요",
            "변수는 어느 장치에서 읽을지 정해야 합니다.",
            btn("장치 등록하기", {
              kind: "primary",
              onclick: () => {
                location.hash = "#/devices";
              },
            }),
          ),
        ),
      );
      return;
    }
    if (!entries.length) {
      root.append(
        panel(
          null,
          empty(
            "등록된 변수가 없습니다",
            "변수를 하나씩 추가하거나, 엑셀에 정리한 표를 붙여넣어 한 번에 등록할 수 있습니다.",
            h(
              "div",
              { class: "row tight", style: { justifyContent: "center" } },
              btn("변수 추가", {
                kind: "primary",
                icon: "plus",
                onclick: () => openTag(null),
              }),
              btn("엑셀·CSV 가져오기", {
                icon: "paste",
                onclick: () => openImport(),
              }),
            ),
          ),
        ),
      );
      return;
    }
    const search = h("input", {
      type: "search",
      placeholder: "변수 이름 검색",
      class: "grow",
      oninput: (e) => {
        q = e.target.value.trim().toLowerCase();
        draw();
      },
    });
    const devSel = h(
      "select",
      {
        style: { width: "auto" },
        onchange: (e) => {
          dev = e.target.value;
          draw();
        },
      },
      h("option", { value: "" }, "모든 장치"),
      Object.keys(S.cfg.devices).map((d) => h("option", { value: d }, d)),
    );
    const readBtn = btn("현재 값 읽기", {
      icon: "refresh",
      onclick: async () => {
        readBtn.disabled = true;
        try {
          S.live = await api("GET", "/api/live");
          draw();
        } catch (e) {
          toast(e.message, "bad");
        }
        readBtn.disabled = false;
      },
    });
    root.append(h("div", { class: "toolbar" }, search, devSel, readBtn));
    const host = h("div");
    root.append(host);

    function draw() {
      const list = Object.entries(S.cfg.tags).filter(
        ([n, s]) =>
          (!q || n.toLowerCase().includes(q)) && (!dev || s.device === dev),
      );
      host.replaceChildren();
      if (!list.length) {
        host.append(panel(null, empty("조건에 맞는 변수가 없습니다")));
        return;
      }
      host.append(
        panel(
          null,
          h(
            "div",
            { class: "scroll-x" },
            h(
              "table",
              { class: "tbl" },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  [
                    "이름",
                    "장치",
                    "주소",
                    "타입",
                    "변환",
                    "정상 범위",
                    "현재 값",
                    "",
                  ].map((t, i) => h("th", { class: i === 6 ? "num" : "" }, t)),
                ),
              ),
              h(
                "tbody",
                null,
                list.map(([n, s]) => {
                  const a = parseAddr(s.address, s.area, driverOf(s)),
                    lv = S.live && S.live.values[n];
                  const cur = !lv
                    ? "—"
                    : lv.q === "COMM"
                      ? h("span", { class: "cell-bad" }, "통신 끊김")
                      : [
                          fmtVal(lv.v),
                          s.unit ? h("span", { class: "unit" }, s.unit) : null,
                        ];
                  return h(
                    "tr",
                    null,
                    h("td", { class: "name" }, n),
                    h("td", null, s.device),
                    h(
                      "td",
                      null,
                      h("span", { class: "mono" }, String(s.address)),
                      a
                        ? h(
                            "span",
                            {
                              class: "dim",
                              style: { marginLeft: "8px", fontSize: "12px" },
                            },
                            a.xgt
                              ? xgtLabel(a)
                              : `${AREA_SHORT[a.area]} ${a.addr}`,
                          )
                        : null,
                    ),
                    h("td", null, TYPE_SHORT[tagType(s)]),
                    h("td", { class: "dim" }, tagConv(s) || "—"),
                    h(
                      "td",
                      { class: "dim" },
                      s.valid ? `${s.valid[0]} ~ ${s.valid[1]}` : "—",
                    ),
                    h("td", { class: "num" }, cur),
                    h(
                      "td",
                      { class: "act" },
                      btn("편집", { size: "sm", onclick: () => openTag(n) }),
                      btn("복제", {
                        size: "sm",
                        onclick: () =>
                          openTag(
                            null,
                            Object.assign({}, s, { _name: n + "_copy" }),
                          ),
                      }),
                      btn("삭제", {
                        size: "sm",
                        kind: "danger",
                        onclick: () => delTag(n),
                      }),
                    ),
                  );
                }),
              ),
            ),
          ),
          { flush: true },
        ),
      );
    }
    draw();
  };

  async function delTag(n) {
    const jobs = Object.entries(S.cfg.jobs)
      .filter(([, j]) => jobTagRefs(j).includes(n))
      .map(([k]) => k);
    if (jobs.length)
      return toast(
        `수집 작업(${jobs.join(", ")})에서 사용 중인 변수입니다. 작업에서 먼저 제외하세요.`,
        "bad",
      );
    if (
      !(await confirmBox(`변수 '${n}'을(를) 삭제할까요?`, {
        ok: "삭제",
        danger: true,
      }))
    )
      return;
    if (
      await saveCfg((c) => {
        delete c.tags[n];
      }, "변수를 삭제했습니다.")
    )
      PC.refresh();
  }

  // 변수 편집 창 (preset: 복제/주소 탐색에서 넘어온 초기값)
  function openTag(name, preset) {
    const old = name ? S.cfg.tags[name] : null;
    const base = old || preset || {};
    const devDriver = (d) => (S.cfg.devices[d] || {}).driver || "modbus_tcp";
    const dev0 = base.device || Object.keys(S.cfg.devices)[0];
    const wo0 =
      base.word_order || (devDriver(dev0) === "xgt" ? "little" : "big");
    const pa0 =
      base.address !== undefined
        ? parseAddr(base.address, base.area, devDriver(dev0))
        : null;
    const f = {
      name: h("input", {
        type: "text",
        value: name || (preset && preset._name) || "",
        readonly: !!name,
        placeholder: "예: 용탕온도",
      }),
      device: h(
        "select",
        null,
        Object.keys(S.cfg.devices).map((d) =>
          h(
            "option",
            { value: d, selected: d === dev0 },
            `${d}  (${DRIVER_LABEL[devDriver(d)]})`,
          ),
        ),
      ),
      address: h("input", {
        type: "text",
        value: base.address !== undefined ? String(base.address) : "",
        placeholder: "예: 40001 또는 100",
        class: "mono",
      }),
      area: h(
        "select",
        null,
        Object.entries(AREA_LABEL).map(([k, v]) =>
          h(
            "option",
            { value: k, selected: k === (pa0 ? pa0.area : "holding") },
            v,
          ),
        ),
      ),
      type: h(
        "select",
        null,
        Object.entries(TYPE_LABEL).map(([k, v]) =>
          h(
            "option",
            {
              value: k,
              selected:
                k === (base.address !== undefined ? tagType(base) : "u16"),
            },
            v,
          ),
        ),
      ),
      word: h(
        "select",
        null,
        h(
          "option",
          { value: "big", selected: wo0 !== "little" },
          "상위 워드 먼저",
        ),
        h(
          "option",
          { value: "little", selected: wo0 === "little" },
          "하위 워드 먼저",
        ),
      ),
      bit: h("input", {
        type: "number",
        min: 0,
        max: 15,
        value: base.bit ?? "",
        placeholder: "비워 두면 0이 아닌 값 = ON",
      }),
      conv: h(
        "select",
        null,
        h("option", { value: "none" }, "변환 없음 (읽은 값 그대로)"),
        h(
          "option",
          { value: "scale" },
          "배율·보정 (값 = 읽은 값 × 배율 + 보정)",
        ),
        h("option", { value: "linear" }, "범위 변환 (예: 4~20mA → 0~500℃)"),
      ),
      factor: h("input", {
        type: "number",
        step: "any",
        value: base.factor ?? 1,
      }),
      offset: h("input", {
        type: "number",
        step: "any",
        value: base.offset ?? 0,
      }),
      rlo: h("input", {
        type: "number",
        step: "any",
        value: base.linear ? base.linear[0] : 0,
      }),
      rhi: h("input", {
        type: "number",
        step: "any",
        value: base.linear ? base.linear[1] : 65535,
      }),
      elo: h("input", {
        type: "number",
        step: "any",
        value: base.linear ? base.linear[2] : 0,
      }),
      ehi: h("input", {
        type: "number",
        step: "any",
        value: base.linear ? base.linear[3] : 100,
      }),
      unit: h("input", {
        type: "text",
        value: base.unit || "",
        placeholder: "예: ℃, L/min",
      }),
      vmin: h("input", {
        type: "number",
        step: "any",
        value: base.valid ? base.valid[0] : "",
      }),
      vmax: h("input", {
        type: "number",
        step: "any",
        value: base.valid ? base.valid[1] : "",
      }),
    };
    f.conv.value = base.linear
      ? "linear"
      : (base.factor ?? 1) !== 1 || (base.offset ?? 0) !== 0
        ? "scale"
        : "none";
    const addrHint = h("p", { class: "hint" });
    const secWord = field(
      "32비트 값의 워드 순서",
      f.word,
      "실수·32비트 정수가 이상한 값으로 나오면 반대로 바꿔 보세요. (주소 탐색 화면에서 확인할 수 있습니다)",
    );
    const secBit = field(
      "비트 번호 (선택)",
      f.bit,
      "레지스터의 특정 비트(0~15)만 ON/OFF로 읽을 때 입력합니다.",
    );
    const secScale = h(
      "div",
      { class: "row" },
      field("배율", f.factor),
      field("보정", f.offset),
    );
    const secLinear = h(
      "div",
      null,
      h(
        "div",
        { class: "row" },
        field("읽은 값 하한", f.rlo),
        field("읽은 값 상한", f.rhi),
      ),
      h(
        "div",
        { class: "row" },
        field("실제 값 하한", f.elo),
        field("실제 값 상한", f.ehi),
      ),
      h(
        "p",
        { class: "hint", style: { marginTop: "-6px", marginBottom: "12px" } },
        "읽은 값이 하한~상한 사이일 때 실제 값 하한~상한으로 비례 변환합니다.",
      ),
    );
    const secConv = h(
      "div",
      null,
      field("값 변환", f.conv),
      secScale,
      secLinear,
    );
    const secRest = h(
      "div",
      null,
      h(
        "div",
        { class: "row" },
        field("단위", f.unit),
        field("정상 범위 최소", f.vmin),
        field("정상 범위 최대", f.vmax),
      ),
      h(
        "p",
        { class: "hint", style: { marginTop: "-6px" } },
        '정상 범위를 벗어난 값은 저장 파일에 "범위 밖" 표시가 붙습니다. 비워 두면 검사하지 않습니다.',
      ),
    );

    function sync() {
      const xgt = devDriver(f.device.value) === "xgt";
      const pa = parseAddr(
        f.address.value,
        f.area.value,
        xgt ? "xgt" : "modbus_tcp",
      );
      const bitArea = xgt
        ? !!(pa && pa.bit)
        : (pa ? pa.area : f.area.value) === "coil" ||
          (pa ? pa.area : f.area.value) === "discrete";
      areaField.hidden = xgt;
      f.area.disabled = !xgt && !!(pa && pa.modicon);
      if (!xgt && pa && pa.modicon) f.area.value = pa.area;
      if (bitArea) f.type.value = "bool";
      f.type.disabled = bitArea;
      f.address.placeholder = xgt
        ? "예: %DW100 (워드), %MX10 (비트)"
        : "예: 40001 또는 100";
      const is32 = ["u32", "i32", "f32"].includes(f.type.value);
      addrHint.textContent = xgt
        ? !f.address.value.trim()
          ? "PLC 변수 이름을 입력하세요. 워드는 %DW100, 비트는 %MX10 형태입니다. (D100처럼 쓰면 워드로 읽습니다)"
          : !pa
            ? "주소 형식이 올바르지 않습니다. 예: %DW100, %MX10, D100"
            : `→ ${pa.letter} 영역 ${pa.bit ? "비트" : "워드"} ${pa.addr}번을 읽습니다.` +
              (is32 && !pa.bit ? " (연속된 워드 2개 사용)" : "")
        : !f.address.value.trim()
          ? "5자리 번호(예: 40001)는 앞자리로 영역을 판단합니다. 그 외 숫자는 아래 영역을 선택하세요."
          : !pa
            ? "주소 형식이 올바르지 않습니다. 5자리 번호(40001) 또는 0~65535 숫자를 입력하세요."
            : `→ ${AREA_SHORT[pa.area]} 영역 ${pa.addr}번 주소를 읽습니다.` +
              (pa.modicon ? " (5자리 표기: 번호 − 1)" : "");
      const t = f.type.value;
      secWord.hidden = !is32;
      secBit.hidden = !(t === "bool" && !bitArea);
      secConv.hidden = t === "bool";
      secRest.hidden = t === "bool";
      secScale.hidden = f.conv.value !== "scale";
      secLinear.hidden = f.conv.value !== "linear";
    }
    [f.address, f.area, f.type, f.conv].forEach((e) =>
      e.addEventListener("input", sync),
    );
    f.device.addEventListener("change", () => {
      if (!old)
        f.word.value = devDriver(f.device.value) === "xgt" ? "little" : "big";
      sync();
    });

    function build() {
      const n = f.name.value.trim();
      if (!name) {
        if (!validName(n))
          return {
            err: "이름이 비었거나 사용할 수 없는 문자가 있습니다. (공백과 , \" ' / \\ : * ? < > | 불가, _ 로 시작 불가)",
          };
        if (S.cfg.tags[n]) return { err: "같은 이름의 변수가 이미 있습니다." };
      }
      if (!f.device.value) return { err: "장치를 선택하세요." };
      const pa = parseAddr(
        f.address.value,
        f.area.value,
        devDriver(f.device.value) === "xgt" ? "xgt" : "modbus_tcp",
      );
      if (!pa) return { err: "주소 형식이 올바르지 않습니다." };
      const s = {};
      if (old && old.sim) s.sim = old.sim;
      s.device = f.device.value;
      if (pa.xgt) s.address = pa.norm;
      else if (pa.modicon) s.address = f.address.value.trim();
      else {
        s.address = pa.addr;
        s.area = pa.area;
      }
      const t = f.type.value;
      const bitArea = pa.xgt
        ? pa.bit
        : pa.area === "coil" || pa.area === "discrete";
      if (!bitArea) s.type = t;
      if (t === "u32" || t === "i32" || t === "f32")
        s.word_order = f.word.value;
      if (t === "bool" && !bitArea && f.bit.value !== "")
        s.bit = parseInt(f.bit.value, 10);
      if (t !== "bool") {
        if (f.conv.value === "scale") {
          const fa = Number(f.factor.value),
            of = Number(f.offset.value);
          if (f.factor.value === "" || isNaN(fa) || fa === 0)
            return { err: "배율은 0이 아닌 숫자여야 합니다." };
          if (fa !== 1) s.factor = fa;
          if (of) s.offset = of;
        } else if (f.conv.value === "linear") {
          const v = [f.rlo, f.rhi, f.elo, f.ehi].map((e) => Number(e.value));
          if (
            v.some(isNaN) ||
            [f.rlo, f.rhi, f.elo, f.ehi].some((e) => e.value === "")
          )
            return { err: "범위 변환 값을 모두 숫자로 입력하세요." };
          if (v[0] === v[1] || v[2] === v[3])
            return { err: "범위 변환의 하한과 상한은 달라야 합니다." };
          s.linear = v;
        }
        if (f.unit.value.trim()) s.unit = f.unit.value.trim();
        if (f.vmin.value !== "" && f.vmax.value !== "") {
          const a = Number(f.vmin.value),
            b = Number(f.vmax.value);
          if (a > b) return { err: "정상 범위의 최소가 최대보다 큽니다." };
          s.valid = [a, b];
        } else if (f.vmin.value !== "" || f.vmax.value !== "")
          return {
            err: "정상 범위는 최소와 최대를 모두 입력하거나 모두 비워 두세요.",
          };
      }
      return { n, s };
    }

    const areaField = field("영역", f.area);
    const result = h("div");
    const testBtn = btn("값 읽어보기", {
      icon: "eye",
      onclick: async () => {
        const b = build();
        if (b.err && !/이름|같은 이름/.test(b.err)) {
          result.replaceChildren(h("div", { class: "result-box bad" }, b.err));
          return;
        }
        const spec = b.s || null;
        if (!spec) {
          // 이름 오류만 있는 경우에도 읽기 테스트는 가능하도록 임시 이름 사용
          const prev = f.name.value;
          f.name.value = "_t";
          const b2 = build();
          f.name.value = prev;
          if (b2.err) {
            result.replaceChildren(
              h("div", { class: "result-box bad" }, b2.err),
            );
            return;
          }
          return runRead(b2.s);
        }
        runRead(spec);
      },
    });
    async function runRead(spec) {
      testBtn.disabled = true;
      result.replaceChildren(h("div", { class: "result-box" }, "읽는 중…"));
      try {
        const r = await api("POST", "/api/tag/test", { tag: spec });
        if (!r.ok)
          result.replaceChildren(
            h("div", { class: "result-box bad" }, r.message, frameView(r)),
          );
        else
          result.replaceChildren(
            h(
              "div",
              { class: "result-box ok" },
              h(
                "dl",
                { class: "kv", style: { margin: 0 } },
                h("dt", null, "읽은 원시값"),
                h("dd", { class: "mono" }, r.raw.join(", ")),
                h("dt", null, "변환된 값"),
                h(
                  "dd",
                  null,
                  fmtVal(r.value) +
                    (spec.unit ? " " + spec.unit : "") +
                    (r.quality === "RANGE" ? "  (정상 범위 밖)" : ""),
                ),
                h("dt", null, "응답 시간"),
                h("dd", null, r.ms + "ms"),
              ),
              frameView(r),
            ),
          );
      } catch (e) {
        result.replaceChildren(
          h("div", { class: "result-box bad" }, e.message),
        );
      }
      testBtn.disabled = false;
    }

    const m = openModal({
      title: name ? `변수 편집 · ${name}` : "변수 추가",
      size: "wide",
      body: [
        h(
          "div",
          { class: "row" },
          field(
            "이름",
            f.name,
            name
              ? "이름은 수집 작업이 참조하고 있어 바꿀 수 없습니다."
              : "저장 파일의 열 이름이 됩니다. 공백 없이 입력하세요.",
          ),
          field("장치", f.device),
        ),
        h(
          "div",
          { class: "row" },
          field("주소", f.address, addrHint),
          areaField,
        ),
        field(
          "데이터 타입",
          f.type,
          "장치 매뉴얼의 데이터 형식을 따릅니다. 온도 모듈은 보통 정수 16비트, 유량계는 실수 32비트입니다.",
        ),
        secWord,
        secBit,
        secConv,
        secRest,
        result,
      ],
      footer: [
        testBtn,
        h("span", { class: "grow" }),
        btn("취소", { onclick: () => m.close() }),
        btn("저장", {
          kind: "primary",
          onclick: async () => {
            const b = build();
            if (b.err) return toast(b.err, "bad");
            if (
              await saveCfg((c) => {
                c.tags[b.n || name] = b.s;
              }, "변수를 저장했습니다.")
            ) {
              m.close();
              PC.refresh();
            }
          },
        }),
      ],
    });
    sync();
  }

  PC.openTag = openTag;
})();
