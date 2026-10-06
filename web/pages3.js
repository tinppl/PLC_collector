'use strict';
/* 페이지: 장애 재현 (가상 장치에 일부러 문제를 일으켜 수집기 반응을 확인) */
(function () {
  const { h, icon, btn, badge, api, toast, pageHead, panel, empty, field } = PC;
  const P = (window.PAGES = window.PAGES || {});

  P.faults = function (root) {
    root.append(pageHead('장애 재현',
      '가상 장치에 실기기에서 겪을 만한 문제를 일으킵니다. 켠 상태에서 수집을 돌려 CSV·로그에 어떻게 기록되는지 확인하세요.'));
    const body = h('div');
    root.append(body);

    let info = null;          // 서버가 알려 준 장애 목록·상태
    let device = null;        // 선택한 장치
    const drafts = {};        // 장애 id -> 입력 중인 파라미터 (자동 갱신 때 입력값이 지워지지 않게 보관)
    let alive = true;
    let busy = false;

    async function turnSimOn() {
      try { await api('POST', '/api/sim', { on: true }); toast('데모 장치를 켰습니다.'); await PC.pollNow(); refresh(); }
      catch (e) { toast(e.message, 'bad'); }
    }

    async function refresh() {
      if (!alive || busy) return;
      try { info = await api('GET', '/api/sim/faults'); } catch (e) { return; }
      if (!alive) return;
      if (!info.running || !info.devices.length) {
        body.replaceChildren(panel(null, empty(
          info.running ? '장애를 걸 수 있는 장치가 없습니다' : '데모 장치가 꺼져 있습니다',
          info.running ? 'Modbus TCP 데모 장치(sim)가 설정에 있어야 합니다.' : '장애 재현은 데모 장치가 켜져 있을 때만 쓸 수 있습니다.',
          info.running ? null : btn('데모 장치 켜기', { kind: 'primary', icon: 'bolt', onclick: turnSimOn }))));
        return;
      }
      if (!info.devices.includes(device)) device = info.devices.includes('fc5000') ? 'fc5000' : info.devices[0];
      draw();
    }

    async function send(payload, okMsg) {
      busy = true;
      try { await api('POST', '/api/sim/faults', payload); if (okMsg) toast(okMsg); }
      catch (e) { toast(e.message, 'bad'); }
      busy = false;
      refresh();
    }

    function card(d, st) {
      const on = !!st;
      const inputs = d.params.map(p => {
        const cur = (drafts[d.id] || {})[p.key] ?? (st ? st.params[p.key] : p.default);
        const el = h('input', { type: 'number', min: p.min, max: p.max, step: 'any', value: String(cur),
          oninput: (e) => { (drafts[d.id] = drafts[d.id] || {})[p.key] = e.target.value; } });
        return field(p.label, el);
      });
      const params = () => Object.fromEntries(d.params.map(p => [p.key, (drafts[d.id] || {})[p.key] ?? p.default]));
      let action;
      if (d.kind === 'action') {
        action = btn('지금 실행', { icon: 'bolt', onclick: () => send({ device, id: d.id, action: true }, d.title + ' 실행') });
      } else if (d.kind === 'timed') {
        action = btn(on ? '지금 끄기' : '시작', { kind: on ? '' : 'primary', icon: on ? 'stop' : 'play',
          onclick: () => send({ device, id: d.id, on: !on, params: params() }) });
      } else {
        action = btn(on ? '끄기' : '켜기', { kind: on ? '' : 'primary', icon: on ? 'stop' : 'play',
          onclick: () => send({ device, id: d.id, on: !on, params: params() }) });
      }
      const state = d.kind === 'action' ? null
        : on ? badge(st.remaining_s != null ? `켜짐 · ${Math.ceil(st.remaining_s)}초 남음` : '켜짐', 'bad') : badge('꺼짐', 'mute');
      return h('section', { class: 'panel fault-card' + (on ? ' on' : '') },
        h('div', { class: 'panel-head' }, h('span', null, `${d.code} · ${d.title}`), h('span', { class: 'end' }, state)),
        h('div', { class: 'panel-body' },
          h('p', { class: 'hint', style: { marginTop: 0 } }, d.desc),
          inputs.length ? h('div', { class: 'row tight' }, inputs) : null,
          h('div', { style: { marginTop: '10px' } }, action)));
    }

    function draw() {
      const sel = h('select', { onchange: (e) => { device = e.target.value; draw(); } },
        info.devices.map(n => h('option', { value: n, selected: n === device }, n)));
      const mine = info.state[device] || {};
      const anyOn = Object.keys(mine).length > 0;
      body.replaceChildren(
        h('div', { class: 'row tight', style: { alignItems: 'flex-end', marginBottom: '8px' } },
          field('대상 장치', sel),
          anyOn ? btn('모두 끄기', { icon: 'stop', onclick: async () => {
            busy = true;
            try { for (const id of Object.keys(mine)) await api('POST', '/api/sim/faults', { device, id, on: false }); toast('모든 장애를 껐습니다.'); }
            catch (e) { toast(e.message, 'bad'); }
            busy = false; refresh();
          } }) : null),
        h('div', { class: 'banner info' }, icon('bolt'), h('span', null,
          '실제 장비가 오류를 어떤 형태로 돌려주는지(무응답인지 예외 응답인지)는 추정입니다. 실기기에서는 반응이 다를 수 있습니다.')),
        h('div', { class: 'fault-grid' }, info.defs.map(d => card(d, mine[d.id]))));
    }

    refresh();
    const timer = setInterval(refresh, 1000);
    return () => { alive = false; clearInterval(timer); };
  };
})();
