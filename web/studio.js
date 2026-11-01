'use strict';
/* A guided local workspace. All imported text is rendered through PC.h. */
(function () {
  const { h, btn, icon, api, toast, confirmBox, openModal, loadCfg } = PC;
  const steps = ['설비 정보', '연결 방식', '수집할 신호', '검토·활용'];
  const protocols = { unknown: '아직 모르겠어요', modbus_tcp: 'Modbus TCP', xgt: 'LS XGT 전용 (FEnet)', serial: '시리얼 (RS-232/485)', opcua: 'OPC UA' };
  let rememberedStep = 0;

  window.PAGES.studio = function (main) {
    let active = true, project, revision, saving = null, timer, step = rememberedStep;
    let importResult = null, importEpoch = 0, report = null, reportEpoch = 0;
    let dirty = false;
    const saveText = h('span', { class: 'studio-save', role: 'status' }, '초안 불러오는 중…');
    const body = h('div', { class: 'studio-body' });
    const workspace = h('section', { class: 'studio-card' }, body);
    const aside = h('aside', { class: 'studio-aside', 'aria-label': '설비 요약과 도움말' });
    const stepper = h('nav', { class: 'studio-steps', 'aria-label': '설비 등록 단계' });
    const root = h('div', { class: 'studio' });
    main.append(root);

    function note(text, kind = '') { return h('div', { class: 'studio-note ' + kind }, text); }
    function title(kicker, name, description) {
      return h('div', { class: 'studio-section-head' }, h('span', { class: 'studio-eyebrow' }, kicker), h('h2', { tabindex: '-1' }, name), h('p', null, description));
    }
    function changed() {
      dirty = true; report = null; reportEpoch++;
      saveText.textContent = '변경 사항 저장 대기';
      clearTimeout(timer);
      timer = setTimeout(() => save().catch(() => {}), 700);
      renderAside();
    }
    async function save() {
      clearTimeout(timer);
      if (saving) { await saving; if (dirty) return save(); return; }
      if (!dirty) return;
      const snapshot = JSON.stringify(project);
      saveText.textContent = '저장 중…';
      saving = api('PUT', '/api/aas/project', { project: JSON.parse(snapshot), revision }).then(doc => {
        revision = doc.revision;
        dirty = JSON.stringify(project) !== snapshot;
        if (active) saveText.textContent = dirty ? '변경 사항 저장 대기' : '이 PC에 자동 저장됨';
      }).catch(e => {
        if (active) { saveText.textContent = '저장 실패 · 다시 저장을 눌러주세요'; toast(e.message, 'bad'); }
        throw e;
      }).finally(() => { saving = null; });
      await saving;
      if (dirty) return save();
    }
    function input(group, key, label, hint, options = {}) {
      const id = 'aas-' + key;
      const attrs = { id, value: project[group][key], ...options, oninput: e => {
        project[group][key] = options.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
        changed();
      } };
      const control = h('input', attrs);
      if (hint) control.setAttribute('aria-describedby', id + '-hint');
      return h('div', { class: 'studio-field' }, h('label', { for: id }, label), control,
        hint ? h('p', { id: id + '-hint', class: 'studio-hint' }, hint) : null);
    }
    function select(key, label, choices, hint) {
      const control = h('select', { id: 'aas-' + key, value: project.connection[key], onchange: e => {
        const prev = project.connection[key];
        project.connection[key] = e.target.value;
        if (key === 'protocol' && prev !== e.target.value) {
          project.connection.port = e.target.value === 'xgt' ? 2004 : 502;
          // Existing signal addresses require a deliberate review after a protocol change.
          if (e.target.value === 'xgt') project.tags.forEach(t => { t.word_order = 'little'; });
          changed(); render();
        } else changed();
      } }, Object.entries(choices).map(([value, name]) => h('option', { value }, name)));
      return h('div', { class: 'studio-field' }, h('label', { for: 'aas-' + key }, label), control, hint ? h('p', { class: 'studio-hint' }, hint) : null);
    }
    function go(next) {
      step = next; rememberedStep = next; render();
      body.querySelector('h2')?.focus();
    }
    function renderAside() {
      if (!project || !active) return;
      const c = project.connection, a = project.asset;
      aside.replaceChildren(
        h('div', { class: 'studio-mini-head' }, h('span', { class: 'studio-eyebrow' }, 'ASSET PREVIEW'), h('span', { class: 'studio-chip' }, '초안')),
        h('div', { class: 'studio-asset-icon' }, icon('devices', 28), h('span', null, 'AAS')),
        h('h3', null, a.name || '새로운 설비'),
        h('p', { class: 'studio-meta' }, [a.manufacturer, a.model].filter(Boolean).join(' / ') || '설비 정보를 채워주세요'),
        h('dl', { class: 'studio-summary' },
          h('div', null, h('dt', null, '연결'), h('dd', null, protocols[c.protocol] || '미확인')),
          h('div', null, h('dt', null, '신호'), h('dd', null, project.tags.length + '개')),
          h('div', null, h('dt', null, '저장 주기'), h('dd', null, c.period_ms + ' ms')),
          h('div', null, h('dt', null, '현장 검증'), h('dd', { class: 'studio-amber' }, '진행 전'))),
        h('div', { class: 'studio-boundary' }, h('strong', null, '어디까지 자동화되나요?'),
          h('p', null, '입력한 정보를 파일과 수집 설정으로 연결합니다. 실제 주소·배선·값은 현장에서 한 번 확인해야 합니다.')),
        h('a', { href: '#/devices', class: 'studio-link' }, '기존 장치 확인하기 ', '↗'));
    }
    function footer() {
      return h('div', { class: 'studio-footer' }, step ? btn('← 이전', { onclick: () => go(step - 1) }) : h('span'),
        h('span', { class: 'studio-hint' }, `${step + 1} / 4 단계`),
        step < 3 ? btn(steps[step + 1] + ' →', { kind: 'primary', onclick: () => go(step + 1) }) : null);
    }
    function render() {
      if (!active || !project) return;
      root.classList.toggle('studio-working', step > 0 || !!project.asset.name);
      stepper.replaceChildren(...steps.map((label, i) => h('button', {
        type: 'button', class: 'studio-step' + (i === step ? ' current' : ''),
        'aria-current': i === step ? 'step' : null, onclick: () => go(i)
      }, h('span', { class: 'studio-step-num' }, String(i + 1).padStart(2, '0')), h('span', null, label))));
      body.replaceChildren();
      if (step === 0) renderIdentity();
      if (step === 1) renderConnection();
      if (step === 2) renderSignals();
      if (step === 3) renderReview();
      body.append(footer()); renderAside();
    }
    function renderIdentity() {
      body.append(title('01 / IDENTIFY', '어떤 설비를 연결할까요?', '명판에 있는 정보부터 시작하세요. 어려운 AAS 구조는 서비스가 정리합니다.'),
        h('div', { class: 'studio-grid' },
          input('asset', 'name', '설비 이름 *', '현장에서 부르는 이름을 사용해도 좋습니다.', { placeholder: '예: 1라인 냉각수 유량계', maxlength: 120 }),
          input('asset', 'location', '설치 위치', null, { placeholder: '예: A동 / 생산 1라인' }),
          input('asset', 'manufacturer', '제조사 *', null, { placeholder: '예: LS ELECTRIC' }),
          input('asset', 'model', '모델명 *', '명판에 적힌 정확한 형번을 입력하세요.', { placeholder: '장비·CPU 모델명' }),
          input('asset', 'serial', '일련번호', '같은 모델의 다른 설비를 구분하는 번호입니다.', { placeholder: '예: SN-2026-001' }),
          input('asset', 'purpose', '활용 목적', null, { placeholder: '예: 유량 이상 감지, 가동률 분석' })),
        h('details', { class: 'studio-details' }, h('summary', null, '고유 식별자 · 자동 생성됨'),
          h('p', { class: 'studio-hint' }, '한 설비의 식별자는 계속 유지하세요. 외부 시스템의 식별자가 있다면 바꿀 수 있습니다.'),
          input('asset', 'asset_id', '설비 ID', null), input('asset', 'aas_id', 'AAS ID', null)),
        note('✦ 필수 정보가 준비되면 연결 설정을 모두 마치기 전에도 AASX를 만들 수 있습니다.'));
    }
    function renderConnection() {
      body.append(title('02 / CONNECT', '데이터가 오는 경로를 정해요', '확실하지 않은 항목은 ‘아직 모르겠어요’로 두세요. 필요한 확인 사항을 정리해드립니다.'),
        h('div', { class: 'studio-grid' },
          select('protocol', '장치 통신 방식', protocols, '현재 수집 지원: Modbus TCP, LS XGT 전용 프로토콜'),
          select('ethernet', '장치에 사용할 Ethernet 연결이 있나요?', { unknown: '확인 필요', yes: '있어요', no: '없어요' }),
          input('connection', 'host', '장치 IP / 호스트 주소', '파일을 올리거나 저장해도 장치에 자동으로 접속하지 않습니다.', { placeholder: '예: 192.168.0.10', spellcheck: 'false' }),
          input('connection', 'port', '포트', 'Modbus TCP 기본 502 · LS XGT 기본 2004', { type: 'number', min: 1, max: 65535, step: 1 }),
          input('connection', 'unit', 'Modbus 국번 (Unit ID)', 'XGT 연결에는 사용하지 않습니다.', { type: 'number', min: 0, max: 255, step: 1 }),
          input('connection', 'period_ms', '수집 주기 (ms)', '1000ms = 1초. 실제 성능은 장치와 신호 수에 따라 달라집니다.', { type: 'number', min: 100, max: 3600000, step: 100 })),
        h('div', { class: 'studio-divider' }), h('h3', null, '추가 장비가 필요한지도 살펴볼게요'),
        h('p', { class: 'studio-hint', style: { margin: '8px 0 18px' } }, '이미 PLC에 들어오는 값은 기존 장치를 먼저 활용합니다. 센서를 직접 연결할 때만 입력 모듈을 검토하세요.'),
        h('div', { class: 'studio-grid' },
          select('signal', '현장에서 확보할 신호', { unknown: '확인 필요', plc: 'PLC 내부 값', '4-20ma': '4–20mA 전류', '0-10v': '0–10V 전압', rtd: 'RTD 온도 센서', thermocouple: '열전대 온도 센서', digital: '디지털 접점 / 펄스' }),
          input('connection', 'channels', '직접 연결할 신호 수', '모듈의 최소 입력 채널 수를 산정하는 데 사용합니다.', { type: 'number', min: 1, max: 1024, step: 1 })),
        note('통신 방식을 바꾸면 기본 포트가 바뀝니다. 이미 입력한 신호 주소와 워드 순서도 함께 확인하세요.', 'amber'));
    }
    function newTag() {
      return { name: '', address: '', type: 'u16', unit: '', area: 'holding', word_order: project.connection.protocol === 'xgt' ? 'little' : 'big', factor: 1, offset: 0, semantic_id: '' };
    }
    function renderSignals() {
      body.append(title('03 / MAP', '읽을 신호를 매핑하세요', '주소와 자료형은 장비 매뉴얼 기준입니다. 추측한 값을 실제 매핑으로 채우지 않습니다.'));
      const xgt = project.connection.protocol === 'xgt';
      body.append(note(xgt ? '주소 예: %DW100 = D영역 100번 워드 · %MX10 = M영역 비트. 32비트 값은 워드 2개를 사용합니다.' :
        '주소 예: 40001 = Holding 0번. 원시 주소 0을 입력할 때는 영역을 지정하세요. 32비트 값은 워드 2개를 사용합니다.'));
      const list = h('div', { class: 'studio-signals' });
      project.tags.forEach((t, i) => {
        function signalInput(key, label, attrs = {}) {
          const id = `signal-${i}-${key}`;
          return h('div', { class: 'studio-field' }, h('label', { for: id }, label), h('input', { id, value: t[key], ...attrs, oninput: e => {
            t[key] = attrs.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value; changed();
          } }));
        }
        function signalSelect(key, label, choices) {
          const id = `signal-${i}-${key}`;
          return h('div', { class: 'studio-field' }, h('label', { for: id }, label), h('select', { id, value: t[key], onchange: e => { t[key] = e.target.value; changed(); } },
            Object.entries(choices).map(([value, name]) => h('option', { value }, name))));
        }
        list.append(h('section', { class: 'studio-signal' },
          h('div', { class: 'studio-signal-head' }, h('h3', null, '신호 ' + String(i + 1).padStart(2, '0')),
            btn('삭제', { size: 'sm', icon: 'trash', onclick: () => { project.tags.splice(i, 1); changed(); render(); } })),
          h('div', { class: 'studio-grid signal-grid' }, signalInput('name', '신호 이름 *', { placeholder: '예: FlowRate', maxlength: 64 }),
            signalInput('address', '주소 *', { placeholder: xgt ? '%DW100' : '40001' }),
            signalSelect('type', '자료형', { u16: 'u16 · 16비트 양의 정수', i16: 'i16 · 16비트 정수', u32: 'u32 · 32비트 양의 정수', i32: 'i32 · 32비트 정수', f32: 'f32 · 실수', bool: 'bool · 켜짐/꺼짐' }),
            signalInput('unit', '단위', { placeholder: '예: L/min, °C' })),
          h('details', { class: 'studio-details' }, h('summary', null, '주소 영역 · 워드 순서 · 스케일 · 의미 식별자'),
            h('div', { class: 'studio-grid' }, signalSelect('area', 'Modbus 영역 (원시 주소용)', { holding: 'Holding register', input: 'Input register', coil: 'Coil', discrete: 'Discrete input' }),
              signalSelect('word_order', '32비트 워드 순서', { big: '상위 워드 먼저 (big)', little: '하위 워드 먼저 (little)' }),
              signalInput('factor', '배율 (공학값 = 원시값 × 배율 + 보정)', { type: 'number', step: 'any' }), signalInput('offset', '보정값', { type: 'number', step: 'any' })),
            signalInput('semantic_id', '의미 식별자 (IRI, 선택)', { placeholder: '관리하는 urn:… / https://… 식별자' }))));
      });
      body.append(list);
      if (!project.tags.length) body.append(h('div', { class: 'studio-empty' }, icon('plus', 25), h('h3', null, '첫 번째 신호를 추가해보세요'), h('p', null, '유량·온도·가동 신호 등 모니터링할 값을 등록합니다.')));
      body.append(btn('신호 추가', { icon: 'plus', disabled: project.tags.length >= 100, onclick: () => {
        project.tags.push(newTag()); changed(); render(); body.querySelector(`#signal-${project.tags.length - 1}-name`)?.focus();
      } }), h('p', { class: 'studio-hint', style: { marginTop: '12px' } }, '신호 이름은 영문자로 시작하는 영문·숫자·밑줄 조합입니다. 한 번에 최대 100개를 등록합니다.'));
    }
    function renderReview() {
      body.append(title('04 / REVIEW', '확인하고, 다음 단계로 연결하세요', '파일 생성과 현장 수집 준비를 따로 점검합니다. 누락된 정보는 정확히 짚어드립니다.'));
      const results = h('div', { 'aria-live': 'polite' }, note('설비 정보와 매핑을 점검하고 있습니다…'));
      body.append(results);
      const epoch = ++reportEpoch;
      api('POST', '/api/aas/assess', { project }).then(data => {
        if (!active || step !== 3 || epoch !== reportEpoch) return;
        report = data;
        results.replaceChildren(
          h('div', { class: 'studio-checks' }, data.checks.map(c => h('div', { class: 'studio-check' + (c.ok ? ' ok' : '') },
            h('span', null, c.ok ? '✓' : '○'), h('strong', null, c.label), h('small', null, c.ok ? '입력 확인' : '확인 필요')))),
          data.issues.length ? h('section', { class: 'studio-issues' }, h('h3', null, '완성도를 높이려면'), ...data.issues.map(issue => {
            const target = issue.field.startsWith('asset.') ? 0 : issue.field.startsWith('connection.') ? 1 : 2;
            return h('div', { class: 'studio-issue' }, h('span', { class: 'studio-chip ' + (issue.level === 'error' ? 'red' : 'amber') }, { error: '파일 필수', blocker: '수집 필수', warning: '권장' }[issue.level]),
              h('div', null, h('strong', null, issue.message), h('p', null, issue.action)), btn('수정', { size: 'sm', onclick: () => {
                go(target);
                const id = issue.field.startsWith('tags.') ? '#signal-' + issue.field.split('.')[1] + '-' + (issue.field.split('.')[2] || 'address') : '#aas-' + issue.field.split('.')[1];
                body.querySelector(id)?.focus();
              } }));
          })) : note('입력과 수집 매핑이 준비되었습니다. 실제 장비의 연결과 값은 적용 후 테스트하세요.'),
          h('section', { class: 'studio-recommendations' }, h('h3', null, '장비 구성 제안'), h('p', { class: 'studio-hint' }, '조건에 따른 검토 후보입니다. 구매 가능 여부와 가격은 제공하지 않습니다.'),
            ...data.recommendations.map(rec => h('article', { class: 'studio-recommendation' },
              h('div', { class: 'studio-signal-head' }, h('span', { class: 'studio-eyebrow' }, rec.title), h('span', { class: 'studio-chip amber' }, rec.status)),
              h('h4', null, rec.product), h('p', null, rec.reason), h('ul', null, rec.verify.map(t => h('li', null, t))),
              h('a', { href: rec.source, target: '_blank', rel: 'noopener noreferrer', class: 'studio-link' }, '제조사 자료 확인 ↗')))),
          h('div', { class: 'studio-actions' },
            h('div', null, h('strong', null, 'AASX 파일 만들기'), h('p', { class: 'studio-hint' }, data.can_export ? 'AAS 구조와 앱 전용 수집 프로필을 함께 담습니다.' : '설비 기본 정보의 오류를 먼저 수정하세요.')),
            btn('AASX 다운로드', { icon: 'download', kind: 'primary', disabled: !data.can_export, onclick: download })),
          h('div', { class: 'studio-actions' },
            h('div', null, h('strong', null, '이 수집기에 설정 추가'), h('p', { class: 'studio-hint' }, data.can_apply ? '장치 1개와 신호·주기 작업을 미리 확인합니다.' : '통신 정보와 신호 매핑을 완료하면 사용할 수 있습니다.')),
            btn('적용 내용 미리보기', { icon: 'eye', disabled: !data.can_apply, onclick: previewApply })),
          h('p', { class: 'studio-validation' }, data.notice, ' 파일은 앱 정의 서브모델을 사용합니다.'));
      }).catch(e => { if (active && epoch === reportEpoch) results.replaceChildren(note(e.message, 'amber'), btn('입력 수정하기', { onclick: () => go(0) })); });
    }
    async function download(e) {
      const button = e.currentTarget; button.disabled = true;
      try {
        await save();
        const res = await fetch('/api/aas/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'plc-collector' }, body: JSON.stringify({ project }) });
        if (!res.ok) throw new Error((await res.json()).error || '파일을 만들지 못했습니다.');
        const url = URL.createObjectURL(await res.blob());
        const a = h('a', { href: url, download: (project.asset.name.replace(/[^\w가-힣.-]/g, '_') || 'asset') + '.aasx' });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast('AASX 파일을 만들었습니다. 다운로드 폴더를 확인하세요.');
      } catch (err) { toast(err.message, 'bad'); }
      finally { button.disabled = false; }
    }
    async function previewApply() {
      try {
        await save();
        const snapshot = JSON.parse(JSON.stringify(project));
        const plan = await api('POST', '/api/aas/plan', { project: snapshot });
        const errors = h('div', { role: 'alert' });
        const apply = btn('설정 추가', { kind: 'primary', disabled: !plan.can_apply, onclick: async () => {
          apply.disabled = true;
          try {
            await api('POST', '/api/aas/apply', { project: snapshot, config_revision: plan.config_revision });
            await loadCfg(); modal.close();
            const success = openModal({ title: '수집 설정을 추가했습니다', body: [note('기존 설정 백업을 저장하고 새 장치·신호·작업을 추가했습니다.'),
              h('p', { style: { marginTop: '14px' } }, '장치에서 연결 테스트 → 변수에서 값 읽어보기 → 수집 시작 순서로 진행하세요.')],
              footer: [h('a', { href: '#/devices', class: 'btn primary', onclick: () => success.close() }, '장치 확인하기')] });
          } catch (err) { errors.replaceChildren(note(err.message, 'amber')); apply.disabled = false; }
        } });
        const modal = openModal({ title: '수집 설정 추가 미리보기', size: 'wide', body: [
          note('설정 저장만 수행합니다. 연결 테스트와 수집 시작은 별도로 실행하세요.'),
          h('p', { style: { margin: '16px 0' } }, `장치 ${plan.summary.devices}개 · 신호 ${plan.summary.tags}개 · 작업 ${plan.summary.jobs}개 추가`),
          plan.conflicts.length ? note('이미 같은 설비의 항목이 있습니다. 중복 적용할 수 없습니다: ' + plan.conflicts.join(', '), 'amber') : null,
          h('dl', { class: 'studio-summary' },
            h('div', null, h('dt', null, '연결 장치'), h('dd', null, snapshot.asset.name)),
            h('div', null, h('dt', null, '접속 경로'), h('dd', null, `${protocols[snapshot.connection.protocol]} · ${snapshot.connection.host}:${snapshot.connection.port}`)),
            h('div', null, h('dt', null, '수집 주기'), h('dd', null, snapshot.connection.period_ms + ' ms'))),
          h('ul', { class: 'studio-plan-signals' }, snapshot.tags.map(t => h('li', null, h('strong', null, t.name), h('span', null, `${t.address} · ${t.type} · ${t.unit || '단위 없음'}`)))),
          h('details', { class: 'studio-details' }, h('summary', null, '생성될 설정 원문 보기'),
            h('pre', { class: 'studio-code', tabindex: 0 }, JSON.stringify(plan.additions, null, 2))), errors],
          footer: [btn('닫기', { onclick: () => modal.close() }), apply] });
      } catch (e) { toast(e.message, 'bad'); }
    }
    const importBox = h('div', { class: 'studio-import-result', 'aria-live': 'polite' });
    const fileInput = h('input', { type: 'file', accept: '.aasx,.json', id: 'aas-upload', class: 'studio-file-input', onchange: e => inspectFile(e.target.files[0]) });
    async function inspectFile(file) {
      if (!file) return;
      const epoch = ++importEpoch; importResult = null;
      if (file.size > 3 * 1024 * 1024) { importBox.replaceChildren(note('파일 크기는 3MB 이하여야 합니다.', 'amber')); return; }
      importBox.replaceChildren(note('패키지 구조와 수집 프로필을 읽고 있습니다…'));
      try {
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.')); reader.readAsDataURL(file);
        });
        const result = await api('POST', '/api/aas/import', { filename: file.name, content });
        if (!active || epoch !== importEpoch) return;
        importResult = result;
        const shellChoice = h('select', { 'aria-label': '매핑할 설비 선택' }, result.shells.map(s => h('option', { value: s.id }, s.name)));
        importBox.replaceChildren(h('div', { class: 'studio-import-heading' }, h('strong', null, result.filename),
          h('span', { class: 'studio-chip' }, 'AAS ' + result.shells.length + ' · 서브모델 ' + result.submodels.length)),
          h('p', null, result.message), h('p', { class: 'studio-hint' }, result.validation),
          h('details', { class: 'studio-details' }, h('summary', null, '파일 구성과 SHA-256 확인'),
            h('ul', null, result.submodels.map(s => h('li', null, s.name))), h('code', { class: 'studio-hash' }, result.sha256)),
          result.project ? btn('매핑을 초안으로 가져오기', { icon: 'upload', onclick: async () => {
            if (await confirmBox('현재 초안을 업로드한 설비 정보와 매핑으로 바꿉니다. 적용 전 검토 화면에서 수정할 수 있습니다.', { title: '초안 가져오기', ok: '가져오기' })) {
              project = JSON.parse(JSON.stringify(importResult.project)); changed(); go(3);
            }
          } }) : h('div', { class: 'studio-manual-import' }, shellChoice, btn('선택한 설비 직접 매핑', { onclick: async () => {
            if (!await confirmBox('선택한 AAS의 고유 식별자와 이름을 초안으로 가져옵니다. 제조사·모델·통신 주소는 직접 입력해야 합니다. 현재 초안을 바꿉니다.', { title: '외부 설비 가져오기', ok: '매핑 시작' })) return;
            const shell = result.shells.find(s => s.id === shellChoice.value);
            const freshId = () => 'urn:uuid:' + crypto.randomUUID();
            project = { schema_version: 1, asset: { name: shell.name, aas_id: shell.id, asset_id: shell.asset_id || freshId(), manufacturer: '', model: '', serial: '', location: '', purpose: '설비 상태 모니터링' },
              connection: { protocol: 'unknown', host: '', port: 502, unit: 1, ethernet: 'unknown', signal: 'unknown', channels: 1, period_ms: 1000 }, tags: [] };
            changed(); go(0);
          } })));
      } catch (e) { if (active && epoch === importEpoch) importBox.replaceChildren(note(e.message, 'amber')); }
      finally { fileInput.value = ''; }
    }
    async function example() {
      if (dirty || project.asset.name || project.tags.length) {
        if (!await confirmBox('현재 초안을 가상 FC-5000 예제로 바꿉니다. 필요한 초안은 AASX로 다운로드한 뒤 진행하세요.', { title: '예제 불러오기', ok: '예제 사용' })) return;
      }
      const uuid = () => 'urn:uuid:' + crypto.randomUUID();
      project = { schema_version: 1,
        asset: { name: '1라인 냉각수 유량계', manufacturer: '데모 제조사', model: 'FC-5000 (가상)', serial: 'DEMO-001', location: 'A동 · 생산 1라인', purpose: '냉각수 유량 모니터링', asset_id: uuid(), aas_id: uuid() },
        connection: { protocol: 'modbus_tcp', host: '127.0.0.1', port: 5023, unit: 1, ethernet: 'yes', signal: 'plc', channels: 1, period_ms: 1000 },
        tags: [{ name: 'FlowRate', address: '40001', type: 'f32', unit: 'L/min', area: 'holding', word_order: 'big', factor: 1, offset: 0, semantic_id: '' }] };
      changed(); go(0); toast('가상 장치 예제입니다. 수집하려면 대시보드에서 데모 장치를 켜세요.');
    }
    async function start() {
      try {
        const doc = await api('GET', '/api/aas/project');
        if (!active) return;
        project = doc.project; revision = doc.revision;
        saveText.textContent = doc.updated_at ? '이 PC에 저장된 초안 복원됨' : '새 초안 · 입력하면 자동 저장';
        const upload = h('label', { for: 'aas-upload', class: 'studio-upload-label' }, icon('upload', 17), h('strong', null, 'AASX 파일 가져오기'), h('span', null, '또는 여기에 놓으세요 · AASX / JSON · 최대 3MB'));
        const drop = h('section', { class: 'studio-upload', 'aria-label': '기존 AASX 파일 업로드',
          ondragover: e => { e.preventDefault(); drop.classList.add('dragging'); }, ondragleave: () => drop.classList.remove('dragging'),
          ondrop: e => { e.preventDefault(); drop.classList.remove('dragging'); if (e.dataTransfer.files.length !== 1) { importBox.replaceChildren(note('파일을 한 개씩 올려주세요.', 'amber')); return; } inspectFile(e.dataTransfer.files[0]); }
        }, fileInput, upload, importBox);
        root.append(h('div', { class: 'studio-topline' }, h('span', null, 'WORKSPACE / DIGITAL TWIN'), h('div', { class: 'studio-save-group' }, saveText,
          btn('새 설비', { size: 'sm', icon: 'plus', onclick: async () => {
            if (!await confirmBox('현재 초안을 새 설비 초안으로 바꿉니다. 계속 사용할 정보는 먼저 AASX 파일로 다운로드하세요. 이미 적용한 수집 설정은 유지됩니다.', { title: '새 설비 등록', ok: '새 초안 만들기' })) return;
            const freshId = () => 'urn:uuid:' + crypto.randomUUID();
            project = { schema_version: 1, asset: { name: '', manufacturer: '', model: '', serial: '', location: '', purpose: '설비 상태 모니터링', aas_id: freshId(), asset_id: freshId() },
              connection: { protocol: 'unknown', host: '', port: 502, unit: 1, ethernet: 'unknown', signal: 'unknown', channels: 1, period_ms: 1000 }, tags: [] };
            importResult = null; importBox.replaceChildren(); changed(); go(0);
          } }),
          btn('다시 저장', { size: 'sm', onclick: () => { dirty = true; save().catch(() => {}); } }))),
          h('section', { class: 'studio-hero' }, h('div', null, h('span', { class: 'studio-eyebrow' }, '현장의 설비를, 활용할 수 있는 데이터로'),
            h('h1', null, '설비의 디지털 전환, ', h('br'), h('span', null, 'AASX 하나로 시작하세요.')),
            h('p', null, '복잡한 구조 대신 익숙한 설비 정보부터.', h('br'), '파일 생성부터 수집 준비까지 한 흐름으로 연결합니다.'),
            h('div', { class: 'studio-hero-actions' }, btn('예제로 둘러보기', { onclick: example }), h('span', null, '프로그램 설치 추가 없이 · 로컬 작업 공간'))),
            h('div', { class: 'studio-hero-diagram', 'aria-label': '설비 정보를 AASX로 정리하고 수집에 연결하는 흐름' },
              h('div', { class: 'studio-schema-top' }, h('span', null, 'YOUR ASSET'), h('small', null, '01')),
              h('div', { class: 'studio-schema-block' }, icon('plug', 21), h('span', null, '현장의 설비'), h('small', null, 'PLC · SENSOR · I/O')),
              h('div', { class: 'studio-schema-line' }),
              h('div', { class: 'studio-schema-file' }, h('span', null, 'AASX'), h('small', null, '설비 정보 + 수집 프로필'), icon('check', 19)),
              h('div', { class: 'studio-schema-line' }), h('div', { class: 'studio-schema-end' }, h('span', null, '데이터 수집'), h('span', null, '구성 제안')))),
          drop, h('div', { class: 'studio-workspace-head' }, h('h2', null, '설비 등록 워크스페이스'), h('span', null, '입력한 내용은 이 PC에 자동 저장됩니다')),
          stepper, h('div', { class: 'studio-layout' }, workspace, aside),
          h('div', { class: 'studio-bottomline' }, h('span', null, 'AASX STUDIO / v0.4'), h('span', null, '표준 파일 생성 → 매핑 점검 → 현장 검증 → 수집')));
        render();
      } catch (e) { if (active) root.append(note(e.message, 'amber'), btn('다시 불러오기', { onclick: () => { root.replaceChildren(); start(); } })); }
    }
    const beforeUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    start();
    return () => { active = false; importEpoch++; reportEpoch++; clearTimeout(timer); if (dirty) save().catch(() => {}); window.removeEventListener('beforeunload', beforeUnload); };
  };
})();
