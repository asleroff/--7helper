import { DEFAULT_CONFIG, loadConfig } from '../shared/config.js';

const els = {
  pointBadge: document.getElementById('pointBadge'),
  btnRefreshPoint: document.getElementById('btnRefreshPoint'),
  btnCollect: document.getElementById('btnCollect'),
  tabHome: document.getElementById('tabHome'),
  tabGiveout: document.getElementById('tabGiveout'),
  tabReports: document.getElementById('tabReports'),
  panelHome: document.getElementById('panelHome'),
  panelGiveout: document.getElementById('panelGiveout'),
  panelReports: document.getElementById('panelReports'),
  machineTime: document.getElementById('machineTime'),
  btnMachineNow: document.getElementById('btnMachineNow'),
  btnMachineSend: document.getElementById('btnMachineSend'),
  machinePreview: document.getElementById('machinePreview'),
  machineStatus: document.getElementById('machineStatus'),
  returnDate: document.getElementById('returnDate'),
  returnDriver: document.getElementById('returnDriver'),
  returnKindReturns: document.getElementById('returnKindReturns'),
  returnKindZasyl: document.getElementById('returnKindZasyl'),
  returnKindTare: document.getElementById('returnKindTare'),
  returnFormedFrom: document.getElementById('returnFormedFrom'),
  returnFormedTo: document.getElementById('returnFormedTo'),
  returnHanded: document.getElementById('returnHanded'),
  btnReturnPhone: document.getElementById('btnReturnPhone'),
  returnQrHint: document.getElementById('returnQrHint'),
  returnQr: document.getElementById('returnQr'),
  returnPhotoHint: document.getElementById('returnPhotoHint'),
  returnPhotoList: document.getElementById('returnPhotoList'),
  returnViewer: document.getElementById('returnViewer'),
  returnViewerImg: document.getElementById('returnViewerImg'),
  returnViewerClose: document.getElementById('returnViewerClose'),
  returnPreview: document.getElementById('returnPreview'),
  btnReturnNow: document.getElementById('btnReturnNow'),
  btnReturnSend: document.getElementById('btnReturnSend'),
  returnStatus: document.getElementById('returnStatus'),
  status: document.getElementById('status'),
  progress: document.getElementById('progress'),
  choiceSection: document.getElementById('choiceSection'),
  carriageChoices: document.getElementById('carriageChoices'),
  checklistSection: document.getElementById('checklistSection'),
  checklist: document.getElementById('checklist'),
  warnings: document.getElementById('warnings'),
  previewSection: document.getElementById('previewSection'),
  previewText: document.getElementById('previewText'),
  editFields: document.getElementById('editFields'),
  btnResetDraft: document.getElementById('btnResetDraft'),
  btnSend: document.getElementById('btnSend'),
  autoSend: document.getElementById('autoSend'),
  autoSendChat: document.getElementById('autoSendChat'),
  senderUsername: document.getElementById('senderUsername'),
  linkStatus: document.getElementById('linkStatus'),
  linkForm: document.getElementById('linkForm'),
  btnLinkCode: document.getElementById('btnLinkCode'),
  linkCodeWrap: document.getElementById('linkCodeWrap'),
  linkCode: document.getElementById('linkCode'),
  btnLinkConfirm: document.getElementById('btnLinkConfirm'),
  btnUnlink: document.getElementById('btnUnlink'),
  linkMessage: document.getElementById('linkMessage'),
  sendStatus: document.getElementById('sendStatus'),
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  apiToken: document.getElementById('apiToken'),
  pageSettleMs: document.getElementById('pageSettleMs'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  settingsStatus: document.getElementById('settingsStatus'),
};

let currentDraft = null;
let originalDraft = null;
let draftEdited = false;
let currentPoint = '';
let telegramLink = { linked: false, username: '', token: '' };
let phoneToken = '';
let phoneCount = 0;
let phonePhotos = [];
let phoneTimer = 0;

const EDIT_FIELDS = [
  ['transport_number', 'Номер перевозки', 'text', true],
  ['transport_date', 'Дата', 'text', true],
  ['closing_time', 'Время', 'text', true],
  ['accepted_total', 'Принято', 'number', false],
  ['tya', 'ТЯ', 'number', false],
  ['ktya', 'КТЯ', 'number', false],
  ['shortage', 'Недостачи', 'number', false],
  ['excess', 'Излишки', 'number', false],
  ['zasyl', 'Засылы', 'number', false],
  ['issued', 'Выдано', 'number', false],
  ['leftover', 'Остатки', 'number', false],
];

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
    `1) ТЯ: ${dash(c.tya)}`,
    `2) КТЯ: ${dash(c.ktya)}`,
    `3) Недостачи: ${dash(c.shortage)}`,
    `4) Излишки: ${dash(c.excess)}`,
    `5) Засылы: ${dash(c.zasyl)}`,
    '',
    `Выдано: ${dash(c.issued)} ед.`,
    '',
    `Остатки на складе: ${dash(c.leftover)} ед.`,
    '',
    'ПП - закрыто.',
  ].join('\n');
}

