/**
 * WebAnnotator 新标签页 · 核心逻辑
 *
 * 架构（见 design.md 3.3）：模块注册表模式。
 * - NavModule        左侧导航：主页 / 标签墙 视图切换（左栏自动隐藏，底部设置入口）
 * - WebSearchModule  网络搜索框（自定义引擎菜单 + 记忆、可拖动记忆位置、
 *                    实时本地匹配窗口：高亮/骨架/空态/键盘导航）
 * - TagWallModule    标签墙视图：可拖动 / 可缩放面板（位置与尺寸记忆持久化）
 * - SettingsModule   左栏底部设置入口（打开管理面板首页）
 * - BackgroundModule 背景（随机换背景 / 恢复默认，右键菜单触发）
 * - ContextMenuModule 右键菜单（随机换背景 / 恢复默认等）
 *
 * 可扩展接口：后续小组件 / 暗黑模式等按 registerModule 同款接口注册即可（R9）。
 */

"use strict";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/** 背景图片文件名列表（extension/backgrounds/ 下；由 tools/sync-backgrounds.ps1 自动更新） */
const BGM_LIST = ["cb31721e96c1d69eae39ada9ab04795f.jpg"];

/** 背景存储键（chrome.storage.local） */
const BG_STORE_KEY = "newtabBg";

/** 搜索框位置存储键 */
const SEARCH_POS_KEY = "webSearchPos";

/** 搜索引擎选择存储键 */
const ENGINE_STORE_KEY = "webSearchEngine";

/** 标签墙面板位置 / 尺寸存储键 */
const TAGWALL_POS_KEY = "tagWallPos";
const TAGWALL_SIZE_KEY = "tagWallSize";

/** 搜索引擎配置（badge = 徽标字，color = 品牌色） */
const ENGINES = {
  baidu:  { name: "百度",       url: "https://www.baidu.com/s?wd=",      badge: "百", color: "#2932E1" },
  bing:   { name: "必应（微软）", url: "https://www.bing.com/search?q=",  badge: "必", color: "#008373" },
  google: { name: "谷歌",       url: "https://www.google.com/search?q=", badge: "G",  color: "#4285F4" },
  sogou:  { name: "搜狗",       url: "https://www.sogou.com/web?query=", badge: "搜", color: "#FF6600" },
};

/* ================================================================== */
/* 工具函数                                                           */
/* ================================================================== */

/** 统一发送请求：经 background 转发到本地 host（复用既有帧协议） */
function sendAction(payload, label) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("[newtab] sendMessage 失败(" + (label || payload.action) + "):", chrome.runtime.lastError.message);
        resolve({ success: false, error: chrome.runtime.lastError.message, errorCode: "CHROME_ERROR" });
        return;
      }
      resolve(resp || { success: false, error: "空响应", errorCode: "INTERNAL_ERROR" });
    });
  });
}

/** 打开网页 / 扩展页面（新标签页中打开） */
function openUrl(url) {
  if (!url) return;
  chrome.tabs.create({ url: url });
}

/** chrome.bookmarks.search 的 Promise 包装（callback → Promise） */
function bookmarksSearch(query) {
  return new Promise((resolve) => {
    try {
      chrome.bookmarks.search(query, (nodes) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ success: true, nodes: nodes || [] });
      });
    } catch (err) {
      resolve({ success: false, error: String(err && err.message || err) });
    }
  });
}
/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
function formatRelTime(isoString) {
  if (!isoString) return "";
  const t = new Date(isoString).getTime();
  if (isNaN(t)) return isoString;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小时前";
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨天";
  if (day < 7) return day + " 天前";
  const d = new Date(t);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** 标题文本 + 关键词高亮（纯 text 节点构建，无 XSS 面） */
function setTextWithHighlight(el, text, q) {
  el.textContent = "";
  if (!q) {
    el.textContent = text;
    return;
  }
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) {
    el.textContent = text;
    return;
  }
  el.append(text.slice(0, idx));
  const em = document.createElement("em");
  em.className = "hl";
  em.textContent = text.slice(idx, idx + q.length);
  el.append(em, text.slice(idx + q.length));
}

/** 字符串 → 0-359 色相（同站同色） */
function hashHue(str) {
  let h = 0;
  const s = str || "";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 展示用 URL：去协议（https://a.com/p?q → a.com/p?q） */
function displayUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname + u.search;
  } catch (err) {
    return url || "";
  }
}

/** 站点字母徽标（域名 hash → HSL 配色，零网络依赖） */
function createSiteBadge(url) {
  const badge = document.createElement("span");
  badge.className = "site-badge";
  let host = "";
  try {
    host = new URL(url).hostname || "";
  } catch (err) {
    host = "";
  }
  const label = host ? host.replace(/^www\./, "").charAt(0).toUpperCase() : "•";
  badge.style.setProperty("--h", String(hashHue(host || label)));
  badge.textContent = label;
  return badge;
}

