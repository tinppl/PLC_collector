'use strict';
/* 진입점: 라우터 / 상단 표시줄 / 수집 시작 창 / 상태 폴링 */
(function () {
  const { h, $, icon, btn, S, api, loadCfg, toast, openModal, fmtDur, JOB_LABEL, jobSummary, empty, panel } = PC;

  const ROUTES = [
    ['', '대시보드', 'dashboard'], ['devices', '장치', 'devices'], ['tags', '변수', 'tags'],
    ['jobs', '수집 작업', 'jobs'], ['files', '결과 파일', 'files'], ['scan', '주소 탐색', 'scan'], ['faults', '장애 재현', 'faults']
  ];
  PC.statusListeners = new Set();
  let cleanup = null;

  // ---------- 라우터 ----------
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const id = location.hash.replace(/^#\/?/, '');
    const r = ROUTES.find(x => x[0] === id) || ROUTES[0];
    const main = $('#main');
    main.replaceChildren();
    try { cleanup = window.PAGES[r[2]](main) || null; }
    catch (e) { main.append(panel(null, empty('화면을 표시하지 못했습니다', e.message))); console.error(e); }
    document.querySelectorAll('#nav a').forEach(a => {
      if (a.dataset.id === r[0]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = (r[0] ? r[1] + ' · ' : '') + 'PLC 데이터 수집기';
  }
  PC.refresh = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

  // ---------- 상단 실행 표시줄 ----------
  const elapsed = () => S.status ? S.status.elapsed + (S.status.running ? (Date.now() - S.statusAt) / 1000 : 0) : 0;
  function renderRun() {
    const pill = $('#runpill'), txt = $('#runtext'), b = $('#runbtn');
    if (S.offline) { pill.className = 'pill offline'; txt.textContent = '서버 연결 끊김'; b.disabled = true; return; }
    b.disabled = false;
    const running = S.status && S.status.running;
    pill.className = 'pill' + (running ? ' running' : '');
    txt.textContent = running ? '수집 중 ' + fmtDur(elapsed()) : '대기 중';
    b.className = 'btn ' + (running ? 'halt' : 'go');
    b.replaceChildren(icon(running ? 'stop' : 'play', 14), h('span', null, running ? '수집 중지' : '수집 시작'));
  }
  let prevRunning = null;
  async function pollNow() {
    try { S.status = await api('GET', '/api/status'); S.statusAt = Date.now(); S.offline = false; }
    catch (e) { S.offline = true; }
    if (S.status && prevRunning === true && !S.status.running) {
      const rows = S.status.jobs.reduce((a, j) => a + j.records, 0);
      toast(`수집이 끝났습니다. 저장된 행 ${rows}개 — 결과 파일 탭에서 확인하세요.`);
    }
    if (S.status) prevRunning = S.status.running;
    renderRun();
    PC.statusListeners.forEach(fn => fn(S.status));
  }
  PC.pollNow = pollNow;
  function loop() { pollNow().finally(() => setTimeout(loop, S.status && S.status.running ? 1000 : 2000)); }
  setInterval(() => { if (S.status && S.status.running) renderRun(); }, 1000);

  $('#runbtn').addEventListener('click', async () => {
    if (S.status && S.status.running) {
      try { await api('POST', '/api/stop'); } catch (e) { toast(e.message, 'bad'); }
      pollNow();
    } else PC.openStart();
  });

  // ---------- 수집 시작 창 ----------
  PC.openStart = function (pre) {
    const jobs = Object.entries(S.cfg.jobs);
    if (!jobs.length) { toast('먼저 수집 작업을 만드세요.', 'bad'); location.hash = '#/jobs'; return; }
    if (S.status && S.status.running) return toast('이미 수집 중입니다.');
    const sel = new Set(pre && pre.length ? pre : jobs.map(([n]) => n));
    const checks = jobs.map(([n, s]) => h('label', { class: 'picker-item' },
      h('input', { type: 'checkbox', checked: sel.has(n), onchange: (e) => { e.target.checked ? sel.add(n) : sel.delete(n); } }),
      h('span', null, h('strong', null, n), h('span', { class: 'dim', style: { marginLeft: '8px', color: 'var(--ink3)' } }, JOB_LABEL[s.type] + ' · ' + jobSummary(s)))));
    const ovCheck = h('input', { type: 'checkbox', onchange: () => { ovNum.disabled = ovUnit.disabled = !ovCheck.checked; } });
    const ovNum = h('input', { type: 'number', min: 0, step: 'any', value: 1, disabled: true });
    const ovUnit = h('select', { style: { width: '90px', flex: 'none' }, disabled: true }, [[1, 'ms'], [1000, '초'], [60000, '분']].map(([v, l]) => h('option', { value: v, selected: v === 1000 }, l)));
    const durSel = h('select', { onchange: () => { custom.hidden = durSel.value !== 'custom'; } },
      [['0', '직접 중지할 때까지'], ['60', '1분'], ['300', '5분'], ['600', '10분'], ['1800', '30분'], ['3600', '1시간'], ['custom', '직접 입력 (분)']].map(([v, l]) => h('option', { value: v }, l)));
    const custom = h('input', { type: 'number', min: 1, step: 'any', value: 10, hidden: true, style: { marginTop: '8px' } });
    const simNote = h('div');
    if (S.status && S.status.sim.available && !S.status.sim.running) {
      simNote.append(h('div', { class: 'banner warn', style: { marginBottom: '14px' } }, icon('bolt'),
        h('span', null, '데모 장치가 꺼져 있습니다. 지금 시작하면 값을 읽지 못해 "통신 끊김"으로 기록됩니다.'),
        btn('데모 장치 켜기', { size: 'sm', onclick: async (e) => { try { await api('POST', '/api/sim', { on: true }); simNote.replaceChildren(); toast('데모 장치를 켰습니다.'); pollNow(); } catch (er) { toast(er.message, 'bad'); } } })));
    }
    const m = openModal({
      title: '수집 시작',
      body: [
        simNote,
        h('div', { class: 'lbl' }, '실행할 작업'),
        h('div', { class: 'picker', style: { marginBottom: '14px' } }, h('div', { class: 'picker-list' }, checks)),
        h('div', { class: 'field' }, h('label', { class: 'inline-check' }, ovCheck, h('span', { style: { fontWeight: 600 } }, '이번에만 수집 주기 바꾸기')),
          h('div', { class: 'row tight', style: { marginTop: '8px' } }, ovNum, ovUnit),
          h('p', { class: 'hint' }, '주기 수집은 읽는 간격, 이벤트·사이클 수집은 신호를 확인하는 간격에 적용됩니다. 작업 설정은 바뀌지 않습니다.')),
        PC.field('수집 시간', durSel), h('div', { style: { marginTop: '-6px' } }, custom)
      ],
      footer: [h('span', { class: 'grow' }), btn('취소', { onclick: () => m.close() }),
        btn('시작', { kind: 'primary', icon: 'play', onclick: async () => {
          if (!sel.size) return toast('실행할 작업을 하나 이상 선택하세요.', 'bad');
          const body = { jobs: jobs.map(([n]) => n).filter(n => sel.has(n)) };
          if (ovCheck.checked) {
            const ms = Math.round(Number(ovNum.value) * Number(ovUnit.value));
            if (!(ms >= 10)) return toast('수집 주기는 10ms 이상이어야 합니다.', 'bad');
            body.period_ms = ms;
          }
          let dur = durSel.value === 'custom' ? Number(custom.value) * 60 : Number(durSel.value);
          if (durSel.value === 'custom' && !(dur > 0)) return toast('수집 시간을 분 단위로 입력하세요.', 'bad');
          if (dur > 0) body.duration_s = dur;
          try { await api('POST', '/api/run', body); m.close(); toast('수집을 시작했습니다.'); pollNow(); }
          catch (e) { toast(e.message, 'bad'); }
        } })]
    });
  };

  // ---------- 테마 ----------
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch (e) { /* 무시 */ }
    $('#themebtn').replaceChildren(icon(t === 'dark' ? 'sun' : 'moon', 16));
    $('#themebtn').title = t === 'dark' ? '밝은 화면으로' : '어두운 화면으로';
  }
  $('#themebtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  setTheme(document.documentElement.dataset.theme || 'light');

  // ---------- 시작 ----------
  $('#nav').append(...ROUTES.map(([id, label]) => h('a', { href: '#/' + id, 'data-id': id }, label)));
  renderRun();
  (async function init() {
    try { await loadCfg(); }
    catch (e) {
      $('#main').append(panel(null, empty('설정을 불러오지 못했습니다', e.message, btn('다시 시도', { kind: 'primary', onclick: () => location.reload() }))));
      return;
    }
    route();
    loop();
  })();
})();