function isLinked() {
  return Boolean(
    telegramLink.linked &&
      telegramLink.token &&
      /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramLink.username)
  );
}

function chatSignature() {
  if (!isLinked()) return '';
  return `\nОтчет от: @${telegramLink.username}\nС помощью @plus7helper_bot`;
}

function syncChatAccess() {
  const linked = isLinked();
  els.btnCollect.disabled = !linked;
  els.autoSend.disabled = !linked;
  els.btnMachineSend.disabled = !linked;
  els.btnMachineNow.disabled = !linked;
  els.machineTime.disabled = !linked;
  els.autoSendChat.disabled = !linked;
  if (!linked && els.autoSend.checked) {
    els.autoSend.checked = false;
    chrome.storage.sync.set({ autoSend: false });
  }
  if (!linked && els.autoSendChat.checked) {
    els.autoSendChat.checked = false;
    chrome.storage.sync.set({ autoSendChat: false });
  }
  syncSendButton();
  renderMachinePreview();
}

function renderLink() {
  const linked = telegramLink.linked && telegramLink.username;
  els.linkForm.hidden = Boolean(linked);
  els.btnUnlink.hidden = !linked;
  els.linkStatus.textContent = linked
    ? `Привязан: @${telegramLink.username}`
    : 'Сначала привяжите Telegram — без этого расширение не работает.';
  els.linkStatus.className = linked ? 'status ok' : 'hint';
  syncChatAccess();
}

async function saveLink() {
  await chrome.storage.sync.set({
    telegramLinked: telegramLink.linked,
    senderUsername: telegramLink.username,
    telegramLinkToken: telegramLink.token,
  });
  renderLink();
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
      if (els.autoSendChat.checked || els.autoSend.checked) {
        await sendDraft();
        return;
      }
      setStatus('Перевозка выбрана', 'ok');
    });
    els.carriageChoices.appendChild(btn);
  });
}

function refreshPreview() {
  if (!currentDraft) return;
  els.previewText.textContent = formatReportText(currentDraft) + chatSignature();
}

function renderEditFields(draft) {
  const closing = draft.closing || {};
  els.editFields.innerHTML = '';
  for (const [key, label, kind, wide] of EDIT_FIELDS) {
    const wrap = document.createElement('label');
    wrap.className = wide ? 'edit-field wide' : 'edit-field';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = key;
    input.dataset.kind = kind;
    input.autocomplete = 'off';
    if (kind === 'number') input.inputMode = 'numeric';
    const value = closing[key];
    input.value = value == null ? '' : String(value);
    wrap.append(title, input);
    els.editFields.appendChild(wrap);
  }
}

function markChecklist(key) {
  const checklist = currentDraft?.meta?.checklist;
  if (!checklist) return;
  const closing = currentDraft.closing || {};
  if (key === 'tya' || key === 'ktya') {
    checklist.tare = closing.tya != null && closing.ktya != null;
  } else if (key === 'issued' || key === 'leftover' || key === 'zasyl') {
    checklist[key] = closing[key] != null;
  } else if (key === 'transport_number') {
    checklist.carriage = Boolean(closing.transport_number);
  }
}

function cloneDraft(draft) {
  return JSON.parse(JSON.stringify(draft));
}