/** 加载骨架（两行 shimmer） */
function renderSkeleton(container) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "skeleton";
  for (let i = 0; i < 2; i++) {
    const row = document.createElement("div");
    row.className = "sk-row";
    const badge = document.createElement("div");
    badge.className = "sk-badge";
    const lines = document.createElement("div");
    lines.className = "sk-lines";
    const l1 = document.createElement("div");
    l1.className = "sk-line w70";
    const l2 = document.createElement("div");
    l2.className = "sk-line w45";
    lines.append(l1, l2);
    row.append(badge, lines);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}
/* ================================================================== */
/* 模块注册表（可扩展接口，R9）                                        */
/* ================================================================== */

const app = {
  modules: [],

  /** 注册模块：{ id, init?, refresh? }，refresh 返回 Promise */
  registerModule(m) {
    this.modules.push(m);
    return this;
  },

  /** 启动：先 init（绑定事件），再并行 refresh（取数渲染） */
  start() {
    this.modules.forEach((m) => { if (typeof m.init === "function") m.init(); });
    this.modules.forEach((m) => { if (typeof m.refresh === "function") m.refresh(); });
  },
};

/* ================================================================== */
/* 全局错误条（R15：host 未连接指引）                                 */
/* ================================================================== */

const errorBar = document.getElementById("errorBar");

function showError(msg) {
  errorBar.textContent = msg;
  errorBar.hidden = false;
}

function hideError() {
  errorBar.hidden = true;
  errorBar.textContent = "";
}

function isHostFailure(resp) {
  return !resp || !resp.success ||
    resp.errorCode === "HOST_NOT_FOUND" || resp.errorCode === "HOST_DISCONNECTED" || resp.errorCode === "CHROME_ERROR";
}

/** host 失败统一提示：错误条 + 模块内占位，不白屏（R15/R18） */
function handleHostFailure(moduleEl, resp) {
  showError("本地服务未连接，请运行 auto-register.ps1 重新注册后重试。");
  renderModuleError(moduleEl, "本地服务未连接", "重试", () => {
    hideError();
    app.modules.forEach((m) => { if (typeof m.refresh === "function") m.refresh(); });
  });
}

function renderModuleError(container, text, btnText, onClick) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "module-error";
  div.textContent = text;
  if (btnText && onClick) {
    const btn = document.createElement("button");
    btn.textContent = btnText;
    btn.addEventListener("click", onClick);
    div.appendChild(btn);
  }
  container.appendChild(div);
}

function renderEmpty(container, text) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text || "暂无数据";
  container.appendChild(div);
}

function renderLoading(container, text) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "loading";
  div.textContent = text || "加载中…";
  container.appendChild(div);
}

/** 构建标注结果卡片（站点徽标 / title 高亮 / url / 标签 / 相对时间） */
function createAnnotationItem(item, q) {
  const a = document.createElement("a");
  a.className = "result-item";
  a.href = item.url || "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (item.url) openUrl(item.url);
  });

  if (item.url) a.appendChild(createSiteBadge(item.url));

  const body = document.createElement("div");
  body.className = "ri-body";

  const title = document.createElement("div");
  title.className = "ri-title";
  setTextWithHighlight(title, item.title || item.url || "(无标题)", q);

  const meta = document.createElement("div");
  meta.className = "ri-meta";

  const tags = item.tags || [];
  if (tags.length > 0) {
    const tagsWrap = document.createElement("span");
    tagsWrap.className = "ri-tags";
    tags.forEach((t) => {
      const span = document.createElement("span");
      span.className = "ri-tag";
      span.textContent = t;
      tagsWrap.appendChild(span);
    });
    meta.appendChild(tagsWrap);
  }

  if (item.updatedAt) {
    const time = document.createElement("span");
    time.className = "ri-time";
    time.textContent = formatRelTime(item.updatedAt);
    meta.appendChild(time);
  }

  const urlSpan = document.createElement("span");
  urlSpan.className = "ri-url";
  urlSpan.textContent = item.url ? displayUrl(item.url) : "";
  meta.appendChild(urlSpan);

  body.appendChild(title);
  body.appendChild(meta);
  a.appendChild(body);
  return a;
}

/** 构建收藏夹结果卡片（站点徽标 / title 高亮 / 「收藏夹」来源标签） */
function createBookmarkItem(node, q) {
  const a = document.createElement("a");
  a.className = "result-item";
  a.href = node.url || "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (node.url) openUrl(node.url);
  });

  if (node.url) a.appendChild(createSiteBadge(node.url));

  const body = document.createElement("div");
  body.className = "ri-body";

  const title = document.createElement("div");
  title.className = "ri-title";
  setTextWithHighlight(title, node.title || node.url || "(无标题)", q);

  const meta = document.createElement("div");
  meta.className = "ri-meta";
  const src = document.createElement("span");
  src.className = "ri-tag src";
  src.textContent = "收藏夹";
  meta.appendChild(src);
  const urlSpan = document.createElement("span");
  urlSpan.className = "ri-url";
  urlSpan.textContent = node.url ? displayUrl(node.url) : "";
  meta.appendChild(urlSpan);

  body.appendChild(title);
  body.appendChild(meta);
  a.appendChild(body);
  return a;
}
/* ================================================================== */
/* NavModule：左侧导航（主页 / 标签墙；左栏自动隐藏可唤出）             */
/* ================================================================== */

