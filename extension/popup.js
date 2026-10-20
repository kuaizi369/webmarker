/**
 * WebAnnotator popup.js
 *
 * 实现 T17（标注编辑与智能记忆）+ T18（搜索与标签管理）+ T19（主题切换与通信超时重试）。
 *
 * 核心流程：
 * 1. 打开时获取当前标签页 URL/标题 → 查询历史标注（智能记忆）→ 填充标签与备注
 * 2. 保存时发送 {action:"save"} → 成功反馈
 * 3. 搜索时发送 {action:"search"} → 结果列表
 * 4. 标签管理：{action:"getTagsWithCount"} → 标签列表 → 筛选/删除
 * 5. 主题：加载配置 → FollowSystem/Light/Dark → 切换持久化
 * 6. 通信超时：5s 无响应提示重试，保存超时保留编辑内容
 */

"use strict";

/* ================================================================== */
/* 常量定义                                                            */
/* ================================================================== */

/** 通信超时阈值（毫秒），design.md 2.9.3 */
const COMMUNICATION_TIMEOUT = 5000;

/** 主题模式枚举（与 C# ThemeMode 一致） */
const THEME_FOLLOW_SYSTEM = 0;
const THEME_LIGHT = 1;
const THEME_DARK = 2;

/** 标签名称最大长度 */
const TAG_NAME_MAX_LENGTH = 30;

/** 搜索/筛选默认分页大小 */

/** 搜索防抖延迟（毫秒） */

/** 标签自动补全防抖延迟 */
const AUTOCOMPLETE_DEBOUNCE_MS = 150;

/* ================================================================== */
/* 全局状态                                                            */
/* ================================================================== */

const state = {
  /** 当前网页 URL */
  currentUrl: "",
  /** 当前网页标题 */
  currentTitle: "",
  /** 当前 URL 是否可标注 */
  urlValid: false,
  /** 当前标签列表（字符串数组） */
  tags: [],
  /** 已加载的历史标注 id（编辑保存时按 id 更新；null=首次新建） */
  currentAnnotationId: null,
  /** 主题模式 */
  themeMode: THEME_FOLLOW_SYSTEM,
  /** 系统主题媒体查询监听器 */
  mediaQueryList: null,
  /** 搜索分页 offset */
  /** 搜索结果总数 */
  /** 当前搜索关键词 */
  /** 标签筛选分页 offset */
  /** 标签筛选结果总数 */
  /** 当前筛选的标签 ID 列表 */
  /** 自动补全当前高亮索引 */
  autocompleteActiveIndex: -1,
  /** 自动补全当前候选项 */
  autocompleteItems: [],
  /** 是否正在加载中 */
  loading: false,
};

/* ================================================================== */
/* DOM 元素引用                                                        */
/* ================================================================== */

const dom = {};

/** 初始化所有 DOM 引用 */
function initDomRefs() {
  dom.themeToggle = document.getElementById("theme-toggle");
  dom.pageTitle = document.getElementById("page-title");
  dom.pageUrl = document.getElementById("page-url");
  dom.pageInfoSection = document.getElementById("page-info-section");
  dom.tagsSection = document.getElementById("tags-section");
  dom.tagsChipContainer = document.getElementById("tags-chip-container");
  dom.tagsEmptyHint = document.getElementById("tags-empty-hint");
  dom.tagInput = document.getElementById("tag-input");
  dom.tagAutocomplete = document.getElementById("tag-autocomplete");
  dom.noteSection = document.getElementById("note-section");
  dom.noteInput = document.getElementById("note-input");
  dom.saveBtn = document.getElementById("save-btn");
  dom.panelMgrBtn = document.getElementById("panel-mgr-btn");
  dom.saveSessionBtn = document.getElementById("save-session-btn");
  dom.statusBar = document.getElementById("status-bar");
  dom.statusText = document.getElementById("status-text");
  dom.installGuide = document.getElementById("install-guide");
  dom.guideRetryBtn = document.getElementById("guide-retry-btn");
  dom.dataPathBtn = document.getElementById("data-path-btn");
  dom.configGuide = document.getElementById("config-guide");
  dom.dataPathInput = document.getElementById("data-path-input");
  dom.configHint = document.getElementById("config-hint");
  dom.configConfirmBtn = document.getElementById("config-confirm-btn");
  dom.configCancelBtn = document.getElementById("config-cancel-btn");
  dom.previewPopup = document.getElementById("preview-popup");
  dom.previewTitle = document.getElementById("preview-title");
  dom.previewBody = document.getElementById("preview-body");
  dom.previewCloseBtn = document.getElementById("preview-close-btn");
}

