'use strict';
/* 페이지: 수집 작업 / 결과 파일 / 주소 탐색 */
(function () {
  const { h, icon, btn, badge, S, api, saveCfg, toast, openModal, confirmBox,
    fmtVal, fmtMs, fmtSize, JOB_LABEL, EDGE_LABEL, AREA_LABEL, isBool, jobSummary, jobColumns,
    validName, pageHead, panel, empty, field } = PC;
  const P = (window.PAGES = window.PAGES || {});
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ======================================================================
  // 입력 부품
  // ======================================================================
  function tagSelect(filter, value, onChange) {
    const sel = h('select', { onchange: (e) => onChange(e.target.value) }, h('option', { value: '' }, '선택하세요'));
    const groups = {};
    Object.entries(S.cfg.tags).forEach(([n, s]) => { if (!filter || filter(n, s)) (groups[s.device] = groups[s.device] || []).push(n); });
    Object.entries(groups).forEach(([d, names]) => sel.append(h('optgroup', { label: d }, names.map(n => h('option', { value: n, selected: n === value }, n)))));
    if (value && !Object.values(groups).flat().includes(value)) sel.append(h('option', { value, selected: true }, value + ' (사용할 수 없음)'));
    return sel;
  }

  function tagPicker(o) {
    let order = [...(o.selected || [])];
    const search = h('input', { type: 'search', placeholder: '변수 검색', oninput: draw });
    const count = h('span', { class: 'picker-count' });
    const list = h('div', { class: 'picker-list' });
    const visible = () => {
      const q = search.value.trim().toLowerCase();
      return Object.entries(S.cfg.tags).filter(([n, s]) => (!o.filter || o.filter(n, s)) && (!q || n.toLowerCase().includes(q)));
    };
    function emit() { o.onChange([...order]); count.textContent = `${order.length}개 선택`; }
    function draw() {
      list.replaceChildren();
      const items = visible();
      if (!items.length) { list.append(h('div', { class: 'picker-empty' }, Object.keys(S.cfg.tags).length ? '조건에 맞는 변수가 없습니다' : '등록된 변수가 없습니다')); count.textContent = `${order.length}개 선택`; return; }
      const groups = {};
      items.forEach(([n, s]) => (groups[s.device] = groups[s.device] || []).push([n, s]));
      Object.entries(groups).forEach(([d, arr]) => {
        list.append(h('div', { class: 'picker-group' }, d));
        arr.forEach(([n, s]) => list.append(h('label', { class: 'picker-item' },
          h('input', { type: 'checkbox', checked: order.includes(n), onchange: (e) => { if (e.target.checked) { if (!order.includes(n)) order.push(n); } else order = order.filter(x => x !== n); emit(); } }),
          h('span', null, n), h('span', { class: 'p-meta' }, s.unit || ''))));
      });
      count.textContent = `${order.length}개 선택`;
    }
    const el = h('div', { class: 'picker' },
      h('div', { class: 'picker-top' }, search,
        btn('보이는 항목 모두 선택', { size: 'sm', onclick: () => { visible().forEach(([n]) => { if (!order.includes(n)) order.push(n); }); draw(); emit(); } }),
        btn('선택 해제', { size: 'sm', onclick: () => { order = []; draw(); emit(); } }), count), list);
    draw();
    return el;
  }

  function periodInput(ms, cb) {
    const unit0 = ms >= 60000 && ms % 60000 === 0 ? 60000 : ms >= 1000 && ms % 1000 === 0 ? 1000 : 1;
    const num = h('input', { type: 'number', min: '0', step: 'any', value: String(ms / unit0) });
    const sel = h('select', { style: { width: '90px', flex: 'none' } }, [[1, 'ms (1/1000초)'], [1000, '초'], [60000, '분']].map(([v, l]) => h('option', { value: v, selected: v === unit0 }, l)));
    const get = () => Math.round(Number(num.value) * Number(sel.value));
    num.addEventListener('input', () => cb(get()));
    sel.addEventListener('change', () => cb(get()));
    return h('div', { class: 'row tight' }, num, sel);
  }

  function eventsEditor(list, onChange) {
    const host = h('div');
    function draw() {
      host.replaceChildren();
      list.forEach((ev, i) => {
        const head = h('div', { class: 'evrow-head' },
          h('input', { type: 'text', value: ev.name || '', placeholder: '이벤트 이름 (예: pour)', 'aria-label': '이벤트 이름', oninput: (e) => { ev.name = e.target.value; onChange(); } }),
          h('span', { style: { marginLeft: 'auto' } }), btn('삭제', { size: 'sm', kind: 'danger', onclick: () => { list.splice(i, 1); draw(); onChange(); } }));
        const body = h('div', { class: 'evrow-body' },
          h('div', { class: 'row' },
            field('감시할 신호', tagSelect((n, s) => isBool(s), ev.tag, (v) => { ev.tag = v; onChange(); })),
            field('감지 시점', h('select', { onchange: (e) => { ev.edge = e.target.value; onChange(); } }, Object.entries(EDGE_LABEL).map(([k, l]) => h('option', { value: k, selected: (ev.edge || 'rising') === k }, l))))),
          field('이 신호가 감지되면 저장할 변수', tagPicker({ selected: ev.snapshot || [], onChange: (v) => { ev.snapshot = v; onChange(); } })),
          field('신호 후 읽기 지연 (초, 선택)', h('input', { type: 'number', min: 0, step: 'any', value: ev.delay_ms ? ev.delay_ms / 1000 : '', placeholder: '0 = 바로 읽음', oninput: (e) => { const v = Number(e.target.value); if (v > 0) ev.delay_ms = Math.round(v * 1000); else delete ev.delay_ms; onChange(); } }),
            '예: 제품이 배출되고 2초 뒤의 온도를 저장하려면 2를 입력합니다.'));
        host.append(h('div', { class: 'evrow' }, head, body));
      });
      host.append(h('div', { class: 'events-add' }, btn('이벤트 추가', { icon: 'plus', onclick: () => { list.push({ name: `이벤트${list.length + 1}`, tag: '', edge: 'rising', snapshot: [] }); draw(); onChange(); } })));
    }
    draw();
    return host;
  }

  // ======================================================================
  // 수집 작업 목록
  // ======================================================================
  const svgTile = (inner) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 200 48'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = inner; return s; };
  const TILE_ART = {
    interval: '<line x1="6" y1="34" x2="194" y2="34" stroke="currentColor" stroke-opacity=".3"/>' + [20, 56, 92, 128, 164].map(x => `<circle cx="${x}" cy="34" r="4.5" fill="currentColor"/>`).join(''),
    event: '<path d="M6 36H74V12H98V36H194" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="2"/><circle cx="74" cy="24" r="5" fill="#2dbe6e"/><circle cx="74" cy="24" r="9" fill="none" stroke="#2dbe6e" stroke-opacity=".5"/>',
    cycle: '<path d="M30 6V42M170 6V42" stroke="currentColor" stroke-width="2"/><path d="M30 24H170" stroke="currentColor" stroke-opacity=".3"/>' + [70, 105, 138].map(x => `<circle cx="${x}" cy="24" r="4.5" fill="#2dbe6e"/>`).join('')
  };

  function openTypePicker() {
    if (!Object.keys(S.cfg.tags).length) return toast('먼저 변수를 등록하세요. 작업은 등록된 변수를 골라 만듭니다.', 'bad');
    const tiles = [
      ['interval', '주기 수집', '정해진 간격마다 선택한 값을 계속 저장합니다. 온도·유량을 1초마다 기록하는 경우에 씁니다.'],
      ['event', '이벤트 수집', 'PLC 신호가 켜지는 순간 그때의 값을 저장합니다. "용탕 주입 순간의 온도"처럼 쓰입니다.'],
      ['cycle', '사이클 수집', '시작~종료 신호로 한 생산 사이클을 묶어 한 줄로 저장합니다. 사이클 사용량 계산도 됩니다.']
    ];
    const m = openModal({
      title: '어떤 방식으로 수집할까요?', size: 'wide', dismiss: true,
      body: h('div', { class: 'tiles' }, tiles.map(([k, t, d]) => h('button', { class: 'tile', type: 'button', onclick: () => { m.close(); openJobEditor(k, null); } },
        svgTile(TILE_ART[k]), h('span', { class: 't-title' }, t), h('span', { class: 't-desc' }, d))))
    });
  }

  P.jobs = function (root) {
    const jobs = Object.entries(S.cfg.jobs);
    root.append(pageHead('수집 작업', '언제, 어떤 값을 저장할지 정합니다. 작업마다 결과 파일이 하나씩 만들어집니다.',
      btn('작업 만들기', { kind: 'primary', icon: 'plus', onclick: openTypePicker })));
    if (!jobs.length) {
      root.append(panel(null, empty('만들어진 작업이 없습니다', '주기 수집, 이벤트 수집, 사이클 수집 중에서 골라 만들 수 있습니다.',
        btn('작업 만들기', { kind: 'primary', icon: 'plus', onclick: openTypePicker }))));
      return;
    }
    root.append(panel(null, h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['이름', '방식', '내용', ''].map(t => h('th', null, t)))),
      h('tbody', null, jobs.map(([n, s]) => h('tr', null,
        h('td', { class: 'name' }, n),
        h('td', null, badge(JOB_LABEL[s.type], 'info')),
        h('td', { class: 'dim wrap' }, jobSummary(s)),
        h('td', { class: 'act' },
          btn('이 작업만 실행', { size: 'sm', icon: 'play', onclick: () => PC.openStart([n]) }),
          btn('편집', { size: 'sm', onclick: () => openJobEditor(s.type, n) }),
          btn('복제', { size: 'sm', onclick: async () => { let nn = n + '_copy', i = 2; while (S.cfg.jobs[nn]) nn = `${n}_copy${i++}`; if (await saveCfg(c => { c.jobs[nn] = clone(s); }, '작업을 복제했습니다.')) PC.refresh(); } }),
          btn('삭제', { size: 'sm', kind: 'danger', onclick: async () => { if (await confirmBox(`작업 '${n}'을(를) 삭제할까요?\n이미 저장된 결과 파일은 삭제되지 않습니다.`, { ok: '삭제', danger: true }) && await saveCfg(c => { delete c.jobs[n]; }, '작업을 삭제했습니다.')) PC.refresh(); } }))))))), { flush: true }));
  };

  // ======================================================================
  // 작업 편집기
  // ======================================================================
  function openJobEditor(type, name) {
    const old = name ? S.cfg.jobs[name] : null;
    const draft = old ? clone(old) : (
      type === 'interval' ? { type, period_ms: 1000, tags: [] } :
      type === 'event' ? { type, poll_ms: 100, events: [{ name: '이벤트1', tag: '', edge: 'rising', snapshot: [] }] } :
      { type, poll_ms: 100, start: { tag: '', edge: 'rising' }, end: { tag: '', edge: 'rising' }, start_snapshot: [], end_snapshot: [], diff: {}, events: [] });
    draft.events = draft.events || [];
    const diffRows = Object.entries(draft.diff || {}).map(([k, v]) => ({ name: k, tag: v }));

    const nameIn = h('input', { type: 'text', value: name || '', placeholder: type === 'interval' ? '예: 온도_모니터링' : type === 'event' ? '예: 공정_이벤트' : '예: 주조_사이클', oninput: () => update() });
    const chipsBox = h('div', { class: 'chips' });
    const colsNote = h('p', { class: 'hint' }, '결과 파일(CSV)에는 아래 열이 저장됩니다.');

    const specNow = () => { const s = clone(draft); s.diff = Object.fromEntries(diffRows.filter(r => r.name && r.tag).map(r => [r.name, r.tag])); return s; };
    function update() {
      chipsBox.replaceChildren(...jobColumns(specNow()).map((c, i, a) => h('span', { class: 'chip' + (['time', 'event', 'cycle_id', 'quality', 'status'].includes(c) ? '' : ' key') }, c)));
    }

    const pollHint = '신호가 켜져 있는 시간보다 짧게 설정하세요. 신호가 이 간격보다 짧게 켜지면 놓칠 수 있습니다.';
    let body;
    if (type === 'interval') {
      body = [
        field('작업 이름', nameIn, '결과 파일 이름에 사용됩니다. 공백 없이 입력하세요.'),
        field('읽는 간격', periodInput(draft.period_ms, (v) => { draft.period_ms = v; }), '수집을 시작할 때 이번 한 번만 다른 간격으로 바꿀 수도 있습니다.'),
        field('저장할 변수', tagPicker({ selected: draft.tags, onChange: (v) => { draft.tags = v; update(); } }))
      ];
    } else if (type === 'event') {
      body = [
        field('작업 이름', nameIn, '결과 파일 이름에 사용됩니다. 공백 없이 입력하세요.'),
        field('신호 확인 간격', periodInput(draft.poll_ms || 100, (v) => { draft.poll_ms = v; }), pollHint),
        h('div', { class: 'lbl' }, '이벤트'), eventsEditor(draft.events, update)
      ];
    } else {
      const edgeSel = (obj) => h('select', { onchange: (e) => { obj.edge = e.target.value; } }, Object.entries(EDGE_LABEL).map(([k, l]) => h('option', { value: k, selected: (obj.edge || 'rising') === k }, l)));
      const diffHost = h('div');
      const drawDiff = () => {
        diffHost.replaceChildren();
        diffRows.forEach((r, i) => diffHost.append(h('div', { class: 'row tight', style: { marginBottom: '8px' } },
          h('input', { type: 'text', value: r.name, placeholder: '결과 열 이름 (예: 냉각수_사용량)', oninput: (e) => { r.name = e.target.value; update(); } }),
          tagSelect((n, s) => !isBool(s), r.tag, (v) => { r.tag = v; update(); }),
          btn('삭제', { size: 'sm', kind: 'danger', onclick: () => { diffRows.splice(i, 1); drawDiff(); update(); } }))));
        diffHost.append(btn('계산 항목 추가', { icon: 'plus', onclick: () => { diffRows.push({ name: '', tag: '' }); drawDiff(); } }));
      };
      drawDiff();
      body = [
        field('작업 이름', nameIn, '결과 파일 이름에 사용됩니다. 공백 없이 입력하세요.'),
        field('신호 확인 간격', periodInput(draft.poll_ms || 100, (v) => { draft.poll_ms = v; }), pollHint),
        h('div', { class: 'row' },
          field('사이클 시작 신호', tagSelect((n, s) => isBool(s), draft.start.tag, (v) => { draft.start.tag = v; }), null),
          field('시작 감지 시점', edgeSel(draft.start))),
        h('div', { class: 'row' },
          field('사이클 종료 신호', tagSelect((n, s) => isBool(s), draft.end.tag, (v) => { draft.end.tag = v; }), null),
          field('종료 감지 시점', edgeSel(draft.end))),
        field('사이클 시작 순간에 저장할 변수 (선택)', tagPicker({ selected: draft.start_snapshot, onChange: (v) => { draft.start_snapshot = v; update(); } })),
        h('div', { class: 'lbl' }, '사이클 중간 이벤트 (선택)'), eventsEditor(draft.events, update),
        field('사이클 종료 순간에 저장할 변수 (선택)', tagPicker({ selected: draft.end_snapshot, onChange: (v) => { draft.end_snapshot = v; update(); } })),
        field('사이클 사용량 계산 (선택)', diffHost, '적산 유량처럼 계속 늘어나는 값을 고르면 "종료 값 − 시작 값"을 계산해 저장합니다.')
      ];
    }
    body.push(h('div', { class: 'sectionline' }, '저장될 결과 미리보기'), h('div', { class: 'preview-box' }, colsNote, chipsBox));
    update();

    const m = openModal({
      title: (name ? '작업 편집' : JOB_LABEL[type] + ' 만들기') + (name ? ` · ${name}` : ''), size: 'wide', body,
      footer: [h('span', { class: 'grow' }), btn('취소', { onclick: () => m.close() }), btn('저장', { kind: 'primary', onclick: save })]
    });

    async function save() {
      const n = nameIn.value.trim();
      if (!validName(n)) return toast('작업 이름이 비었거나 사용할 수 없는 문자가 있습니다. (공백과 , " \' / \\ : * ? < > | 불가)', 'bad');
      if (n !== name && S.cfg.jobs[n]) return toast('같은 이름의 작업이 이미 있습니다.', 'bad');
      const s = specNow();
      if (type === 'interval') {
        if (!s.tags.length) return toast('저장할 변수를 하나 이상 선택하세요.', 'bad');
        if (!(s.period_ms >= 10)) return toast('읽는 간격은 10ms 이상이어야 합니다.', 'bad');
      } else {
        if (!(s.poll_ms >= 10)) return toast('신호 확인 간격은 10ms 이상이어야 합니다.', 'bad');
        if (type === 'event' && !s.events.length) return toast('이벤트를 하나 이상 추가하세요.', 'bad');
        const names = new Set();
        for (const e of s.events) {
          if (!e.name.trim()) return toast('이름이 비어 있는 이벤트가 있습니다.', 'bad');
          if (names.has(e.name)) return toast(`이벤트 이름 '${e.name}'이 중복되었습니다.`, 'bad');
          names.add(e.name);
          if (!e.tag) return toast(`이벤트 '${e.name}'의 감시할 신호를 선택하세요.`, 'bad');
          e.edge = e.edge || 'rising';
        }
        if (type === 'cycle') {
          if (!s.start.tag || !s.end.tag) return toast('사이클 시작 신호와 종료 신호를 선택하세요.', 'bad');
          if (s.start.tag === s.end.tag && (s.start.edge || 'rising') === (s.end.edge || 'rising')) return toast('시작 신호와 종료 신호가 같습니다. 서로 다른 신호나 감지 시점을 선택하세요.', 'bad');
          if (diffRows.some(r => (r.name && !r.tag) || (!r.name && r.tag))) return toast('사용량 계산 항목은 열 이름과 변수를 모두 입력하세요.', 'bad');
          const dn = diffRows.filter(r => r.name).map(r => r.name);
          if (new Set(dn).size !== dn.length) return toast('사용량 계산의 열 이름이 중복되었습니다.', 'bad');
        }
      }
      if (await saveCfg(c => { if (name && name !== n) delete c.jobs[name]; c.jobs[n] = s; }, '작업을 저장했습니다.')) { m.close(); PC.refresh(); }
    }
  }

  // ======================================================================
  // 결과 파일
  // ======================================================================
  P.files = function (root) {
    const host = h('div');
    root.append(pageHead('결과 파일', '수집이 끝나면 작업마다 CSV 파일이 만들어집니다. 엑셀에서 바로 열 수 있습니다.',
      btn('새로고침', { icon: 'refresh', onclick: load }),
      S.status && S.status.loopback ? btn('폴더 열기', { icon: 'folder', onclick: async () => { try { await api('POST', '/api/open-output'); } catch (e) { toast(e.message, 'bad'); } } }) : null), host);

    async function load() {
      host.replaceChildren(h('p', { class: 'hint' }, '불러오는 중…'));
      let files;
      try { files = (await api('GET', '/api/files')).files; } catch (e) { host.replaceChildren(panel(null, empty('파일 목록을 불러오지 못했습니다', e.message))); return; }
      host.replaceChildren();
      if (!files.length) { host.append(panel(null, empty('아직 결과 파일이 없습니다', '수집을 시작하면 이곳에 파일이 생깁니다.'))); return; }
      host.append(panel(null, h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['파일', '행 수', '크기', '마지막 수정', ''].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'num' : '' }, t)))),
        h('tbody', null, files.map(f => h('tr', null,
          h('td', { class: 'name' }, f.name, f.active ? h('span', { style: { marginLeft: '8px' } }, badge('수집 중', 'ok')) : null),
          h('td', { class: 'num' }, f.rows === null ? '—' : String(f.rows)),
          h('td', { class: 'num' }, fmtSize(f.size)),
          h('td', { class: 'dim' }, f.mtime),
          h('td', { class: 'act' },
            btn('미리보기', { size: 'sm', icon: 'eye', onclick: () => preview(f.name) }),
            h('a', { class: 'btn sm', href: `/api/files/${encodeURIComponent(f.name)}/download`, download: f.name }, icon('download', 13), h('span', null, '다운로드')),
            btn('삭제', { size: 'sm', kind: 'danger', disabled: f.active, onclick: async () => { if (!await confirmBox(`'${f.name}' 파일을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`, { ok: '삭제', danger: true })) return; try { await api('DELETE', `/api/files/${encodeURIComponent(f.name)}`); toast('파일을 삭제했습니다.'); load(); } catch (e) { toast(e.message, 'bad'); } } }))))))), { flush: true }));
    }

    async function preview(name) {
      try {
        const d = await api('GET', `/api/files/${encodeURIComponent(name)}`);
        const qi = d.columns.indexOf('quality'), si = d.columns.indexOf('status');
        openModal({
          title: name, size: 'xl', dismiss: true,
          body: [
            h('p', { class: 'hint', style: { margin: '0 0 10px' } }, d.truncated ? `전체 ${d.total}행 중 처음 ${d.rows.length}행만 표시합니다. 전체는 다운로드해서 확인하세요.` : `총 ${d.total}행`),
            d.rows.length ? h('div', { class: 'scroll-x', style: { border: '1px solid var(--line)', borderRadius: '4px', maxHeight: '60vh', overflow: 'auto' } }, h('table', { class: 'tbl nowrap' },
              h('thead', null, h('tr', null, d.columns.map(c => h('th', null, c)))),
              h('tbody', null, d.rows.map(r => h('tr', null, r.map((v, i) => h('td', { class: (i === qi && v !== 'OK') || (i === si && v !== 'COMPLETE') ? 'cell-bad' : '' }, v))))))) : empty('저장된 행이 없습니다')
          ]
        });
      } catch (e) { toast(e.message, 'bad'); }
    }
    load();
  };

  // ======================================================================
  // 주소 탐색
  // ======================================================================
  // LS XGT 영역 (워드: D, M ... / 비트: DX, MX ...)
  const XGT_WORD_AREAS = { D: 'D 데이터 레지스터', M: 'M 내부 릴레이', K: 'K 킵 릴레이', L: 'L 링크 릴레이', F: 'F 특수 릴레이', P: 'P 입출력', R: 'R 파일 레지스터', T: 'T 타이머', C: 'C 카운터' };
  const XGT_BIT_AREAS = { MX: 'M 내부 릴레이 (비트)', KX: 'K 킵 릴레이 (비트)', LX: 'L 링크 릴레이 (비트)', FX: 'F 특수 릴레이 (비트)', PX: 'P 입출력 (비트)', DX: 'D 데이터 레지스터 (비트)' };
  const drvOf = (dev) => (S.cfg.devices[dev] || {}).driver || 'modbus_tcp';
  // 읽은 주소를 변수 등록창에 넘길 때의 표기
  function regAddr(driver, area, addr) {
    if (driver !== 'xgt') return addr;
    return area.endsWith('X') ? `%${area}${addr}` : `%${area}W${addr}`;
  }

  P.scan = function (root) {
    root.append(pageHead('주소 탐색', '장치의 주소 범위를 그대로 읽어 값을 확인합니다. 어떤 주소에 무슨 값이 있는지, 32비트 값의 워드 순서가 맞는지 찾을 때 씁니다.'));
    const devs = Object.keys(S.cfg.devices);
    if (!devs.length) { root.append(panel(null, empty('먼저 장치를 등록하세요', null, btn('장치 등록하기', { kind: 'primary', onclick: () => { location.hash = '#/devices'; } })))); return; }
    const f = {
      device: h('select', null, devs.map(d => h('option', { value: d }, d))),
      area: h('select'),
      start: h('input', { type: 'number', min: 0, max: 65535, value: 0 }),
      count: h('input', { type: 'number', min: 1, max: 100, value: 10 })
    };
    const note = h('p', { class: 'hint' });
    // 장치 종류에 맞게 영역 목록과 안내 문구를 바꾼다
    function syncDevice() {
      const xgt = drvOf(f.device.value) === 'xgt';
      const opts = xgt
        ? [...Object.entries(XGT_WORD_AREAS).map(([k, v]) => [k, v + ' (워드)']), ...Object.entries(XGT_BIT_AREAS)]
        : Object.entries(AREA_LABEL);
      f.area.replaceChildren(...opts.map(([k, v]) => h('option', { value: k }, v)));
      f.start.max = xgt ? 262143 : 65535;
      note.textContent = xgt
        ? '비트 영역(MX 등)의 번호는 %MX10 처럼 비트 순번 그대로입니다. 워드 영역은 %DW100 의 100 에 해당합니다. LS PLC는 32비트 값이 하위 워드부터 저장되므로 "하위 워드 먼저" 열이 상식에 맞는 숫자인지 확인하세요.'
        : '';
    }
    f.device.addEventListener('change', syncDevice);
    syncDevice();
    const out = h('div');
    const go = btn('읽기', { kind: 'primary', icon: 'eye', onclick: run });
    root.append(panel(null, h('div', null,
      h('div', { class: 'row' }, field('장치', f.device), field('영역', f.area), field('시작 주소 (0부터)', f.start), field('개수 (최대 100)', f.count)), note, go)), out);
    async function run() {
      go.disabled = true; out.replaceChildren(h('p', { class: 'hint' }, '읽는 중…'));
      const dev = f.device.value, area = f.area.value, drv = drvOf(dev);
      const reg = (addr, type) => PC.openTag(null, { device: dev, address: regAddr(drv, area, addr), area, type });
      try {
        const r = await api('POST', '/api/scan', { device: dev, area, start: Number(f.start.value), count: Number(f.count.value) });
        out.replaceChildren();
        if (!r.ok) { out.append(h('div', { class: 'result-box bad' }, r.message, PC.frameView(r))); }
        else if (r.bits) {
          out.append(panel('읽은 결과', h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, '주소'), h('th', null, '값'), h('th', null, ''))),
            h('tbody', null, r.rows.map(x => h('tr', null, h('td', { class: 'mono' }, String(x.addr)), h('td', null, x.value ? badge('ON', 'ok') : badge('OFF', 'mute')),
              h('td', { class: 'act' }, btn('변수로 등록', { size: 'sm', onclick: () => reg(x.addr, 'bool') })))))), { flush: true }));
        } else {
          const xgt = drv === 'xgt';
          const heads = ['주소', '정수(0~65535)', '정수(음수 포함)', '16진수', '32비트 정수(상위 워드 먼저)', '32비트 정수(하위 워드 먼저)', '실수(상위 워드 먼저)', '실수(하위 워드 먼저)', ''];
          out.append(panel('읽은 결과', h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, heads.map((t, i) => h('th', { class: i > 0 && i < 8 ? 'num' : '' }, t)))),
            h('tbody', null, r.rows.map(x => h('tr', null,
              h('td', { class: 'mono' }, String(x.addr)), h('td', { class: 'num' }, String(x.u16)), h('td', { class: 'num' }, String(x.i16)), h('td', { class: 'num mono' }, x.hex),
              h('td', { class: 'num dim' }, x.u32 === undefined ? '' : String(x.u32)),
              h('td', { class: 'num dim' }, x.u32_little === undefined ? '' : String(x.u32_little)),
              h('td', { class: 'num' }, x.f32_big === undefined ? '' : fmtVal(x.f32_big)), h('td', { class: 'num' }, x.f32_little === undefined ? '' : fmtVal(x.f32_little)),
              h('td', { class: 'act' },
                btn('정수로', { size: 'sm', onclick: () => reg(x.addr, 'u16') }),
                x.f32_big === undefined ? null : btn('실수로', { size: 'sm', onclick: () => reg(x.addr, 'f32') }))))))), { flush: true }),
            h('p', { class: 'hint' }, '실수·32비트 값은 두 개의 연속된 주소를 합쳐 읽습니다. 상식에 맞는 숫자가 나오는 쪽이 올바른 워드 순서입니다.' + (xgt ? ' LS PLC는 보통 "하위 워드 먼저"입니다.' : '') + ' 값이 없는 주소는 0으로 보입니다.'));
        }
      } catch (e) { out.replaceChildren(h('div', { class: 'result-box bad' }, e.message)); }
      go.disabled = false;
    }
  };
})();