const NavModule = {
  id: "nav",
  navItems: document.querySelectorAll(".nav-item"),
  sidebar: document.getElementById("sidebar"),
  toggleBtn: document.getElementById("navToggle"),
  viewHome: document.getElementById("viewHome"),
  viewTags: document.getElementById("viewTags"),

  init() {
    // 左栏自动隐藏：悬浮按钮唤出 / 收起
    this.toggleBtn.addEventListener("click", () => this.toggleSidebar());

    this.navItems.forEach((item) => {
      const activate = () => {
        this.switchTo(item.dataset.view);
        this.collapseSidebar(); // 选择后收起左栏，不遮挡背景
      };
      item.addEventListener("click", activate);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
      });
    });
  },

  toggleSidebar() {
    this.sidebar.classList.toggle("collapsed");
  },
  collapseSidebar() {
    this.sidebar.classList.add("collapsed");
  },

  switchTo(view) {
    this.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    this.viewHome.hidden = view !== "home";
    this.viewTags.hidden = view !== "tags";
    // 首次进入标签墙视图时确保数据已渲染
    if (view === "tags" && typeof TagWallModule.refresh === "function") {
      if (TagWallModule._loaded === false) TagWallModule.refresh();
    }
  },
};

/* ================================================================== */
/* WebSearchModule：网络搜索框（自定义引擎菜单 + 记忆；拖动记忆位置；   */
/*                  实时匹配窗口：高亮/骨架/空态/键盘导航）             */
/* ================================================================== */

