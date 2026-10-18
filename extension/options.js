/**
 * WebAnnotator options.js
 *
 * 全页管理面板：首页概览 / 全文搜索 / 标签管理。
 * 通信方式与 popup 一致：经 background 转发到本地程序（Native Messaging）。
 *
 * 视图路由：URL hash 控制
 *   #home    首页概览（默认）
 *   #search  搜索全部标注
 *   #manage  标签管理（标签列表 / 按标签筛选）
 */

"use strict";

/* ================================================================== */
/* 常量定义                                                            */
/* ================================================================== */

/** 通信超时阈值（毫秒），与 popup 一致 */
const COMMUNICATION_TIMEOUT = 5000;

/** 主题模式枚举（与 C# ThemeMode 一致） */
const THEME_FOLLOW_SYSTEM = 0;
const THEME_LIGHT = 1;
const THEME_DARK = 2;

/** 分页大小 */
const DEFAULT_LIMIT = 50;
/** 首页最近标注条数 */
const HOME_RECENT_LIMIT = 10;

/** 搜索防抖延迟（毫秒） */
const SEARCH_DEBOUNCE_MS = 250;

/* ================================================================== */
/* 全局状态                                                            */
/* ================================================================== */

const state = {
  themeMode: THEME_FOLLOW_SYSTEM,
  mediaQueryList: null,
  currentView: "home",
  // 搜索
  searchOffset: 0,
  searchTotal: 0,
  searchQuery: "",
  // 标签筛选
  filterTagIds: [],
  filterTagName: "",
  filterOffset: 0,
  filterTotal: 0,
};

/* ================================================================== */
/* DOM 引用                                                           */
/* ================================================================== */

const dom = {};

function initDomRefs() {
  dom.themeToggle = document.getElementById("theme-toggle");
  dom.navTabs = document.getElementById("nav-tabs");
  dom.viewHome = document.getElementById("view-home");
  dom.viewSearch = document.getElementById("view-search");
  dom.viewManage = document.getElementById("view-manage");
  dom.homeStats = document.getElementById("home-stats");
  dom.homeRecent = document.getElementById("home-recent");
  dom.homeViewAll = document.getElementById("home-view-all");
  dom.exportCsvBtn = document.getElementById("export-csv-btn");
  dom.importCsvBtn = document.getElementById("import-csv-btn");
  dom.importCsvFile = document.getElementById("import-csv-file");
  dom.searchInput = document.getElementById("search-input");
  dom.searchTitle = document.getElementById("search-title");
  dom.searchCount = document.getElementById("search-count");
  dom.searchResults = document.getElementById("search-results");
  dom.searchMoreWrap = document.getElementById("search-more-wrap");
  dom.searchMoreBtn = document.getElementById("search-more-btn");
  dom.manageBreadcrumb = document.getElementById("manage-breadcrumb");
  dom.backToTags = document.getElementById("back-to-tags");
  dom.manageTitle = document.getElementById("manage-title");
  dom.manageCount = document.getElementById("manage-count");
  dom.tagList = document.getElementById("tag-list");
  dom.manageMoreWrap = document.getElementById("manage-more-wrap");
  dom.manageMoreBtn = document.getElementById("manage-more-btn");
  dom.statusBar = document.getElementById("status-bar");
  dom.statusText = document.getElementById("status-text");
  dom.deleteConfirm = document.getElementById("delete-confirm");
  dom.deleteConfirmTitle = document.getElementById("delete-confirm-title");
  dom.deleteConfirmDesc = document.getElementById("delete-confirm-desc");
  dom.deleteCancelBtn = document.getElementById("delete-cancel-btn");
  dom.deleteOkBtn = document.getElementById("delete-ok-btn");
}

/* ================================================================== */
/* 通信层（与 popup 相同，5s 超时）                                    */
/* ================================================================== */