/* ================================================================== */
/* 通信层（含 5s 超时） — T19                                          */
/* ================================================================== */

/**
 * 向 background 发送消息，带 5 秒超时保护。
 *
 * 超时处理（design.md 2.9.3）：
 * - 5s 内收到响应：清除定时器，返回响应
 * - 超时：返回超时错误对象，记录 console.error
 *
 * @param {object} message - 发送给 background 的消息
 * @param {string} requestLabel - 请求标签（用于日志和超时提示）
 * @returns {Promise<object>} 响应对象
 */
function sendMessageWithTimeout(message, requestLabel = "请求") {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[WebAnnotator] ${requestLabel}超时（${COMMUNICATION_TIMEOUT}ms）:`, message);
      resolve({
        success: false,
        error: `${requestLabel}超时，请重试`,
        errorCode: "TIMEOUT",
      });
    }, COMMUNICATION_TIMEOUT);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          console.error(`[WebAnnotator] ${requestLabel}通信错误:`, chrome.runtime.lastError);
          resolve({
            success: false,
            error: `${requestLabel}通信失败，请重试`,
            errorCode: "COMMUNICATION_ERROR",
          });
          return;
        }

        resolve(response || { success: false, error: "空响应", errorCode: "INTERNAL_ERROR" });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[WebAnnotator] ${requestLabel}发送异常:`, err);
      resolve({
        success: false,
        error: `${requestLabel}发送失败，请重试`,
        errorCode: "COMMUNICATION_ERROR",
      });
    }
  });
}

/**
 * 向本地程序发送 action 请求（经 background 转发）。
 * @param {object} request - 含 action 字段的请求
 * @param {string} label - 请求标签
 * @returns {Promise<object>} 响应
 */
function sendAction(request, label) {
  return sendMessageWithTimeout(request, label);
}

/* ================================================================== */
/* 打开管理面板（options.html）                                       */
/* ================================================================== */

/**
 * 打开全页管理面板到指定视图。
 * 标注/标签增多时，popup 空间有限，搜索与标签管理移到独立页面。
 * @param {"home"|"search"|"manage"} view - 要打开的视图
 */
function openOptionsPage(view) {
  const url = chrome.runtime.getURL(`options.html#${view || "home"}`);
  chrome.tabs.create({ url }, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("[WebAnnotator] 打开管理面板失败:", chrome.runtime.lastError);
      showStatus("打开管理面板失败", "error");
    }
  });
}

/* ================================================================== */
/* 保存会话（当前窗口全部标签页）                                     */
/* ================================================================== */

async function saveCurrentWindowSession() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const items = tabs
      .filter((t) => t.url && /^https?:\/\//i.test(t.url))
      .map((t) => ({ url: t.url, title: t.title || "" }));
    if (items.length === 0) {
      showStatus("当前窗口没有可保存的网页标签页", "info", 2500);
      return;
    }
    const resp = await sendAction({ action: "saveSession", items }, "保存会话");
    if (resp && resp.success) {
      showStatus(`会话已保存（${items.length} 个标签页）`, "success", 3000);
    } else {
      showStatus((resp && resp.error) || "保存会话失败", "error");
    }
  } catch (err) {
    console.error("[WebAnnotator] 保存会话失败:", err);
    showStatus("保存会话失败", "error");
  }
}

/* ================================================================== */
/* 状态提示                                                            */
/* ================================================================== */

/**
 * 显示状态提示条。
 * @param {string} text - 提示文本
 * @param {"success"|"error"|"info"} type - 提示类型
 * @param {number} duration - 显示时长（毫秒），0 表示不自动消失
 */
function showStatus(text, type = "info", duration = 2000) {
  dom.statusText.textContent = text;
  dom.statusBar.className = "status-bar " + type;
  dom.statusBar.hidden = false;

  if (duration > 0) {
    setTimeout(() => {
      dom.statusBar.hidden = true;
    }, duration);
  }
}

/* ================================================================== */
/* 主题管理 — T19                                                     */
/* ================================================================== */

/**
 * 应用主题到 DOM。
 * @param {"light"|"dark"} themeName
 */
function applyTheme(themeName) {
  document.documentElement.dataset.theme = themeName;
}

/**
 * 根据系统配色方案设置主题（FollowSystem 模式）。
 */
function applySystemTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
}

