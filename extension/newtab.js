/**
 * WebAnnotator 新标签页 · 核心逻辑
 *
 * 架构（见 design.md 3.3）：模块注册表模式。
 * - NavModule        左侧导航：主页 / 标签页 视图切换（左栏自动隐藏）
 * - WebSearchModule  网络搜索框（可切换搜索引擎，默认百度）——主页唯一内容
 * - RecentModule     最近标注（host search 空查询 limit=10）
 * - SearchModule     标注 + 收藏夹双源搜索框（标签页内）
 * - TagWallModule    标签页视图：标签墙（居右）
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

/** 搜索引擎 URL 模板（网络搜索框） */
const ENGINES = {
  baidu:  { name: "百度",   url: "https://www.baidu.com/s?wd=" },
  bing:   { name: "必应",   url: "https://www.bing.com/search?q=" },
  google: { name: "谷歌",   url: "https://www.google.com/search?q=" },
  sogou:  { name: "搜狗",   url: "https://www.sogou.com/web?query=" },
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

/** 构建标注结果卡片（title / url / 标签 / 相对时间） */
function createAnnotationItem(item) {
  const a = document.createElement("a");
  a.className = "result-item";
  a.href = item.url || "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (item.url) openUrl(item.url);
  });

  const title = document.createElement("div");
  title.className = "ri-title";
  title.textContent = item.title || item.url || "(无标题)";

  const meta = document.createElement("div");
  meta.className = "ri-meta";

  const urlSpan = document.createElement("span");
  urlSpan.className = "ri-url";
  urlSpan.textContent = item.url || "";

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
    time.textContent = formatRelTime(item.updatedAt);
    meta.appendChild(time);
  }

  meta.appendChild(urlSpan);
  a.appendChild(title);
  a.appendChild(meta);
  return a;
}

/* ================================================================== */
/* NavModule：左侧导航（主页 / 标签页；左栏自动隐藏可唤出）            */
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
    // 首次进入标签页视图时确保数据已渲染
    if (view === "tags" && typeof TagWallModule.refresh === "function") {
      if (TagWallModule._loaded === false) TagWallModule.refresh();
    }
  },
};

/* ================================================================== */
/* WebSearchModule：网络搜索框（默认百度；鼠标左键可拖动位置并持久化） */
/* ================================================================== */

const WebSearchModule = {
  id: "websearch",
  select: document.getElementById("engineSelect"),
  input: document.getElementById("webSearchInput"),
  btn: document.getElementById("webSearchBtn"),
  box: document.querySelector(".web-search"),
  POS_KEY: "webSearchPos",
  _dragging: false,
  _startX: 0,
  _startY: 0,
  _origLeft: 0,
  _origTop: 0,

  async init() {
    const go = () => this.search();
    this.btn.addEventListener("click", go);
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });

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

  search() {
    const q = (this.input.value || "").trim();
    if (!q) { this.input.focus(); return; }
    const engine = this.select.value || "baidu";
    const url = (ENGINES[engine] || ENGINES.baidu).url + encodeURIComponent(q);
    openUrl(url);
  },

  /** 固定到指定位置（脱离居中布局） */
  pin(left, top) {
    this.box.classList.add("pinned");
    this.box.style.left = left + "px";
    this.box.style.top = top + "px";
  },

  /** 鼠标左键拖动：容器空白/边框区为手柄，输入/下拉/按钮上不触发 */
  bindDrag() {
    this.box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("input,select,button")) return;
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
    });

    document.addEventListener("mouseup", () => {
      if (!this._dragging) return;
      this._dragging = false;
      this.box.classList.remove("dragging");
      const left = parseFloat(this.box.style.left) || this._origLeft;
      const top = parseFloat(this.box.style.top) || this._origTop;
      try {
        chrome.storage.local.set({ [this.POS_KEY]: { left: left, top: top } });
      } catch (err) {
        console.warn("[newtab] 保存搜索框位置失败:", err);
      }
    });
  },
};

/* ================================================================== */
/* RecentModule：最近标注（四态：空 / 单 / 多 / 全）                  */
/* ================================================================== */

const RecentModule = {
  id: "recent",
  container: document.getElementById("recentList"),
  section: document.getElementById("recentSection"),
  LIMIT: 10,

  async refresh() {
    renderLoading(this.container, "加载中…");
    const resp = await sendAction({ action: "search", query: "", limit: this.LIMIT, offset: 0 }, "最近标注");
    if (isHostFailure(resp)) {
      handleHostFailure(this.container, resp);
      return;
    }
    if (!resp.success) {
      renderModuleError(this.container, resp.error || "加载失败");
      return;
    }
    const results = resp.data && resp.data.results ? resp.data.results : [];
    if (results.length === 0) {
      renderEmpty(this.container, "还没有标注，在网页上点击扩展图标即可打标签");
      return;
    }
    this.container.innerHTML = "";
    results.forEach((item) => this.container.appendChild(createAnnotationItem(item)));
  },
};

/* ================================================================== */
/* TagWallModule：标签页视图（标签墙居右，四态全覆盖）                 */
/* ================================================================== */

const TagWallModule = {
  id: "tagwall",
  wallContainer: document.getElementById("tagWall"),
  _loaded: false,

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
      chip.addEventListener("click", () => this.openTag(tag));
      c.appendChild(chip);
    });
  },

  /** 点击标签：打开管理面板并定位该标签（options#manage?tagId=&name=） */
  openTag(tag) {
    if (tag.id == null || !tag.name) return;
    const url = chrome.runtime.getURL("options.html") + "#manage?tagId=" + encodeURIComponent(tag.id) + "&name=" + encodeURIComponent(tag.name);
    openUrl(url);
  },
};