function sendMessageWithTimeout(message, requestLabel = "请求") {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[WebAnnotator] ${requestLabel}超时（${COMMUNICATION_TIMEOUT}ms）:`, message);
      resolve({ success: false, error: `${requestLabel}超时，请重试`, errorCode: "TIMEOUT" });
    }, COMMUNICATION_TIMEOUT);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: `${requestLabel}通信失败`, errorCode: "COMMUNICATION_ERROR" });
          return;
        }
        resolve(response || { success: false, error: "空响应", errorCode: "INTERNAL_ERROR" });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, error: `${requestLabel}发送失败`, errorCode: "COMMUNICATION_ERROR" });
    }
  });
}

function sendAction(request, label) {
  return sendMessageWithTimeout(request, label);
}

/* ================================================================== */
/* 状态提示                                                            */
/* ================================================================== */

let statusTimer = null;

function showStatus(text, type = "info", duration = 2500) {
  dom.statusText.textContent = text;
  dom.statusBar.className = "status-bar " + type;
  dom.statusBar.hidden = false;
  if (statusTimer) clearTimeout(statusTimer);
  if (duration > 0) {
    statusTimer = setTimeout(() => { dom.statusBar.hidden = true; }, duration);
  }
}

/* ================================================================== */
/* 主题管理                                                            */
/* ================================================================== */

function applyTheme(themeName) {
  document.documentElement.dataset.theme = themeName;
}

function applySystemTheme() {
  applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function setThemeMode(mode) {
  state.themeMode = mode;
  if (state.mediaQueryList) {
    state.mediaQueryList.removeEventListener("change", onSystemThemeChange);
    state.mediaQueryList = null;
  }
  if (mode === THEME_FOLLOW_SYSTEM) {
    applySystemTheme();
    state.mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    state.mediaQueryList.addEventListener("change", onSystemThemeChange);
  } else if (mode === THEME_LIGHT) {
    applyTheme("light");
  } else if (mode === THEME_DARK) {
    applyTheme("dark");
  }
}

function onSystemThemeChange() {
  if (state.themeMode === THEME_FOLLOW_SYSTEM) applySystemTheme();
}

async function onThemeToggleClick() {
  const next = state.themeMode === THEME_FOLLOW_SYSTEM ? THEME_LIGHT
    : state.themeMode === THEME_LIGHT ? THEME_DARK
    : THEME_FOLLOW_SYSTEM;
  setThemeMode(next);
  await sendAction({ action: "setConfig", themeMode: next }, "保存主题");
}

async function loadThemeConfig() {
  const resp = await sendAction({ action: "getConfig" }, "加载配置");
  if (resp.success && resp.data && typeof resp.data.themeMode === "number") {
    setThemeMode(resp.data.themeMode);
  } else {
    setThemeMode(THEME_FOLLOW_SYSTEM);
  }
}

/* ================================================================== */
/* 视图路由（hash）                                                   */
/* ================================================================== */

function getViewFromHash() {
  const h = location.hash.replace(/^#/, "").split("?")[0];
  if (h === "search" || h === "manage") return h;
  return "home";
}

/** 解析 hash 中的 query 参数（如 #manage?tagId=5&name=标签） */
function getHashParams() {
  const raw = location.hash.replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return {};
  const params = {};
  try {
    new URLSearchParams(raw.slice(qIdx + 1)).forEach((v, k) => { params[k] = v; });
  } catch (err) {
    console.warn("[WebAnnotator] 解析 hash 参数失败:", err);
  }
  return params;
}

function showView(view) {
  state.currentView = view;
  dom.viewHome.hidden = view !== "home";
  dom.viewSearch.hidden = view !== "search";
  dom.viewManage.hidden = view !== "manage";

  const tabs = dom.navTabs.querySelectorAll(".nav-tab");
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));

  // 进入对应视图时加载数据
  if (view === "home") {
    loadHome();
  } else if (view === "search") {
    // 自动聚焦搜索框；保留已有结果
    dom.searchInput.focus();
    if (state.searchQuery === "" && dom.searchResults.children.length === 0) {
      doSearch(true);
    }
  } else if (view === "manage") {
    // 支持 #manage?tagId=<id>&name=<名称> 直达标签筛选（新标签页标签墙跳转）
    const p = getHashParams();
    const tagId = p.tagId ? Number(p.tagId) : NaN;
    if (Number.isInteger(tagId) && tagId > 0 && p.name) {
      filterByTag({ id: tagId, name: p.name });
    } else {
      showTagList();
    }
  }
}

function navigate(view) {
  location.hash = view;
}

function onHashChange() {
  showView(getViewFromHash());
}

/* ================================================================== */
/* 结果项渲染（通用）                                                 */
/* ================================================================== */

function formatTime(isoString) {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const diff = Date.now() - date;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 604800000) return Math.floor(diff / 86400000) + " 天前";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  } catch (e) {
    return isoString;
  }
}

function createResultItem(item, opts = {}) {
  const div = document.createElement("div");
  div.className = "result-item";

  const titleEl = document.createElement("div");
  titleEl.className = "result-item-title";
  titleEl.textContent = item.title || "（无标题）";
  titleEl.title = item.title || "";
  div.appendChild(titleEl);

  if (item.url) {
    const urlEl = document.createElement("div");
    urlEl.className = "result-item-url";
    urlEl.textContent = item.url;
    urlEl.title = item.url;
    div.appendChild(urlEl);
  }

  if (Array.isArray(item.tags) && item.tags.length > 0) {
    const tagsEl = document.createElement("div");
    tagsEl.className = "result-item-tags";
    for (const tag of item.tags) {
      const span = document.createElement("span");
      span.className = "result-item-tag";
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
    div.appendChild(tagsEl);
  }

  if (item.note || item.notePreview) {
    const noteEl = document.createElement("div");
    noteEl.className = "result-item-note";
    noteEl.textContent = item.note || item.notePreview;
    div.appendChild(noteEl);
  }

  if (item.updatedAt) {
    const timeEl = document.createElement("div");
    timeEl.className = "result-item-time";
    timeEl.textContent = "更新于 " + formatTime(item.updatedAt);
    div.appendChild(timeEl);
  }

  // 单条删除按钮（搜索 / 标签筛选结果使用）
  if (opts.showDelete && typeof item.id === "number") {
    const delBtn = document.createElement("button");
    delBtn.className = "result-item-delete";
    delBtn.textContent = "🗑";
    delBtn.title = "删除这条标注";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showAnnotationDeleteConfirm(item, opts.onDeleted);
    });
    div.appendChild(delBtn);
  }

  // 点击打开网页
  div.addEventListener("click", () => {
    if (item.url) chrome.tabs.create({ url: item.url });
  });

  return div;
}

function renderEmpty(container, text) {
  container.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  container.appendChild(empty);
}

function renderLoading(container, text) {
  container.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "loading-state";
  loading.textContent = text;
  container.appendChild(loading);
}

function handleCommonError(resp) {
  if (resp.errorCode === "HOST_NOT_FOUND") {
    showStatus("未检测到本地程序，请先安装并运行配套程序", "error", 0);
  } else if (resp.errorCode === "HOST_NOT_INITIALIZED") {
    showStatus("本地程序未完成首次配置，请在 popup 中选择数据路径", "error", 0);
  } else {
    showStatus(resp.error || "操作失败", "error", 0);
  }
}

/* ================================================================== */
/* 首页                                                               */
/* ================================================================== */

async function loadHome() {
  renderLoading(dom.homeRecent, "加载中...");

  // 统计：标注总数 + 标签数（并行）
  const [searchResp, tagsResp] = await Promise.all([
    sendAction({ action: "search", query: "", limit: 1, offset: 0 }, "加载统计"),
    sendAction({ action: "getTagsWithCount" }, "加载标签"),
  ]);

  let totalAnnotations = 0;
  let tagCount = 0;
  let totalTagged = 0;

  if (searchResp.success && searchResp.data) {
    totalAnnotations = searchResp.data.total || 0;
  } else if (searchResp.errorCode === "HOST_NOT_FOUND" || searchResp.errorCode === "HOST_NOT_INITIALIZED") {
    renderEmpty(dom.homeRecent, "本地程序未就绪");
    dom.homeStats.innerHTML = "";
    handleCommonError(searchResp);
    return;
  }

  if (tagsResp.success && tagsResp.data && Array.isArray(tagsResp.data.tags)) {
    tagCount = tagsResp.data.tags.length;
    totalTagged = tagsResp.data.tags.reduce((s, t) => s + (t.count || 0), 0);
  }

  // 渲染统计卡片
  dom.homeStats.innerHTML = "";
  dom.homeStats.appendChild(createStatCard(totalAnnotations, "标注总数"));
  dom.homeStats.appendChild(createStatCard(tagCount, "标签数量"));
  dom.homeStats.appendChild(createStatCard(totalTagged, "标签关联次数"));

  // 最近标注
  const recentResp = await sendAction(
    { action: "search", query: "", limit: HOME_RECENT_LIMIT, offset: 0 },
    "加载最近标注"
  );

  if (recentResp.success && recentResp.data) {
    const results = recentResp.data.results || [];
    dom.homeRecent.innerHTML = "";
    if (results.length === 0) {
      renderEmpty(dom.homeRecent, "暂无标注。在网页上点击扩展图标即可添加标注。");
    } else {
      for (const item of results) dom.homeRecent.appendChild(createResultItem(item));
    }
  } else {
    renderEmpty(dom.homeRecent, "加载失败");
  }
}

function createStatCard(value, label) {
  const card = document.createElement("div");
  card.className = "stat-card";
  const v = document.createElement("div");
  v.className = "stat-card-value";
  v.textContent = value;
  const l = document.createElement("div");
  l.className = "stat-card-label";
  l.textContent = label;
  card.appendChild(v);
  card.appendChild(l);
  return card;
}

/* ================================================================== */
/* 导入 / 导出 CSV                                                     */
/* ================================================================== */

/** 导出：向 host 取全部标注 CSV，加 UTF-8 BOM 后下载为文件。 */
async function onExportCsv() {
  showStatus("正在导出...", "info", 0);
  const resp = await sendAction({ action: "exportCsv" }, "导出数据");
  if (!resp.success || !resp.data || typeof resp.data.csv !== "string") {
    showStatus("导出失败：" + (resp.error || "未知错误"), "error");
    return;
  }

  // 前置 BOM，Excel 直接打开中文不乱码
  const blob = new Blob(["\uFEFF" + resp.data.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "webmarker-annotations-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const count = Number(resp.data.count) || 0;
  showStatus(`已导出 ${count} 条标注到 CSV`, "success");
}

/** 导入：选择文件后读取文本并提交 host（导入前会确认 + host 自动备份数据库）。 */
function onImportCsvFileSelected() {
  const file = dom.importCsvFile.files && dom.importCsvFile.files[0];
  if (!file) return;
  dom.importCsvFile.value = ""; // 允许再次选择同一文件

  const reader = new FileReader();
  reader.onload = async () => {
    const csv = String(reader.result || "");
    if (!csv.trim()) {
      showStatus("所选文件为空", "error");
      return;
    }

    const ok = window.confirm(
      `将导入「${file.name}」中的数据（${csv.trim().split(/\r?\n/).length} 行）。\n\n` +
      `合并规则：URL 已存在的标注将被更新，不存在的将新增；标签按原样合并。\n` +
      `导入前会自动备份数据库（可随时还原）。\n\n确定继续吗？`
    );
    if (!ok) return;

    showStatus("正在导入...", "info", 0);
    const resp = await sendAction({ action: "importCsv", csv }, "导入数据");
    if (resp.success && resp.data) {
      const imported = Number(resp.data.imported) || 0;
      const skipped = Number(resp.data.skipped) || 0;
      const errors = Array.isArray(resp.data.errors) ? resp.data.errors : [];
      let msg = `导入完成：成功 ${imported} 条，跳过 ${skipped} 条`;
      if (errors.length > 0) {
        msg += `（详情见浏览器控制台）`;
        console.warn("[WebAnnotator] 导入跳过/失败明细：", errors);
      }
      showStatus(msg, skipped > 0 ? "warn" : "success", 4000);
      loadHome(); // 刷新统计与最近标注
    } else {
      showStatus("导入失败：" + (resp.error || "未知错误"), "error");
    }
  };
  reader.onerror = () => showStatus("读取文件失败", "error");
  reader.readAsText(file, "utf-8");
}

/* ================================================================== */
/* 搜索视图                                                           */
/* ================================================================== */

let searchDebounceTimer = null;

function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => doSearch(true), SEARCH_DEBOUNCE_MS);
}

async function doSearch(reset = false) {
  const query = dom.searchInput.value.trim();

  if (reset) {
    state.searchOffset = 0;
    state.searchQuery = query;
  }

  renderLoading(dom.searchResults, "搜索中...");
  dom.searchMoreWrap.hidden = true;
  dom.searchCount.textContent = "";

  const resp = await sendAction(
    { action: "search", query, limit: DEFAULT_LIMIT, offset: state.searchOffset },
    "搜索"
  );

  if (!resp.success) {
    if (resp.errorCode === "HOST_NOT_FOUND" || resp.errorCode === "HOST_NOT_INITIALIZED") {
      renderEmpty(dom.searchResults, "本地程序未就绪");
    } else {
      renderEmpty(dom.searchResults, resp.error || "搜索失败");
    }
    handleCommonError(resp);
    return;
  }

  const results = resp.data.results || [];
  state.searchTotal = resp.data.total || 0;

  if (reset) dom.searchResults.innerHTML = "";

  if (results.length === 0 && state.searchOffset === 0) {
    renderEmpty(dom.searchResults, query ? "未找到匹配的标注" : "暂无标注记录");
    return;
  }

  for (const item of results) {
    dom.searchResults.appendChild(
      createResultItem(item, { showDelete: true, onDeleted: () => doSearch(true) })
    );
  }

  dom.searchCount.textContent = `共 ${state.searchTotal} 条`;
  const shown = state.searchOffset + results.length;
  if (shown < state.searchTotal) {
    dom.searchMoreWrap.hidden = false;
    dom.searchMoreBtn.textContent = `加载更多（${shown}/${state.searchTotal}）`;
  } else {
    dom.searchMoreWrap.hidden = true;
  }
}

async function onSearchMore() {
  state.searchOffset += DEFAULT_LIMIT;
  await doSearch(false);
}

/* ================================================================== */
/* 标签管理视图                                                       */
/* ================================================================== */

/** 当前是否处于"按标签筛选"模式 */
let filterMode = false;

async function showTagList() {
  filterMode = false;
  dom.manageBreadcrumb.hidden = true;
  dom.manageMoreWrap.hidden = true;
  dom.manageTitle.textContent = "全部标签";

  renderLoading(dom.tagList, "加载标签...");
  dom.manageCount.textContent = "";

  const resp = await sendAction({ action: "getTagsWithCount" }, "加载标签列表");
  if (!resp.success) {
    if (resp.errorCode === "HOST_NOT_FOUND" || resp.errorCode === "HOST_NOT_INITIALIZED") {
      renderEmpty(dom.tagList, "本地程序未就绪");
    } else {
      renderEmpty(dom.tagList, resp.error || "加载失败");
    }
    handleCommonError(resp);
    return;
  }

  const tags = resp.data.tags || [];
  dom.manageCount.textContent = `${tags.length} 个标签`;

  if (tags.length === 0) {
    renderEmpty(dom.tagList, "暂无标签。给网页添加标签后会自动创建。");
    return;
  }

  dom.tagList.innerHTML = "";
  tags.sort((a, b) => (b.count || 0) - (a.count || 0));
  for (const tag of tags) dom.tagList.appendChild(createTagItem(tag));
}

function createTagItem(tag) {
  const div = document.createElement("div");
  div.className = "tag-mgr-item";

  const info = document.createElement("div");
  info.className = "tag-mgr-item-info";

  const name = document.createElement("span");
  name.className = "tag-mgr-item-name";
  name.textContent = tag.name;
  name.title = tag.name;
  info.appendChild(name);

  const count = document.createElement("span");
  count.className = "tag-mgr-item-count";
  count.textContent = `${tag.count || 0} 个网页`;
  info.appendChild(count);

  div.appendChild(info);

  const delBtn = document.createElement("button");
  delBtn.className = "tag-mgr-item-delete";
  delBtn.textContent = "🗑";
  delBtn.title = "删除标签";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showDeleteConfirm(tag);
  });
  div.appendChild(delBtn);

  // 点击按标签筛选
  div.addEventListener("click", () => filterByTag(tag));
  return div;
}

async function filterByTag(tag) {
  filterMode = true;
  state.filterTagIds = [tag.id];
  state.filterTagName = tag.name;
  state.filterOffset = 0;

  dom.manageBreadcrumb.hidden = false;
  dom.manageTitle.textContent = `标签「${tag.name}」的网页`;

  renderLoading(dom.tagList, "筛选中...");
  dom.manageCount.textContent = "";

  const resp = await sendAction(
    { action: "getAnnotationsByTag", tagIds: [tag.id], limit: DEFAULT_LIMIT, offset: 0 },
    "标签筛选"
  );

  if (!resp.success) {
    renderEmpty(dom.tagList, resp.error || "筛选失败");
    handleCommonError(resp);
    return;
  }

  const results = resp.data.results || [];
  state.filterTotal = resp.data.total || 0;
  dom.manageCount.textContent = `共 ${state.filterTotal} 条`;

  dom.tagList.innerHTML = "";
  if (results.length === 0) {
    renderEmpty(dom.tagList, "该标签下没有网页");
    dom.manageMoreWrap.hidden = true;
    return;
  }

  // 单条删除后重新筛选该标签（计数同步变化）
  const refresh = () => filterByTag(tag);
  for (const item of results) {
    dom.tagList.appendChild(createResultItem(item, { showDelete: true, onDeleted: refresh }));
  }

  // 分页：未加载完则显示"加载更多"
  const shown = state.filterOffset + results.length;
  if (shown < state.filterTotal) {
    dom.manageMoreWrap.hidden = false;
    dom.manageMoreBtn.textContent = `加载更多（${shown}/${state.filterTotal}）`;
  } else {
    dom.manageMoreWrap.hidden = true;
  }
}

async function onLoadMoreFilter() {
  state.filterOffset += DEFAULT_LIMIT;
  const resp = await sendAction(
    { action: "getAnnotationsByTag", tagIds: state.filterTagIds, limit: DEFAULT_LIMIT, offset: state.filterOffset },
    "标签筛选"
  );
  if (!resp.success) return;
  const results = resp.data.results || [];
  const refresh = () => filterByTag({ id: state.filterTagIds[0], name: state.filterTagName });
  for (const item of results) {
    dom.tagList.appendChild(createResultItem(item, { showDelete: true, onDeleted: refresh }));
  }
  const shown = state.filterOffset + results.length;
  if (shown < (resp.data.total || 0)) {
    dom.manageMoreWrap.hidden = false;
    dom.manageMoreBtn.textContent = `加载更多（${shown}/${resp.data.total || 0}）`;
  } else {
    dom.manageMoreWrap.hidden = true;
  }
}

/* ---------- 删除确认（标签 / 单条标注 通用） ---------- */

let pendingDelete = null; // { type: "tag", tag } | { type: "annotation", item, onDeleted }

function showDeleteConfirm(tag) {
  pendingDelete = { type: "tag", tag };
  dom.deleteConfirmTitle.textContent = "确认删除标签";
  dom.deleteConfirmDesc.textContent =
    `标签「${tag.name}」关联了 ${tag.count || 0} 个网页，确认删除将解除全部关联。`;
  dom.deleteConfirm.hidden = false;
}

function showAnnotationDeleteConfirm(item, onDeleted) {
  pendingDelete = { type: "annotation", item, onDeleted };
  dom.deleteConfirmTitle.textContent = "确认删除这条标注";
  const display = item.title || item.url || "（无标题）";
  dom.deleteConfirmDesc.textContent =
    `将删除「${display}」的标注记录（含备注与标签关联），此操作不可恢复。`;
  dom.deleteConfirm.hidden = false;
}

function hideDeleteConfirm() {
  dom.deleteConfirm.hidden = true;
  pendingDelete = null;
}

async function confirmDelete() {
  if (!pendingDelete) return;
  const target = pendingDelete;
  hideDeleteConfirm();

  if (target.type === "tag") {
    showStatus("正在删除...", "info", 0);
    const resp = await sendAction({ action: "deleteTag", tagId: target.tag.id }, "删除标签");

    if (resp.success) {
      const affected = (resp.data && resp.data.affectedAnnotations) || 0;
      showStatus(`已删除标签「${target.tag.name}」，解除 ${affected} 个网页关联`, "success");
      showTagList();
      // 若首页可见则刷新统计
      if (state.currentView === "home") loadHome();
    } else {
      showStatus(resp.error || "删除失败", "error", 0);
    }
    return;
  }

  // 单条标注
  showStatus("正在删除...", "info", 0);
  const resp = await sendAction({ action: "deleteAnnotation", annotationId: target.item.id }, "删除标注");

  if (resp.success) {
    showStatus("已删除这条标注", "success");
    if (typeof target.onDeleted === "function") target.onDeleted();
  } else {
    showStatus(resp.error || "删除失败", "error", 0);
  }
}

/* ================================================================== */
/* 事件绑定                                                            */
/* ================================================================== */

function bindEvents() {
  dom.themeToggle.addEventListener("click", onThemeToggleClick);

  // 导航标签
  dom.navTabs.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => navigate(tab.dataset.view));
  });

  // 首页
  dom.homeViewAll.addEventListener("click", () => navigate("search"));
  dom.exportCsvBtn.addEventListener("click", onExportCsv);
  dom.importCsvBtn.addEventListener("click", () => dom.importCsvFile.click());
  dom.importCsvFile.addEventListener("change", onImportCsvFileSelected);

  // 搜索
  dom.searchInput.addEventListener("input", onSearchInput);
  dom.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch(true);
  });
  dom.searchMoreBtn.addEventListener("click", onSearchMore);

  // 标签管理
  dom.backToTags.addEventListener("click", showTagList);
  dom.manageMoreBtn.addEventListener("click", onLoadMoreFilter);

  // 删除确认
  dom.deleteCancelBtn.addEventListener("click", hideDeleteConfirm);
  dom.deleteOkBtn.addEventListener("click", confirmDelete);

  // hash 变化
  window.addEventListener("hashchange", onHashChange);

  // Esc 关闭弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.deleteConfirm.hidden) hideDeleteConfirm();
  });
}

/* ================================================================== */
/* 初始化                                                             */
/* ================================================================== */

async function init() {
  // 卸载脚本触发的自卸载（uninstall.ps1 打开 options.html#uninstall）：
  // 必须放在任何 host 请求之前处理，避免移除瞬间出现连接错误
  const bootHash = location.hash.replace(/^#/, "").split("?")[0];
  if (bootHash === "uninstall") {
    document.title = "正在移除页签扩展…";
    document.body.innerHTML = '<div style="padding:48px 40px;font-size:15px;">正在从浏览器移除「页签 WebMarker」扩展…</div>';
    chrome.management.uninstallSelf({ showConfirmDialog: false }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        document.body.innerHTML = '<div style="padding:48px 40px;font-size:15px;">自动移除失败：' + err.message + '<br/><br/>请到扩展管理页（chrome://extensions）手动移除。</div>';
      }
    });
    return;
  }
  initDomRefs();
  bindEvents();
  setThemeMode(THEME_FOLLOW_SYSTEM);
  await loadThemeConfig();
  showView(getViewFromHash());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