/**
 * 根据 themeMode 设置主题。
 * - FollowSystem：跟随系统 + 监听变化
 * - Light/Dark：固定主题，不监听系统变化
 * @param {number} mode - 主题模式枚举值
 */
function setThemeMode(mode) {
  state.themeMode = mode;

  // 移除旧的系统主题监听
  if (state.mediaQueryList) {
    state.mediaQueryList.removeEventListener("change", onSystemThemeChange);
    state.mediaQueryList = null;
  }

  if (mode === THEME_FOLLOW_SYSTEM) {
    applySystemTheme();
    // 监听系统主题变化
    state.mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    state.mediaQueryList.addEventListener("change", onSystemThemeChange);
  } else if (mode === THEME_LIGHT) {
    applyTheme("light");
  } else if (mode === THEME_DARK) {
    applyTheme("dark");
  }
}

/** 系统主题变化回调 */
function onSystemThemeChange() {
  if (state.themeMode === THEME_FOLLOW_SYSTEM) {
    applySystemTheme();
  }
}

/**
 * 主题切换按钮点击：循环切换 FollowSystem → Light → Dark → FollowSystem。
 * 切换后通过 setConfig 持久化到本地程序配置。
 */
async function onThemeToggleClick() {
  let nextMode;
  if (state.themeMode === THEME_FOLLOW_SYSTEM) {
    nextMode = THEME_LIGHT;
  } else if (state.themeMode === THEME_LIGHT) {
    nextMode = THEME_DARK;
  } else {
    nextMode = THEME_FOLLOW_SYSTEM;
  }

  setThemeMode(nextMode);

  // 持久化主题配置
  const resp = await sendAction({ action: "setConfig", themeMode: nextMode }, "保存主题");
  if (!resp.success) {
    console.warn("[WebAnnotator] 主题配置保存失败:", resp.errorCode);
    // 不回滚 UI，用户选择已生效，下次启动会重新读取配置
  }
}

/**
 * 加载主题配置。
 * 向本地程序发送 {action:"getConfig"} 获取 themeMode。
 */
async function loadThemeConfig() {
  const resp = await sendAction({ action: "getConfig" }, "加载配置");
  if (resp.success && resp.data) {
    const mode = resp.data.themeMode;
    if (typeof mode === "number") {
      setThemeMode(mode);
    } else {
      // themeMode 可能为字符串（兼容处理）
      const modeMap = { FollowSystem: 0, Light: 1, Dark: 2 };
      setThemeMode(modeMap[mode] !== undefined ? modeMap[mode] : THEME_FOLLOW_SYSTEM);
    }
  } else {
    // 获取配置失败（可能 HOST_NOT_INITIALIZED），使用默认跟随系统
    setThemeMode(THEME_FOLLOW_SYSTEM);
  }
}

/* ================================================================== */
/* 标签编辑 — T17                                                     */
/* ================================================================== */

/**
 * 渲染标签 chip 列表。
 */
function renderTags() {
  // 清除旧 chip（保留 empty hint）
  const chips = dom.tagsChipContainer.querySelectorAll(".tag-chip");
  chips.forEach((c) => c.remove());

  if (state.tags.length === 0) {
    dom.tagsEmptyHint.hidden = false;
  } else {
    dom.tagsEmptyHint.hidden = true;
    for (const tag of state.tags) {
      const chip = createTagChip(tag);
      dom.tagsChipContainer.appendChild(chip);
    }
  }
}

/**
 * 创建标签 chip 元素。
 * @param {string} name - 标签名称
 * @returns {HTMLElement}
 */
function createTagChip(name) {
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.dataset.name = name;

  const nameSpan = document.createElement("span");
  nameSpan.className = "tag-chip-name";
  nameSpan.textContent = name;
  nameSpan.title = name;
  chip.appendChild(nameSpan);

  const removeBtn = document.createElement("button");
  removeBtn.className = "tag-chip-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "删除标签";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeTag(name);
  });
  chip.appendChild(removeBtn);

  return chip;
}

/**
 * 添加标签（去重、校验长度）。
 * @param {string} name - 标签名称
 * @returns {boolean} 是否添加成功
 */
function addTag(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    showStatus("标签名称不能为空", "error");
    return false;
  }
  if (trimmed.length > TAG_NAME_MAX_LENGTH) {
    showStatus(`标签名称不超过 ${TAG_NAME_MAX_LENGTH} 字符`, "error");
    return false;
  }
  // 大小写不敏感去重
  const exists = state.tags.some((t) => t.toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    showStatus("该标签已存在", "info", 1500);
    return false;
  }
  state.tags.push(trimmed);
  renderTags();
  return true;
}

