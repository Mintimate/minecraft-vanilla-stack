(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const config = window.MVS_SITE;

  if (config) {
    $$('[data-link]').forEach((link) => {
      if (config.links[link.dataset.link]) link.href = config.links[link.dataset.link];
    });
    $$('[data-doc]').forEach((link) => { link.href = config.docsBase + link.dataset.doc; });
    $$('[data-version]').forEach((label) => {
      if (config[label.dataset.version]) label.textContent = config[label.dataset.version];
    });
  }

  function initializePublicStatus() {
    const panel = $('#public-status');
    if (!panel) return;
    if (config?.publicStatusEnabled === false) { panel.hidden = true; return; }
    panel.hidden = false;

    const refreshInterval = 5 * 60 * 1000;
    const cacheInterval = 30 * 1000;
    const requestTimeout = 15 * 1000;
    const badge = $('#public-status-badge');
    const count = $('#public-status-count');
    const capacity = $('#public-status-capacity');
    const message = $('#public-status-message');
    const playersLabel = $('#public-status-players-label');
    const playerList = $('#public-status-players');
    const empty = $('#public-status-empty');
    const updated = $('#public-status-updated');
    const historyPlayers = $('#public-status-history-players');
    const historyEmpty = $('#public-status-history-empty');
    const historyTime = $('#public-status-history-time');
    const historyUpdated = $('#public-status-history-updated');
    const dateFormat = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    let snapshot = null;
    let lastOnline = null;
    let lastAttempt = null;
    let lastFullAttempt = null;
    let inFlight = false;
    let refreshTimer;
    let freshnessTimer;
    let lastResponseFresh = false;

    function isDate(value) {
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    }

    function readStatus(value) {
      const isCount = (number) => Number.isSafeInteger(number) && number >= 0;
      const isPlayerList = (players) => Array.isArray(players) && players.length <= 10000
        && players.every((player) => player && typeof player.name === 'string'
          && player.name.length > 0 && player.name.length <= 64);
      if (!value || !['online', 'unavailable'].includes(value.status)
        || typeof value.stale !== 'boolean' || !isDate(value.checkedAt)
        || !isPlayerList(value.players)
        || !(value.onlinePlayers === null || isCount(value.onlinePlayers))
        || !(value.maxPlayers === null || isCount(value.maxPlayers))
        || !(value.updatedAt === null || isDate(value.updatedAt))
        || (value.updatedAt !== null && value.onlinePlayers === null)
        || (value.status === 'online' && value.updatedAt === null)
        || (value.lastOnline != null && (!isDate(value.lastOnline.updatedAt)
          || !isPlayerList(value.lastOnline.players) || value.lastOnline.players.length === 0))) {
        throw new Error('Invalid public status');
      }
      return value;
    }

    function renderStatus() {
      const fresh = snapshot && lastResponseFresh
        && Date.now() - Date.parse(snapshot.updatedAt) < refreshInterval;
      // Cached samples can expire before the next five-minute request.
      window.clearTimeout(freshnessTimer);
      if (fresh && !document.hidden) {
        freshnessTimer = window.setTimeout(renderStatus,
          refreshInterval - (Date.now() - Date.parse(snapshot.updatedAt)));
      }
      panel.dataset.state = fresh ? 'online' : 'pending';
      badge.textContent = fresh ? '在线' : (inFlight && !snapshot ? '查询中' : '待刷新');
      count.textContent = snapshot ? String(snapshot.onlinePlayers) : '—';
      capacity.textContent = snapshot?.maxPlayers === null || !snapshot ? '—' : String(snapshot.maxPlayers);
      message.textContent = fresh ? '状态已更新，看看谁正在冒险。'
        : snapshot ? '暂未获得最新状态，以下为上次成功更新的记录。'
          : inFlight ? '正在获取服务器状态…' : '暂时无法获取状态，稍后会自动重试。';
      playersLabel.textContent = fresh ? '世界里的冒险家' : '上次记录的冒险家';
      playerList.replaceChildren();
      if (snapshot) {
        const names = document.createDocumentFragment();
        snapshot.players.forEach((player) => {
          const item = document.createElement('li');
          item.textContent = player.name;
          names.appendChild(item);
        });
        playerList.appendChild(names);
        updated.dateTime = snapshot.updatedAt;
        updated.textContent = dateFormat.format(new Date(snapshot.updatedAt));
      }
      const hasPlayers = snapshot && snapshot.players.length > 0;
      playerList.hidden = !hasPlayers;
      empty.hidden = Boolean(hasPlayers);
      empty.textContent = !snapshot ? '玩家名单尚未获取。'
        : snapshot.onlinePlayers > 0 ? '本次记录未提供玩家名单。'
          : fresh ? '此刻还没有玩家，下一段冒险等你加入。' : '上次更新时暂无玩家在线。';
      historyPlayers.replaceChildren();
      if (lastOnline) {
        const names = document.createDocumentFragment();
        lastOnline.players.forEach((player) => {
          const item = document.createElement('li');
          item.textContent = player.name;
          names.appendChild(item);
        });
        historyPlayers.appendChild(names);
        historyUpdated.dateTime = lastOnline.updatedAt;
        historyUpdated.textContent = dateFormat.format(new Date(lastOnline.updatedAt));
      }
      historyPlayers.hidden = !lastOnline;
      historyEmpty.hidden = Boolean(lastOnline);
      historyEmpty.textContent = '暂无最近在线记录';
      historyTime.hidden = !lastOnline;
    }

    function scheduleRefresh() {
      window.clearTimeout(refreshTimer);
      if (document.hidden || inFlight) return;
      const sinceAttempt = lastAttempt === null ? cacheInterval : Date.now() - lastAttempt;
      const sinceFullAttempt = lastFullAttempt === null ? refreshInterval : Date.now() - lastFullAttempt;
      const remaining = Math.max(0, Math.min(cacheInterval - sinceAttempt, refreshInterval - sinceFullAttempt));
      refreshTimer = window.setTimeout(refreshStatus, remaining);
    }

    async function refreshStatus() {
      if (document.hidden || inFlight) return;
      inFlight = true;
      lastAttempt = Date.now();
      // Cache reads pick up administrator updates without advancing the separate
      // five-minute clock that allows the server to check the game again.
      const cacheOnly = lastFullAttempt !== null && lastAttempt - lastFullAttempt < refreshInterval;
      if (!cacheOnly) lastFullAttempt = lastAttempt;
      renderStatus();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), requestTimeout);
      try {
        const response = await fetch(cacheOnly ? '/api/server-status?cached=1' : '/api/server-status', {
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Public status unavailable');
        const result = readStatus(await response.json());
        // A failed sample may still carry the last successful server-side record.
        if (result.updatedAt && (!snapshot || Date.parse(result.updatedAt) >= Date.parse(snapshot.updatedAt))) {
          snapshot = result;
        }
        // History keeps its own observation time, including across empty samples
        // and older cache responses from another function instance.
        if (result.lastOnline && (!lastOnline
          || Date.parse(result.lastOnline.updatedAt) >= Date.parse(lastOnline.updatedAt))) {
          lastOnline = result.lastOnline;
        }
        lastResponseFresh = result.status === 'online' && !result.stale
          && snapshot?.updatedAt === result.updatedAt;
      } catch {
        lastResponseFresh = false;
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
        renderStatus();
        scheduleRefresh();
      }
    }

    document.addEventListener('visibilitychange', () => {
      window.clearTimeout(refreshTimer);
      window.clearTimeout(freshnessTimer);
      if (!document.hidden) {
        renderStatus();
        if (lastAttempt === null || Date.now() - lastAttempt >= cacheInterval
          || lastFullAttempt === null || Date.now() - lastFullAttempt >= refreshInterval) refreshStatus();
        else scheduleRefresh();
      }
    });
    if (!document.hidden) refreshStatus();
  }
  initializePublicStatus();


  $$('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const content = document.getElementById(button.dataset.copy)?.textContent;
      if (!content) return;
      try {
        await navigator.clipboard.writeText(content);
        button.textContent = '已复制';
      } catch {
        button.textContent = '请选中文本复制';
      }
      window.setTimeout(() => { button.textContent = '复制'; }, 2000);
    });
  });
})();
