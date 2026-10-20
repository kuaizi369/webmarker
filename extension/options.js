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
  dom.searchFilter = document.getElementById("search-filter");
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
  dom.editModal = document.getElementById("edit-modal");
  dom.editTitle = document.getElementById("edit-title");
  dom.editUrl = document.getElementById("edit-url");
  dom.editTags = document.getElementById("edit-tags");
  dom.editNote = document.getElementById("edit-note");
  dom.editError = document.getElementById("edit-error");
  dom.editCancelBtn = document.getElementById("edit-cancel-btn");
  dom.editSaveBtn = document.getElementById("edit-save-btn");
  // P0/P1 新增视图与控件
  dom.exportMdBtn = document.getElementById("export-md-btn");
  dom.exportHtmlBtn = document.getElementById("export-html-btn");
  dom.viewHighlights = document.getElementById("view-highlights");
  dom.viewSessions = document.getElementById("view-sessions");
  dom.viewSnapshots = document.getElementById("view-snapshots");
  dom.manageTabs = document.getElementById("manage-tabs");
  dom.manageTagsPane = document.getElementById("manage-tags-pane");
  dom.manageGraphPane = document.getElementById("manage-graph-pane");
  dom.tagGraph = document.getElementById("tag-graph");
  dom.hlSearchInput = document.getElementById("hl-search-input");
  dom.hlCount = document.getElementById("hl-count");
  dom.hlList = document.getElementById("hl-list");
  dom.hlMoreWrap = document.getElementById("hl-more-wrap");
  dom.hlMoreBtn = document.getElementById("hl-more-btn");
  dom.sessCount = document.getElementById("sess-count");
  dom.sessList = document.getElementById("sess-list");
  dom.snapCount = document.getElementById("snap-count");
  dom.snapList = document.getElementById("snap-list");
  dom.snapMoreWrap = document.getElementById("snap-more-wrap");
  dom.snapMoreBtn = document.getElementById("snap-more-btn");
  // 快捷标注视图（右键「添加为页签标注」跳转）
  dom.viewAnnotate = document.getElementById("view-annotate");
  dom.annTitle = document.getElementById("ann-title");
  dom.annUrl = document.getElementById("ann-url");
  dom.annNote = document.getElementById("ann-note");
  dom.annTags = document.getElementById("ann-tags");
  dom.annSaveBtn = document.getElementById("ann-save-btn");
  dom.annCancelBtn = document.getElementById("ann-cancel-btn");
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
  if (h === "search" || h === "manage" || h === "highlights" || h === "sessions" || h === "snapshots" || h === "annotate") return h;
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
  dom.viewHighlights.hidden = view !== "highlights";
  dom.viewSessions.hidden = view !== "sessions";
  dom.viewSnapshots.hidden = view !== "snapshots";
  dom.viewAnnotate.hidden = view !== "annotate";

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
  } else if (view === "highlights") {
    loadHighlights(true);
  } else if (view === "sessions") {
    loadSessions();
  } else if (view === "snapshots") {
    loadSnapshots(true);
  } else if (view === "annotate") {
    setupAnnotateView();
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

  // 单条编辑按钮 + 右键编辑（搜索 / 标签筛选结果使用）
  if (opts.showDelete && typeof item.id === "number") {
    const editBtn = document.createElement("button");
    editBtn.className = "result-item-edit";
    editBtn.textContent = "✏️";
    editBtn.title = "编辑这条标注";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showEditModal(item, opts.onDeleted);
    });
    div.appendChild(editBtn);

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

  // 右键单条记录：弹出编辑（阻止默认菜单）
  div.addEventListener("contextmenu", (e) => {
    if (typeof item.id !== "number") return;
    e.preventDefault();
    e.stopPropagation();
    showEditModal(item, opts.onDeleted);
  });

  // 点击打开网页
  div.addEventListener("click", () => {
    if (item.url) chrome.tabs.create({ url: item.url });
  });

  return div;
}

/* ---------- 编辑单条标注（编辑弹窗） ---------- */

let editTarget = null; // { item, onSaved }