/**
 * 删除标签。
 * @param {string} name - 标签名称
 */
function removeTag(name) {
  state.tags = state.tags.filter((t) => t !== name);
  renderTags();
}

/* ---------- 标签自动补全 ---------- */

let autocompleteDebounceTimer = null;

/**
 * 标签输入事件处理：防抖触发自动补全。
 */
function onTagInput() {
  const query = dom.tagInput.value.trim();

  if (autocompleteDebounceTimer) {
    clearTimeout(autocompleteDebounceTimer);
  }

  if (!query) {
    hideAutocomplete();
    return;
  }

  autocompleteDebounceTimer = setTimeout(() => {
    fetchAutocomplete(query);
  }, AUTOCOMPLETE_DEBOUNCE_MS);
}

/**
 * 标签输入聚焦：显示已有标签候选。
 * 输入框为空时显示全部标签（按使用量降序），方便直接点击选择减少打字；有文字时显示匹配联想。
 */
function onTagFocus() {
  if (autocompleteDebounceTimer) {
    clearTimeout(autocompleteDebounceTimer);
  }
  fetchAutocomplete(dom.tagInput.value.trim());
}

/**
 * 查询自动补全候选标签。
 * @param {string} query
 */
async function fetchAutocomplete(query) {
  const resp = await sendAction({ action: "listTags", query }, "标签补全");
  if (!resp.success || !resp.data || !resp.data.tags) {
    hideAutocomplete();
    return;
  }

  // 过滤掉已添加的标签
  const existing = new Set(state.tags.map((t) => t.toLowerCase()));
  state.autocompleteItems = resp.data.tags.filter(
    (t) => !existing.has(t.name.toLowerCase())
  );
  state.autocompleteActiveIndex = -1;
  renderAutocomplete();
}

/**
 * 渲染自动补全下拉。
 */
function renderAutocomplete() {
  if (state.autocompleteItems.length === 0) {
    hideAutocomplete();
    return;
  }

  dom.tagAutocomplete.innerHTML = "";
  state.autocompleteItems.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "autocomplete-item";
    if (index === state.autocompleteActiveIndex) {
      div.classList.add("active");
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "autocomplete-item-name";
    nameSpan.textContent = item.name;
    div.appendChild(nameSpan);

    if (item.count !== undefined) {
      const countSpan = document.createElement("span");
      countSpan.className = "autocomplete-item-count";
      countSpan.textContent = `${item.count} 个标注`;
      div.appendChild(countSpan);
    }

    div.addEventListener("mousedown", (e) => {
      e.preventDefault(); // 防止 input 失焦
      selectAutocomplete(item.name);
    });

    dom.tagAutocomplete.appendChild(div);
  });

  dom.tagAutocomplete.hidden = false;
}

/** 隐藏自动补全下拉 */
function hideAutocomplete() {
  dom.tagAutocomplete.hidden = true;
  state.autocompleteItems = [];
  state.autocompleteActiveIndex = -1;
}

/**
 * 选择自动补全项。
 * @param {string} name
 */
function selectAutocomplete(name) {
  if (addTag(name)) {
    dom.tagInput.value = "";
    hideAutocomplete();
  }
}

/**
 * 标签输入键盘事件：回车添加、上下选择补全项、Esc 关闭。
 * @param {KeyboardEvent} e
 */
function onTagInputKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (state.autocompleteActiveIndex >= 0 &&
        state.autocompleteActiveIndex < state.autocompleteItems.length) {
      selectAutocomplete(state.autocompleteItems[state.autocompleteActiveIndex].name);
    } else if (dom.tagInput.value.trim()) {
      addTag(dom.tagInput.value);
      dom.tagInput.value = "";
      hideAutocomplete();
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (state.autocompleteItems.length > 0) {
      state.autocompleteActiveIndex =
        (state.autocompleteActiveIndex + 1) % state.autocompleteItems.length;
      renderAutocomplete();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (state.autocompleteItems.length > 0) {
      state.autocompleteActiveIndex =
        (state.autocompleteActiveIndex - 1 + state.autocompleteItems.length) %
        state.autocompleteItems.length;
      renderAutocomplete();
    }
  } else if (e.key === "Escape") {
    hideAutocomplete();
  }
}

/* ================================================================== */
/* 标注加载（智能记忆） — T17                                         */
/* ================================================================== */