/* SearchModule：搜索框（标注 + 收藏夹双源，四态全覆盖）               */
/* ================================================================== */

const SearchModule = {
  id: "search",
  input: document.getElementById("searchInput"),
  btn: document.getElementById("searchBtn"),
  hint: document.getElementById("searchHint"),
  resultSection: document.getElementById("resultSection"),
  recentSection: document.getElementById("recentSection"),
  resultAnnotations: document.getElementById("resultAnnotations"),
  resultBookmarks: document.getElementById("resultBookmarks"),
  MAX_QUERY_LEN: 200,   // R17：超长截断
  DEBOUNCE_MS: 250,
  RESULT_LIMIT: 20,     // R19：收藏夹最多展示 20 条
  _timer: null,

  init() {
    this.input.addEventListener("input", () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.onInput(this.input.value), this.DEBOUNCE_MS);
    });
    // 点击「搜索」按钮立即触发（同主页网络搜索框交互）
    this.btn.addEventListener("click", () => this.onInput(this.input.value));
  },

  onInput(raw) {
    const q = (raw || "").trim().slice(0, this.MAX_QUERY_LEN);
    if (q === "") {
      // 空输入：最近标注与结果区均隐藏，只留搜索框（最近标注不再默认展示）
      this.resultSection.hidden = true;
      this.recentSection.hidden = true;
      this.hint.hidden = true;
      return;
    }
    this.doSearch(q);
  },

  async doSearch(q) {
    // 搜索态：隐藏最近标注，显示结果区
    this.recentSection.hidden = true;
    this.resultSection.hidden = false;
    this.hint.hidden = false;
    this.hint.textContent = "搜索「" + q + "」";

    this.renderAnnotationsLoading();
    this.renderBookmarksLoading();

    // 双源并行：标注（host）+ 收藏夹（浏览器 API）
    const [annoResp, bmResp] = await Promise.all([
      sendAction({ action: "search", query: q, limit: this.RESULT_LIMIT, offset: 0 }, "搜索标注"),
      bookmarksSearch(q),
    ]);

    // 标注结果（在前）
    if (isHostFailure(annoResp)) {
      handleHostFailure(this.resultAnnotations, annoResp);
    } else if (!annoResp.success) {
      renderModuleError(this.resultAnnotations, annoResp.error || "标注搜索失败");
    } else {
      const results = (annoResp.data && annoResp.data.results) || [];
      this.renderAnnotations(results, annoResp.data.total || results.length);
    }

    // 收藏夹结果（在后；权限不可用仅降级本区，R13）
    if (!bmResp.success) {
      renderModuleError(this.resultBookmarks, "收藏夹不可用", null, null);
    } else {
      const nodes = (bmResp.nodes || []).filter((n) => n.url && /^https?:\/\//i.test(n.url)).slice(0, this.RESULT_LIMIT);
      this.renderBookmarks(nodes);
    }
  },

  renderAnnotationsLoading() {
    renderLoading(this.resultAnnotations, "搜索标注中…");
  },
  renderBookmarksLoading() {
    renderLoading(this.resultBookmarks, "搜索收藏夹中…");
  },

  renderAnnotations(results, total) {
    this.resultAnnotations.innerHTML = "";
    if (results.length === 0) {
      renderEmpty(this.resultAnnotations, "标注中未找到「" + this.input.value.trim() + "」");
      return;
    }
    results.forEach((item) => this.resultAnnotations.appendChild(createAnnotationItem(item)));
    if (results.length < total) {
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = "仅显示前 " + results.length + " 条（共 " + total + " 条），请在管理面板查看全部";
      this.resultAnnotations.appendChild(more);
    }
  },

  renderBookmarks(nodes) {
    this.resultBookmarks.innerHTML = "";
    if (nodes.length === 0) {
      renderEmpty(this.resultBookmarks, "收藏夹中未找到「" + this.input.value.trim() + "」");
      return;
    }
    nodes.forEach((n) => this.resultBookmarks.appendChild(this.createBookmarkItem(n)));
    if (nodes.length === this.RESULT_LIMIT) {
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = "仅显示前 " + this.RESULT_LIMIT + " 条（R19）";
      this.resultBookmarks.appendChild(more);
    }
  },

  createBookmarkItem(node) {
    const a = document.createElement("a");
    a.className = "result-item";
    a.href = node.url || "#";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (node.url) openUrl(node.url);
    });

    const title = document.createElement("div");
    title.className = "ri-title";
    title.textContent = node.title || node.url || "(无标题)";

    const meta = document.createElement("div");
    meta.className = "ri-meta";
    const urlSpan = document.createElement("span");
    urlSpan.className = "ri-url";
    urlSpan.textContent = node.url || "";
    const src = document.createElement("span");
    src.textContent = "收藏夹";
    meta.appendChild(src);
    meta.appendChild(urlSpan);

    a.appendChild(title);
    a.appendChild(meta);
    return a;
  },
};

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
  .registerModule(RecentModule)
  .registerModule(SearchModule)
  .registerModule(TagWallModule)
  .registerModule(BackgroundModule)
  .registerModule(ContextMenuModule)
  .start();