function showEditModal(item, onSaved) {
  editTarget = { item, onSaved };
  // 先用列表已知内容预填（标签/标题/网址完整；备注可能只是前100字摘要）
  dom.editTitle.value = item.title || "";
  dom.editUrl.value = item.url || "";
  dom.editTags.value = Array.isArray(item.tags) && item.tags.length > 0 ? item.tags.join(", ") : "";
  dom.editNote.value = item.note || item.notePreview || "";
  dom.editError.hidden = true;
  dom.editError.textContent = "";
  dom.editModal.hidden = false;
  dom.editUrl.focus();

  // 异步加载完整原文（备注等可能被截断），回来后补全输入框，方便对照修改
  loadFullAnnotation(item).then((full) => {
    if (full) {
      dom.editTitle.value = full.title || "";
      dom.editUrl.value = full.url || "";
      dom.editTags.value = Array.isArray(full.tags) && full.tags.length > 0 ? full.tags.join(", ") : "";
      dom.editNote.value = full.note || "";
    }
  });
}

/** 按 url 读取完整标注记录（失败返回 null，保持预填内容） */
async function loadFullAnnotation(item) {
  if (!item || !item.url) return null;
  try {
    const resp = await sendAction({ action: "get", url: item.url }, "加载原文");
    if (resp.success && resp.data && resp.data.annotation) {
      return resp.data.annotation;
    }
  } catch (err) { /* 保持预填内容 */ }
  return null;
}

function hideEditModal() {
  dom.editModal.hidden = true;
  editTarget = null;
}

async function saveEdit() {
  if (!editTarget) return;
  const target = editTarget;

  const url = dom.editUrl.value.trim();
  if (!url) {
    showEditError("网址不能为空");
    return;
  }
  const title = dom.editTitle.value.trim();
  const tags = dom.editTags.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const note = dom.editNote.value;

  showStatus("正在保存...", "info", 0);
  const resp = await sendAction(
    { action: "updateAnnotation", annotationId: target.item.id, url, title, tags, note },
    "编辑标注"
  );

  if (resp.success) {
    hideEditModal();
    showStatus("已保存修改", "success");
    if (typeof target.onSaved === "function") target.onSaved();
  } else if (resp.errorCode === "URL_CONFLICT") {
    showEditError(resp.error || "该网址已有其他标注");
  } else if (resp.errorCode === "TAG_NAME_INVALID" || resp.errorCode === "TAG_NAME_CONFLICT") {
    showEditError(resp.error || "标签名称不合法");
  } else if (resp.errorCode === "ANNOTATION_NOT_FOUND") {
    hideEditModal();
    showStatus(resp.error || "记录不存在，可能已被删除", "error", 0);
    if (typeof target.onSaved === "function") target.onSaved();
  } else {
    hideEditModal();
    handleCommonError(resp);
  }
}