const WebSearchModule = {
  id: "websearch",
  input: document.getElementById("webSearchInput"),
  btn: document.getElementById("webSearchBtn"),
  box: document.querySelector(".web-search"),
  engineBtn: document.getElementById("engineBtn"),
  engineBadge: document.getElementById("engineBadge"),
  engineName: document.getElementById("engineName"),
  engineMenu: document.getElementById("engineMenu"),
  localResults: document.getElementById("localResults"),
  localGroups: document.getElementById("localGroups"),
  localEmpty: document.getElementById("localEmpty"),
  localAnnotations: document.getElementById("localAnnotations"),
  localBookmarks: document.getElementById("localBookmarks"),
  annoCount: document.getElementById("annoCount"),
  bmCount: document.getElementById("bmCount"),
  footTip: document.getElementById("footTip"),
  POS_KEY: SEARCH_POS_KEY,
  ENGINE_KEY: ENGINE_STORE_KEY,
  LOCAL_LIMIT: 8,       // 每源最多展示条数（面板限高，防撑爆）
  _localTimer: null,
  _engine: "baidu",
  _dragging: false,
  _startX: 0,
  _startY: 0,
  _origLeft: 0,
  _origTop: 0,

  async init() {
    // 恢复上次选择的搜索引擎（记忆）
    await this.restoreEngine();
    this.applyEngineBadge(this._engine);

    this.btn.addEventListener("click", () => this.search());
    this.input.addEventListener("keydown", (e) => this.onInputKeydown(e));
    // 输入时动态搜索标注与收藏夹（防抖）
    this.input.addEventListener("input", () => {
      clearTimeout(this._localTimer);
      this._localTimer = setTimeout(() => this.doLocalSearch(this.input.value), 250);
    });

    // "/" 快捷键聚焦搜索框（输入类元素聚焦时不抢占）
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      this.input.focus();
    });

    // 引擎菜单：点击触发 / 点击外部关闭 / Esc 关闭 / 缩放关闭
    this.engineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleEngineMenu();
    });
    document.addEventListener("click", (e) => {
      if (!this.engineMenu.hidden && !this.engineMenu.contains(e.target)) this.closeEngineMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.engineMenu.hidden) this.closeEngineMenu();
    });
    window.addEventListener("resize", () => this.closeEngineMenu());

    // 恢复上次拖动位置（无记录时保持默认居中）
    try {
      const st = await chrome.storage.local.get(this.POS_KEY);
      const pos = st && st[this.POS_KEY];
      if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
        this.pin(pos.left, pos.top);
      }
    } catch (err) {
      console.warn("[newtab] 读取搜索框位置失败:", err);
    }
    this.bindDrag();
  },

  async restoreEngine() {
    try {
      const st = await chrome.storage.local.get(this.ENGINE_KEY);
      const key = st && st[this.ENGINE_KEY];
      if (key && ENGINES[key]) this._engine = key;
    } catch (err) {
      console.warn("[newtab] 读取搜索引擎配置失败:", err);
    }
  },

  /** 徽标 / 名称同步到触发按钮 */
  applyEngineBadge(key) {
    const eng = ENGINES[key] || ENGINES.baidu;
    this.engineBadge.textContent = eng.badge;
    if (eng.color) this.engineBadge.style.setProperty("--e", eng.color);
    this.engineName.textContent = eng.name;
  },

  toggleEngineMenu() {
    if (this.engineMenu.hidden) {
      this.renderEngineMenu();
      const rect = this.box.getBoundingClientRect();
      this.engineMenu.style.left = (rect.left + 6) + "px";
      this.engineMenu.style.top = (rect.bottom + 10) + "px";
      this.engineMenu.hidden = false;
      this.engineBtn.classList.add("open");
    } else {
      this.closeEngineMenu();
    }
  },

  closeEngineMenu() {
    this.engineMenu.hidden = true;
    this.engineBtn.classList.remove("open");
  },

  renderEngineMenu() {
    const menu = this.engineMenu;
    menu.textContent = "";
    Object.keys(ENGINES).forEach((key) => {
      const eng = ENGINES[key];
      const item = document.createElement("div");
      item.className = "engine-item" + (key === this._engine ? " active" : "");
      const badge = document.createElement("span");
      badge.className = "engine-badge";
      if (eng.color) badge.style.setProperty("--e", eng.color);
      badge.textContent = eng.badge;
      const name = document.createElement("span");
      name.textContent = eng.name;
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      item.append(badge, name, check);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._engine = key;
        this.applyEngineBadge(key);
        try {
          chrome.storage.local.set({ [this.ENGINE_KEY]: key });
        } catch (err) {
          console.warn("[newtab] 保存搜索引擎配置失败:", err);
        }
        this.closeEngineMenu();
        this.input.focus();
      });
      menu.appendChild(item);
    });
    const tip = document.createElement("div");
    tip.className = "menu-tip";
    tip.textContent = "当前引擎已记忆，下次打开保持不变";
    menu.appendChild(tip);
  },
  /** 匹配窗口键盘导航：↑↓ 选择 / Enter 打开（无选中时网络搜索）/ Esc 收起 */
  onInputKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const active = this.localResults.querySelector(".result-item.active");
      if (active) {
        active.click();
        return;
      }
      this.search();
    } else if (e.key === "Escape") {
      this.input.value = "";
      this.doLocalSearch("");
      this.input.blur();
    }
  },

  /** 键盘高亮项移动（循环） */
  moveActive(delta) {
    const items = Array.from(this.localResults.querySelectorAll(".result-item"));
    if (items.length === 0) return;
    let idx = items.findIndex((el) => el.classList.contains("active"));
    idx = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
    items.forEach((el) => el.classList.remove("active"));
    items[idx].classList.add("active");
    items[idx].scrollIntoView({ block: "nearest" });
  },

  /** 主页动态本地搜索：标注 + 收藏夹，结果面板实时显示（骨架 / 高亮 / 计数 / 双源空态） */
  async doLocalSearch(raw) {
    const q = (raw || "").trim().slice(0, 200);
    if (q === "") {
      this.localResults.hidden = true;
      this.localAnnotations.innerHTML = "";
      this.localBookmarks.innerHTML = "";
      this.annoCount.hidden = true;
      this.bmCount.hidden = true;
      this.localGroups.hidden = false;
      this.localEmpty.hidden = true;
      return;
    }
    this.localResults.hidden = false;
    this.syncPanel();   // 显示前确保与搜索框对齐（含拖动过的 fixed 场景）
    renderSkeleton(this.localAnnotations);
    renderSkeleton(this.localBookmarks);

    const [annoResp, bmResp] = await Promise.all([
      sendAction({ action: "search", query: q, limit: this.LOCAL_LIMIT, offset: 0 }, "主页搜索标注"),
      bookmarksSearch(q),
    ]);

    let annoCount = 0;
    if (isHostFailure(annoResp)) {
      handleHostFailure(this.localAnnotations, annoResp);
    } else if (!annoResp.success) {
      renderModuleError(this.localAnnotations, annoResp.error || "标注搜索失败");
    } else {
      const results = (annoResp.data && annoResp.data.results) || [];
      this.localAnnotations.innerHTML = "";
      annoCount = results.length;
      if (results.length === 0) {
        renderEmpty(this.localAnnotations, "未找到匹配内容");
      } else {
        results.forEach((item) => this.localAnnotations.appendChild(createAnnotationItem(item, q)));
      }
    }

    let bmCount = 0;
    if (!bmResp.success) {
      renderModuleError(this.localBookmarks, "收藏夹不可用");
    } else {
      const nodes = (bmResp.nodes || []).filter((n) => n.url && /^https?:\/\//i.test(n.url)).slice(0, this.LOCAL_LIMIT);
      this.localBookmarks.innerHTML = "";
      bmCount = nodes.length;
      if (nodes.length === 0) {
        renderEmpty(this.localBookmarks, "未找到匹配内容");
      } else {
        nodes.forEach((n) => this.localBookmarks.appendChild(createBookmarkItem(n, q)));
      }
    }

    // 计数徽标
    this.annoCount.textContent = annoCount;
    this.annoCount.hidden = annoCount === 0;
    this.bmCount.textContent = bmCount;
    this.bmCount.hidden = bmCount === 0;

    // 双源均无结果：整体空态（仅双源都成功时，错误态保持分组占位）
    const annoOk = annoResp.success && !isHostFailure(annoResp);
    const bmOk = !!bmResp.success;
    if (annoOk && bmOk && annoCount === 0 && bmCount === 0) {
      this.localGroups.hidden = true;
      this.localEmpty.querySelector(".empty-title").textContent = "标注与收藏夹中未找到「" + q + "」";
      this.localEmpty.hidden = false;
      this.footTip.textContent = "按 Enter 直接网络搜索";
    } else {
      this.localGroups.hidden = false;
      this.localEmpty.hidden = true;
      this.footTip.textContent = "输入为空时自动收起";
    }
    this.syncPanel();
  },

  search() {
    const q = (this.input.value || "").trim();
    if (!q) { this.input.focus(); return; }
    const engine = this._engine || "baidu";
    const url = (ENGINES[engine] || ENGINES.baidu).url + encodeURIComponent(q);
    openUrl(url);
  },

  /** 固定到指定位置（脱离居中布局） */
  pin(left, top) {
    this.box.classList.add("pinned");
    this.box.style.left = left + "px";
    this.box.style.top = top + "px";
    this.syncPanel();
  },

  /** 结果面板与搜索框对齐：搜索框被拖走(fixed)时面板跟随其底部 +10px；未拖走时回到文档流 */
  syncPanel() {
    const panel = this.localResults;
    if (this.box.classList.contains("pinned")) {
      const rect = this.box.getBoundingClientRect();
      panel.style.position = "fixed";
      panel.style.left = rect.left + "px";
      panel.style.top = (rect.bottom + 10) + "px";
      panel.style.width = this.box.offsetWidth + "px";
      panel.style.maxWidth = this.box.offsetWidth + "px";
      panel.style.margin = "0";
    } else {
      panel.style.position = "";
      panel.style.left = "";
      panel.style.top = "";
      panel.style.width = "";
      panel.style.maxWidth = "";
      panel.style.margin = "";
    }
  },

  /** 鼠标左键拖动：容器空白/边框/把手区为手柄，输入/引擎按钮/搜索按钮上不触发 */
  bindDrag() {
    this.box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("input,button")) return;
      this.closeEngineMenu();
      this._dragging = true;
      this._startX = e.clientX;
      this._startY = e.clientY;
      const rect = this.box.getBoundingClientRect();
      this._origLeft = rect.left;
      this._origTop = rect.top;
      this.pin(rect.left, rect.top);
      this.box.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this._dragging) return;
      const w = this.box.offsetWidth;
      const h = this.box.offsetHeight;
      const left = Math.max(8, Math.min(this._origLeft + (e.clientX - this._startX), window.innerWidth - w - 8));
      const top = Math.max(8, Math.min(this._origTop + (e.clientY - this._startY), window.innerHeight - h - 8));
      this.box.style.left = left + "px";
      this.box.style.top = top + "px";
      this.syncPanel();   // 拖动中面板实时跟随
    });

    document.addEventListener("mouseup", () => {
      if (!this._dragging) return;
      this._dragging = false;
      this.box.classList.remove("dragging");
      const left = parseFloat(this.box.style.left) || this._origLeft;
      const top = parseFloat(this.box.style.top) || this._origTop;
      this.syncPanel();
      try {
        chrome.storage.local.set({ [this.POS_KEY]: { left: left, top: top } });
      } catch (err) {
        console.warn("[newtab] 保存搜索框位置失败:", err);
      }
    });
  },
};
/* ================================================================== */
/* TagWallModule：标签墙（可拖动 / 右下角可缩放面板，位置与尺寸记忆）   */
/* ================================================================== */

