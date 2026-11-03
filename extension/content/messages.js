/** Входящие команды от service worker. */
(() => {
  const api = window.TurboClose;
  const S = window.TurboPvzSelectors;
  if (!api || !S) {
    console.error('[turbo-close] части сборщика не загружены');
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handle = async () => {
      switch (message?.type) {
        case 'PING':
          return { ok: true, href: location.href };
        case 'GET_POINT':
          await api.settle(300);
          {
            const point = api.getPointNumber();
            if (!point) {
              return { ok: false, error: 'ПП не найден в шапке (ожидался текст вида ПП_1125)' };
            }
            return { ok: true, ...point };
          }
        case 'SCRAPE_FOUND': {
          const isRemains = Boolean(message.remains);
          if (isRemains) {
            const hrefDecoded = decodeURIComponent(location.href || '');
            if (!hrefDecoded.includes('GRPC_REMNANT_FILTER_ARTICLE_POSTING')) {
              return {
                ok: false,
                error:
                  'Остатки: нет фильтра типа «Отправления» в URL (ожидался GRPC_REMNANT_FILTER_ARTICLE_POSTING)',
                diagnostics: api.pageDiagnostics(),
              };
            }
          }
          const prep = await api.prepareReportPage({
            settleMs: message.settleMs || 800,
            ensureTab: null,
            openReportsMenu: false,
            requireNonZero: false,
          });
          if (!prep.ok) {
            return {
              ok: false,
              error: prep.error,
              findClicked: prep.findClicked,
              diagnostics: prep.diagnostics,
            };
          }
          if (isRemains && prep.value === 0) {
            return {
              ok: true,
              value: 0,
              findClicked: prep.findClicked,
              warnings: [
                prep.findClicked
                  ? 'Остатки: после «Найти» всё ещё 0 — на пункте пусто или поиск не применился'
                  : 'Остатки: «Найдено: 0»',
              ],
              diagnostics: prep.diagnostics,
            };
          }
          return {
            ok: true,
            value: prep.value,
            findClicked: prep.findClicked,
            diagnostics: prep.diagnostics,
          };
        }
        case 'SCRAPE_TARE': {
          const hrefDecoded = decodeURIComponent(location.href || '');
          const hasTareFilter = hrefDecoded.includes('GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE');
          if (!hasTareFilter) {
            return {
              ok: false,
              error:
                'Тара: нет фильтра «Тарный ящик» в URL (ожидался GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE). Не кликайте вкладки — они сбрасывают filter.',
              diagnostics: api.pageDiagnostics(),
            };
          }
          const prep = await api.prepareReportPage({
            settleMs: message.settleMs || 800,
            ensureTab: null,
            openReportsMenu: false,
          });
          if (!prep.ok) {
            return {
              ok: false,
              error: prep.error || 'Тара: не собрано после «Найти»',
              findClicked: prep.findClicked,
              diagnostics: prep.diagnostics,
            };
          }
          const tare = await api.scrapeTareAcrossPages();
          if (tare?.ok) {
            tare.findClicked = prep.findClicked;
            tare.diagnostics = prep.diagnostics;
            if (!prep.findClicked) {
              tare.warnings = tare.warnings || [];
              tare.warnings.push('Кнопка «Найти» на странице тары не найдена — проверьте фильтр');
            }
          }
          return tare;
        }
        case 'PAGE_DIAG':
          await api.settle(200);
          return { ok: true, ...api.pageDiagnostics() };
        case 'SCRAPE_CARRIAGES': {
          await api.settle(message.settleMs || 500);
          const todayFilter = await api.applyCarriageTodayFilter();
          await api.settle(600);
          const carriages = api.scrapeFinishedCarriages();
          carriages.warnings = carriages.warnings || [];
          if (!todayFilter.applied) {
            carriages.warnings.push(
              'Дата перевозок: кнопка «Применить» не нажата. Проверьте, что в таблице только сегодняшний день.'
            );
          }
          return carriages;
        }
        case 'SCRAPE_ZASYL':
          return api.scrapeZasyl();
        case 'OPEN_CARRIAGE':
          return api.openCarriageByNumber(message.transportNumber);
        case 'GET_URLS':
          return {
            ok: true,
            urls: {
              giveout: api.buildGiveoutUrl(),
              remains: api.buildRemainsUrl(),
              tare: api.buildTareUrl(),
              carriages: api.buildCarriagesUrl(),
              carriageDetail: message.longId ? api.buildCarriageDetailUrl(message.longId) : null,
            },
            today: api.todayLocalParts(),
          };
        default:
          return { ok: false, error: `Unknown message: ${message?.type}` };
      }
    };

    handle()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
