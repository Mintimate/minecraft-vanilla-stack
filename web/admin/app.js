"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const publicPrefix = "/admin";
  const elements = {
    loading: byId("initial-loading"), login: byId("login-panel"), loginForm: byId("login-form"),
    key: byId("admin-key"), loginButton: byId("login-button"), loginMessage: byId("login-message"),
    dashboard: byId("dashboard"), account: byId("account"), adminName: byId("admin-name"),
    logout: byId("logout"), refresh: byId("refresh"), connection: byId("connection"),
    connectionText: byId("connection-text"), count: byId("player-count"),
    message: byId("dashboard-message"), addForm: byId("add-form"),
    name: byId("player-name"), addButton: byId("add-button"), search: byId("search"),
    players: byId("players"), empty: byId("empty-state"), updatedAt: byId("updated-at"), summary: byId("list-summary"),
    settingsRefresh: byId("settings-refresh"), settingsStatus: byId("settings-status"), settingsMessage: byId("settings-message"),
    onlineCount: byId("online-count"), worldTime: byId("world-time"), worldTimeNote: byId("world-time-note"), overviewUpdated: byId("overview-updated"),
    overviewRefresh: byId("overview-refresh"), onlinePlayers: byId("online-players"), onlineEmpty: byId("online-empty"),
    dailyStatus: byId("daily-status"), dailyMessage: byId("daily-message"),
    publicStatusSync: byId("public-status-sync"),
    announceForm: byId("announce-form"), announcement: byId("announcement"), announceButton: byId("announce-button"),
    timeForm: byId("time-form"), timeValue: byId("time-value"), timeButton: byId("time-button"),
    weatherForm: byId("weather-form"), weatherValue: byId("weather-value"), weatherSeconds: byId("weather-seconds"), weatherButton: byId("weather-button"),
    saveWorld: byId("save-world"), confirmation: byId("action-confirmation"),
    globalUpdated: byId("global-updated"), whitelistUpdated: byId("whitelist-updated"), worldUpdated: byId("world-updated"),
    lastActionAt: byId("last-action-at"),
    confirmationTitle: byId("confirmation-title"), confirmationDescription: byId("confirmation-description"),
    confirmationCancel: byId("confirmation-cancel"), confirmationSubmit: byId("confirmation-submit"),
    rules: byId("game-rules"), rulesRefresh: byId("rules-refresh"), rulesStatus: byId("rules-status"), rulesMessage: byId("rules-message"),
    detailPanel: byId("player-detail-panel"), detailHeading: byId("player-detail-heading"), detailRefresh: byId("player-detail-refresh"),
    detailClose: byId("player-detail-close"),
    detailStatus: byId("player-detail-status"), detailMessage: byId("player-detail-message"), detailName: byId("player-detail-name"),
    detailDimension: byId("player-detail-dimension"), detailPosition: byId("player-detail-position"),
    teleportForm: byId("teleport-form"), teleportTarget: byId("teleport-target"), teleportButton: byId("teleport-button"),
    bansRefresh: byId("bans-refresh"), bansStatus: byId("bans-status"), bansMessage: byId("bans-message"),
    banForm: byId("ban-form"), banName: byId("ban-name"), banReason: byId("ban-reason"), banButton: byId("ban-button"),
    bans: byId("banned-players"), bansEmpty: byId("bans-empty"), bansSummary: byId("bans-summary"),
    unbanForm: byId("unban-form"), unbanName: byId("unban-name"), unbanButton: byId("unban-button"),
    locateForm: byId("locate-form"), locateStructure: byId("locate-structure"), locateX: byId("locate-x"), locateZ: byId("locate-z"),
    locateOriginDimension: byId("locate-origin-dimension"), locateConversionNote: byId("locate-conversion-note"),
    locateButton: byId("locate-button"), locateDimensionNote: byId("locate-dimension-note"), locateStatus: byId("locate-status"),
    locateMessage: byId("locate-message"), locateEmpty: byId("locate-empty"), locateResult: byId("locate-result"),
    locateResultName: byId("locate-result-name"), locateResultOrigin: byId("locate-result-origin"), locateResultSearchOrigin: byId("locate-result-search-origin"),
    locateResultX: byId("locate-result-x"), locateResultY: byId("locate-result-y"), locateResultYRow: byId("locate-result-y-row"), locateResultZ: byId("locate-result-z"),
    locateResultDimension: byId("locate-result-dimension"), locateResultDistance: byId("locate-result-distance"), locateResultBearing: byId("locate-result-bearing"),
    locateResultDistanceLabel: byId("locate-result-distance-label"), locateResultBearingLabel: byId("locate-result-bearing-label"),
    locateHeightNote: byId("locate-height-note"), locateCopy: byId("locate-copy"),
  };
  const difficultyLabels = { peaceful: "和平", easy: "简单", normal: "普通", hard: "困难" };
  const difficulty = {
    form: byId("setting-difficulty-form"), input: byId("setting-difficulty"),
    button: byId("save-difficulty"), current: byId("current-difficulty"),
  };
  const ruleDefinitions = [
    { key: "keepInventory", label: "死亡保留物品", note: "开启后，玩家死亡时保留物品和经验。", type: "boolean" },
    { key: "playersSleepingPercentage", label: "睡眠人数比例", note: "本面板可设置 0–100%。0 表示一名玩家入睡即可，100 表示所有符合条件的玩家；服务器值大于 100 时无法通过睡眠跳过夜晚。", type: "integer" },
    { key: "mobGriefing", label: "生物破坏", note: "控制生物改变方块、拾取物品等行为，也会影响部分村民与农场机制。", type: "boolean" },
    { key: "doDaylightCycle", label: "昼夜自然变化", note: "关闭后停止时间自然流逝，仍可手动调整主世界时间。", type: "boolean" },
    { key: "doWeatherCycle", label: "天气自然变化", note: "关闭后停止天气自然变化，仍可手动设置主世界天气。", type: "boolean" },
  ];
  const ruleControls = new Map();
  const structureDefinitions = {
    mansion: { label: "林地府邸（林间小屋）", dimension: "minecraft:overworld" },
    swamp_hut: { label: "沼泽小屋", dimension: "minecraft:overworld" },
    village: { label: "村庄", dimension: "minecraft:overworld" },
    desert_pyramid: { label: "沙漠神殿", dimension: "minecraft:overworld" },
    jungle_pyramid: { label: "丛林神庙", dimension: "minecraft:overworld" },
    monument: { label: "海底神殿", dimension: "minecraft:overworld" },
    ancient_city: { label: "远古城市", dimension: "minecraft:overworld" },
    trial_chambers: { label: "试炼密室", dimension: "minecraft:overworld" },
    stronghold: {
      label: "末地传送门（要塞）", resultLabel: "末地传送门所在要塞", dimension: "minecraft:overworld",
      note: "末地传送门位于主世界的要塞内。此功能返回要塞定位点，到达后仍需寻找传送门房间，无法精确定位传送门方块。",
    },
    fortress: { label: "下界要塞", dimension: "minecraft:the_nether" },
    bastion_remnant: { label: "堡垒遗迹", dimension: "minecraft:the_nether" },
    end_city: { label: "末地城", dimension: "minecraft:the_end" },
  };
  const dimensionLabels = { "minecraft:overworld": "主世界", "minecraft:the_nether": "下界", "minecraft:the_end": "末地" };
  const tabNames = ["daily", "locate", "whitelist", "settings", "bans"];
  const state = { confirmation: null, overviewReady: false, overview: null, csrfToken: "", user: null, busy: false, connected: false, loaded: false, players: [], updatedAt: null, settingsReady: false, settingsUpdatedAt: null, lastAction: null, overviewLoading: false, whitelistLoading: false, settingsLoading: false,
    rules: null, rulesReady: false, rulesLoading: false, rulesUpdatedAt: null,
    bans: null, bansReady: false, bansLoading: false, bansUpdatedAt: null,
    detailName: "", detail: null, detailReady: false, detailLoading: false, detailUpdatedAt: null,
    locateBusy: false, locateVersion: 0, locatePending: null, locateResult: null,
  };

  class APIError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      let response;
      try {
        response = await fetch(`${publicPrefix}${path}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal, ...options });
      } catch {
        throw new APIError("无法连接管理服务，请检查网络后刷新。");
      }
      let data = null;
      if (response.status !== 204) {
        try { data = await response.json(); } catch { /* Handled below without trusting an HTML error page. */ }
      }
      if (!response.ok) {
        const message = typeof data?.error?.message === "string" ? data.error.message : "请求未完成，请稍后刷新重试。";
        throw new APIError(message, response.status);
      }
      if (response.status !== 204 && !data) throw new APIError("服务器返回了无法识别的数据，请刷新重试。", 502);
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function message(element, text, type = "error") {
    element.textContent = text;
    element.dataset.type = type;
    element.hidden = !text;
  }

  function snapshotTime(value) {
    if (typeof value !== "string" || !value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatUpdatedAt(value) {
    return snapshotTime(value)?.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }) ?? null;
  }

  function snapshotLabel(value, ready, loading) {
    const time = formatUpdatedAt(value);
    if (!time) return loading ? "正在读取…" : ready ? "已读取 · 更新时间未提供" : "尚未读取";
    return `最后更新 ${time}${loading ? " · 刷新中" : ready ? "" : " · 待刷新"}`;
  }

  function renderPublicStatusSync() {
    const synced = state.overviewReady ? state.overview?.publicStatusSynced : undefined;
    const text = synced === true ? "已同步游客状态，已打开的首页约 30 秒内更新。"
      : synced === false ? "后台数据已更新，游客状态暂未同步，可稍后刷新重试。" : "";
    message(elements.publicStatusSync, text, synced === true ? "success" : "error");
  }

  function renderFreshness() {
    renderPublicStatusSync();
    const overview = snapshotLabel(state.overview?.updatedAt, state.overviewReady, state.overviewLoading);
    const whitelist = snapshotLabel(state.updatedAt, state.connected, state.whitelistLoading);
    elements.overviewUpdated.textContent = overview;
    elements.worldUpdated.textContent = overview;
    elements.whitelistUpdated.textContent = whitelist;
    elements.updatedAt.textContent = whitelist;
    elements.settingsStatus.textContent = snapshotLabel(state.settingsUpdatedAt, state.settingsReady, state.settingsLoading);
    [elements.overviewUpdated, elements.worldUpdated].forEach((element) => { element.dataset.stale = String(Boolean(state.overview) && !state.overviewReady); });
    [elements.whitelistUpdated, elements.updatedAt].forEach((element) => { element.dataset.stale = String(state.loaded && !state.connected); });
    elements.settingsStatus.dataset.stale = String(Boolean(state.settingsUpdatedAt) && !state.settingsReady);
    elements.rulesStatus.textContent = snapshotLabel(state.rulesUpdatedAt, state.rulesReady, state.rulesLoading);
    elements.rulesStatus.dataset.stale = String(Boolean(state.rules) && !state.rulesReady);
    elements.bansStatus.textContent = snapshotLabel(state.bansUpdatedAt, state.bansReady, state.bansLoading);
    elements.bansStatus.dataset.stale = String(Boolean(state.bans) && !state.bansReady);
    elements.detailStatus.textContent = snapshotLabel(state.detailUpdatedAt, state.detailReady, state.detailLoading);
    if (state.detailName && !state.detailLoading) {
      if (!state.overviewReady) elements.detailStatus.textContent += " · 在线状态待确认";
      else if (!isOnline(state.detailName)) elements.detailStatus.textContent += " · 玩家已离线";
    }
    elements.detailStatus.dataset.stale = String(Boolean(state.detail) && (!state.detailReady || !state.overviewReady));
    const times = [state.overview?.updatedAt, state.updatedAt, state.settingsUpdatedAt, state.rulesUpdatedAt, state.bansUpdatedAt, state.detailUpdatedAt].map(snapshotTime).filter(Boolean);
    const loading = state.overviewLoading || state.whitelistLoading || state.settingsLoading || state.rulesLoading || state.bansLoading || state.detailLoading;
    const complete = state.overviewReady && state.connected && state.settingsReady && state.rulesReady && state.bansReady && (!state.detailName || state.detailReady);
    elements.connection.dataset.state = loading ? "loading" : complete ? "connected" : times.length ? "disconnected" : "unknown";
    elements.connectionText.textContent = loading ? "正在读取数据" : complete ? "数据已读取" : times.length ? "部分数据待刷新" : "尚未读取数据";
    elements.globalUpdated.textContent = times.length ?
      `最近成功读取 ${formatUpdatedAt(new Date(Math.max(...times.map((date) => date.getTime()))).toISOString())} · 本地时间` : "打开页面后读取，或点击刷新获取最新数据";
    elements.lastActionAt.hidden = !state.lastAction;
    if (state.lastAction) {
      const time = formatUpdatedAt(state.lastAction.updatedAt);
      elements.lastActionAt.textContent = `最近确认操作：${state.lastAction.label}${time ? ` · ${time}` : " · 时间未提供"}`;
    } else elements.lastActionAt.textContent = "尚未执行日常操作";
  }

  function playerIdentity(name) {
    const identity = document.createElement("span");
    identity.className = "player-identity";
    const avatar = document.createElement("span");
    avatar.className = "avatar-shell";
    avatar.setAttribute("aria-hidden", "true");
    const fallback = document.createElement("span");
    fallback.className = "avatar-fallback";
    fallback.textContent = name.slice(0, 2).toUpperCase();
    const image = document.createElement("img");
    image.className = "player-avatar";
    image.alt = "";
    image.width = 36;
    image.height = 36;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    // Keep a layout box for lazy loading. display:none would prevent loading.
    image.addEventListener("load", () => { image.classList.add("is-loaded"); fallback.hidden = true; }, { once: true });
    image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; }, { once: true });
    // RCON exposes player names. Only validated public names go to the avatar
    // service; no API credentials, server address, or referrer is included.
    image.src = `https://minotar.net/helm/${encodeURIComponent(name)}/64.png`;
    const label = document.createElement("strong");
    label.className = "player-label";
    label.textContent = name;
    avatar.append(fallback, image);
    identity.append(avatar, label);
    return identity;
  }

  function setConnection(connected, loading = false) {
    state.connected = connected;
    state.whitelistLoading = loading;
    renderFreshness();
    syncControls();
  }

  function syncControls() {
    const busy = state.busy || state.locateBusy;
    elements.loginButton.disabled = busy;
    elements.key.disabled = busy;
    elements.logout.disabled = state.busy;
    elements.refresh.disabled = busy;
    elements.addButton.disabled = busy || !state.connected;
    elements.name.disabled = busy || !state.connected;
    elements.dashboard.setAttribute("aria-busy", String(busy));
    elements.players.querySelectorAll("button").forEach((button) => { button.disabled = busy || !state.connected; });
    elements.settingsRefresh.disabled = busy;
    difficulty.input.disabled = busy || !state.settingsReady;
    difficulty.button.disabled = busy || !state.settingsReady;
    elements.overviewRefresh.disabled = busy;
    [elements.announcement, elements.announceButton, elements.timeValue, elements.timeButton,
      elements.weatherValue, elements.weatherSeconds, elements.weatherButton, elements.saveWorld].forEach((control) => {
      control.disabled = busy || !state.overviewReady;
    });
    elements.onlinePlayers.querySelectorAll("button").forEach((button) => { button.disabled = busy || !state.overviewReady; });
    elements.rulesRefresh.disabled = busy;
    ruleControls.forEach(({ input, button }, key) => {
      input.disabled = busy || !state.rulesReady;
      button.disabled = busy || !state.rulesReady || String(state.rules?.get(key)) === input.value;
    });
    elements.bansRefresh.disabled = busy;
    [elements.banName, elements.banReason, elements.banButton, elements.unbanName, elements.unbanButton].forEach((control) => { control.disabled = busy || !state.bansReady; });
    elements.detailRefresh.disabled = busy || !state.detailName;
    elements.detailClose.disabled = busy;
    const rescueReady = state.overviewReady && state.detailReady && isOnline(state.detailName);
    elements.teleportTarget.disabled = busy || !rescueReady || elements.teleportTarget.options.length < 2;
    elements.teleportButton.disabled = busy || !rescueReady || !isOnline(elements.teleportTarget.value) || elements.teleportTarget.value === state.detailName;
    [elements.locateStructure, elements.locateOriginDimension, elements.locateX, elements.locateZ, elements.locateButton].forEach((control) => {
      control.disabled = busy || !state.user;
    });
    elements.locateCopy.disabled = state.locateBusy || !state.user || !state.locateResult;
    elements.locateForm.setAttribute("aria-busy", String(state.locateBusy));
    elements.locateButton.textContent = state.locateBusy ? "正在定位…" : "查找最近的结构";
  }

  function setBusy(busy, action = "") {
    state.busy = busy;
    elements.loginButton.textContent = busy && action === "login" ? "正在登录…" : "登录管理后台";
    elements.refresh.textContent = busy && action === "refresh" ? "正在刷新…" : "刷新全部状态";
    elements.addButton.textContent = busy && action === "add" ? "正在添加…" : "添加到白名单";
    elements.settingsRefresh.textContent = busy && action === "settings-refresh" ? "正在刷新…" : "刷新难度";
    difficulty.button.textContent = busy && action === "save-difficulty" ? "正在保存…" : "保存游戏难度";
    elements.overviewRefresh.textContent = busy && action === "overview-refresh" ? "正在刷新…" : "刷新在线与时间";
    elements.announceButton.textContent = busy && action === "announce" ? "正在发送…" : "发送公告";
    elements.timeButton.textContent = busy && action === "time" ? "正在设置…" : "设置主世界时间";
    elements.weatherButton.textContent = busy && action === "weather" ? "正在设置…" : "设置主世界天气";
    elements.saveWorld.textContent = busy && action === "save" ? "正在保存…" : "保存当前世界";
    elements.rulesRefresh.textContent = busy && action === "rules-refresh" ? "正在刷新…" : "刷新规则";
    elements.bansRefresh.textContent = busy && action === "bans-refresh" ? "正在刷新…" : "刷新封禁名单";
    elements.banButton.textContent = busy && action === "ban" ? "正在封禁…" : "封禁玩家";
    elements.unbanButton.textContent = busy && action === "unban" ? "正在解封…" : "解封玩家";
    elements.detailRefresh.textContent = busy && action === "detail-refresh" ? "正在刷新…" : "刷新玩家状态";
    elements.teleportButton.textContent = busy && action === "teleport" ? "正在传送…" : "确认救援";
    ruleControls.forEach(({ button }, key) => { button.textContent = busy && action === `rule-${key}` ? "正在保存…" : "保存规则"; });
    syncControls();
  }

  function resetSession() {
    finishConfirmation(false);
    state.user = null;
    state.csrfToken = "";
    state.locateBusy = false;
    state.locatePending = null;
    elements.locateStructure.value = "mansion";
    elements.locateOriginDimension.value = "minecraft:overworld";
    elements.locateX.value = elements.locateZ.value = "0";
    clearLocateResult();
    state.players = [];
    state.loaded = false;
    state.updatedAt = null;
    state.settingsReady = false;
    state.settingsUpdatedAt = null;
    state.lastAction = null;
    state.overviewLoading = state.whitelistLoading = state.settingsLoading = false;
    state.overviewReady = false;
    state.overview = null;
    state.rules = state.bans = state.detail = null;
    state.rulesReady = state.bansReady = state.detailReady = false;
    state.rulesLoading = state.bansLoading = state.detailLoading = false;
    state.rulesUpdatedAt = state.bansUpdatedAt = state.detailUpdatedAt = null;
    state.detailName = "";
    elements.banName.value = elements.banReason.value = elements.unbanName.value = "";
    elements.banReason.setCustomValidity("");
    [elements.rulesMessage, elements.bansMessage, elements.detailMessage].forEach((element) => message(element, ""));
    renderRules();
    renderBans();
    renderPlayerDetail();
    elements.announcement.value = "";
    elements.announcement.setCustomValidity("");
    elements.timeValue.value = "day";
    elements.weatherValue.value = "clear";
    elements.weatherSeconds.value = "300";
    elements.dailyStatus.textContent = "尚未读取在线玩家与主世界时间";
    renderOverview();
    selectTab("daily");
    message(elements.dailyMessage, "");
    difficulty.input.value = "peaceful";
    difficulty.input.setCustomValidity("");
    difficulty.current.textContent = "当前：—";
    elements.key.value = "";
    elements.name.value = "";
    elements.search.value = "";
    elements.dashboard.hidden = true;
    elements.account.hidden = true;
    elements.login.hidden = false;
    setConnection(false);
    renderPlayers();
    message(elements.message, "");
    message(elements.settingsMessage, "");
  }

  function applySession(data) {
    if (data?.authenticated !== true || typeof data.csrfToken !== "string" || !data.csrfToken || typeof data.user?.name !== "string") {
      throw new APIError("登录信息无效，请重新登录。", 401);
    }
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    elements.adminName.textContent = data.user.name;
    elements.login.hidden = true;
    elements.dashboard.hidden = false;
    elements.account.hidden = false;
    renderLocateOriginHint();
    const requestedTab = window.location.hash.slice(1);
    selectTab(tabNames.includes(requestedTab) ? requestedTab : "daily");
    message(elements.loginMessage, "");
  }

  function applyPlayers(data) {
    if (!Array.isArray(data?.players) || data.players.some((player) => typeof player?.name !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(player.name))) {
      throw new APIError("服务器返回的白名单数据不完整，请刷新确认。", 502);
    }
    state.players = data.players;
    state.loaded = true;
    state.updatedAt = data.updatedAt || null;
    setConnection(true);
    renderPlayers();
  }

  function handleError(error, writing = false) {
    if (error.status === 401) {
      resetSession();
      message(elements.loginMessage, "登录已失效，请重新输入管理密钥。");
      elements.key.focus();
      return;
    }
    if (!writing || error.status === 0 || error.status >= 500) setConnection(false);
    let text = error.message || "请求失败，请刷新重试。";
    if (writing && (error.status === 0 || error.status >= 500)) {
      text = "操作结果暂时无法确认。服务器可能已执行变更，请先刷新白名单核对，不要重复提交。";
    } else if (!state.connected) {
      text += " 当前已暂停添加和移除，请先刷新服务器状态。";
    }
    message(elements.message, text);
  }

  async function loadPlayers() {
    setConnection(false, true);
    try { applyPlayers(await request("/api/whitelist")); }
    catch (error) { handleError(error); }
  }

  function validateSettings(data) {
    const settings = data?.settings;
    if (!settings || typeof settings.difficulty !== "string" || !Object.hasOwn(difficultyLabels, settings.difficulty)) {
      throw new APIError("服务器返回的难度数据不完整，请刷新难度确认。", 502);
    }
    return settings;
  }

  function applySettings(data) {
    const settings = validateSettings(data);
    state.settingsReady = true;
    state.settingsLoading = false;
    state.settingsUpdatedAt = data.updatedAt || null;
    difficulty.input.value = settings.difficulty;
    difficulty.input.setCustomValidity("");
    difficulty.current.textContent = `当前：${difficultyLabels[settings.difficulty]}`;
    renderFreshness();
    syncControls();
  }

  function handleSettingsError(error, writing = false) {
    if (error.status === 401) { handleError(error); return; }
    const uncertain = error.status === 0 || error.status >= 500;
    if (!writing || uncertain) {
      state.settingsReady = false;
      state.settingsLoading = false;
      renderFreshness();
      syncControls();
    }
    let text = error.message || "难度请求失败，请刷新重试。";
    if (writing && uncertain) {
      text = "难度保存结果暂时无法确认。服务器可能已执行变更，请先刷新难度核对，不要重复提交。";
    } else if (!state.settingsReady) {
      text += " 难度编辑已暂停，刷新成功后可继续操作。";
    }
    message(elements.settingsMessage, text);
  }

  async function loadSettings() {
    state.settingsReady = false;
    state.settingsLoading = true;
    renderFreshness();
    syncControls();
    try { applySettings(await request("/api/settings")); }
    catch (error) { handleSettingsError(error); }
  }

  async function loadDashboard() {
    await loadOverview();
    if (state.user) await loadPlayers();
    if (state.user) await loadSettings();
    if (state.user) await loadRules();
    if (state.user) await loadBans();
    if (state.user && state.detailName && state.overviewReady) await loadPlayerDetail();
  }

  function buildRuleForms() {
    ruleDefinitions.forEach((rule) => {
      const form = document.createElement("form");
      form.className = "setting-form";
      const labelRow = document.createElement("div");
      labelRow.className = "setting-label";
      const label = document.createElement("label");
      label.htmlFor = `rule-${rule.key}`;
      label.textContent = rule.label;
      const current = document.createElement("span");
      current.className = "current-value";
      const note = document.createElement("p");
      note.id = `rule-note-${rule.key}`;
      note.className = "field-note";
      note.textContent = rule.note;
      const controls = document.createElement("div");
      controls.className = "setting-control";
      const input = document.createElement(rule.type === "boolean" ? "select" : "input");
      input.id = label.htmlFor;
      input.required = true;
      input.disabled = true;
      input.setAttribute("aria-describedby", note.id);
      if (rule.type === "boolean") {
        input.append(new Option("开启", "true"), new Option("关闭", "false"));
      } else {
        input.type = "number";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.inputMode = "numeric";
      }
      const button = document.createElement("button");
      button.type = "submit";
      button.className = "button button-subtle";
      button.textContent = "保存规则";
      button.disabled = true;
      button.setAttribute("aria-label", `保存${rule.label}`);
      button.setAttribute("aria-haspopup", "dialog");
      labelRow.append(label, current);
      controls.append(input, button);
      form.append(labelRow, note, controls);
      elements.rules.append(form);
      ruleControls.set(rule.key, { form, input, button, current });
      input.addEventListener("input", syncControls);
      input.addEventListener("change", syncControls);
      form.addEventListener("submit", (event) => { event.preventDefault(); saveRule(rule); });
    });
    renderRules();
  }

  function ruleLabel(rule, value) {
    return rule.type === "boolean" ? value ? "开启" : "关闭" : `${value}%`;
  }

  function renderRules() {
    ruleDefinitions.forEach((rule) => {
      const controls = ruleControls.get(rule.key);
      if (!controls) return;
      const value = state.rules?.get(rule.key);
      controls.current.textContent = value === undefined ? "当前：—" : `当前：${ruleLabel(rule, value)}`;
      controls.input.value = value === undefined ? "" : String(value);
    });
    renderFreshness();
    syncControls();
  }

  function validateRules(data) {
    if (!Array.isArray(data?.rules) || data.rules.length !== ruleDefinitions.length) {
      throw new APIError("服务器返回的游戏规则不完整，请刷新规则确认。", 502);
    }
    const rules = new Map();
    data.rules.forEach((entry) => {
      const rule = ruleDefinitions.find((candidate) => candidate.key === entry?.key);
      if (!rule || rules.has(rule.key) || (rule.type === "boolean" ? typeof entry.value !== "boolean" :
        !Number.isSafeInteger(entry.value) || entry.value < 0)) {
        throw new APIError("服务器返回的游戏规则无效，请刷新规则确认。", 502);
      }
      rules.set(rule.key, entry.value);
    });
    return rules;
  }

  function applyRules(data) {
    state.rules = validateRules(data);
    state.rulesReady = true;
    state.rulesLoading = false;
    state.rulesUpdatedAt = data.updatedAt || null;
    renderRules();
  }

  function handleRulesError(error, writing = false) {
    if (error.status === 401) { handleError(error); return; }
    state.rulesReady = state.rulesLoading = false;
    renderFreshness();
    syncControls();
    const uncertain = error.status === 0 || error.status >= 500;
    message(elements.rulesMessage, writing && uncertain ?
      "规则保存结果暂时无法确认，服务器可能已执行变更。已保留上次读取值，请刷新规则核对，不要重复提交。" :
      `${error.message || "规则请求失败。"} 规则编辑已暂停，请手动刷新后继续。`);
  }

  async function loadRules() {
    state.rulesReady = false;
    state.rulesLoading = true;
    renderFreshness();
    syncControls();
    try { applyRules(await request("/api/gamerules")); }
    catch (error) { handleRulesError(error); }
  }

  async function saveRule(rule) {
    const { form, input, button } = ruleControls.get(rule.key);
    if (state.busy || !state.rulesReady || !form.reportValidity()) return;
    const value = rule.type === "boolean" ? input.value === "true" : Number(input.value);
    if (rule.type === "boolean" ? !["true", "false"].includes(input.value) : !Number.isInteger(value) || value < 0 || value > 100) return;
    const current = state.rules.get(rule.key);
    if (current === value) return;
    if (!await confirmAction(`确认修改${rule.label}？`,
      `将从「${ruleLabel(rule, current)}」改为「${ruleLabel(rule, value)}」，修改立即影响全服。${rule.note}`, "确认保存规则", button)) return;
    if (!state.user || state.busy || !state.rulesReady) return;
    setBusy(true, `rule-${rule.key}`);
    message(elements.rulesMessage, "");
    try {
      const data = await request(`/api/gamerules/${encodeURIComponent(rule.key)}`, writeOptions("PATCH", { value }));
      if (validateRules(data).get(rule.key) !== value) throw new APIError("返回的规则与提交值不一致，请刷新核对。", 502);
      applyRules(data);
      message(elements.rulesMessage, `${rule.label}已设为${ruleLabel(rule, value)}，服务器已读回确认。`, "success");
      state.lastAction = { label: `修改${rule.label}`, updatedAt: data.updatedAt || null };
      renderFreshness();
    } catch (error) { handleRulesError(error, true); }
    finally { setBusy(false); }
    if (state.user && state.rulesReady) input.focus();
    else if (!state.user) elements.key.focus();
  }

  function renderBans() {
    elements.bans.textContent = state.bans?.rawOutput || "";
    elements.bans.hidden = !state.bans;
    elements.bansEmpty.hidden = Boolean(state.bans);
    elements.bansSummary.textContent = state.bans ? `最近一次读取：共 ${state.bans.count} 位封禁玩家。以下为服务器返回的报告。` : "尚未读取封禁名单";
    renderFreshness();
    syncControls();
  }

  function applyBans(data) {
    if (!Number.isInteger(data?.bans?.count) || data.bans.count < 0 || typeof data.bans.rawOutput !== "string") {
      throw new APIError("服务器返回的封禁报告不完整，请刷新确认。", 502);
    }
    state.bans = data.bans;
    state.bansUpdatedAt = data.updatedAt || null;
    state.bansReady = true;
    state.bansLoading = false;
    renderBans();
  }

  function handleBansError(error, writing = false) {
    if (error.status === 401) { handleError(error); return; }
    state.bansReady = state.bansLoading = false;
    renderFreshness();
    syncControls();
    const uncertain = error.status === 0 || error.status >= 500;
    message(elements.bansMessage, writing && uncertain ?
      "封禁操作结果暂时无法确认，服务器可能已执行。已保留上次报告，请先刷新封禁名单核对，不要重复提交。" :
      `${error.message || "封禁请求失败。"} 封禁与解封已暂停，请手动刷新后继续。`);
  }

  async function loadBans() {
    state.bansReady = false;
    state.bansLoading = true;
    renderFreshness();
    syncControls();
    try { applyBans(await request("/api/bans")); }
    catch (error) { handleBansError(error); }
  }

  async function changeBan(name, reason, removing = false) {
    if (state.busy || !state.bansReady) return;
    const trigger = removing ? elements.unbanButton : elements.banButton;
    if (!await confirmAction(`确认${removing ? "解封" : "封禁"} ${name}？`, removing ?
      "解封后，该玩家可重新尝试加入服务器，仍需满足白名单等加入条件。" :
      `该玩家将无法加入服务器，当前在线连接也会被断开。封禁原因：${reason}`, removing ? "确认解封" : "确认封禁", trigger)) return;
    if (!state.user || state.busy || !state.bansReady) return;
    setBusy(true, removing ? "unban" : "ban");
    message(elements.bansMessage, "");
    try {
      const data = await request(removing ? `/api/bans/${encodeURIComponent(name)}` : "/api/bans", writeOptions(removing ? "DELETE" : "POST", removing ? undefined : { name, reason }));
      applyBans(data);
      message(elements.bansMessage, `服务器已确认${removing ? "解封" : "封禁"} ${name}，封禁报告已刷新。`, "success");
      if (removing) elements.unbanName.value = "";
      else elements.banName.value = elements.banReason.value = "";
      state.lastAction = { label: `${removing ? "解封" : "封禁"} ${name}`, updatedAt: data.updatedAt || null };
      renderFreshness();
      if (!removing) await loadOverview();
    } catch (error) {
      handleBansError(error, true);
      if (!removing && state.user) {
        state.overviewReady = false;
        if (samePlayer(name, state.detailName)) state.detailReady = false;
        renderFreshness();
        syncControls();
      }
    } finally { setBusy(false); }
    if (!state.user) elements.key.focus();
  }

  function samePlayer(left, right) { return Boolean(left && right) && left.toLowerCase() === right.toLowerCase(); }

  function isOnline(name) {
    return Boolean(name) && Boolean(state.overview?.server.players.some((player) => samePlayer(name, player.name)));
  }

  function renderPlayerDetail() {
    elements.detailPanel.hidden = !state.detailName;
    elements.detailName.textContent = state.detailName || "—";
    elements.detailHeading.textContent = state.detailName ? `${state.detailName} · 详情与救援` : "玩家详情与救援";
    const dimensions = { "minecraft:overworld": "主世界", "minecraft:the_nether": "下界", "minecraft:the_end": "末地" };
    elements.detailDimension.textContent = state.detail ? dimensions[state.detail.dimension] || state.detail.dimension : "—";
    elements.detailPosition.textContent = state.detail ? state.detail.position.map((value) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })).join(" / ") : "—";
    const target = elements.teleportTarget.value;
    const others = (state.overview?.server.players || []).filter((player) => !samePlayer(player.name, state.detailName));
    elements.teleportTarget.replaceChildren(new Option(others.length ? "请选择另一名在线玩家" : "没有可用的在线目标玩家", ""));
    others.forEach((player) => { elements.teleportTarget.add(new Option(player.name, player.name)); });
    if (others.some((player) => player.name === target)) elements.teleportTarget.value = target;
    renderFreshness();
    syncControls();
  }

  function handleDetailError(error, writing = false) {
    if (error.status === 401) { handleError(error); return; }
    state.detailReady = state.detailLoading = false;
    state.overviewReady = false;
    renderFreshness();
    syncControls();
    const uncertain = error.status === 0 || error.status >= 500;
    message(elements.detailMessage, writing && uncertain ?
      "传送结果暂时无法确认，服务器可能已执行。已保留上次位置，请刷新玩家状态并核对游戏内位置，不要重复提交。" :
      `${error.message || "玩家状态读取失败。"} 救援已暂停，请刷新玩家状态后继续。`);
  }

  async function loadPlayerDetail() {
    if (!state.detailName) return;
    state.detailReady = false;
    if (!state.overviewReady || !isOnline(state.detailName)) {
      state.detailLoading = false;
      renderFreshness();
      syncControls();
      message(elements.detailMessage, state.overviewReady ? "该玩家已不在最近读取的在线列表中，救援已暂停。" : "在线状态尚未确认，请刷新玩家状态后继续。");
      return;
    }
    state.detailLoading = true;
    renderFreshness();
    syncControls();
    try {
      const data = await request(`/api/players/${encodeURIComponent(state.detailName)}`);
      const player = data?.player;
      if (!player || typeof player.name !== "string" || !samePlayer(player.name, state.detailName) ||
        typeof player.dimension !== "string" || !player.dimension || !Array.isArray(player.position) ||
        player.position.length !== 3 || player.position.some((value) => !Number.isFinite(value))) {
        throw new APIError("服务器返回的玩家位置不完整，请刷新玩家状态确认。", 502);
      }
      state.detail = player;
      state.detailReady = true;
      state.detailLoading = false;
      state.detailUpdatedAt = data.updatedAt || null;
      renderPlayerDetail();
    } catch (error) { handleDetailError(error); }
  }

  async function openPlayerDetail(name) {
    if (state.busy || !state.overviewReady) return;
    if (!samePlayer(state.detailName, name)) {
      state.detail = null;
      state.detailUpdatedAt = null;
      state.detailReady = false;
      elements.teleportTarget.value = "";
    }
    state.detailName = name;
    message(elements.detailMessage, "");
    renderPlayerDetail();
    setBusy(true, "detail-refresh");
    try { await loadPlayerDetail(); }
    finally { setBusy(false); }
    if (state.user) elements.detailHeading.focus();
    else elements.key.focus();
  }

  async function teleportPlayer() {
    const player = state.detailName;
    const target = elements.teleportTarget.value;
    if (state.busy || !state.overviewReady || !state.detailReady || !isOnline(player) || !isOnline(target) || samePlayer(player, target)) return;
    if (!await confirmAction(`将 ${player} 传送到 ${target}？`,
      `${player} 将立即移动到 ${target} 身边，可能跨维度。请确认目标玩家所在位置安全。`, "确认传送", elements.teleportButton)) return;
    if (!state.user || state.busy || !state.overviewReady || !state.detailReady) return;
    setBusy(true, "teleport");
    message(elements.detailMessage, "");
    try {
      const result = await request("/api/actions/teleport", writeOptions("POST", { player, target }));
      if (typeof result?.message !== "string" || !result.message) throw new APIError("传送响应不完整，请核对服务器。", 502);
      state.lastAction = { label: `将 ${player} 传送到 ${target}`, updatedAt: result.updatedAt || null };
      state.detailReady = false;
      message(elements.detailMessage, result.message, "success");
      await loadOverview();
      if (state.user) await loadPlayerDetail();
    } catch (error) { handleDetailError(error, true); }
    finally { setBusy(false); }
    if (!state.user) elements.key.focus();
  }

  function clearLocateResult() {
    state.locateVersion += 1;
    state.locateResult = null;
    elements.locateResult.hidden = true;
    elements.locateEmpty.hidden = false;
    elements.locateStatus.textContent = "等待查询";
    elements.locateResultName.textContent = elements.locateResultOrigin.textContent = elements.locateResultSearchOrigin.textContent = "";
    elements.locateResultSearchOrigin.hidden = true;
    elements.locateResultDistanceLabel.textContent = "水平距离";
    elements.locateResultBearingLabel.textContent = "前进方向";
    [elements.locateResultX, elements.locateResultY, elements.locateResultZ, elements.locateResultDimension,
      elements.locateResultDistance, elements.locateResultBearing].forEach((element) => { element.textContent = "—"; });
    elements.locateResultYRow.hidden = true;
    elements.locateHeightNote.hidden = false;
    elements.locateHeightNote.textContent = "服务器未提供高度，请到达目标附近后探索。";
    elements.locateX.setCustomValidity("");
    elements.locateZ.setCustomValidity("");
    renderLocateOriginHint();
    message(elements.locateMessage, "");
    syncControls();
  }

  function locateQuery() {
    return {
      structure: elements.locateStructure.value, originDimension: elements.locateOriginDimension.value,
      x: elements.locateX.valueAsNumber, z: elements.locateZ.valueAsNumber,
    };
  }

  function locateOrigins(query) {
    if (!Object.hasOwn(structureDefinitions, query.structure) || !Object.hasOwn(dimensionLabels, query.originDimension)) {
      throw new APIError("请选择有效的目标结构和你所在的维度。", 400);
    }
    const targetDimension = structureDefinitions[query.structure].dimension;
    if (query.originDimension !== targetDimension && [query.originDimension, targetDimension].includes("minecraft:the_end")) {
      throw new APIError(`末地与其他维度无法换算坐标。请将当前维度选为${dimensionLabels[targetDimension]}，并填写该维度中的坐标。`, 400);
    }
    if (![query.x, query.z].every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 29999984)) {
      throw new APIError("请填写 −29,999,984 至 29,999,984 之间的整数坐标。", 400);
    }
    const origin = { dimension: query.originDimension, x: query.x, z: query.z };
    const searchOrigin = { ...origin, dimension: targetDimension };
    if (origin.dimension !== targetDimension) {
      const convert = targetDimension === "minecraft:the_nether" ? (value) => Math.floor(value / 8) : (value) => value * 8;
      searchOrigin.x = convert(origin.x);
      searchOrigin.z = convert(origin.z);
      if (Math.abs(searchOrigin.x) > 29999984 || Math.abs(searchOrigin.z) > 29999984) {
        throw new APIError("换算后的搜索起点超出世界范围，请填写更靠近中心的坐标。", 400);
      }
    }
    return { origin, searchOrigin };
  }

  function renderLocateOriginHint() {
    const query = locateQuery();
    const structure = structureDefinitions[query.structure];
    elements.locateDimensionNote.textContent = `目标结构所在维度：${dimensionLabels[structure?.dimension] || "—"}。${structure?.note || ""}`;
    try {
      const { origin, searchOrigin } = locateOrigins(query);
      const position = `${dimensionLabels[searchOrigin.dimension]} · X ${searchOrigin.x} / Z ${searchOrigin.z}`;
      const conversion = searchOrigin.dimension === "minecraft:the_nether" ? "主世界 → 下界：X、Z ÷ 8，结果向下取整。" : "下界 → 主世界：X、Z × 8。";
      elements.locateConversionNote.textContent = origin.dimension === searchOrigin.dimension ?
        `搜索起点：${position}，使用填写的原坐标。` : `换算后的搜索起点：${position}。${conversion}`;
      elements.locateConversionNote.dataset.type = "info";
    } catch (error) {
      elements.locateConversionNote.textContent = error.message;
      elements.locateConversionNote.dataset.type = "error";
    }
  }

  function horizontalBearing(dx, dz) {
    if (dx === 0 && dz === 0) return "就在起点";
    const angle = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    return ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.round(angle / 45) % 8];
  }

  function formatLocateCoordinates(result) {
    const location = result.structure === "stronghold" ? "要塞定位点（需在要塞内寻找末地传送门） · " : "";
    return `${dimensionLabels[result.dimension]} · ${location}X: ${result.x}${result.y == null ? "" : `, Y: ${result.y}`}, Z: ${result.z}`;
  }

  function applyLocateResult(data, query) {
    const result = data?.result;
    const structure = structureDefinitions[query.structure];
    const { origin, searchOrigin } = locateOrigins(query);
    const matchesOrigin = (actual, expected) => actual?.dimension === expected.dimension && actual.x === expected.x && actual.z === expected.z;
    if (!result || result.structure !== query.structure || result.dimension !== structure.dimension ||
      !Number.isSafeInteger(result.x) || !Number.isSafeInteger(result.z) ||
      Math.abs(result.x) > 30000000 || Math.abs(result.z) > 30000000 ||
      (result.y != null && !Number.isSafeInteger(result.y)) ||
      !matchesOrigin(result.origin, origin) || !matchesOrigin(result.searchOrigin, searchOrigin)) {
      throw new APIError("服务器返回的结构坐标不完整，请稍后重新查询。", 502);
    }
    const dx = result.x - searchOrigin.x;
    const dz = result.z - searchOrigin.z;
    state.locateResult = { ...result, origin, searchOrigin, updatedAt: data.updatedAt || null };
    elements.locateResultName.textContent = structure.resultLabel || structure.label;
    elements.locateResultOrigin.textContent = `填写的起点：${dimensionLabels[origin.dimension]} · X ${origin.x} / Z ${origin.z}`;
    elements.locateResultSearchOrigin.textContent = `换算后的搜索起点：${dimensionLabels[searchOrigin.dimension]} · X ${searchOrigin.x} / Z ${searchOrigin.z}`;
    elements.locateResultSearchOrigin.hidden = origin.dimension === searchOrigin.dimension;
    elements.locateResultX.textContent = String(result.x);
    elements.locateResultZ.textContent = String(result.z);
    elements.locateResultY.textContent = result.y == null ? "—" : String(result.y);
    elements.locateResultYRow.hidden = result.y == null;
    elements.locateHeightNote.hidden = result.y != null && !structure.note;
    elements.locateHeightNote.textContent = `${structure.note || ""}${result.y == null ? "服务器未提供高度，请到达目标附近后探索。" : ""}`;
    elements.locateResultDimension.textContent = dimensionLabels[result.dimension];
    elements.locateResultDistanceLabel.textContent = `${dimensionLabels[result.dimension]}水平距离`;
    elements.locateResultBearingLabel.textContent = `${dimensionLabels[result.dimension]}方向`;
    elements.locateResultDistance.textContent = `约 ${Math.round(Math.hypot(dx, dz)).toLocaleString("zh-CN")} 格`;
    elements.locateResultBearing.textContent = horizontalBearing(dx, dz);
    const updatedAt = formatUpdatedAt(data.updatedAt);
    elements.locateStatus.textContent = updatedAt ? `查询完成 · ${updatedAt}` : "查询完成";
    elements.locateEmpty.hidden = true;
    elements.locateResult.hidden = false;
  }

  async function locateStructure() {
    if (state.busy || state.locateBusy || !state.user) return;
    [elements.locateX, elements.locateZ].forEach((input) => {
      const value = input.valueAsNumber;
      input.setCustomValidity(Number.isSafeInteger(value) && Math.abs(value) <= 29999984 ? "" : "请输入 −29,999,984 至 29,999,984 之间的整数。");
    });
    if (!elements.locateForm.reportValidity() || !Object.hasOwn(structureDefinitions, elements.locateStructure.value)) return;
    const query = locateQuery();
    try { locateOrigins(query); }
    catch {
      renderLocateOriginHint();
      return;
    }
    clearLocateResult();
    const version = state.locateVersion;
    const csrfToken = state.csrfToken;
    state.locatePending = version;
    state.locateBusy = true;
    elements.locateStatus.textContent = "正在搜索附近的结构，请稍候…";
    elements.locateEmpty.hidden = true;
    syncControls();
    const isCurrent = () => state.user && state.csrfToken === csrfToken && state.locateVersion === version;
    try {
      const data = await request("/api/locate", writeOptions("POST", query));
      if (isCurrent()) applyLocateResult(data, query);
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status === 401) { handleError(error); return; }
      elements.locateStatus.textContent = "本次查询未完成";
      message(elements.locateMessage, error.status === 0 ? "查询结果暂时无法确认，服务器可能仍在搜索。请稍候再查询，避免连续重复提交。" : error.message || "暂时无法定位，请稍后重新查询。");
    } finally {
      if (state.locatePending === version) {
        state.locatePending = null;
        state.locateBusy = false;
        syncControls();
      }
    }
  }

  function selectTab(name, focus = false, updateHash = false) {
    tabNames.forEach((tab) => {
      const selected = name === tab;
      const button = byId(`tab-${tab}`);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      byId(`${tab}-panel`).hidden = !selected;
      if (selected && focus) button.focus();
    });
    if (updateHash) window.history.replaceState(null, "", `#${name}`);
  }

  function confirmAction(title, description, label, trigger) {
    if (state.busy || state.confirmation) return Promise.resolve(false);
    return new Promise((resolve) => {
      state.confirmation = { resolve, trigger };
      elements.confirmationTitle.textContent = title;
      elements.confirmationDescription.textContent = description;
      elements.confirmationSubmit.textContent = label;
      setBusy(true, "confirm");
      elements.confirmation.showModal();
      elements.confirmationCancel.focus();
    });
  }

  function finishConfirmation(confirmed) {
    const pending = state.confirmation;
    if (!pending) return;
    state.confirmation = null;
    if (elements.confirmation.open) elements.confirmation.close();
    setBusy(false);
    pending.trigger?.focus();
    pending.resolve(confirmed);
  }

  function renderOverview() {
    const server = state.overview?.server;
    elements.onlineCount.textContent = server ? `${server.players.length} / ${server.maxPlayers}` : "—";
    const minutes = server ? (Math.floor(server.dayTime * 60 / 1000) + 360) % 1440 : 0;
    elements.worldTime.textContent = server ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` : "—";
    elements.worldTimeNote.textContent = server ? `${server.dayTime} ticks · 主世界昼夜周期` : "主世界昼夜周期 · 等待读取";
    renderFreshness();
    elements.onlinePlayers.replaceChildren();
    elements.onlineEmpty.hidden = Boolean(server?.players.length);
    elements.onlineEmpty.textContent = server ? "最近一次读取时，没有玩家在线。" : "读取服务器后显示在线玩家。";
    (server?.players || []).forEach((player) => {
      const item = document.createElement("li");
      item.className = "online-player";
      const button = makeButton("踢出", "button-danger", async () => {
        if (state.busy || !state.overviewReady) return;
        if (await confirmAction(`确认踢出 ${player.name}？`, "这会断开该玩家当前连接；玩家仍可重新登录，不会被封禁。", "确认踢出", button)) {
          runAction("kick", { player: player.name });
        }
      });
      button.setAttribute("aria-label", `踢出在线玩家 ${player.name}`);
      const detailButton = makeButton("详情 / 救援", "button-subtle", () => openPlayerDetail(player.name));
      detailButton.setAttribute("aria-label", `查看 ${player.name} 的详情与救援`);
      detailButton.setAttribute("aria-controls", "player-detail-panel");
      const actions = document.createElement("span");
      actions.className = "online-actions";
      actions.append(detailButton, button);
      item.append(playerIdentity(player.name), actions);
      elements.onlinePlayers.append(item);
    });
    if (state.detailName && state.overviewReady && !isOnline(state.detailName)) state.detailReady = false;
    renderPlayerDetail();
    syncControls();
  }

  async function loadOverview() {
    state.overviewReady = false;
    state.overviewLoading = true;
    elements.dailyStatus.textContent = "正在读取在线玩家与主世界时间…";
    renderFreshness();
    syncControls();
    try {
      const data = await request("/api/overview");
      const server = data?.server;
      if (!server || !Array.isArray(server.players) || server.players.some((player) =>
        typeof player?.name !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(player.name)) ||
        !Number.isInteger(server.maxPlayers) || server.maxPlayers < 0 ||
        !Number.isInteger(server.dayTime) || server.dayTime < 0 || server.dayTime >= 24000) {
        throw new APIError("服务器返回的在线状态不完整，请手动刷新确认。", 502);
      }
      state.overview = data;
      state.overviewReady = true;
      state.overviewLoading = false;
      elements.dailyStatus.textContent = "在线列表和主世界时间为同一次读取结果";
      renderOverview();
    } catch (error) { handleDailyError(error); }
  }

  function handleDailyError(error, action = "") {
    if (error.status === 401) { handleError(error); return; }
    state.overviewReady = false;
    state.overviewLoading = false;
    elements.dailyStatus.textContent = "日常操作已暂停，请手动刷新在线与时间后继续";
    renderFreshness();
    syncControls();
    const uncertain = error.status === 0 || error.status >= 500;
    let text = error.message || "请求未完成，请手动刷新后重试。";
    if (action && uncertain) {
      text = action === "save" ? "保存结果暂时无法确认。请检查服务端日志，刷新在线列表不能证明存档已保存；不要连续重复提交。" :
        "操作结果暂时无法确认，服务器可能已执行。请核对服务端日志或游戏内状态，不要重复提交；手动刷新后可恢复操作。";
    }
    message(elements.dailyMessage, text);
  }

  async function runAction(action, data) {
    if (state.busy || !state.overviewReady) return;
    setBusy(true, action);
    message(elements.dailyMessage, "");
    try {
      const result = await request(`/api/actions/${action}`, writeOptions("POST", data));
      if (typeof result?.message !== "string" || !result.message) throw new APIError("操作响应不完整，请核对服务器。", 502);
      const labels = { announce: "发送公告", kick: "踢出玩家", time: "设置时间", weather: "设置天气", save: "保存世界" };
      state.lastAction = { label: labels[action], updatedAt: result.updatedAt || null };
      renderFreshness();
      message(elements.dailyMessage, result.message, "success");
      if (action === "announce") elements.announcement.value = "";
      if (action === "kick" || action === "time") await loadOverview();
    } catch (error) { handleDailyError(error, action); }
    finally { setBusy(false); }
    if (!state.user) elements.key.focus();
  }

  function makeButton(text, className, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button button-small ${className}`;
    button.textContent = text;
    button.addEventListener("click", callback);
    return button;
  }

  function renderPlayers() {
    elements.players.replaceChildren();
    elements.count.textContent = state.loaded ? String(state.players.length) : "—";
    const query = elements.search.value.trim().toLowerCase();
    const players = state.players.filter((player) => player.name.toLowerCase().includes(query));
    elements.empty.hidden = players.length !== 0;
    elements.empty.textContent = !state.loaded ? "连接服务器后显示白名单。" : query ? "没有匹配的玩家，试试其他玩家名。" : "白名单还是空的，在上方添加第一位玩家。";
    elements.summary.textContent = state.loaded ? `共 ${state.players.length} 位玩家，显示 ${players.length} 位。` : "尚未读取白名单。";
    players.forEach((player) => {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "player-name";
      name.append(playerIdentity(player.name));
      const actions = document.createElement("td");
      actions.className = "actions";
      const removeButton = makeButton("移除", "button-danger", async () => {
        if (state.busy || !state.connected) return;
        if (await confirmAction(`确认将 ${player.name} 移出白名单？`,
          "移除的是白名单资格。服务器同时开启白名单和强制白名单时，名单外在线玩家可能断开连接。",
          "确认移除", removeButton)) await removePlayer(player);
      });
      removeButton.setAttribute("aria-label", `移除 ${player.name}`);
      removeButton.setAttribute("aria-haspopup", "dialog");
      actions.append(removeButton);
      row.append(name, actions);
      elements.players.append(row);
    });
    syncControls();
  }

  function writeOptions(method, data) {
    return { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) };
  }

  async function removePlayer(player) {
    if (state.busy || !state.connected) return;
    setBusy(true, "remove");
    message(elements.message, "");
    try {
      const data = await request(`/api/whitelist/${encodeURIComponent(player.name)}`, writeOptions("DELETE"));
      applyPlayers(data);
      message(elements.message, `已将 ${player.name} 移出白名单。`, "success");
    } catch (error) { handleError(error, true); }
    finally { setBusy(false); }
    if (state.user) elements.search.focus();
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || !elements.loginForm.reportValidity()) return;
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: elements.key.value }) };
    elements.key.value = "";
    setBusy(true, "login");
    message(elements.loginMessage, "");
    try {
      const pending = request("/auth/login", options);
      options.body = "";
      applySession(await pending);
      await loadDashboard();
    } catch (error) {
      resetSession();
      message(elements.loginMessage, error.status === 401 ? "管理密钥不正确，请重新输入。" : error.message);
    } finally {
      options.body = "";
      setBusy(false);
      (state.user ? elements.refresh : elements.key).focus();
    }
  });

  elements.logout.addEventListener("click", async () => {
    if (state.busy) return;
    clearLocateResult();
    setBusy(true, "logout");
    try {
      await request("/auth/logout", writeOptions("POST"));
      resetSession();
      message(elements.loginMessage, "已退出登录。", "info");
    } catch (error) { handleError(error); }
    finally { setBusy(false); }
    if (!state.user) elements.key.focus();
  });

  elements.refresh.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true, "refresh");
    message(elements.message, "");
    message(elements.settingsMessage, "");
    message(elements.dailyMessage, "");
    [elements.rulesMessage, elements.bansMessage, elements.detailMessage].forEach((element) => message(element, ""));
    try { await loadDashboard(); }
    finally { setBusy(false); }
  });

  elements.settingsRefresh.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true, "settings-refresh");
    message(elements.settingsMessage, "");
    try { await loadSettings(); }
    finally { setBusy(false); }
    if (!state.user) elements.key.focus();
  });

  difficulty.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || !state.settingsReady) return;
    if (!difficulty.form.reportValidity()) return;
    const value = difficulty.input.value;
    if (!Object.hasOwn(difficultyLabels, value)) return;
    setBusy(true, "save-difficulty");
    message(elements.settingsMessage, "");
    try {
      const data = await request("/api/settings/difficulty", writeOptions("PATCH", { value }));
      const confirmedSettings = validateSettings(data);
      if (confirmedSettings.difficulty !== value) throw new APIError("返回的当前难度与提交值不一致，请刷新难度核对。", 502);
      applySettings(data);
      message(elements.settingsMessage, "游戏难度已保存，服务器已确认当前值。", "success");
    } catch (error) { handleSettingsError(error, true); }
    finally { setBusy(false); }
    if (state.user && state.settingsReady) difficulty.input.focus();
    else if (!state.user) elements.key.focus();
  });

  elements.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || !state.connected) return;
    elements.name.value = elements.name.value.trim();
    if (!elements.addForm.reportValidity()) return;
    const name = elements.name.value;
    setBusy(true, "add");
    message(elements.message, "");
    try {
      applyPlayers(await request("/api/whitelist", writeOptions("POST", { name })));
      elements.name.value = "";
      message(elements.message, `已将 ${name} 添加到白名单。`, "success");
    } catch (error) { handleError(error, true); }
    finally { setBusy(false); }
    if (state.user && state.connected) elements.name.focus();
  });

  tabNames.forEach((name, index) => {
    const tab = byId(`tab-${name}`);
    tab.addEventListener("click", () => selectTab(name, false, true));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabNames.length;
      else if (event.key === "ArrowLeft") next = (index + tabNames.length - 1) % tabNames.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabNames.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabNames[next], true, true);
    });
  });

  window.addEventListener("hashchange", () => {
    const name = window.location.hash.slice(1);
    if (state.user && tabNames.includes(name)) selectTab(name);
  });

  elements.locateForm.addEventListener("submit", (event) => { event.preventDefault(); locateStructure(); });
  [elements.locateStructure, elements.locateOriginDimension, elements.locateX, elements.locateZ].forEach((input) => {
    input.addEventListener("input", clearLocateResult);
    input.addEventListener("change", clearLocateResult);
  });
  elements.locateCopy.addEventListener("click", async () => {
    const result = state.locateResult;
    if (!state.user || state.locateBusy || !result) return;
    const coordinates = formatLocateCoordinates(result);
    try {
      await navigator.clipboard.writeText(coordinates);
      if (state.user && state.locateResult === result) message(elements.locateMessage, "坐标已复制。", "success");
    } catch {
      if (state.user && state.locateResult === result) message(elements.locateMessage, "无法写入剪贴板，请手动选择并复制上方坐标。");
    }
  });

  elements.overviewRefresh.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true, "overview-refresh");
    message(elements.dailyMessage, "");
    try { await loadOverview(); }
    finally { setBusy(false); }
  });

  elements.rulesRefresh.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true, "rules-refresh");
    message(elements.rulesMessage, "");
    try { await loadRules(); }
    finally { setBusy(false); }
  });

  elements.bansRefresh.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true, "bans-refresh");
    message(elements.bansMessage, "");
    try { await loadBans(); }
    finally { setBusy(false); }
  });

  elements.banReason.addEventListener("input", () => { elements.banReason.setCustomValidity(""); });
  elements.banForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !state.bansReady) return;
    elements.banName.value = elements.banName.value.trim();
    const reason = elements.banReason.value.trim();
    let error = "";
    if (!reason) error = "请输入封禁原因。";
    else if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(reason)) error = "封禁原因必须为单行文字，不包含换行或控制字符。";
    else if (reason.includes("@")) error = "封禁原因不能包含 @，请改用玩家名或其他文字。";
    else if ([...reason].length > 160 || reason.length > 256 || new TextEncoder().encode(reason).length > 512) error = "封禁原因过长：最多 160 个字符、512 字节；表情等特殊字符也占用长度，请缩短内容。";
    elements.banReason.setCustomValidity(error);
    if (!elements.banForm.reportValidity()) return;
    changeBan(elements.banName.value, reason);
  });

  elements.unbanForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !state.bansReady) return;
    elements.unbanName.value = elements.unbanName.value.trim();
    if (elements.unbanForm.reportValidity()) changeBan(elements.unbanName.value, "", true);
  });

  elements.detailRefresh.addEventListener("click", async () => {
    if (state.busy || !state.detailName) return;
    setBusy(true, "detail-refresh");
    message(elements.detailMessage, "");
    try {
      await loadOverview();
      if (state.user) await loadPlayerDetail();
    } finally { setBusy(false); }
  });

  elements.detailClose.addEventListener("click", () => {
    if (state.busy) return;
    state.detailName = "";
    state.detail = state.detailUpdatedAt = null;
    state.detailReady = false;
    renderPlayerDetail();
    elements.overviewRefresh.focus();
  });

  elements.teleportTarget.addEventListener("change", syncControls);
  elements.teleportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (elements.teleportForm.reportValidity()) teleportPlayer();
  });

  elements.announcement.addEventListener("input", () => { elements.announcement.setCustomValidity(""); });
  elements.announceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !state.overviewReady) return;
    const text = elements.announcement.value.trim();
    let error = "";
    if (!text) error = "请输入公告内容。";
    else if (/\p{Cc}/u.test(text)) error = "公告请使用单行文字，不包含换行或控制字符。";
    else if ([...text].length > 160 || new TextEncoder().encode(text).length > 512) error = "公告最多 160 个字符、512 字节，请缩短内容。";
    elements.announcement.setCustomValidity(error);
    if (!elements.announceForm.reportValidity()) return;
    runAction("announce", { message: text });
  });

  elements.timeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || !state.overviewReady || !elements.timeForm.reportValidity()) return;
    const value = elements.timeValue.value;
    if (!["day", "noon", "night", "midnight"].includes(value)) return;
    const labels = { day: "白天", noon: "正午", night: "夜晚", midnight: "午夜" };
    if (await confirmAction(`将主世界时间设为${labels[value]}？`, "这会立即改变主世界的昼夜时间。", "确认调整时间", elements.timeButton)) runAction("time", { value });
  });

  elements.weatherForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || !state.overviewReady || !elements.weatherForm.reportValidity()) return;
    const value = elements.weatherValue.value;
    const seconds = Number(elements.weatherSeconds.value);
    if (!["clear", "rain", "thunder"].includes(value) || ![300, 600, 1200, 3600].includes(seconds)) return;
    if (value === "thunder" && !await confirmAction("确认将主世界天气设为雷暴？", `持续 ${seconds / 60} 分钟，可能产生闪电并影响玩家和建筑。`, "确认开启雷暴", elements.weatherButton)) return;
    runAction("weather", { value, seconds });
  });

  elements.saveWorld.addEventListener("click", async () => {
    if (state.busy || !state.overviewReady) return;
    if (await confirmAction("确认保存当前世界？", "这会将当前存档写入磁盘，可能短暂影响响应；不会生成备份。", "确认保存", elements.saveWorld)) runAction("save", {});
  });

  elements.confirmationCancel.addEventListener("click", () => finishConfirmation(false));
  elements.confirmationSubmit.addEventListener("click", () => finishConfirmation(true));
  elements.confirmation.addEventListener("cancel", (event) => { event.preventDefault(); finishConfirmation(false); });
  elements.confirmation.addEventListener("close", () => { if (!elements.confirmation.open) finishConfirmation(false); });

  elements.search.addEventListener("input", () => renderPlayers());

  async function init() {
    buildRuleForms();
    renderBans();
    setBusy(true);
    try {
      applySession(await request("/api/session"));
      await loadDashboard();
    } catch (error) {
      resetSession();
      if (error.status !== 401) message(elements.loginMessage, error.message);
    } finally {
      elements.loading.hidden = true;
      setBusy(false);
    }
  }
  init();
})();