function resetDraft() {
  if (!originalDraft) return;
  const keepSend = !els.btnSend.hidden && els.autoSendChat.checked;
  currentDraft = cloneDraft(originalDraft);
  draftEdited = keepSend;
  els.btnResetDraft.disabled = true;
  renderChecklist(currentDraft);
  renderEditFields(currentDraft);
  refreshPreview();
  syncSendButton();
  chrome.storage.session.set({ lastDraft: currentDraft });
  els.sendStatus.textContent = 'Черновик возвращён к собранным данным.';
  els.sendStatus.className = 'status ok';
}

function applyFieldEdit(input) {
  if (!currentDraft) return;
  const key = input.dataset.field;
  const raw = input.value.trim();
  currentDraft.closing = currentDraft.closing || {};
  if (input.dataset.kind === 'number') {
    if (raw === '') currentDraft.closing[key] = null;
    else if (!/^\d+$/.test(raw)) return;
    else currentDraft.closing[key] = Number(raw);
  } else {
    const text = key === 'transport_number' ? raw.replace(/^#/, '') : raw;
    currentDraft.closing[key] = text === '' ? null : text;
  }
  draftEdited = true;
  els.btnResetDraft.disabled = false;
  markChecklist(key);
  renderChecklist(currentDraft);
  refreshPreview();
  syncSendButton();
  chrome.storage.session.set({ lastDraft: currentDraft });
}

function showDraft(draft) {
  originalDraft = cloneDraft(draft);
  currentDraft = draft;
  draftEdited = false;
  els.btnResetDraft.disabled = true;
  els.pointBadge.textContent = `ПП: ${draft.point_number}`;
  els.pointBadge.className = 'badge ok';
  renderChecklist(draft);
  renderChoices(draft);
  els.checklistSection.hidden = false;
  els.previewSection.hidden = false;
  renderEditFields(draft);
  refreshPreview();
  els.btnSend.disabled = false;
  els.sendStatus.textContent = '';
  syncSendButton();
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
  currentPoint = String(point.point_number);
  renderMachinePreview();
  renderReturnPreview();
  suggestReturnDriver();
  setStatus(`Текущий пункт: ПП_${point.point_number}`);
}

async function collect() {
  if (!isLinked()) {
    setStatus('Сначала привяжите Telegram.', 'error');
    return;
  }
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
    if (els.autoSendChat.checked || els.autoSend.checked) {
      const sent = await sendDraft();
      if (sent && warnCount) {
        const where = els.autoSendChat.checked ? 'Отчёт отправлен в чат' : 'Черновик отправлен';
        setStatus(`${where}. Предупреждений: ${warnCount}. Проверьте чеклист.`, '');
      }
      return;
    }
    setStatus(
      warnCount
        ? `Собрано с предупреждениями (${warnCount}). Проверьте чеклист.`
        : 'Черновик собран.',
      warnCount ? '' : 'ok'
    );
  } catch (e) {
    setStatus(String(e?.message || e), 'error');
  } finally {
    els.btnCollect.disabled = !isLinked();
    els.progress.classList.add('hidden');
  }
}

function missingDraftFields(draft) {
  const closing = draft?.closing || {};
  const labels = [
    ['transport_number', 'номер перевозки'],
    ['transport_date', 'дата перевозки'],
    ['closing_time', 'время закрытия'],
    ['accepted_total', 'принято'],
    ['tya', 'ТЯ'],
    ['ktya', 'КТЯ'],
    ['shortage', 'недостачи'],
    ['excess', 'излишки'],
    ['zasyl', 'засылы'],
    ['issued', 'выдано'],
    ['leftover', 'остатки'],
  ];
  return labels
    .filter(([key]) => closing[key] == null || closing[key] === '')
    .map(([, label]) => label);
}

