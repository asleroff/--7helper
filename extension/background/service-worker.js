import { loadConfig } from '../shared/config.js';

const TURBO_ORIGIN = 'https://turbo-pvz.ozon.ru';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

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
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selectors.js', 'content/content.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  }
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

async function navigateAndReady(tabId, url, settleMs) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitTabComplete(tabId);
  await ensureContentScript(tabId);
  // Extra settle for SPA hydration
  await new Promise((r) => setTimeout(r, settleMs));
}

async function send(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
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
    nedovoz: null,
    issued: null,
    leftover: null,
  };
}

async function collectClosing({ selectedCarriageLongId } = {}) {
  const config = await loadConfig();
  const settleMs = config.pageSettleMs || 2500;
  const warnings = [];
  const pages = [];
  const checklist = {
    point: false,
    issued: false,
    leftover: false,
    tare: false,
    carriage: false,
    zasyl: false,
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

  // 2) Leftover — Отчёты → Остатки → Тип=Отправления → Найти → «Найдено»
  try {
    await navigateAndReady(tabId, urls.remains, Math.max(settleMs, 3500));
    let leftover = await send(tabId, {
      type: 'SCRAPE_FOUND',
      settleMs: 1200,
      remains: true,
      // URL уже с filter POSTING — не трогаем вкладки
      openReportsMenu: false,
      ensureTab: null,
    });
    if (leftover?.ok && leftover.value === 0) {
      await navigateAndReady(tabId, urls.remains, Math.max(settleMs, 4000));
      leftover = await send(tabId, {
        type: 'SCRAPE_FOUND',
        settleMs: 1500,
        remains: true,
        openReportsMenu: false,
        ensureTab: null,
      });
    }
    pages.push('remains');
    if (leftover?.ok) {
      closing.leftover = leftover.value;
      checklist.leftover = leftover.value > 0 || leftover.findClicked;
      if (leftover.warnings?.length) warnings.push(...leftover.warnings);
      if (!leftover.findClicked) {
        warnings.push('Остатки: «Найти» не нажата — значение могло быть пустым/старым');
      }
      if (leftover.value === 0) {
        const d = leftover.diagnostics || {};
        warnings.push(
          `Остатки = 0 (Найти=${leftover.findClicked ? 'да' : 'нет'}, кнопок=[${(d.findButtons || []).join(',') || 'не видно'}], строк таблицы=${d.tableRows ?? '?'})`
        );
        checklist.leftover = false;
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

  // 3) Tare TYA/KTYA
  try {
    await navigateAndReady(tabId, urls.tare, Math.max(settleMs, 3000));
    const tare = await send(tabId, { type: 'SCRAPE_TARE', settleMs: 1000 });
    pages.push('tare');
    if (tare?.ok) {
      closing.tya = tare.tya;
      closing.ktya = tare.ktya;
      checklist.tare = true;
      if (tare.warnings?.length) warnings.push(...tare.warnings);
    } else {
      warnings.push(tare?.error || 'Тара: не собрано');
    }
  } catch (e) {
    warnings.push(`Тара: ${e.message}`);
  }

  // 4) Carriages
  let carriagesPayload = null;
  let chosen = null;
  try {
    await navigateAndReady(tabId, urls.carriages, settleMs);
    carriagesPayload = await send(tabId, { type: 'SCRAPE_CARRIAGES', settleMs: 400 });
    pages.push('carriages');
    if (carriagesPayload?.warnings?.length) warnings.push(...carriagesPayload.warnings);

    const todayOnly = carriagesPayload?.today_carriages || [];
    const allCarriages = carriagesPayload?.carriages || [];
    let todayList = todayOnly.length ? todayOnly : [];
    if (!todayList.length && allCarriages.length) {
      todayList = allCarriages;
      warnings.push(
        'Не удалось уверенно отфильтровать перевозки «за сегодня» по дате закрытия — показаны все найденные. Проверьте выбор.'
      );
    }

    carriageChoices = todayList.map((c, i) => ({
      index: i,
      transport_number: c.transport_number,
      carriage_long_id: c.carriage_long_id,
      closing_time: c.closing_time,
      transport_date: c.transport_date,
      accepted: c.accepted,
      shortage: c.shortage,
      excess: c.excess,
      row_preview: c.row_preview,
      is_today: c.is_today,
    }));

    if (!carriageChoices.length) {
      warnings.push('За сегодня перевозок не найдено');
    } else if (carriageChoices.length > 1 && !selectedCarriageLongId) {
      warnings.push(
        `Найдено перевозок: ${carriageChoices.length}. Выберите нужную в панели.`
      );
    }

    if (selectedCarriageLongId) {
      chosen =
        carriageChoices.find((c) => c.carriage_long_id === selectedCarriageLongId) ||
        carriageChoices.find((c) => c.transport_number === selectedCarriageLongId) ||
        (carriagesPayload.carriages || []).find((c) => c.carriage_long_id === selectedCarriageLongId);
    } else if (carriageChoices.length === 1) {
      chosen = carriageChoices[0];
    } else if (carriageChoices.length > 1) {
      // Несколько за период фильтра — берём первую с датой закрытия = сегодня, иначе первую
      chosen =
        carriageChoices.find((c) => c.is_today) ||
        carriageChoices[0] ||
        null;
      if (carriageChoices.length > 1) {
        warnings.push(
          `Автовыбор перевозки #${chosen?.transport_number || '?'}. Если не та — выберите в списке ниже.`
        );
      }
    }

    if (chosen) {
      applyCarriage(closing, chosen, carriagesPayload?.accepted_today_card);
      carriageLongId = chosen.carriage_long_id || null;
      checklist.carriage = Boolean(chosen.transport_number);
    }
  } catch (e) {
    warnings.push(`Перевозки: ${e.message}`);
  }

  // 5) Zasyl — в таблице часто нет href, только клик по строке → URL .../finished-carriage-detail/{longId}
  const chosenTransport =
    closing.transport_number ||
    chosen?.transport_number ||
    carriageChoices[0]?.transport_number ||
    null;

  if (!carriageLongId && chosenTransport) {
    try {
      await navigateAndReady(tabId, urls.carriages, settleMs);
      const opened = await send(tabId, {
        type: 'OPEN_CARRIAGE',
        transportNumber: chosenTransport,
      });
      if (opened?.ok && opened.carriage_long_id) {
        carriageLongId = opened.carriage_long_id;
        if (chosen) chosen.carriage_long_id = carriageLongId;
        const choice = carriageChoices.find((c) => c.transport_number === chosenTransport);
        if (choice) choice.carriage_long_id = carriageLongId;
      } else {
        warnings.push(opened?.error || `Не удалось открыть карточку перевозки #${chosenTransport}`);
      }
    } catch (e) {
      warnings.push(`Открытие карточки перевозки: ${e.message}`);
    }
  }

  if (carriageLongId) {
    try {
      const detailUrl = `https://turbo-pvz.ozon.ru/carriages_list/finished-carriage-detail/${carriageLongId}`;
      // Если уже на карточке после клика — не перезагружаем зря
      const tabInfo = await chrome.tabs.get(tabId);
      const alreadyThere = tabInfo.url && tabInfo.url.includes(`finished-carriage-detail/${carriageLongId}`);
      if (!alreadyThere) {
        await navigateAndReady(tabId, detailUrl, Math.max(settleMs, 3000));
      } else {
        await ensureContentScript(tabId);
        await new Promise((r) => setTimeout(r, 800));
      }
      const zasyl = await send(tabId, { type: 'SCRAPE_ZASYL', settleMs: 1000 });
      pages.push('zasyl');
      if (zasyl?.ok) {
        closing.zasyl = zasyl.value;
        checklist.zasyl = true;
        if (zasyl.warnings?.length) warnings.push(...zasyl.warnings);
        if (zasyl.method && zasyl.method.includes('found')) {
          // ок — взяли из «Найдено», без перебора строк
        } else if (zasyl.value === 0) {
          warnings.push(
            `Засылы = 0 (метод: ${zasyl.method || '?'}). Если на сайте есть засылы — фильтр статуса не сработал.`
          );
        }
      } else {
        warnings.push(zasyl?.error || 'Засылы: не собрано');
      }
    } catch (e) {
      warnings.push(`Засылы: ${e.message}`);
    }
  } else {
    warnings.push(
      'Засылы пропущены: не удалось получить long id (в таблице нет ссылки, клик по строке не открыл карточку).'
    );
  }

  closing.nedovoz = null;

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
    },
  };

  await chrome.storage.session.set({ lastDraft: draft });
  return draft;
}

function applyCarriage(closing, chosen, acceptedCard) {
  closing.transport_number = chosen.transport_number || null;
  if (chosen.transport_date) closing.transport_date = chosen.transport_date;
  closing.closing_time = chosen.closing_time || null;
  closing.shortage = chosen.shortage;
  closing.excess = chosen.excess;
  // «Принято всего» = карточка «Сегодня принято», НЕ колонка «Отправлений» у перевозки
  closing.accepted_total =
    acceptedCard != null ? acceptedCard : chosen.accepted != null ? chosen.accepted : null;
}

async function sendDraftToApi(draft) {
  const config = await loadConfig();
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}/api/drafts`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify(draft),
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'COLLECT_CLOSING':
        return collectClosing({ selectedCarriageLongId: message.selectedCarriageLongId });
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
              if (zasyl?.ok) {
                lastDraft.closing.zasyl = zasyl.value;
                lastDraft.meta.checklist.zasyl = true;
                if (!lastDraft.meta.pages.includes('zasyl')) lastDraft.meta.pages.push('zasyl');
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
        return sendDraftToApi(draft);
      }
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