const TagWallModule = {
  id: "tagwall",
  panel: document.getElementById("tagWallPanel"),
  head: document.getElementById("tagWallHead"),
  wallContainer: document.getElementById("tagWall"),
  resizeHandle: document.getElementById("tagWallResize"),
  POS_KEY: TAGWALL_POS_KEY,
  SIZE_KEY: TAGWALL_SIZE_KEY,
  MIN_W: 260,           // 最小宽度
  MIN_H: 180,           // 最小高度
  MARGIN: 8,            // 距视口边缘最小距离
  DEFAULT_W: 480,       // 默认宽度（无记忆时）
  DEFAULT_H: 440,       // 默认高度（无记忆时）
  EXPAND_LIMIT: 20,     // 点击标签展开时最多展示的链接条数
  _expandedTagId: null,
  _expandEl: null,
  _loaded: false,
  _dragging: false,
  _resizing: false,
  _startX: 0,
  _startY: 0,
  _origLeft: 0,
  _origTop: 0,
  _origW: 0,
  _origH: 0,

  async init() {
    await this.restoreLayout();
    this.bindDrag();
    this.bindResize();
    // 窗口缩放：把面板收回视口内（隐藏状态下跳过，避免破坏记忆位置）
    window.addEventListener("resize", () => {
      if (!this.panel.offsetWidth) return;
      this.clampIntoViewport();
    });
  },

  /** 恢复记忆的位置与尺寸（无记忆时默认尺寸居中） */
  async restoreLayout() {
    let pos = null, size = null;
    try {
      const st = await chrome.storage.local.get([this.POS_KEY, this.SIZE_KEY]);
      pos = st && st[this.POS_KEY];
      size = st && st[this.SIZE_KEY];
    } catch (err) {
      console.warn("[newtab] 读取标签墙面板布局失败:", err);
    }
    let w = this.DEFAULT_W, h = this.DEFAULT_H;
    if (size && typeof size.width === "number" && typeof size.height === "number") {
      w = Math.max(this.MIN_W, size.width);
      h = Math.max(this.MIN_H, size.height);
    }
    w = Math.min(w, window.innerWidth - this.MARGIN * 2);
    h = Math.min(h, window.innerHeight - this.MARGIN * 2);
    this.panel.style.width = w + "px";
    this.panel.style.height = h + "px";
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      this.place(pos.left, pos.top);
    } else {
      this.place((window.innerWidth - w) / 2, (window.innerHeight - h) / 2);
    }
  },

  /** 设置面板位置（clamp 到视口内；隐藏时 offsetWidth 为 0，回退读 style.width） */
  place(left, top) {
    const w = this.panel.offsetWidth || parseInt(this.panel.style.width, 10) || this.DEFAULT_W;
    const h = this.panel.offsetHeight || parseInt(this.panel.style.height, 10) || this.DEFAULT_H;
    left = Math.max(this.MARGIN, Math.min(left, window.innerWidth - w - this.MARGIN));
    top = Math.max(this.MARGIN, Math.min(top, window.innerHeight - h - this.MARGIN));
    this.panel.style.left = left + "px";
    this.panel.style.top = top + "px";
  },

  /** 窗口缩放后：位置/尺寸收回视口内 */
  clampIntoViewport() {
    let w = this.panel.offsetWidth;
    let h = this.panel.offsetHeight;
    const maxW = window.innerWidth - this.MARGIN * 2;
    const maxH = window.innerHeight - this.MARGIN * 2;
    if (w > maxW) { w = Math.max(this.MIN_W, maxW); this.panel.style.width = w + "px"; }
    if (h > maxH) { h = Math.max(this.MIN_H, maxH); this.panel.style.height = h + "px"; }
    const left = parseFloat(this.panel.style.left) || this.MARGIN;
    const top = parseFloat(this.panel.style.top) || this.MARGIN;
    this.place(left, top);
  },

  /** 布局持久化 */
  saveLayout(key, value) {
    try {
      chrome.storage.local.set({ [key]: value });
    } catch (err) {
      console.warn("[newtab] 保存标签墙面板布局失败:", err);
    }
  },

  /** 标题栏按住拖动移动面板（位置记忆） */
  bindDrag() {
    this.head.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("input,button")) return;
      this._dragging = true;
      this._startX = e.clientX;
      this._startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      this._origLeft = rect.left;
      this._origTop = rect.top;
      this.panel.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (this._dragging) {
        const left = this._origLeft + (e.clientX - this._startX);
        const top = this._origTop + (e.clientY - this._startY);
        this.place(left, top);
      } else if (this._resizing) {
        const w = Math.max(this.MIN_W, Math.min(this._origW + (e.clientX - this._startX), window.innerWidth - this.MARGIN * 2));
        const h = Math.max(this.MIN_H, Math.min(this._origH + (e.clientY - this._startY), window.innerHeight - this.MARGIN * 2));
        this.panel.style.width = w + "px";
        this.panel.style.height = h + "px";
      }
    });

    document.addEventListener("mouseup", () => {
      if (this._dragging) {
        this._dragging = false;
        this.panel.classList.remove("dragging");
        this.saveLayout(this.POS_KEY, {
          left: parseFloat(this.panel.style.left) || this.MARGIN,
          top: parseFloat(this.panel.style.top) || this.MARGIN,
        });
      }
      if (this._resizing) {
        this._resizing = false;
        this.saveLayout(this.SIZE_KEY, {
          width: this.panel.offsetWidth,
          height: this.panel.offsetHeight,
        });
      }
    });
  },

  /** 右下角手柄按住缩放宽高（尺寸记忆，最小 MIN_W × MIN_H，不出视口） */
  bindResize() {
    this.resizeHandle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this._resizing = true;
      this._startX = e.clientX;
      this._startY = e.clientY;
      this._origW = this.panel.offsetWidth;
      this._origH = this.panel.offsetHeight;
    });
  },

  async refresh() {
    this._loaded = false;
    renderLoading(this.wallContainer, "加载中…");
    const resp = await sendAction({ action: "getTagsWithCount" }, "标签墙");
    if (isHostFailure(resp)) {
      handleHostFailure(this.wallContainer, resp);
      return;
    }
    if (!resp.success) {
      renderModuleError(this.wallContainer, resp.error || "加载失败");
      return;
    }
    const tags = resp.data && resp.data.tags ? resp.data.tags : [];
    this.renderWall(tags);
    this._loaded = true;
  },

  /** 标签墙（数量倒序 chips） */
  renderWall(tags) {
    const c = this.wallContainer;
    this.collapseTag();
    c.innerHTML = "";
    if (tags.length === 0) {
      renderEmpty(c, "还没有标签，先给网页打个标签吧");
      return;
    }
    tags.forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.title = "查看标签「" + (tag.name || "") + "」下的网页";

      const name = document.createElement("span");
      name.textContent = tag.name || "(未命名)";
      const count = document.createElement("span");
      count.className = "tc-count";
      count.textContent = tag.count || 0;

      chip.appendChild(name);
      chip.appendChild(count);
      chip.addEventListener("click", () => this.toggleTag(tag, chip));
      c.appendChild(chip);
    });
  },

  /** 点击标签：在面板内展开 / 收起该标签下的网页链接 */
  toggleTag(tag, chip) {
    if (this._expandedTagId === tag.id) {
      this.collapseTag();
      return;
    }
    this.collapseTag();
    this._expandedTagId = tag.id;
    chip.classList.add("expanded");

    const box = document.createElement("div");
    box.className = "tag-expand";
    renderSkeleton(box);
    chip.after(box);
    this._expandEl = box;
    this.loadTagLinks(tag, box);
  },

  /** 收起当前展开区 */
  collapseTag() {
    this._expandedTagId = null;
    if (this._expandEl) {
      this._expandEl.remove();
      this._expandEl = null;
    }
    this.wallContainer.querySelectorAll(".tag-chip.expanded").forEach((el) => el.classList.remove("expanded"));
  },

  /** 加载标签下的标注列表（host: getAnnotationsByTag） */
  async loadTagLinks(tag, box) {
    const resp = await sendAction(
      { action: "getAnnotationsByTag", tagIds: [tag.id], limit: this.EXPAND_LIMIT, offset: 0 },
      "标签链接"
    );
    if (this._expandEl !== box) return;   // 展开区已切换 / 收起，丢弃过期响应
    if (isHostFailure(resp)) {
      handleHostFailure(box, resp);
      return;
    }
    if (!resp.success) {
      renderModuleError(box, resp.error || "加载失败");
      return;
    }
    const results = (resp.data && resp.data.results) || [];
    const total = (resp.data && resp.data.total) || results.length;
    this.renderTagLinks(box, tag, results, total);
  },

  /** 渲染展开区：标题 + 链接列表 + 查看全部入口 */
  renderTagLinks(box, tag, results, total) {
    box.textContent = "";

    const head = document.createElement("div");
    head.className = "tag-expand-head";
    const name = document.createElement("span");
    name.textContent = "「" + (tag.name || "") + "」下的网页";
    const count = document.createElement("span");
    count.className = "count-badge";
    count.textContent = total;
    head.append(name, count);
    box.appendChild(head);

    if (results.length === 0) {
      renderEmpty(box, "该标签下还没有网页");
      return;
    }

    const list = document.createElement("div");
    list.className = "list";
    results.forEach((item) => list.appendChild(createAnnotationItem(item)));
    box.appendChild(list);

    if (total > results.length) {
      const more = document.createElement("div");
      more.className = "tag-expand-more";
      more.textContent = "共 " + total + " 条，在管理面板查看全部 →";
      more.addEventListener("click", () => this.openTag(tag));
      box.appendChild(more);
    }
  },

  /** 点击标签：打开管理面板并定位该标签（options#manage?tagId=&name=） */
  openTag(tag) {
    if (tag.id == null || !tag.name) return;
    const url = chrome.runtime.getURL("options.html") + "#manage?tagId=" + encodeURIComponent(tag.id) + "&name=" + encodeURIComponent(tag.name);
    openUrl(url);
  },
};