async function sendDraft(forceChat = false) {
  if (!currentDraft) return false;
  if (!isLinked()) {
    els.sendStatus.textContent = 'Сначала привяжите Telegram.';
    els.sendStatus.className = 'status error';
    return false;
  }
  const gaps = missingDraftFields(currentDraft);
  if (gaps.length) {
    els.sendStatus.textContent = `Пока нельзя отправить. Не хватает: ${gaps.join(', ')}. Если перевозок несколько — выберите одну.`;
    els.sendStatus.className = 'status error';
    return false;
  }
  const publish = forceChat === true || els.autoSendChat.checked;
  if (publish && !isLinked()) {
    els.sendStatus.textContent = 'Сначала привяжите Telegram. Без этого отчёт в чат не уйдёт.';
    els.sendStatus.className = 'status error';
    return false;
  }
  els.btnSend.disabled = true;
  els.sendStatus.textContent = publish ? 'Отправляю в чат…' : 'Отправка…';
  els.sendStatus.className = 'status';
  const res = await bg('SEND_DRAFT', {
    draft: currentDraft,
    publish,
    linkToken: publish ? telegramLink.token : '',
  });
  if (!res?.ok) {
    els.sendStatus.textContent = res?.error || 'Ошибка API';
    els.sendStatus.className = 'status error';
    els.btnSend.disabled = false;
    return false;
  }
  els.sendStatus.textContent = publish
    ? `Отчёт ушёл в чат ПП ${currentDraft.point_number} от @${telegramLink.username}.`
    : `Сохранено на API для ПП ${currentDraft.point_number}. В чат ещё не ушло — только черновик.`;
  els.sendStatus.className = 'status ok';
  els.btnSend.disabled = false;
  if (publish) {
    draftEdited = false;
    syncSendButton();
  }
  return true;
}

async function loadSettings() {
  const cfg = await loadConfig();
  els.apiBaseUrl.value = cfg.apiBaseUrl;
  els.apiToken.value = cfg.apiToken;
  els.pageSettleMs.value = cfg.pageSettleMs;
  els.autoSend.checked = Boolean(cfg.autoSend);
  els.autoSendChat.checked = Boolean(cfg.autoSendChat);
  telegramLink = {
    linked: Boolean(cfg.telegramLinked && cfg.telegramLinkToken && cfg.senderUsername),
    username: cfg.senderUsername || '',
    token: cfg.telegramLinkToken || '',
  };
  els.senderUsername.value = telegramLink.linked ? telegramLink.username : cfg.senderUsername || '';
  syncSendButton();
  renderLink();
}

function syncSendButton() {
  const manual = !els.autoSendChat.checked || draftEdited;
  els.btnSend.hidden = !manual;
  els.btnSend.textContent = 'Отправить в чат';
  if (els.btnSend.parentElement) els.btnSend.parentElement.hidden = !manual;
  refreshPreview();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    apiBaseUrl: els.apiBaseUrl.value.trim() || DEFAULT_CONFIG.apiBaseUrl,
    apiToken: els.apiToken.value.trim() || DEFAULT_CONFIG.apiToken,
    pageSettleMs: Number(els.pageSettleMs.value) || DEFAULT_CONFIG.pageSettleMs,
    autoSend: els.autoSend.checked,
    autoSendChat: els.autoSendChat.checked,
    senderUsername: telegramLink.username,
    telegramLinked: telegramLink.linked,
    telegramLinkToken: telegramLink.token,
  });
  els.settingsStatus.textContent = 'Сохранено';
  els.settingsStatus.className = 'status ok';
}

els.btnRefreshPoint.addEventListener('click', refreshPoint);
els.btnCollect.addEventListener('click', collect);
els.btnSend.addEventListener('click', () => sendDraft(true));
els.editFields.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement) applyFieldEdit(event.target);
});
els.btnResetDraft.addEventListener('click', resetDraft);
els.btnSaveSettings.addEventListener('click', saveSettings);

function showTab(name) {
  const panels = {
    home: els.panelHome,
    giveout: els.panelGiveout,
    reports: els.panelReports,
  };
  const tabs = {
    home: els.tabHome,
    giveout: els.tabGiveout,
    reports: els.tabReports,
  };
  for (const key of Object.keys(panels)) {
    panels[key].hidden = key !== name;
    tabs[key].classList.toggle('active', key === name);
  }
}

function machineClock() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function renderMachinePreview() {
  const time = els.machineTime.value.trim() || '—'
  const point = currentPoint || '—'
  const sign = isLinked() ? `\nОтчет от: @${telegramLink.username}\nС помощью @plus7helper_bot` : ''
  els.machinePreview.textContent = `ПП_${point}\nПриехала машина\nВремя: ${time}${sign}`
}

