import { DEFAULT_CONFIG, loadConfig } from '../shared/config.js';

const els = {
  pointBadge: document.getElementById('pointBadge'),
  btnRefreshPoint: document.getElementById('btnRefreshPoint'),
  btnCollect: document.getElementById('btnCollect'),
  status: document.getElementById('status'),
  progress: document.getElementById('progress'),
  choiceSection: document.getElementById('choiceSection'),
  carriageChoices: document.getElementById('carriageChoices'),
  checklistSection: document.getElementById('checklistSection'),
  checklist: document.getElementById('checklist'),
  warnings: document.getElementById('warnings'),
  previewSection: document.getElementById('previewSection'),
  previewText: document.getElementById('previewText'),
  previewJson: document.getElementById('previewJson'),
  btnSend: document.getElementById('btnSend'),
  sendStatus: document.getElementById('sendStatus'),
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  apiToken: document.getElementById('apiToken'),
  pageSettleMs: document.getElementById('pageSettleMs'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  settingsStatus: document.getElementById('settingsStatus'),
};

let currentDraft = null;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function bg(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function formatReportText(draft) {
  const c = draft.closing || {};
  const dash = (v) => (v == null || v === '' ? '—' : v);
  return [
    `ПП-${draft.point_number}`,
    '',
    `Закрыли перевозку #${dash(c.transport_number)} от ${dash(c.transport_date)}.`,
    '',
    `Закрыли перевозку в ${dash(c.closing_time)}`,
    '',
    `Принято всего: ${dash(c.accepted_total)} ед.`,
    '',
    `ТЯ: ${dash(c.tya)}`,
    '',
    `КТЯ: ${dash(c.ktya)}`,
    '',
    `Недостачи: ${dash(c.shortage)}`,
    '',
    `Излишки: ${dash(c.excess)}`,
    '',
    `Засылы: ${dash(c.zasyl)}`,
    '',
    `Недовоз: ${c.nedovoz == null ? '(вручную в боте)' : c.nedovoz}`,
    '',
    `Выдано: ${dash(c.issued)} ед.`,
    '',
    `Остатки на складе: ${dash(c.leftover)} ед.`,
    '',
    'ПП - закрыто.',
  ].join('\n');
}

function renderChecklist(draft) {
  const cl = draft.meta?.checklist || {};
  const labels = {
    point: 'ПП из шапки',
    issued: 'Выдано',
    leftover: 'Остатки',
    tare: 'ТЯ / КТЯ',
    carriage: 'Перевозка',
    zasyl: 'Засылы',
  };
  els.checklist.innerHTML = '';
  for (const [key, label] of Object.entries(labels)) {
    const li = document.createElement('li');
    const ok = Boolean(cl[key]);
    li.className = ok ? 'ok' : 'bad';
    li.textContent = `${label}: ${ok ? 'ок' : 'нет'}`;
    els.checklist.appendChild(li);
  }

  els.warnings.innerHTML = '';
  for (const w of draft.meta?.warnings || []) {
    const li = document.createElement('li');
    li.textContent = w;
    els.warnings.appendChild(li);
  }
  els.checklistSection.hidden = false;
}

function renderChoices(draft) {
  const choices = draft.meta?.carriage_choices || [];
  els.carriageChoices.innerHTML = '';
  if (choices.length <= 1) {
    els.choiceSection.hidden = true;
    return;
  }
  els.choiceSection.hidden = false;
  choices.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice';
    if (c.carriage_long_id && c.carriage_long_id === draft.meta?.carriage_long_id) {
      btn.classList.add('active');
    }
    btn.textContent = `#${c.transport_number || '?'} · ${c.closing_time || '—'} · принято ${c.accepted ?? '—'} · ${c.row_preview || ''}`.slice(
      0,
      180
    );
    btn.addEventListener('click', async () => {
      setStatus('Подставляю выбранную перевозку и засылы…');
      els.btnCollect.disabled = true;
      const res = await bg('APPLY_CARRIAGE_CHOICE', {
        carriageLongId: c.carriage_long_id,
        transportNumber: c.transport_number,
      });
      els.btnCollect.disabled = false;
      if (!res?.ok) {
        setStatus(res?.error || 'Ошибка выбора перевозки', 'error');
        return;
      }
      showDraft(res.result);
      setStatus('Перевозка выбрана', 'ok');
    });
    els.carriageChoices.appendChild(btn);
  });
}