function showEditError(msg) {
  dom.editError.textContent = msg;
  dom.editError.hidden = false;
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
    { action: "search", query, fields: dom.searchFilter.value, limit: DEFAULT_LIMIT, offset: state.searchOffset },
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

  // 通用确认（高亮 / 会话 / 快照删除）
  if (target.type === "custom") {
    if (typeof target.onOk === "function") {
      await target.onOk();
    }
    return;
  }

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

/** 通用确认弹窗（高亮 / 会话 / 快照删除复用，四态均有 confirm 保护）。 */
function showCustomConfirm(title, desc, onOk) {
  pendingDelete = { type: "custom", onOk };
  dom.deleteConfirmTitle.textContent = title;
  dom.deleteConfirmDesc.textContent = desc;
  dom.deleteConfirm.hidden = false;
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
  dom.searchFilter.addEventListener("change", () => doSearch(true));
  dom.searchMoreBtn.addEventListener("click", onSearchMore);

  // 标签管理
  dom.backToTags.addEventListener("click", showTagList);
  dom.manageMoreBtn.addEventListener("click", onLoadMoreFilter);

  // 删除确认
  dom.deleteCancelBtn.addEventListener("click", hideDeleteConfirm);
  dom.deleteOkBtn.addEventListener("click", confirmDelete);

  // 编辑标注弹窗
  dom.editCancelBtn.addEventListener("click", hideEditModal);
  dom.editSaveBtn.addEventListener("click", saveEdit);

  // ===== P0/P1 新增功能绑定 =====
  dom.exportMdBtn.addEventListener("click", () => exportDocuments("md"));
  dom.exportHtmlBtn.addEventListener("click", () => exportDocuments("html"));

  // 高亮管理
  dom.hlSearchInput.addEventListener("input", () => loadHighlights(true));
  dom.hlMoreBtn.addEventListener("click", () => loadHighlights(false));

  // 快照管理
  dom.snapMoreBtn.addEventListener("click", () => loadSnapshots(false));

  // 标签管理内 Tab（列表 / 图谱）
  dom.manageTabs.querySelectorAll(".manage-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pane = btn.dataset.mtab;
      dom.manageTabs.querySelectorAll(".manage-tab").forEach((b) => b.classList.toggle("active", b === btn));
      dom.manageTagsPane.hidden = pane !== "tags";
      dom.manageGraphPane.hidden = pane !== "graph";
      if (pane === "graph" && dom.tagGraph.children.length === 0) {
        loadTagGraph();
      }
    });
  });

  // hash 变化
  window.addEventListener("hashchange", onHashChange);

  // Esc 关闭弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.deleteConfirm.hidden) hideDeleteConfirm();
    if (e.key === "Escape" && !dom.editModal.hidden) hideEditModal();
  });
}

/* ================================================================== */
/* P0/P1 新功能：导出 / 高亮管理 / 会话管理 / 快照管理 / 标签图谱       */
/* ================================================================== */

/* ---------- 导出（Markdown / HTML） ---------- */

function downloadText(filename, content) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

async function exportDocuments(kind) {
  const label = kind === "md" ? "导出 Markdown" : "导出 HTML";
  const resp = await sendAction({ action: kind === "md" ? "exportMarkdown" : "exportHtml" }, label);
  if (!resp.success) {
    showStatus(resp.error || label + "失败", "error");
    return;
  }
  // host 响应统一 { success, data: { content, count } }
  const data = resp.data || {};
  if (!data.content || data.count === 0) {
    showStatus("没有可导出的标注", "info");
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadText(kind === "md" ? `webmarker-标注导出-${date}.md` : `webmarker-标注导出-${date}.html`, data.content);
  showStatus(`${label}成功，共 ${data.count} 条`, "success");
}

/* ---------- 高亮管理 ---------- */

let hlState = { offset: 0, total: 0, query: "" };

function hlItemHtml(hl) {
  const colorMap = {
    yellow: { bg: "#fff59d", border: "#fbc02d" },
    green: { bg: "#c8e6c9", border: "#66bb6a" },
    blue: { bg: "#bbdefb", border: "#42a5f5" },
    red: { bg: "#ffcdd2", border: "#ef5350" },
    purple: { bg: "#e1bee7", border: "#ab47bc" },
  };
  const c = colorMap[hl.color] || colorMap.yellow;
  const time = formatTime(hl.updatedAt);
  return {
    title: hl.quote.slice(0, 80) + (hl.quote.length > 80 ? "…" : ""),
    url: hl.url,
    meta: `${time} · ${hl.quote.length} 字`,
    swatch: `<span class="hl-swatch" style="background:${c.bg};border:2px solid ${c.border};" title="${hl.color}"></span>`,
  };
}

async function loadHighlights(reset) {
  if (reset) {
    hlState = { offset: 0, total: 0, query: dom.hlSearchInput.value.trim().toLowerCase() };
    dom.hlList.innerHTML = "";
  }
  const resp = await sendAction({ action: "getHighlights", limit: 50, offset: hlState.offset }, "加载高亮");
  if (!resp.success) {
    if (hlState.offset === 0) dom.hlList.innerHTML = `<div class="empty-state">${resp.error || "加载失败"}</div>`;
    return;
  }
  const items = (resp.data && resp.data.highlights) || [];
  hlState.total = (resp.data && resp.data.total) || 0;
  dom.hlCount.textContent = hlState.total > 0 ? String(hlState.total) : "";

  if (hlState.offset === 0 && items.length === 0) {
    dom.hlList.innerHTML = `<div class="empty-state"><div class="empty-icon">🖍</div>还没有高亮记录<br/>在网页上划选文字即可添加高亮</div>`;
    dom.hlMoreWrap.hidden = true;
    return;
  }

  const q = hlState.query;
  const filtered = q ? items.filter((hl) =>
    (hl.quote || "").toLowerCase().includes(q) ||
    (hl.url || "").toLowerCase().includes(q)
  ) : items;

  filtered.forEach((hl) => {
    const d = hlItemHtml(hl);
    const item = document.createElement("div");
    item.className = "result-item";
    item.innerHTML = `
      <div class="result-main">
        <div class="result-item-title">${d.swatch} ${escapeHtml(d.title)}</div>
        <div class="result-item-url">${escapeHtml(d.url)}</div>
        <div class="result-item-time">${d.meta}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-secondary btn-sm" data-act="open" title="打开页面并定位高亮">↗ 打开</button>
        <button class="btn btn-secondary btn-sm" data-act="del" title="删除高亮">🗑</button>
      </div>`;
    item.querySelector('[data-act="open"]').addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "WM_OPEN_HIGHLIGHT", url: hl.url, quote: hl.quote }, () => void chrome.runtime.lastError);
    });
    item.querySelector('[data-act="del"]').addEventListener("click", () => confirmDeleteHighlight(hl));
    dom.hlList.appendChild(item);
  });

  dom.hlMoreWrap.hidden = hlState.offset + items.length >= hlState.total;
  hlState.offset += items.length;
}