async function sendMachine() {
  if (!isLinked()) {
    els.machineStatus.textContent = 'Сначала привяжите Telegram.'
    els.machineStatus.className = 'status error'
    return
  }
  const time = els.machineTime.value.trim()
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    els.machineStatus.textContent = 'Время нужно в виде ЧЧ:ММ, например 14:30.'
    els.machineStatus.className = 'status error'
    return
  }
  if (!currentPoint) {
    await refreshPoint()
  }
  if (!/^\d{3,6}$/.test(currentPoint)) {
    els.machineStatus.textContent = 'Не вижу номер ПП. Откройте Турбо и нажмите «Обновить ПП».'
    els.machineStatus.className = 'status error'
    return
  }
  els.btnMachineSend.disabled = true
  els.machineStatus.textContent = 'Отправляю…'
  els.machineStatus.className = 'status'
  const res = await bg('SEND_MACHINE', {
    pointNumber: currentPoint,
    time,
    linkToken: telegramLink.token,
  })
  els.btnMachineSend.disabled = !isLinked()
  if (!res?.ok) {
    els.machineStatus.textContent = res?.error || 'Не удалось отправить'
    els.machineStatus.className = 'status error'
    return
  }
  els.machineStatus.textContent = `В чат ПП ${currentPoint} отправлено: машина в ${time}.`
  els.machineStatus.className = 'status ok'
}

function todayShort() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function returnKinds() {
  const kinds = [];
  if (els.returnKindReturns.checked) kinds.push(['returns', 'возвраты']);
  if (els.returnKindZasyl.checked) kinds.push(['zasyl', 'засылы']);
  if (els.returnKindTare.checked) kinds.push(['tare', 'Тарные ящики']);
  return kinds;
}

function renderReturnPreview() {
  const point = currentPoint || '—';
  const kinds = returnKinds().map((item) => item[1]);
  const handedLine = kinds.length ? `Отдали ${kinds.join(', ')}` : 'Отдали —';
  const formedFrom = els.returnFormedFrom.value.trim() || '—';
  const formedTo = els.returnFormedTo.value.trim() || '—';
  const handed = els.returnHanded.value.trim() || '—';
  els.returnPreview.textContent = [
    `ПП_${point}`,
    els.returnDate.value.trim() || '—',
    `Водитель ${els.returnDriver.value.trim() || '—'}`,
    handedLine,
    `Время формирования: ${formedFrom}-${formedTo}`,
    `Время передачи водителю: ${handed}`,
  ].join('\n');
}