/**
 * 获取当前标签页信息。
 * @returns {Promise<{url:string, title:string, valid:boolean, errorCode:string|null}>}
 */
function getCurrentTabInfo() {
  return sendMessageWithTimeout({ type: "GET_TAB_INFO" }, "获取标签页");
}

/**
 * 加载当前网页的历史标注（智能记忆）。
 * 向本地程序发送 {action:"get", url} 查询已有标注。
 */
async function loadAnnotation() {
  const tabInfo = await getCurrentTabInfo();
  state.currentUrl = tabInfo.url || "";
  state.currentTitle = tabInfo.title || "";
  state.urlValid = tabInfo.valid !== false;

  // 显示网页信息
  dom.pageTitle.textContent = state.currentTitle || "（无标题）";
  dom.pageTitle.title = state.currentTitle || "";
  dom.pageUrl.textContent = state.currentUrl || "—";
  dom.pageUrl.title = state.currentUrl || "";

  if (!state.urlValid) {
    // URL 无效：禁用编辑，显示提示
    disableEditing("当前页面不支持标注");
    return;
  }

  // 查询历史标注
  const resp = await sendAction({ action: "get", url: state.currentUrl }, "加载标注");

  if (!resp.success) {
    handleLoadError(resp);
    return;
  }

  const annotation = resp.data && resp.data.annotation;
  if (annotation) {
    // 有历史标注：填充标签与备注（智能记忆）；记录 id 供编辑保存更新该条
    state.currentAnnotationId = annotation.id || null;
    state.tags = Array.isArray(annotation.tags) ? annotation.tags.slice() : [];
    renderTags();
    dom.noteInput.value = annotation.note || "";
    showStatus("已加载历史标注", "info", 1500);
  } else {
    // 无历史标注：显示空状态提示
    state.currentAnnotationId = null;
    state.tags = [];
    renderTags();
    dom.noteInput.value = "";
  }
}

/**
 * 处理标注加载错误。
 * @param {object} resp - 错误响应
 */
function handleLoadError(resp) {
  switch (resp.errorCode) {
    case "HOST_NOT_FOUND":
      showInstallGuide();
      break;
    case "HOST_NOT_INITIALIZED":
      showConfigGuide();
      break;
    case "HOST_DISCONNECTED":
      showStatus("连接已断开，请重试", "error");
      break;
    case "URL_INVALID":
      disableEditing("当前页面不支持标注");
      break;
    default:
      showStatus(resp.error || "加载标注失败", "error");
      console.error("[WebAnnotator] 加载标注错误:", resp.errorCode, resp.error);
  }
}

/**
 * 禁用编辑区域。
 * @param {string} reason - 禁用原因
 */
function disableEditing(reason) {
  dom.tagInput.disabled = true;
  dom.noteInput.disabled = true;
  dom.saveBtn.disabled = true;
  dom.tagInput.placeholder = reason;
  showStatus(reason, "info", 0);
}

/* ================================================================== */
/* 保存标注 — T17                                                     */
/* ================================================================== */

/**
 * 保存标注。
 * 发送 {action:"save", url, title, tags, note} 到本地程序。
 * 超时时保留编辑内容不丢失（design.md 2.9.3）。
 */
async function saveAnnotation() {
  if (!state.urlValid) {
    showStatus("当前页面不支持标注", "error");
    return;
  }
  if (!state.currentUrl) {
    showStatus("未获取到网页 URL", "error");
    return;
  }

  dom.saveBtn.disabled = true;
  const originalText = dom.saveBtn.textContent;
  dom.saveBtn.textContent = "保存中...";

  const note = dom.noteInput.value;
  const req = {
    action: "save",
    url: state.currentUrl,
    title: state.currentTitle,
    tags: state.tags.slice(),
    note: note,
    category: null,
  };
  // 编辑已有标注时按 id 更新该条；首次保存不带 id → host 新建（同一 URL 可多条）
  if (state.currentAnnotationId) {
    req.annotationId = state.currentAnnotationId;
  }
  const resp = await sendAction(req, "保存");

  // 恢复按钮状态（无论成功失败，编辑内容都保留在输入框中不丢失）
  dom.saveBtn.disabled = false;
  dom.saveBtn.textContent = originalText;

  if (resp.success) {
    showStatus("已保存", "success");
    // 更新标签（本地程序可能对标签做了规范化）
    const annotation = resp.data && resp.data.annotation;
    if (annotation && Array.isArray(annotation.tags)) {
      state.tags = annotation.tags.slice();
      renderTags();
    }
    // 记录新记录 id（新建后后续编辑即更新该条）
    if (annotation && annotation.id) {
      state.currentAnnotationId = annotation.id;
    }
  } else {
    // 保存失败/超时：编辑内容保留在输入框中不丢失
    handleSaveError(resp);
  }
}

