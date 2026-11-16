import { loadConfig } from '../shared/config.js';

const TURBO_ORIGIN = 'https://turbo-pvz.ozon.ru';

const CONTENT_FILES = [
  'content/selectors.js',
  'content/dom.js',
  'content/counts.js',
  'content/report-page.js',
  'content/tare.js',
  'content/carriages.js',
  'content/zasyl.js',
  'content/messages.js',
];

const PANEL_PATH = 'sidepanel/index.html';

chrome.action.onClicked.addListener(() => {
  openOverlayWindow().catch((err) => console.error('overlay window', err));
});

async function openOverlayWindow() {
  const panelUrl = chrome.runtime.getURL(PANEL_PATH);
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
  const existing = wins.find((win) => win.tabs?.some((tab) => tab.url && tab.url.startsWith(panelUrl)));
  if (existing) {
    try {
      await chrome.windows.update(existing.id, { focused: true, drawAttention: true, alwaysOnTop: true });
    } catch {
      await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
    }
    return;
  }

  let anchor = null;
  try {
    anchor = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  } catch {
    anchor = null;
  }
  const width = 420;
  const height = Math.max(560, Math.min(820, (anchor?.height || 860) - 80));
  const left = Math.max(0, (anchor?.left || 0) + (anchor?.width || 1280) - width - 16);
  const top = Math.max(0, (anchor?.top || 0) + 64);
  const spec = {
    url: panelUrl,
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
  };
  try {
    await chrome.windows.create({ ...spec, alwaysOnTop: true });
  } catch {
    await chrome.windows.create(spec);
  }
}

async function findTurboTab() {
  // tabs.query url pattern: только вид https://host/* (без голого URL и без ...ru/)
  let list = [];
  try {
    list = await chrome.tabs.query({ url: `${TURBO_ORIGIN}/*` });
  } catch (_) {
    list = [];
  }
  if (!list.length) {
    const all = await chrome.tabs.query({});
    list = all.filter((t) => {
      try {
        return Boolean(t.url) && new URL(t.url).hostname === 'turbo-pvz.ozon.ru';
      } catch {
        return false;
      }
    });
  }
  const active = list.find((t) => t.active);
  if (active) return active;
  if (list.length) return list[0];
  return null;
}

async function ensureContentScript(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true;
    } catch (err) {
      lastError = err;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: CONTENT_FILES,
        });
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        return true;
      } catch (injectErr) {
        lastError = injectErr;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Скрипт страницы не запустился');
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Таймаут загрузки вкладки'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
    });
  });
}

function sameDocument(tabUrl, wanted) {
  try {
    const current = new URL(tabUrl);
    const target = new URL(wanted);
    return current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
  } catch {
    return false;
  }
}

function waitForUrl(tabId, url, previousUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawLoading = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(fail);
      fn(value);
    };
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'loading') sawLoading = true;
        if (!sameDocument(tab.url, url)) return;
        const changed = Boolean(tab.url && tab.url !== previousUrl);
        if (tab.status === 'complete' && (changed || sawLoading)) {
          finish(resolve);
        }
      } catch (err) {
        finish(reject, err);
      }
    }, 150);
    const fail = setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (sameDocument(tab.url, url)) finish(resolve);
        else finish(reject, new Error('Таймаут загрузки вкладки'));
      } catch (err) {
        finish(reject, err);
      }
    }, timeoutMs);
  });
}

async function navigateAndReady(tabId, url, settleMs, timeoutMs = 15000) {
  const previous = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForUrl(tabId, url, previous.url, timeoutMs);
  await ensureContentScript(tabId);
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
}