function confirmDeleteHighlight(hl) {
  showCustomConfirm(
    "删除高亮",
    `确定删除该高亮吗？\n「${hl.quote.slice(0, 50)}${hl.quote.length > 50 ? "…" : ""}」`,
    async () => {
      const resp = await sendAction({ action: "deleteHighlight", highlightId: hl.id }, "删除高亮");
      if (resp.success) {
        showStatus("高亮已删除", "success");
        loadHighlights(true);
      } else {
        showStatus(resp.error || "删除失败", "error");
      }
    }
  );
}

/* ---------- 会话管理 ---------- */

async function loadSessions() {
  dom.sessList.innerHTML = "";
  const resp = await sendAction({ action: "listSessions" }, "加载会话");
  if (!resp.success) {
    dom.sessList.innerHTML = `<div class="empty-state">${resp.error || "加载失败"}</div>`;
    return;
  }
  const sessions = (resp.data && resp.data.sessions) || [];
  dom.sessCount.textContent = sessions.length > 0 ? String(sessions.length) : "";
  if (sessions.length === 0) {
    dom.sessList.innerHTML = `<div class="empty-state"><div class="empty-icon">🗂</div>还没有保存的会话<br/>在弹出面板点击「保存会话」即可保存当前窗口标签页</div>`;
    return;
  }
  for (const sess of sessions) {
    const item = document.createElement("div");
    item.className = "result-item";
    item.innerHTML = `
      <div class="result-main">
        <div class="result-item-title">${escapeHtml(sess.name)}</div>
        <div class="result-item-time">${formatTime(sess.createdAt)} · ${sess.itemCount} 个标签页</div>
        <div class="sess-items" hidden></div>
      </div>
      <div class="result-actions">
        <button class="btn btn-secondary btn-sm" data-act="expand" title="查看标签页">▶ 查看</button>
        <button class="btn btn-secondary btn-sm" data-act="restore" title="重新打开全部标签页">↗ 恢复</button>
        <button class="btn btn-secondary btn-sm" data-act="del" title="删除会话">🗑</button>
      </div>`;
    const itemsBox = item.querySelector(".sess-items");
    item.querySelector('[data-act="expand"]').addEventListener("click", async () => {
      if (!itemsBox.hidden) {
        itemsBox.hidden = true;
        return;
      }
      const r = await sendAction({ action: "getSessionItems", sessionId: sess.id }, "加载会话标签页");
      itemsBox.innerHTML = "";
      const list = (r.success && r.data && r.data.items) || [];
      if (list.length === 0) {
        itemsBox.innerHTML = `<div class="empty-state" style="padding:8px;">无标签页</div>`;
      } else {
        list.forEach((it) => {
          const row = document.createElement("div");
          row.className = "sess-item-row";
          row.innerHTML = `
            <a class="sess-item-url" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.title || it.url)}</a>
            <button class="btn btn-secondary btn-sm" data-act="delitem" title="删除该标签页">🗑</button>`;
          row.querySelector('[data-act="delitem"]').addEventListener("click", () => confirmDeleteSessionItem(sess, it));
          itemsBox.appendChild(row);
        });
      }
      itemsBox.hidden = false;
    });
    item.querySelector('[data-act="restore"]').addEventListener("click", async () => {
      const r = await sendAction({ action: "getSessionItems", sessionId: sess.id }, "恢复会话");
      const list = (r.success && r.data && r.data.items) || [];
      if (list.length === 0) {
        showStatus("会话中没有标签页", "info");
        return;
      }
      list.forEach((it) => {
        if (it.url) chrome.tabs.create({ url: it.url, active: false });
      });
      showStatus(`已恢复 ${list.length} 个标签页`, "success");
    });
    item.querySelector('[data-act="del"]').addEventListener("click", () => {
      showCustomConfirm(
        "删除会话",
        `确定删除会话「${sess.name}」（含 ${sess.itemCount} 个标签页）吗？`,
        async () => {
          const resp = await sendAction({ action: "deleteSession", sessionId: sess.id }, "删除会话");
          if (resp.success) {
            showStatus("会话已删除", "success");
            loadSessions();
          } else {
            showStatus(resp.error || "删除失败", "error");
          }
        }
      );
    });
    dom.sessList.appendChild(item);
  }
}