/**
 * 处理保存错误。
 * @param {object} resp
 */
function handleSaveError(resp) {
  switch (resp.errorCode) {
    case "TIMEOUT":
      showStatus("保存超时，请重试", "error", 0);
      break;
    case "TAG_NAME_INVALID":
      showStatus("标签名称非法（空或超过30字符）", "error", 0);
      break;
    case "TAG_NAME_CONFLICT":
      showStatus("存在仅大小写不同的同名标签，请复用已有标签", "error", 0);
      break;
    case "HOST_NOT_FOUND":
      showInstallGuide();
      break;
    case "HOST_NOT_INITIALIZED":
      showConfigGuide();
      break;
    default:
      showStatus(resp.error || "保存失败，请重试", "error", 0);
      console.error("[WebAnnotator] 保存错误:", resp.errorCode, resp.error);
  }
}

/* ================================================================== */
/* 搜索 — T18                                                         */
/* ================================================================== */

/* ================================================================== */
/* 标签管理 — T18                                                     */
/* ================================================================== */

/* ---------- 删除标签确认 ---------- */

/** 待删除的标签信息 */

/* ================================================================== */
/* 预览弹窗（动态位置） — T18 / PREFERENCE_1                          */
/* ================================================================== */

/**
 * 显示预览弹窗，动态计算位置出现在触发元素左侧或右侧。
 *
 * 策略（design.md 2.4.2 / PREFERENCE_1）：
 * - 计算触发元素左右可用空间
 * - 优先选择空间充足的一侧
 * - 垂直方向对齐触发元素并钳制在可视区内
 * - 避免遮挡核心内容与溢出 popup 边界
 *
 * @param {HTMLElement} triggerElement - 触发预览的元素
 * @param {object} data - 标注数据 {url, title, tags, note, notePreview, updatedAt}
 */
function showPreview(triggerElement, data) {
  // 填充预览内容
  dom.previewBody.innerHTML = "";
  dom.previewTitle.textContent = "标注详情";

  // 标题
  appendPreviewField("标题", data.title || "（无标题）", "");

  // URL
  appendPreviewField("URL", data.url || "", "url");

  // 标签
  if (Array.isArray(data.tags) && data.tags.length > 0) {
    const tagsContainer = document.createElement("div");
    tagsContainer.className = "preview-tags";
    for (const tag of data.tags) {
      const tagSpan = document.createElement("span");
      tagSpan.className = "preview-tag";
      tagSpan.textContent = tag;
      tagsContainer.appendChild(tagSpan);
    }
    appendPreviewField("标签", "", "", tagsContainer);
  }

  // 备注（优先用完整 note，其次用 notePreview）
  const noteText = data.note || data.notePreview || "";
  if (noteText) {
    appendPreviewField("备注", noteText, "", null, "preview-note");
  }

  // 更新时间
  if (data.updatedAt) {
    appendPreviewField("更新时间", formatTime(data.updatedAt), "");
  }

  // 显示弹窗（先显示才能获取尺寸）
  dom.previewPopup.hidden = false;

  // 动态计算位置
  positionPreview(triggerElement);
}

/**
 * 向预览弹窗添加一个字段。
 * @param {string} label - 字段标签
 * @param {string} value - 字段文本值
 * @param {string} valueClass - 值的额外 CSS 类
 * @param {HTMLElement} [customValue] - 自定义值元素（替代文本）
 * @param {string} [valueExtraClass] - 值容器的额外类
 */
function appendPreviewField(label, value, valueClass, customValue, valueExtraClass) {
  const field = document.createElement("div");
  field.className = "preview-field";

  const labelEl = document.createElement("div");
  labelEl.className = "preview-field-label";
  labelEl.textContent = label;
  field.appendChild(labelEl);

  const valueEl = customValue || document.createElement("div");
  if (!customValue) {
    valueEl.className = "preview-field-value" + (valueClass ? " " + valueClass : "");
    valueEl.textContent = value;
  }
  if (valueExtraClass) {
    valueEl.classList.add(valueExtraClass);
  }
  field.appendChild(valueEl);

  dom.previewBody.appendChild(field);
}