async function send(tabId, message, timeoutMs = 0) {
  await ensureContentScript(tabId);
  const job = chrome.tabs.sendMessage(tabId, message);
  if (!timeoutMs) return job;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Таймаут ответа страницы')), timeoutMs);
  });
  try {
    return await Promise.race([job, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyClosing() {
  return {
    transport_number: null,
    transport_date: null,
    closing_time: null,
    accepted_total: null,
    tya: null,
    ktya: null,
    shortage: null,
    excess: null,
    zasyl: null,
    issued: null,
    leftover: null,
    ozon_shelf: null,
    not_accepted: null,
  };
}

function validClock(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

async function lookupMachineTime(pointNumber) {
  const config = await loadConfig();
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}/api/machine-time/${pointNumber}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return validClock(body?.time) ? body.time : null;
}

async function collectClosing({ selectedCarriageLongId, machineTime } = {}) {
  const config = await loadConfig();
  const settleMs = config.pageSettleMs || 2500;
  const warnings = [];
  const pages = [];
  const checklist = {
    point: false,
    issued: false,
    leftover: false,
    accepted: false,
    not_accepted: false,
    ozon_shelf: false,
    machine: false,
  };

  let tab = await findTurboTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: TURBO_ORIGIN, active: true });
    await waitTabComplete(tab.id);
  }

  const tabId = tab.id;
  await ensureContentScript(tabId);

  const pointRes = await send(tabId, { type: 'GET_POINT' });
  if (!pointRes?.ok) {
    throw new Error(pointRes?.error || 'ПП не прочитан — сбор отменён');
  }
  checklist.point = true;
  const pointNumber = pointRes.point_number;

  const urlsRes = await send(tabId, { type: 'GET_URLS' });
  const urls = urlsRes.urls;
  const today = urlsRes.today;

  const closing = emptyClosing();
  let ozonShelfAvailable = true;
  closing.transport_date = today.displayDate;
  let carriageLongId = selectedCarriageLongId || null;
  let carriageChoices = [];

  // 1) Issued
  try {
    await navigateAndReady(tabId, urls.giveout, settleMs);
    const issued = await send(tabId, { type: 'SCRAPE_FOUND', settleMs: 400 });
    pages.push('giveout');
    if (issued?.ok) {
      closing.issued = issued.value;
      checklist.issued = true;
    } else {
      warnings.push(issued?.error || 'Выдача: не собрано');
    }
  } catch (e) {
    warnings.push(`Выдача: ${e.message}`);
  }

  // Re-check PP after navigation (profile switch mid-run)
  const point2 = await send(tabId, { type: 'GET_POINT' });
  if (point2?.ok && point2.point_number !== pointNumber) {
    throw new Error(
      `ПП сменился во время сбора (${pointNumber} → ${point2.point_number}). Запустите сбор заново.`
    );
  }

  // 2) Leftover — Остатки → тип «Отправления» в URL → Найти → «Найдено»
  try {
    await navigateAndReady(tabId, urls.remains, 300);
    let leftover = await send(tabId, {
      type: 'SCRAPE_FOUND',
      settleMs: 200,
      remains: true,
      openReportsMenu: false,
      ensureTab: null,
    });
    if (leftover?.ok && leftover.value === 0) {
      await navigateAndReady(tabId, urls.remains, 300);
      leftover = await send(tabId, {
        type: 'SCRAPE_FOUND',
        settleMs: 200,
        remains: true,
        openReportsMenu: false,
        ensureTab: null,
      });
    }
    pages.push('remains');
    if (leftover?.ok) {
      closing.leftover = leftover.value;
      checklist.leftover = Boolean(leftover.findClicked);
      if (leftover.warnings?.length) warnings.push(...leftover.warnings);
      if (!leftover.findClicked) {
        warnings.push('Остатки: «Найти» не нажата — значение могло быть пустым/старым');
      } else if (leftover.value === 0) {
        warnings.push('Остатки: после «Найти» найдено 0');
      }
    } else {
      const d = leftover?.diagnostics;
      warnings.push(
        leftover?.error ||
          `Остатки: не собрано${d ? ` | Найти=[${(d.findButtons || []).join(',') || 'нет'}] URL=${d.href}` : ''}`
      );
    }
  } catch (e) {
    warnings.push(`Остатки: ${e.message}`);
  }

  // 2b) Озон полка. Если пункт без этой функции, страница отвечает «Доступ запрещён» — строку в отчёт не пишем.
  try {
    await navigateAndReady(tabId, urls.ozonShelf, 200, 8000);
    const shelf = await send(tabId, { type: 'SCRAPE_OZON_SHELF' }, 8000);
    if (shelf?.unavailable) {
      ozonShelfAvailable = false;
      delete closing.ozon_shelf;
      delete checklist.ozon_shelf;
    } else {
      pages.push('micro-ff-stock');
      if (shelf?.ok) {
        closing.ozon_shelf = shelf.value;
        checklist.ozon_shelf = true;
      } else {
        warnings.push(shelf?.error || 'Озон полка: не собрано');
      }
    }
  } catch (e) {
    warnings.push(`Озон полка: ${e.message}`);
  }

  // 3) Перевозки: только «сегодня принято» и «не принято». Время машины отсюда не берём.
  let carriagesPayload = null;
  try {
    await navigateAndReady(tabId, urls.carriages, settleMs);
    carriagesPayload = await send(tabId, { type: 'SCRAPE_CARRIAGES', settleMs: 400 });
    pages.push('carriages');
    if (carriagesPayload?.accepted_today_card != null) {
      closing.accepted_total = carriagesPayload.accepted_today_card;
      checklist.accepted = true;
    }
    if (carriagesPayload?.not_accepted_today != null) {
      closing.not_accepted = carriagesPayload.not_accepted_today;
      checklist.not_accepted = true;
    } else {
      warnings.push('Не принято: нет «Сегодня принято» или колонки «Отправлений»');
    }
    if (carriagesPayload?.warnings?.length) warnings.push(...carriagesPayload.warnings);
  } catch (e) {
    warnings.push(`Перевозки: ${e.message}`);
  }

  if (validClock(machineTime)) {
    closing.closing_time = String(machineTime).trim();
    checklist.machine = true;
  } else {
    try {
      const fromChat = await lookupMachineTime(pointNumber);
      if (fromChat) {
        closing.closing_time = fromChat;
        checklist.machine = true;
      } else {
        warnings.push('Машина: время не найдено. Напишите его в блоке «Машина» или в чате пункта.');
      }
    } catch (e) {
      warnings.push(`Машина: ${e.message}`);
    }
  }

  const draft = {
    point_number: pointNumber,
    source: 'turbo-pvz',
    collected_at: new Date().toISOString(),
    closing,
    meta: {
      carriage_long_id: carriageLongId,
      pages,
      warnings,
      checklist,
      carriage_choices: carriageChoices,
      accepted_today_card: carriagesPayload?.accepted_today_card ?? null,
      ozon_shelf_available: ozonShelfAvailable,
    },
  };

  await chrome.storage.session.set({ lastDraft: draft });
  return draft;
}