function confirmDeleteSessionItem(session, item) {
  showCustomConfirm(
    "删除标签页",
    `确定从会话「${session.name}」中删除该标签页吗？\n${item.title || item.url}`,
    async () => {
      const resp = await sendAction({ action: "deleteSessionItem", itemId: item.id }, "删除标签页");
      if (resp.success) {
        showStatus("标签页已删除", "success");
        loadSessions();
      } else {
        showStatus(resp.error || "删除失败", "error");
      }
    }
  );
}

/* ---------- 快照管理 ---------- */

let snapState = { offset: 0, total: 0 };

async function loadSnapshots(reset) {
  if (reset) {
    snapState = { offset: 0, total: 0 };
    dom.snapList.innerHTML = "";
  }
  const resp = await sendAction({ action: "listSnapshots", limit: 20, offset: snapState.offset }, "加载快照");
  if (!resp.success) {
    if (snapState.offset === 0) dom.snapList.innerHTML = `<div class="empty-state">${resp.error || "加载失败"}</div>`;
    return;
  }
  const items = (resp.data && resp.data.snapshots) || [];
  snapState.total = (resp.data && resp.data.total) || 0;
  dom.snapCount.textContent = snapState.total > 0 ? String(snapState.total) : "";

  if (snapState.offset === 0 && items.length === 0) {
    dom.snapList.innerHTML = `<div class="empty-state"><div class="empty-icon">📸</div>还没有快照<br/>右键页面选择「保存本页快照」即可存档</div>`;
    dom.snapMoreWrap.hidden = true;
    return;
  }
  items.forEach((snap) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.innerHTML = `
      <div class="result-main">
        <div class="result-item-title">${escapeHtml(snap.title || snap.url)}</div>
        <div class="result-item-url">${escapeHtml(snap.url)}</div>
        <div class="result-item-time">${formatTime(snap.createdAt)}${snap.truncated ? " · ⚠ 已截断（页面过大）" : ""}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-secondary btn-sm" data-act="view" title="查看快照">👁 查看</button>
        <button class="btn btn-secondary btn-sm" data-act="del" title="删除快照">🗑</button>
      </div>`;
    item.querySelector('[data-act="view"]').addEventListener("click", async () => {
      const r = await sendAction({ action: "getSnapshot", snapshotId: snap.id }, "读取快照");
      if (!r.success || !(r.data && r.data.snapshot)) {
        showStatus(r.error || "读取快照失败", "error");
        return;
      }
      const doc = window.open("", "_blank");
      if (!doc) {
        showStatus("浏览器拦截了新窗口，请允许弹窗", "error");
        return;
      }
      doc.document.open();
      doc.document.write(r.data.snapshot.html || "<p>（空快照）</p>");
      doc.document.close();
    });
    item.querySelector('[data-act="del"]').addEventListener("click", () => {
      showCustomConfirm(
        "删除快照",
        `确定删除「${snap.title || snap.url}」的快照吗？`,
        async () => {
          const resp = await sendAction({ action: "deleteSnapshot", snapshotId: snap.id }, "删除快照");
          if (resp.success) {
            showStatus("快照已删除", "success");
            loadSnapshots(true);
          } else {
            showStatus(resp.error || "删除失败", "error");
          }
        }
      );
    });
    dom.snapList.appendChild(item);
  });
  dom.snapMoreWrap.hidden = snapState.offset + items.length >= snapState.total;
  snapState.offset += items.length;
}