async function apiCall(path, payload) {
  const config = await loadConfig();
  const res = await fetch(`${config.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(body?.error || `API ${res.status}`);
  return body;
}

async function suggestReturnDriver() {
  if (!/^\d{3,6}$/.test(currentPoint) || els.returnDriver.value.trim()) return;
  try {
    const body = await apiCall(`/api/driver/${currentPoint}`);
    const name = (body.drivers || []).filter(Boolean).join(', ');
    if (name && !els.returnDriver.value.trim()) {
      els.returnDriver.value = name;
      renderReturnPreview();
    }
  } catch {
    /* список водителей необязателен */
  }
}

async function sendReturns() {
  if (!isLinked()) {
    els.returnStatus.textContent = 'Сначала привяжите Telegram.';
    els.returnStatus.className = 'status error';
    return;
  }
  if (!/^\d{3,6}$/.test(currentPoint)) {
    await refreshPoint();
  }
  if (!/^\d{3,6}$/.test(currentPoint)) {
    els.returnStatus.textContent = 'Не вижу номер ПП. Откройте Турбо и нажмите «Обновить ПП».';
    els.returnStatus.className = 'status error';
    return;
  }
  if (!phoneCount) {
    els.returnStatus.textContent = 'Сначала прикрепите фото с телефона.';
    els.returnStatus.className = 'status error';
    return;
  }
  els.btnReturnSend.disabled = true;
  els.returnStatus.textContent = 'Отправляю в тему…';
  els.returnStatus.className = 'status';
  try {
    await apiCall('/api/returns', {
      point_number: currentPoint,
      date: els.returnDate.value.trim(),
      driver: els.returnDriver.value.trim(),
      kinds: returnKinds().map((item) => item[0]),
      formed_from: els.returnFormedFrom.value.trim(),
      formed_to: els.returnFormedTo.value.trim(),
      handed_at: els.returnHanded.value.trim(),
      photos: [],
      photo_token: phoneToken,
      link_token: telegramLink.token,
    });
    els.returnStatus.textContent = `Отправлено в тему: ПП_${currentPoint}.`;
    els.returnStatus.className = 'status ok';
  } catch (error) {
    els.returnStatus.textContent = error?.message || 'Не удалось отправить';
    els.returnStatus.className = 'status error';
  } finally {
    els.btnReturnSend.disabled = false;
  }
}

function maskClock(input) {
  let digits = input.value.replace(/\D/g, '').slice(0, 4);
  const growing = input.value.length >= (input.dataset.raw || '').length;
  if (digits.length === 1 && growing && '3456789'.includes(digits)) {
    digits = `0${digits}`;
  } else if (digits.length >= 2 && Number(digits.slice(0, 2)) > 23) {
    digits = `0${digits}`.slice(0, 4);
  }
  const next = digits.length >= 3 || (digits.length === 2 && growing)
    ? `${digits.slice(0, 2)}:${digits.slice(2)}`
    : digits;
  input.dataset.raw = next;
  if (input.value !== next) input.value = next;
}

els.returnDate.value = todayShort();
renderReturnPreview();
[
  els.returnDate,
  els.returnDriver,
  els.returnKindReturns,
  els.returnKindZasyl,
  els.returnKindTare,
].forEach((input) => input.addEventListener('input', renderReturnPreview));
[els.returnFormedFrom, els.returnFormedTo, els.returnHanded].forEach((input) => {
  input.addEventListener('input', () => {
    maskClock(input);
    renderReturnPreview();
  });
});
function fileWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
  return 'файлов';
}

function renderPhotoHint() {
  els.returnPhotoHint.textContent = phoneCount
    ? `Прикреплено ${phoneCount} ${fileWord(phoneCount)}`
    : 'Пока нет фото.';
  els.returnPhotoList.replaceChildren();
  for (const photo of phonePhotos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    const img = document.createElement('img');
    img.src = `data:image/jpeg;base64,${photo.data}`;
    img.alt = 'Фото акта';
    img.addEventListener('click', () => {
      els.returnViewerImg.src = img.src;
      els.returnViewer.hidden = false;
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-delete';
    remove.textContent = '×';
    remove.title = 'Удалить';
    remove.addEventListener('click', () => deletePhonePhoto(photo.id));
    tile.append(img, remove);
    els.returnPhotoList.append(tile);
  }
}

async function deletePhonePhoto(photoId) {
  if (!phoneToken) return;
  try {
    const body = await apiCall(`/api/returns/photos/${phoneToken}/delete`, { id: photoId });
    phonePhotos = phonePhotos.filter((photo) => photo.id !== photoId);
    phoneCount = body.count ?? phonePhotos.length;
    if (els.returnViewerImg.src && !phonePhotos.some((photo) => `data:image/jpeg;base64,${photo.data}` === els.returnViewerImg.src)) {
      els.returnViewer.hidden = true;
    }
    renderPhotoHint();
  } catch (error) {
    els.returnStatus.textContent = error?.message || 'Не удалось удалить фото';
    els.returnStatus.className = 'status error';
  }
}

async function openPhoneUpload() {
  if (!isLinked()) {
    els.returnStatus.textContent = 'Сначала привяжите Telegram.';
    els.returnStatus.className = 'status error';
    return;
  }
  els.btnReturnPhone.disabled = true;
  els.returnStatus.textContent = 'Готовлю код для телефона…';
  els.returnStatus.className = 'status';
  try {
    const body = await apiCall('/api/returns/photos/session', { link_token: telegramLink.token });
    phoneToken = body.token;
    phoneCount = 0;
    phonePhotos = [];
    els.returnQr.innerHTML = body.qr_svg || '';
    els.returnQrHint.hidden = false;
    els.returnQr.hidden = false;
    renderPhotoHint();
    els.returnStatus.textContent = '';
    els.returnStatus.className = 'status';
    clearInterval(phoneTimer);
    phoneTimer = setInterval(async () => {
      if (!phoneToken) return;
      try {
        const fresh = await apiCall(`/api/returns/photos/${phoneToken}`);
        const count = fresh.count || 0;
        if (count !== phoneCount) {
          phoneCount = count;
          if (count) {
            const files = await apiCall(`/api/returns/photos/${phoneToken}/files`);
            phonePhotos = files.photos || [];
          } else {
            phonePhotos = [];
          }
          renderPhotoHint();
        }
      } catch {
        /* ссылка ещё жива, просто нет ответа */
      }
    }, 2000);
  } catch (error) {
    els.returnStatus.textContent = error?.message || 'Не удалось сделать код';
    els.returnStatus.className = 'status error';
  } finally {
    els.btnReturnPhone.disabled = false;
  }
}

els.btnReturnPhone.addEventListener('click', openPhoneUpload);
els.returnViewerClose.addEventListener('click', () => {
  els.returnViewer.hidden = true;
});
els.returnViewer.addEventListener('click', (event) => {
  if (event.target === els.returnViewer) els.returnViewer.hidden = true;
});
els.btnReturnNow.addEventListener('click', () => {
  els.returnHanded.value = machineClock();
  renderReturnPreview();
});
els.btnReturnSend.addEventListener('click', sendReturns);

els.tabHome.addEventListener('click', () => showTab('home'));
els.tabGiveout.addEventListener('click', () => showTab('giveout'));
els.tabReports.addEventListener('click', () => showTab('reports'));
els.btnMachineNow.addEventListener('click', () => {
  els.machineTime.value = machineClock()
  renderMachinePreview()
})
els.machineTime.addEventListener('input', () => {
  maskClock(els.machineTime);
  renderMachinePreview();
});
els.btnMachineSend.addEventListener('click', sendMachine)
document.querySelectorAll('.fold-head').forEach((button) => {
  button.addEventListener('click', () => {
    const fold = button.closest('.fold');
    const open = fold.classList.toggle('open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});

els.autoSend.addEventListener('change', () => {
  chrome.storage.sync.set({ autoSend: els.autoSend.checked });
});
els.autoSendChat.addEventListener('change', () => {
  if (els.autoSendChat.checked && !isLinked()) {
    els.autoSendChat.checked = false;
    setLinkMessage('Сначала привяжите Telegram. Без этого отчёт в чат не уйдёт.', 'error');
    return;
  }
  chrome.storage.sync.set({ autoSendChat: els.autoSendChat.checked });
  syncSendButton();
});
function typedUsername() {
  return els.senderUsername.value.trim().replace(/^@/, '');
}

function setLinkMessage(text, kind = '') {
  els.linkMessage.textContent = text;
  els.linkMessage.className = `status ${kind}`.trim();
}

els.btnLinkCode.addEventListener('click', async () => {
  const username = typedUsername();
  els.senderUsername.value = username;
  els.btnLinkCode.disabled = true;
  setLinkMessage('Отправляю код в бота…');
  const res = await bg('LINK_CODE', { username });
  els.btnLinkCode.disabled = false;
  if (!res?.ok) {
    setLinkMessage(res?.error || 'Не удалось отправить код', 'error');
    return;
  }
  els.linkCodeWrap.hidden = false;
  els.btnLinkConfirm.hidden = false;
  els.linkCode.focus();
  setLinkMessage('Код отправлен в личку бота. Введите 5 цифр.', 'ok');
});

els.btnLinkConfirm.addEventListener('click', async () => {
  const username = typedUsername();
  const code = els.linkCode.value.trim();
  els.btnLinkConfirm.disabled = true;
  setLinkMessage('Проверяю код…');
  const res = await bg('LINK_CONFIRM', { username, code });
  els.btnLinkConfirm.disabled = false;
  if (!res?.ok) {
    setLinkMessage(res?.error || 'Не удалось привязать', 'error');
    return;
  }
  telegramLink = {
    linked: true,
    username: res.result.username,
    token: res.result.link_token,
  };
  els.linkCode.value = '';
  await saveLink();
  syncSendButton();
  setLinkMessage(`Аккаунт @${telegramLink.username} привязан.`, 'ok');
});

els.btnUnlink.addEventListener('click', async () => {
  telegramLink = { linked: false, username: '', token: '' };
  els.senderUsername.value = '';
  els.linkCode.value = '';
  els.linkCodeWrap.hidden = true;
  els.btnLinkConfirm.hidden = true;
  await saveLink();
  syncSendButton();
  setLinkMessage('Telegram отвязан.');
});

loadSettings().then(refreshPoint);