/**
 * 动态计算预览弹窗位置。
 *
 * 策略（design.md 2.4.2 / PREFERENCE_1）：
 * - 计算触发元素左右可用空间
 * - 优先选择空间充足的一侧显示
 * - 两侧都不足时选择空间较大的一侧并自适应
 * - 垂直方向对齐触发元素并钳制在可视区内
 *
 * @param {HTMLElement} triggerElement - 触发元素
 */
function positionPreview(triggerElement) {
  const POPUP_WIDTH = 400;
  const PREVIEW_MARGIN = 8;
  const triggerRect = triggerElement.getBoundingClientRect();
  const previewRect = dom.previewPopup.getBoundingClientRect();
  const previewWidth = previewRect.width || 180;
  const previewHeight = previewRect.height || 200;

  // 可用空间
  const leftSpace = triggerRect.left;
  const rightSpace = POPUP_WIDTH - triggerRect.right;

  let previewLeft;

  if (leftSpace >= previewWidth + PREVIEW_MARGIN) {
    // 左侧空间充足，弹窗出现在主体左侧
    previewLeft = triggerRect.left - previewWidth - PREVIEW_MARGIN;
  } else if (rightSpace >= previewWidth + PREVIEW_MARGIN) {
    // 右侧空间充足，弹窗出现在主体右侧
    previewLeft = triggerRect.right + PREVIEW_MARGIN;
  } else {
    // 两侧都不足，选择空间较大的一侧
    if (leftSpace >= rightSpace) {
      // 左侧空间较大，弹窗靠左显示，自适应宽度
      const adjustedWidth = Math.min(previewWidth, leftSpace - PREVIEW_MARGIN);
      dom.previewPopup.style.width = Math.max(adjustedWidth, 120) + "px";
      previewLeft = PREVIEW_MARGIN;
    } else {
      // 右侧空间较大，弹窗靠右显示，自适应宽度
      const adjustedWidth = Math.min(previewWidth, rightSpace - PREVIEW_MARGIN);
      dom.previewPopup.style.width = Math.max(adjustedWidth, 120) + "px";
      previewLeft = POPUP_WIDTH - Math.max(adjustedWidth, 120) - PREVIEW_MARGIN;
    }
  }

  // 确保不溢出 popup 边界
  previewLeft = Math.max(PREVIEW_MARGIN, Math.min(previewLeft, POPUP_WIDTH - previewWidth - PREVIEW_MARGIN));

  dom.previewPopup.style.left = previewLeft + "px";

  // 垂直方向：对齐触发元素顶部，钳制在可视区内
  const popupHeight = window.innerHeight;
  let previewTop = triggerRect.top;
  // 如果弹窗底部超出可视区，上移
  if (previewTop + previewHeight > popupHeight - PREVIEW_MARGIN) {
    previewTop = popupHeight - previewHeight - PREVIEW_MARGIN;
  }
  // 确保不小于顶部边距
  previewTop = Math.max(PREVIEW_MARGIN, previewTop);
  dom.previewPopup.style.top = previewTop + "px";
}

/** 隐藏预览弹窗 */
function hidePreview() {
  dom.previewPopup.hidden = true;
  dom.previewPopup.style.width = ""; // 重置宽度
}

/* ================================================================== */
/* 结果区辅助方法                                                      */
/* ================================================================== */

/**
 * 格式化时间显示。
 * @param {string} isoString - ISO8601 时间字符串
 * @returns {string} 格式化后的时间
 */
function formatTime(isoString) {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 604800000) return Math.floor(diff / 86400000) + " 天前";
    // 超过一周显示日期
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  } catch (e) {
    return isoString;
  }
}

/* ================================================================== */
/* 安装引导 / 首次配置引导 — T17 / T19                                */
/* ================================================================== */

/** 显示安装引导（HOST_NOT_FOUND） */
function showInstallGuide() {
  dom.installGuide.hidden = false;
}

/** 隐藏安装引导 */
function hideInstallGuide() {
  dom.installGuide.hidden = true;
}

/** 显示配置引导（HOST_NOT_INITIALIZED 或用户主动打开设置） */
function showConfigGuide() {
  dom.configGuide.hidden = false;
  // 由用户通过"选择目录"按钮选择真实路径，不预填占位路径
}

/** 打开数据目录设置：先读取当前路径预填，再显示设置弹窗 */
async function openDataPathSettings() {
  try {
    const resp = await sendAction({ action: "getConfig" }, "读取配置");
    if (resp.success && resp.data && resp.data.dataPath) {
      dom.dataPathInput.value = resp.data.dataPath;
    }
  } catch (err) {
    // 读取失败不阻塞，保留默认值建议
  }
  dom.configHint.textContent = "";
  showConfigGuide();
}