/* ---------- 快捷标注（右键「添加为页签标注」跳转 #annotate） ---------- */

let annotateBound = false;

function setupAnnotateView() {
  // 从 hash 解析预填参数：#annotate?text=<选中文本>&url=<页面URL>
  // URLSearchParams 已对 %XX 解码，直接用解析值，勿再 decodeURIComponent
  const p = getHashParams();
  const sel = p.text || "";
  const url = p.url || "";
  if (!annotateBound) {
    annotateBound = true;
    dom.annSaveBtn.addEventListener("click", async () => {
      const targetUrl = (dom.annUrl.value || "").trim();
      if (!targetUrl) {
        showStatus("网址不能为空", "error");
        return;
      }
      const note = dom.annNote.value.trim();
      if (!note) {
        showStatus("标注内容不能为空", "error");
        return;
      }
      const tags = dom.annTags.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      dom.annSaveBtn.disabled = true;
      const resp = await sendAction(
        { action: "save", url: targetUrl, title: dom.annTitle.value.trim(), note, tags },
        "保存标注"
      );
      dom.annSaveBtn.disabled = false;
      if (resp.success) {
        showStatus("标注已保存", "success", 3000);
        setTimeout(() => navigate("home"), 800);
      } else {
        showStatus(resp.error || "保存失败", "error");
      }
    });
    dom.annCancelBtn.addEventListener("click", () => navigate("home"));
  }
  // 每次进入视图刷新预填内容
  dom.annTitle.value = "";
  dom.annUrl.value = url;
  dom.annNote.value = sel;
  dom.annTags.value = "";
  dom.annSaveBtn.disabled = false;
}

/* ---------- 标签关系图谱 ---------- */

async function loadTagGraph() {
  dom.tagGraph.innerHTML = `<div class="empty-state">正在生成图谱…</div>`;
  const resp = await sendAction({ action: "getTagGraph" }, "生成图谱");
  if (!resp.success) {
    dom.tagGraph.innerHTML = `<div class="empty-state">${resp.error || "生成图谱失败"}</div>`;
    return;
  }
  const nodes = (resp.data && resp.data.nodes) || [];
  const edges = (resp.data && resp.data.edges) || [];
  if (nodes.length === 0) {
    dom.tagGraph.innerHTML = `<div class="empty-state"><div class="empty-icon">🕸</div>还没有标签<br/>给标注添加标签后即可生成关系图谱</div>`;
    return;
  }
  renderGraphSvg(nodes, edges);
}