function showDraft(draft) {
  currentDraft = draft;
  els.pointBadge.textContent = `ПП: ${draft.point_number}`;
  els.pointBadge.className = 'badge ok';
  renderChecklist(draft);
  renderChoices(draft);
  els.previewText.textContent = formatReportText(draft);
  els.previewJson.textContent = JSON.stringify(draft, null, 2);
  els.previewSection.hidden = false;
  els.btnSend.disabled = false;
  els.sendStatus.textContent = '';
}

async function refreshPoint() {
  setStatus('Читаю ПП из шапки Турбо ПВЗ…');
  let res;
  try {
    res = await bg('GET_POINT_ONLY');
  } catch (e) {
    els.pointBadge.textContent = 'ПП: ?';
    els.pointBadge.className = 'badge muted';
    setStatus(String(e?.message || e), 'error');
    return;
  }
  if (!res) {
    els.pointBadge.textContent = 'ПП: ?';
    els.pointBadge.className = 'badge muted';
    setStatus('Нет ответа от расширения — перезагрузите вкладку Турбо ПВЗ (F5) и нажмите снова.', 'error');
    return;
  }
  if (!res?.ok) {
    els.pointBadge.textContent = 'ПП: ?';
    els.pointBadge.className = 'badge muted';
    setStatus(res?.error || 'Не удалось прочитать ПП', 'error');
    return;
  }
  const point = res.result;
  if (!point?.ok) {
    els.pointBadge.textContent = 'ПП: ?';
    els.pointBadge.className = 'badge muted';
    setStatus(
      (point?.error || 'ПП не найден') +
        ' Перезагрузите страницу Турбо (F5), обновите расширение на chrome://extensions и нажмите снова.',
      'error'
    );
    return;
  }
  els.pointBadge.textContent = `ПП: ${point.point_number}`;
  els.pointBadge.className = 'badge ok';
  setStatus(`Текущий пункт: ПП_${point.point_number}`);
}

async function collect() {
  els.btnCollect.disabled = true;
  els.btnSend.disabled = true;
  els.progress.classList.remove('hidden');
  els.progress.textContent =
    'Обход: выдача → остатки → тара → перевозки → засылы. Не переключайте ПП.';
  setStatus('Собираю закрытие…');
  try {
    const res = await bg('COLLECT_CLOSING');
    if (!res?.ok) {
      setStatus(res?.error || 'Ошибка сбора', 'error');
      return;
    }
    showDraft(res.result);
    const warnCount = res.result.meta?.warnings?.length || 0;
    setStatus(
      warnCount
        ? `Собрано с предупреждениями (${warnCount}). Проверьте чеклист.`
        : 'Черновик собран.',
      warnCount ? '' : 'ok'
    );
  } catch (e) {
    setStatus(String(e?.message || e), 'error');
  } finally {
    els.btnCollect.disabled = false;
    els.progress.classList.add('hidden');
  }
}

async function sendDraft() {
  if (!currentDraft) return;
  els.btnSend.disabled = true;
  els.sendStatus.textContent = 'Отправка…';
  els.sendStatus.className = 'status';
  const res = await bg('SEND_DRAFT', { draft: currentDraft });
  if (!res?.ok) {
    els.sendStatus.textContent = res?.error || 'Ошибка API';
    els.sendStatus.className = 'status error';
    els.btnSend.disabled = false;
    return;
  }
  els.sendStatus.textContent = `Сохранено на API для ПП ${currentDraft.point_number}. В чат ещё не ушло — только черновик.`;
  els.sendStatus.className = 'status ok';
  els.btnSend.disabled = false;
}

async function loadSettings() {
  const cfg = await loadConfig();
  els.apiBaseUrl.value = cfg.apiBaseUrl;
  els.apiToken.value = cfg.apiToken;
  els.pageSettleMs.value = cfg.pageSettleMs;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    apiBaseUrl: els.apiBaseUrl.value.trim() || DEFAULT_CONFIG.apiBaseUrl,
    apiToken: els.apiToken.value.trim() || DEFAULT_CONFIG.apiToken,
    pageSettleMs: Number(els.pageSettleMs.value) || DEFAULT_CONFIG.pageSettleMs,
  });
  els.settingsStatus.textContent = 'Сохранено';
  els.settingsStatus.className = 'status ok';
}

els.btnRefreshPoint.addEventListener('click', refreshPoint);
els.btnCollect.addEventListener('click', collect);
els.btnSend.addEventListener('click', sendDraft);
els.btnSaveSettings.addEventListener('click', saveSettings);

loadSettings().then(refreshPoint);