/** 隐藏配置引导 */
function hideConfigGuide() {
  dom.configGuide.hidden = true;
  dom.configHint.textContent = "";
}

/**
 * 确认配置数据路径。
 * 发送 {action:"setConfig", dataPath} 到本地程序。
 */
async function confirmConfig() {
  const dataPath = dom.dataPathInput.value.trim();
  if (!dataPath) {
    dom.configHint.textContent = "请输入数据存放路径";
    return;
  }

  dom.configConfirmBtn.disabled = true;
  const originalText = dom.configConfirmBtn.textContent;
  dom.configConfirmBtn.textContent = "配置中...";

  const resp = await sendAction({ action: "setConfig", dataPath, migrate: true }, "配置路径");

  dom.configConfirmBtn.disabled = false;
  dom.configConfirmBtn.textContent = originalText;

  if (resp.success) {
    hideConfigGuide();
    showStatus("配置完成", "success");
    // 配置成功后重新加载标注数据
    await loadAnnotation();
  } else {
    if (resp.errorCode === "DATA_PATH_INVALID") {
      dom.configHint.textContent = "路径无效或不可写，请选择其他文件夹";
    } else {
      dom.configHint.textContent = resp.error || "配置失败，请重试";
    }
  }
}

/* ================================================================== */
/* 事件绑定                                                            */
/* ================================================================== */

function bindEvents() {
  // 主题切换
  dom.themeToggle.addEventListener("click", onThemeToggleClick);

  // 标签输入
  dom.tagInput.addEventListener("focus", onTagFocus);
  dom.tagInput.addEventListener("input", onTagInput);
  dom.tagInput.addEventListener("keydown", onTagInputKeyDown);
  dom.tagInput.addEventListener("blur", () => {
    // 延迟隐藏，允许点击补全项
    setTimeout(hideAutocomplete, 150);
  });

  // 保存
  dom.saveBtn.addEventListener("click", saveAnnotation);

  // 面板管理：打开全页管理面板（options.html）
  // 搜索 / 标签管理 / 导入导出 / 数据统计 均在管理面板内进行（用户需求）
  dom.panelMgrBtn.addEventListener("click", () => openOptionsPage());
  dom.saveSessionBtn.addEventListener("click", saveCurrentWindowSession);

  // 结果区关闭

  // 预览关闭
  dom.previewCloseBtn.addEventListener("click", hidePreview);
  // 点击预览外部关闭
  document.addEventListener("click", (e) => {
    if (!dom.previewPopup.hidden &&
        !dom.previewPopup.contains(e.target) &&
        !e.target.closest(".result-item")) {
      hidePreview();
    }
  });

  // 安装引导重试
  dom.guideRetryBtn.addEventListener("click", async () => {
    hideInstallGuide();
    await loadAnnotation();
  });

  // 配置引导
  dom.dataPathBtn.addEventListener("click", openDataPathSettings);
  dom.configConfirmBtn.addEventListener("click", confirmConfig);
  dom.configCancelBtn.addEventListener("click", hideConfigGuide);

  // 删除确认

  // Esc 关闭弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!dom.previewPopup.hidden) hidePreview();
    }
  });
}

/* ================================================================== */
/* 初始化                                                              */
/* ================================================================== */

/**
 * popup 初始化入口。
 *
 * 流程：
 * 1. 初始化 DOM 引用
 * 2. 绑定事件
 * 3. 加载主题配置（并行）
 * 4. 加载当前网页标注（智能记忆）
 */
async function init() {
  try {
    initDomRefs();
    bindEvents();

    // 初始主题（先跟随系统，后续根据配置调整）
    setThemeMode(THEME_FOLLOW_SYSTEM);

    // 隐藏结果区

    // 并行加载主题配置和标注数据
    await Promise.all([
      loadThemeConfig().catch((err) => {
        console.error("[WebAnnotator] 加载主题配置失败:", err);
      }),
      loadAnnotation().catch((err) => {
        console.error("[WebAnnotator] 加载标注失败:", err);
        showStatus("加载失败，请重试", "error");
      }),
    ]);
  } catch (err) {
    console.error("[WebAnnotator] popup 初始化异常:", err);
    showStatus("初始化失败", "error");
  }
}

// DOM 就绪后初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}