function renderGraphSvg(nodes, edges) {
  const W = 760;
  const H = 400;
  const cx = W / 2;
  const cy = H / 2 - 10;

  // 有关联的标签 = 出现在任意边中的节点；孤立标签（无任何共现边）单独列出
  const edgeNodeIds = new Set();
  edges.forEach((e) => { edgeNodeIds.add(String(e.source)); edgeNodeIds.add(String(e.target)); });
  const related = nodes.filter((n) => edgeNodeIds.has(String(n.id)));
  const isolated = nodes.filter((n) => !edgeNodeIds.has(String(n.id)));

  // 图区：只有关联标签 >= 2 个时才画图（干净、不画孤立节点）
  if (related.length >= 2) {
    const sorted = related.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
    const maxCount = sorted.reduce((m, n) => Math.max(m, n.count || 1), 1);
    // 环形布局
    const R = Math.min(cx, cy) - 60;
    const angleStep = (2 * Math.PI) / sorted.length;
    const pos = new Map();
    sorted.forEach((n, i) => {
      const a = -Math.PI / 2 + angleStep * i;
      pos.set(String(n.id), { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight || 1), 1);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="graph-svg" xmlns="http://www.w3.org/2000/svg">`;
    // 所有关联边都画，粗细/透明度按共现次数分级
    edges.forEach((e) => {
      const p1 = pos.get(String(e.source));
      const p2 = pos.get(String(e.target));
      if (!p1 || !p2) return;
      const weight = e.weight || 1;
      const width = 0.8 + (weight / maxWeight) * 3.0;
      const opacity = 0.3 + (weight / maxWeight) * 0.5;
      svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#94a3b8" stroke-opacity="${opacity.toFixed(2)}" stroke-width="${width.toFixed(2)}"/>`;
    });
    sorted.forEach((n) => {
      const p = pos.get(String(n.id));
      const r = 14 + (n.count / maxCount) * 16;
      svg += `<g class="graph-node" data-tag-id="${n.id}" data-tag-name="${escapeAttr(n.name)}" style="cursor:pointer;">`;
      svg += `<circle cx="${p.x}" cy="${p.y}" r="${r.toFixed(1)}" fill="#2563eb" fill-opacity="0.16" stroke="#2563eb" stroke-width="1.6"/>`;
      svg += `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="12" fill="currentColor">${escapeHtml(n.name.length > 8 ? n.name.slice(0, 8) + "…" : n.name)}</text>`;
      svg += `<title>${escapeHtml(n.name)}（${n.count} 条标注）</title>`;
      svg += `</g>`;
    });
    svg += `</svg>`;
    dom.tagGraph.innerHTML = svg;

    // 点击节点 → 直接走现有 hash 直达筛选（manage?tagId=..&name=..），onHashChange 自动加载
    dom.tagGraph.querySelectorAll(".graph-node").forEach((g) => {
      g.addEventListener("click", () => {
        const tagId = Number(g.dataset.tagId);
        const name = g.dataset.tagName;
        if (Number.isInteger(tagId) && tagId > 0 && name) {
          location.hash = "manage?tagId=" + tagId + "&name=" + encodeURIComponent(name);
        }
      });
    });
  } else {
    dom.tagGraph.innerHTML =
      `<div class="empty-state"><div class="empty-icon">🕸</div>标签之间还没有共现关系<br/>给同一标注添加多个标签后，就会在这里连出关系线</div>`;
  }

  // 全部标签导航 chips（含孤立标签），点击同样直达筛选——保证每个标签都可点
  const chips = nodes.slice().sort((a, b) => (b.count || 0) - (a.count || 0)).map((n) =>
    `<span class="graph-chip" data-tag-id="${n.id}" data-tag-name="${escapeAttr(n.name)}" title="${escapeAttr(n.name)}（${n.count} 条标注）">${escapeHtml(n.name)}<em>${n.count || 0}</em></span>`
  ).join("");
  if (chips) {
    const chipsBox = document.createElement("div");
    chipsBox.className = "graph-chips";
    chipsBox.innerHTML = `<div class="graph-chips-title">全部标签 · 点击查看标注</div><div class="graph-chips-body">${chips}</div>`;
    dom.tagGraph.appendChild(chipsBox);
    chipsBox.querySelectorAll(".graph-chip").forEach((c) => {
      c.addEventListener("click", () => {
        const id = Number(c.dataset.tagId);
        const name = c.dataset.tagName;
        if (Number.isInteger(id) && id > 0 && name) {
          location.hash = "manage?tagId=" + id + "&name=" + encodeURIComponent(name);
        }
      });
    });
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text);
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