function applyCarriage(closing, chosen, acceptedCard) {
  closing.transport_number = chosen.transport_number || null;
  if (chosen.transport_date) closing.transport_date = chosen.transport_date;
  closing.shortage = chosen.shortage;
  closing.excess = chosen.excess;
  // «Принято всего» = карточка «Сегодня принято», НЕ колонка «Отправлений» у перевозки
  closing.accepted_total =
    acceptedCard != null ? acceptedCard : chosen.accepted != null ? chosen.accepted : null;
}

async function postApi(path, payload) {
  const config = await loadConfig();
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(body?.error || body?.detail || `API ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

async function sendDraftToApi(draft, extra = {}) {
  return postApi('/api/drafts', { ...draft, ...extra });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'COLLECT_CLOSING':
        return collectClosing({
          selectedCarriageLongId: message.selectedCarriageLongId,
          machineTime: message.machineTime,
        });
      case 'APPLY_CARRIAGE_CHOICE': {
        const { lastDraft } = await chrome.storage.session.get('lastDraft');
        if (!lastDraft) throw new Error('Нет черновика — сначала соберите закрытие');
        const choice = (lastDraft.meta?.carriage_choices || []).find(
          (c) => c.carriage_long_id === message.carriageLongId || c.transport_number === message.transportNumber
        );
        if (!choice) throw new Error('Выбранная перевозка не найдена в последнем сборе');
        applyCarriage(lastDraft.closing, choice, lastDraft.meta?.accepted_today_card);
        lastDraft.meta.carriage_long_id = choice.carriage_long_id || null;
        lastDraft.meta.checklist = lastDraft.meta.checklist || {};
        lastDraft.meta.checklist.carriage = Boolean(choice.transport_number);
        // Re-scrape zasyl for chosen carriage (long id или клик по короткому номеру)
        {
          const config = await loadConfig();
          const tab = await findTurboTab();
          if (tab) {
            let longId = choice.carriage_long_id || null;
            if (!longId && choice.transport_number) {
              await navigateAndReady(
                tab.id,
                'https://turbo-pvz.ozon.ru/carriages_list/finished',
                config.pageSettleMs || 2500
              );
              const opened = await send(tab.id, {
                type: 'OPEN_CARRIAGE',
                transportNumber: choice.transport_number,
              });
              if (opened?.ok) longId = opened.carriage_long_id;
            }
            if (longId) {
              choice.carriage_long_id = longId;
              lastDraft.meta.carriage_long_id = longId;
              const detailUrl = `https://turbo-pvz.ozon.ru/carriages_list/finished-carriage-detail/${longId}`;
              const tabInfo = await chrome.tabs.get(tab.id);
              if (!(tabInfo.url || '').includes(`finished-carriage-detail/${longId}`)) {
                await navigateAndReady(tab.id, detailUrl, config.pageSettleMs || 2500);
              }
              const zasyl = await send(tab.id, { type: 'SCRAPE_ZASYL', settleMs: 800 });
              lastDraft.meta.warnings = lastDraft.meta.warnings || [];
              if (zasyl?.ok) {
                lastDraft.closing.zasyl = zasyl.value;
                lastDraft.meta.checklist.zasyl = true;
                if (!lastDraft.meta.pages.includes('zasyl')) lastDraft.meta.pages.push('zasyl');
                if (zasyl.warnings?.length) lastDraft.meta.warnings.push(...zasyl.warnings);
              } else {
                lastDraft.closing.zasyl = null;
                lastDraft.meta.checklist.zasyl = false;
                lastDraft.meta.warnings.push(zasyl?.error || 'Засылы: фильтр статуса не сработал');
              }
            }
          }
        }
        lastDraft.collected_at = new Date().toISOString();
        await chrome.storage.session.set({ lastDraft });
        return lastDraft;
      }
      case 'SEND_DRAFT': {
        const draft = message.draft;
        if (!draft?.point_number) throw new Error('Черновик без point_number');
        const extra = {};
        if (message.publish) {
          extra.publish = true;
          if (message.linkToken) extra.link_token = message.linkToken;
        }
        return sendDraftToApi(draft, extra);
      }
      case 'SEND_MACHINE':
        return postApi('/api/machine', {
          point_number: message.pointNumber,
          time: message.time,
          link_token: message.linkToken,
        });
      case 'LINK_CODE':
        return postApi('/api/link/request', { username: message.username });
      case 'LINK_CONFIRM':
        return postApi('/api/link/confirm', { username: message.username, code: message.code });
      case 'GET_POINT_ONLY': {
        const tab = await findTurboTab();
        if (!tab) return { ok: false, error: 'Нет открытой вкладки Турбо ПВЗ' };
        await ensureContentScript(tab.id);
        return send(tab.id, { type: 'GET_POINT' });
      }
      default:
        throw new Error(`Unknown: ${message?.type}`);
    }
  };

  run()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