/* ================================================================== */
/* SettingsModule：左栏底部设置入口（打开管理面板首页）                 */
/* ================================================================== */

const SettingsModule = {
  id: "settings",
  btn: document.getElementById("settingsBtn"),

  init() {
    const open = () => openUrl(chrome.runtime.getURL("options.html"));
    this.btn.addEventListener("click", open);
    this.btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  },
};
/* ================================================================== */
/* BackgroundModule：背景（随机换 / 恢复默认，存储持久化）             */
/* ================================================================== */

const BackgroundModule = {
  id: "background",
  layer: document.getElementById("bgLayer"),

  async init() {
    // 读取上次背景并应用
    let saved = "";
    try {
      const st = await chrome.storage.local.get(BG_STORE_KEY);
      saved = st && st[BG_STORE_KEY] ? st[BG_STORE_KEY] : "";
    } catch (err) {
      console.warn("[newtab] 读取背景配置失败:", err);
    }
    this.apply(saved);
  },

  /** 应用背景：文件名（BGM_LIST 中）→ 设置背景图；空 → 恢复默认 */
  apply(name) {
    if (name && BGM_LIST.includes(name)) {
      this.layer.style.backgroundImage = "url(" + chrome.runtime.getURL("backgrounds/" + name) + ")";
    } else {
      this.layer.style.backgroundImage = "";
    }
  },

  /** 随机换背景（排除当前；仅一张时仍应用该张） */
  randomize() {
    if (BGM_LIST.length === 0) {
      showError("还没有背景图片，请把图片放入项目根「背景图片」文件夹并运行 extension\\tools\\sync-backgrounds.ps1");
      return;
    }
    const current = this.current();
    let next = BGM_LIST[0];
    if (BGM_LIST.length > 1) {
      const candidates = BGM_LIST.filter((n) => n !== current);
      next = candidates[Math.floor(Math.random() * candidates.length)];
    }
    this.set(next);
  },

  /** 恢复默认背景 */
  reset() {
    this.set("");
  },

  /** 当前背景文件名（未设置返回 ""） */
  current() {
    const bg = this.layer.style.backgroundImage || "";
    const m = bg.match(/backgrounds\/([^")]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  },

  /** 设置并持久化 */
  set(name) {
    this.apply(name);
    try {
      chrome.storage.local.set({ [BG_STORE_KEY]: name });
    } catch (err) {
      console.warn("[newtab] 保存背景配置失败:", err);
    }
  },
};

/* ================================================================== */
/* ContextMenuModule：右键菜单（随机换背景等）                         */
/* ================================================================== */

const ContextMenuModule = {
  id: "contextmenu",
  menu: document.getElementById("ctxMenu"),

  init() {
    // 右键任意处：显示菜单（阻止浏览器默认菜单）
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.show(e.clientX, e.clientY);
    });

    // 点击其他处 / Esc / 滚动 / 缩放：关闭菜单
    document.addEventListener("click", (e) => {
      if (!this.menu.contains(e.target)) this.hide();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
    window.addEventListener("scroll", () => this.hide(), true);
    window.addEventListener("resize", () => this.hide());
  },

  show(x, y) {
    this.menu.innerHTML = "";

    const addItem = (text, onClick, opts) => {
      const div = document.createElement("div");
      div.className = "cm-item" + (opts && opts.disabled ? " disabled" : "");
      div.textContent = text;
      if (!(opts && opts.disabled) && onClick) {
        div.addEventListener("click", () => { this.hide(); onClick(); });
      }
      this.menu.appendChild(div);
    };

    // 当前背景提示
    const tip = document.createElement("div");
    tip.className = "cm-tip";
    tip.textContent = "背景：" + (BackgroundModule.current() || "默认");
    this.menu.appendChild(tip);

    // 分隔
    const sep1 = document.createElement("div");
    sep1.className = "cm-sep";
    this.menu.appendChild(sep1);

    addItem("🎲 随机换背景", () => BackgroundModule.randomize(), { disabled: BGM_LIST.length === 0 });
    addItem("🗑 恢复默认背景", () => BackgroundModule.reset());

    // 分隔 + 提示
    const sep2 = document.createElement("div");
    sep2.className = "cm-sep";
    this.menu.appendChild(sep2);
    const tip2 = document.createElement("div");
    tip2.className = "cm-tip";
    tip2.textContent = "提示：把图片放入「背景图片」文件夹，运行 extension\\tools\\sync-backgrounds.ps1 后重载扩展";
    this.menu.appendChild(tip2);

    this.menu.hidden = false;

    // 边界修正：菜单不出视口
    const mw = this.menu.offsetWidth;
    const mh = this.menu.offsetHeight;
    let px = x, py = y;
    if (px + mw > window.innerWidth - 4) px = Math.max(4, window.innerWidth - mw - 4);
    if (py + mh > window.innerHeight - 4) py = Math.max(4, window.innerHeight - mh - 4);
    this.menu.style.left = px + "px";
    this.menu.style.top = py + "px";
  },

  hide() {
    this.menu.hidden = true;
  },
};

/* ================================================================== */
/* 启动                                                               */
/* ================================================================== */

app.registerModule(NavModule)
  .registerModule(WebSearchModule)
  .registerModule(TagWallModule)
  .registerModule(SettingsModule)
  .registerModule(BackgroundModule)
  .registerModule(ContextMenuModule)
  .start();