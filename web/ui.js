'use strict';
/* 공용 도구 (프레임워크 없음). 사용자 입력은 항상 textContent로 들어가므로 XSS 위험이 없다. */
window.PC = (function () {
  const $ = (s, r = document) => r.querySelector(s);

  // ---------- DOM ----------
  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    const late = {};
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'selected') late[k] = v;
        else if (k === 'disabled' || k === 'hidden' || k === 'required') el[k] = !!v;
        else if (k === 'readonly') el.readOnly = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    for (const k in late) el[k] = late[k];
    return el;
  }

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5h10"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    moon: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    refresh: '<path d="M20 11A8 8 0 0 0 5 8M4 4v4h4M4 13a8 8 0 0 0 15 3M20 20v-4h-4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
    paste: '<rect x="6" y="5" width="12" height="16" rx="1"/><path d="M9 5V3h6v2M9 11h6M9 15h6"/>'
  };
  function icon(name, size = 15) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  function btn(label, o = {}) {
    return h('button', {
      type: 'button', class: 'btn' + (o.kind ? ' ' + o.kind : '') + (o.size ? ' ' + o.size : ''),
      onclick: o.onclick, title: o.title, disabled: o.disabled
    }, o.icon ? icon(o.icon, o.size === 'sm' ? 13 : 15) : null, label ? h('span', null, label) : null);
  }
  const badge = (text, kind = 'mute') => h('span', { class: 'badge ' + kind }, text);

  // ---------- 상태 ----------
  const S = {
    cfg: { devices: {}, tags: {}, jobs: {} },
    status: null, statusAt: 0, offline: false,
    live: null, hist: {}, devTest: {},
    logs: [], logLast: 0
  };

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Requested-With': 'plc-collector' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opt); }
    catch (e) { throw new Error('서버에 연결할 수 없습니다. 수집기 프로그램(server.py)이 실행 중인지 확인하세요.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청에 실패했습니다 (${res.status})`);
    return data;
  }

  async function loadCfg() { S.cfg = await api('GET', '/api/config'); }
  async function saveCfg(mutate, okMsg) {
    const next = JSON.parse(JSON.stringify(S.cfg));
    mutate(next);
    try {
      const r = await api('PUT', '/api/config', next);
      S.cfg = next;
      toast((okMsg || '저장했습니다.') + (r.running ? ' 실행 중인 수집에는 다음 실행부터 적용됩니다.' : ''));
      return true;
    } catch (e) { toast(e.message, 'bad'); return false; }
  }

  // ---------- 토스트 · 모달 ----------
  function toast(msg, kind) {
    const el = h('div', { class: 'toast' + (kind === 'bad' ? ' bad' : ''), role: kind === 'bad' ? 'alert' : 'status' }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 7500 : 3200);
  }

  function openModal(o) {
    const prev = document.activeElement;
    const ov = h('div', { class: 'overlay' });
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (prev && prev.focus) prev.focus();
      if (o.onClose) o.onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const f = [...dlg.querySelectorAll('button,input,select,textarea,a[href]')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const body = h('div', { class: 'dialog-body' }, o.body);
    const dlg = h('div', { class: 'dialog' + (o.size ? ' ' + o.size : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('div', { class: 'dialog-head' }, h('h2', null, o.title), h('button', { class: 'icon-btn', 'aria-label': '닫기', type: 'button', onclick: close }, '×')),
      body,
      o.footer ? h('div', { class: 'dialog-foot' }, o.footer) : null);
    ov.append(dlg);
    if (o.dismiss) ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    $('#modal-root').append(ov);
    document.addEventListener('keydown', onKey, true);
    const f = dlg.querySelector('input:not([disabled]):not([readonly]),select:not([disabled]),textarea');
    (f || dlg.querySelector('.btn.primary') || dlg).focus();
    return { close, dlg, body };
  }

  function confirmBox(message, o = {}) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
      const m = openModal({
        title: o.title || '확인', onClose: () => { if (!done) { done = true; resolve(false); } },
        body: h('p', { style: { whiteSpace: 'pre-line' } }, message),
        footer: [h('span', { class: 'grow' }), btn('취소', { onclick: () => fin(false) }),
          btn(o.ok || '확인', { kind: o.danger ? 'danger' : 'primary', onclick: () => fin(true) })]
      });
    });
  }

  // ---------- 포맷 ----------
  const trim = (n) => String(+n.toFixed(2));
  const fmtVal = (v) => v === null || v === undefined ? '—'
    : typeof v === 'boolean' ? (v ? 'ON' : 'OFF')
    : Number.isInteger(v) ? String(v) : (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2));
  function fmtMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return trim(ms / 1000) + '초';
    return trim(ms / 60000) + '분';
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`;
  }
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

  // ---------- 변수/작업 유틸 ----------
  const AREA_LABEL = { holding: 'Holding 레지스터 (4x)', input: 'Input 레지스터 (3x)', coil: 'Coil (0x)', discrete: 'Discrete 입력 (1x)' };
  const AREA_SHORT = { holding: 'Holding', input: 'Input', coil: 'Coil', discrete: 'Discrete' };
  const TYPE_LABEL = {
    bool: '비트 (ON/OFF)', u16: '정수 16비트 (0 ~ 65535)', i16: '정수 16비트 (음수 포함)',
    u32: '정수 32비트 (0 이상)', i32: '정수 32비트 (음수 포함)', f32: '실수 32비트 (소수점)'
  };
  const TYPE_SHORT = { bool: '비트', u16: '정수16', i16: '정수16±', u32: '정수32', i32: '정수32±', f32: '실수32' };
  const JOB_LABEL = { interval: '주기 수집', event: '이벤트 수집', cycle: '사이클 수집' };
  const EDGE_LABEL = { rising: '꺼짐 → 켜짐 (OFF→ON)', falling: '켜짐 → 꺼짐 (ON→OFF)' };

  function parseAddr(address, area) {
    if (typeof address === 'string') {
      const s = address.trim().toLowerCase();
      if (/^\d{5}$/.test(s)) {
        const n = +s, p = Math.floor(n / 10000), num = n % 10000;
        const m = { 0: 'coil', 1: 'discrete', 3: 'input', 4: 'holding' };
        if (!(p in m) || num < 1) return null;
        return { area: m[p], addr: num - 1, modicon: true };
      }
      const v = s.startsWith('0x') ? parseInt(s, 16) : (/^\d+$/.test(s) ? parseInt(s, 10) : NaN);
      if (isNaN(v) || v < 0 || v > 65535) return null;
      return { area: area || 'holding', addr: v, modicon: false };
    }
    if (Number.isInteger(address) && address >= 0 && address <= 65535) return { area: area || 'holding', addr: address, modicon: false };
    return null;
  }
  function tagType(spec) {
    const a = parseAddr(spec.address, spec.area);
    return spec.type || (a && (a.area === 'coil' || a.area === 'discrete') ? 'bool' : 'u16');
  }
  const isBool = (spec) => tagType(spec) === 'bool';
  function tagConv(spec) {
    if (spec.linear) return `${spec.linear[0]}~${spec.linear[1]} → ${spec.linear[2]}~${spec.linear[3]}`;
    const f = spec.factor ?? 1, o = spec.offset ?? 0;
    if (f !== 1 || o !== 0) return `× ${f}` + (o ? ` ${o > 0 ? '+' : '−'} ${Math.abs(o)}` : '');
    return '';
  }
  function jobTagRefs(s) {
    const n = [];
    if (s.type === 'interval') n.push(...(s.tags || []));
    else {
      if (s.type === 'cycle') {
        n.push(s.start?.tag, s.end?.tag, ...(s.start_snapshot || []), ...(s.end_snapshot || []), ...Object.values(s.diff || {}));
      }
      for (const e of s.events || []) n.push(e.tag, ...(e.snapshot || []));
    }
    return [...new Set(n.filter(Boolean))];
  }
  function jobSummary(s) {
    if (s.type === 'interval') return `변수 ${(s.tags || []).length}개 · ${fmtMs(s.period_ms)}마다 읽음`;
    if (s.type === 'event') return `이벤트 ${(s.events || []).length}개 · ${fmtMs(s.poll_ms || 100)} 간격으로 신호 확인`;
    return `${s.start?.tag || '?'} → ${s.end?.tag || '?'} · 중간 이벤트 ${(s.events || []).length}개`;
  }
  const uniq = (a) => [...new Set(a)];
  function jobColumns(s) {
    if (s.type === 'interval') return ['time', ...(s.tags || []), 'quality'];
    if (s.type === 'event') return ['time', 'event', ...uniq((s.events || []).flatMap(e => e.snapshot || [])), 'quality'];
    const c = ['cycle_id', 'status', 'start_time', 'end_time', 'duration_s'];
    (s.start_snapshot || []).forEach(t => c.push('start_' + t));
    (s.events || []).forEach(e => { c.push(e.name + '_time'); (e.snapshot || []).forEach(t => c.push(`${e.name}_${t}`)); });
    (s.end_snapshot || []).forEach(t => c.push('end_' + t));
    Object.keys(s.diff || {}).forEach(k => c.push(k));
    c.push('quality');
    return c;
  }
  const validName = (n) => !!n && /^[^\s,"'\\/:*?<>|]+$/.test(n) && !n.startsWith('_');

  // ---------- 페이지 공용 조각 ----------
  function pageHead(title, sub, ...actions) {
    return h('div', { class: 'page-head' },
      h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
      actions.length ? h('div', { class: 'actions' }, actions) : null);
  }
  function panel(title, body, o = {}) {
    return h('section', { class: 'panel' },
      title ? h('div', { class: 'panel-head' }, h('span', null, title), o.end ? h('span', { class: 'end' }, o.end) : null) : null,
      h('div', { class: 'panel-body' + (o.flush ? ' flush' : '') }, body));
  }
  function empty(title, text, action) {
    return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, action || null);
  }
  let fieldSeq = 0;
  function field(label, input, hint) {
    // 라벨과 입력창을 연결해 라벨을 눌러도 입력창이 선택되고 화면 낭독기도 읽을 수 있게 한다
    let lab = null;
    if (label) {
      lab = h('label', null, label);
      if (input && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName)) {
        if (!input.id) input.id = 'fld' + (++fieldSeq);
        lab.htmlFor = input.id;
      }
    }
    return h('div', { class: 'field' }, lab, input, hint ? (hint instanceof Node ? hint : h('p', { class: 'hint' }, hint)) : null);
  }

  return {
    $, h, icon, btn, badge, S, api, loadCfg, saveCfg, toast, openModal, confirmBox,
    fmtVal, fmtMs, fmtDur, fmtSize, trim,
    AREA_LABEL, AREA_SHORT, TYPE_LABEL, TYPE_SHORT, JOB_LABEL, EDGE_LABEL,
    parseAddr, tagType, isBool, tagConv, jobTagRefs, jobSummary, jobColumns, validName, uniq,
    pageHead, panel, empty, field,
    refresh: () => {}, openStart: () => {}
  };
})();
