/**
 * WebMarker content script（P0-1 文本高亮 / P1-4 快照）
 *
 * 职责：
 * 1. 页面加载后还原已保存的高亮（selector → quote 双兜底）
 * 2. 划词显示浮动工具条（5 色 + 关闭），保存高亮并立即标记
 * 3. 点击已有高亮显示工具条（改色 / 删除 / 备注）
 * 4. 响应 background 请求：抓取页面快照（outerHTML）、定位高亮跳转
 *
 * 与 host 通信统一走 background 中转（chrome.runtime.sendMessage），
 * 避免内容脚本建立多条 Native Messaging 连接。
 */

"use strict";

(() => {
  // 页面为受限页（无 http/https）时直接退出（content_scripts matches 已过滤，双保险）
  if (!/^https?:\/\//i.test(window.location.href)) {
    return;
  }

  /* ========== 常量 ========== */
  const HL_COLORS = {
    yellow: { bg: "#fff59d", border: "#fbc02d" },
    green: { bg: "#c8e6c9", border: "#66bb6a" },
    blue: { bg: "#bbdefb", border: "#42a5f5" },
    red: { bg: "#ffcdd2", border: "#ef5350" },
    purple: { bg: "#e1bee7", border: "#ab47bc" },
  };
  const TOOLBAR_ID = "wm-hl-toolbar";
  const TOOLBAR_SMALL_ID = "wm-hl-toolbar-small";

  let toolbar = null;
  let smallToolbar = null;

  /* ========== host 请求（经 background 中转） ========== */
  function sendToBackground(request) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(request, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message, errorCode: "INTERNAL_ERROR" });
            return;
          }
          resolve(response || { success: false, error: "空响应", errorCode: "INTERNAL_ERROR" });
        });
      } catch (err) {
        resolve({ success: false, error: err.message, errorCode: "INTERNAL_ERROR" });
      }
    });
  }

  /* ========== 定位辅助 ========== */

  /** 生成元素的最简 CSS selector（id → class 组合 → 标签，最多向上 5 层）。 */
  function buildSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
    const parts = [];
    let node = el;
    for (let i = 0; i < 5 && node && node.nodeType === Node.ELEMENT_NODE && node !== document.body; i++) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part = "#" + CSS.escape(node.id);
      } else if (node.classList && node.classList.length > 0) {
        const cls = Array.from(node.classList)
          .slice(0, 2)
          .map((c) => "." + CSS.escape(c))
          .join("");
        if (cls) part += cls;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** 在文档中查找包含指定文本的文本节点（quote 兜底定位）。 */
  function findTextNode(quote) {
    if (!quote) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue || "";
        return text.includes(quote) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    return walker.nextNode();
  }

  /** 在元素内定位 quote 的 Range（先精确匹配，再宽松匹配）。 */
  function createQuoteRange(container, quote) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.nodeValue || "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let offset = 0;
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue || "";
      const idx = text.indexOf(quote);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + quote.length);
        return range;
      }
      offset += text.length;
      node = walker.nextNode();
    }
    // 宽松：忽略空白后匹配（长文本可能因空白差异失配）
    const looseQuote = quote.replace(/\s+/g, " ");
    const looseWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.nodeValue || "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let looseNode = looseWalker.nextNode();
    while (looseNode) {
      const text = (looseNode.nodeValue || "").replace(/\s+/g, " ");
      const idx = text.indexOf(looseQuote);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(looseNode, idx);
        range.setEnd(looseNode, idx + looseQuote.length);
        return range;
      }
      looseNode = looseWalker.nextNode();
    }
    return null;
  }

  /* ========== 高亮标记 ========== */

  /** 用 Range 包裹高亮 mark。 */
  function wrapRange(range, color, hlId) {
    const colors = HL_COLORS[color] || HL_COLORS.yellow;
    const mark = document.createElement("mark");
    mark.className = "wm-hl wm-hl-" + (color || "yellow");
    mark.dataset.hlId = String(hlId);
    mark.style.cssText =
      "background:" + colors.bg + ";color:inherit;border-bottom:2px solid " +
      colors.border + ";border-radius:2px;padding:0 2px;cursor:pointer;";
    try {
      range.surroundContents(mark);
    } catch (e) {
      // 选区跨多个文本节点时 surroundContents 抛错：退化为仅视觉标记（避免破坏 DOM）
      return null;
    }
    return mark;
  }

  /** 保存高亮（经 background 转发 host）。 */
  async function saveHighlight(quote, selector, color) {
    const resp = await sendToBackground({
      action: "saveHighlight",
      url: window.location.href,
      quote: quote,
      selector: selector || "",
      color: color,
      note: "",
    });
    return resp;
  }

  /** 还原页面上已保存的高亮。 */
  async function restoreHighlights() {
    const resp = await sendToBackground({ action: "getHighlightsByUrl", url: window.location.href });
    // host 响应统一 data 包装：{success, data:{highlights:[...]}}
    if (!resp || !resp.success || !resp.data || !Array.isArray(resp.data.highlights)) return;
    let restored = 0;
    for (const hl of resp.data.highlights) {
      let container = null;
      if (hl.selector) {
        try {
          container = document.querySelector(hl.selector);
        } catch (e) {
          container = null;
        }
      }
      if (!container) {
        const textNode = findTextNode(hl.quote);
        container = textNode ? textNode.parentElement : null;
      }
      if (!container) continue;

      const range = createQuoteRange(container, hl.quote);
      if (!range) continue;
      const mark = wrapRange(range, hl.color, hl.id);
      if (mark) restored++;
    }
    if (restored > 0) {
      console.log("[WebMarker] 已还原高亮:", restored);
    }
  }

  /* ========== 浮动工具条 ========== */

  /** 主工具条（划词后）：5 色 + 关闭。 */
  function ensureToolbar() {
    if (toolbar && document.getElementById(TOOLBAR_ID)) return toolbar;
    toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.style.cssText =
      "position:fixed;z-index:2147483647;display:flex;align-items:center;gap:4px;padding:6px 8px;" +
      "background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);" +
      "font-size:0;user-select:none;";
    Object.keys(HL_COLORS).forEach((color) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = "高亮为 " + color;
      btn.dataset.color = color;
      btn.style.cssText =
        "width:22px;height:22px;border:2px solid " + HL_COLORS[color].border +
        ";background:" + HL_COLORS[color].bg + ";border-radius:50%;cursor:pointer;margin:0;padding:0;";
      btn.addEventListener("mousedown", (e) => e.preventDefault()); // 防止工具条抢选区焦点
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const color = btn.dataset.color;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          hideToolbar();
          return;
        }
        const quote = sel.toString().trim().slice(0, 5000);
        const anchor = sel.anchorNode ? (sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement) : null;
        const selector = buildSelector(anchor);
        const range = sel.getRangeAt(0);
        const resp = await saveHighlight(quote, selector, color);
        if (resp && resp.success) {
          const hlId = resp.data && resp.data.highlight ? resp.data.highlight.id : Date.now();
          const mark = wrapRange(range, color, hlId);
          if (mark) {
            sel.removeAllRanges();
          }
        } else {
          showToast(resp && resp.error ? resp.error : "保存高亮失败");
        }
        hideToolbar();
      });
      toolbar.appendChild(btn);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "关闭";
    close.style.cssText =
      "width:22px;height:22px;border:none;background:transparent;color:#57606a;cursor:pointer;font-size:14px;line-height:1;";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      hideToolbar();
    });
    toolbar.appendChild(close);
    document.body.appendChild(toolbar);
    return toolbar;
  }

  /** 小工具条（点击已有高亮）：改色 + 删除。 */
  function ensureSmallToolbar() {
    if (smallToolbar && document.getElementById(TOOLBAR_SMALL_ID)) return smallToolbar;
    smallToolbar = document.createElement("div");
    smallToolbar.id = TOOLBAR_SMALL_ID;
    smallToolbar.style.cssText =
      "position:fixed;z-index:2147483647;display:flex;align-items:center;gap:4px;padding:6px 8px;" +
      "background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);" +
      "font-size:0;user-select:none;";
    Object.keys(HL_COLORS).forEach((color) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = "改为 " + color;
      btn.dataset.color = color;
      btn.style.cssText =
        "width:18px;height:18px;border:2px solid " + HL_COLORS[color].border +
        ";background:" + HL_COLORS[color].bg + ";border-radius:50%;cursor:pointer;margin:0;padding:0;";
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const mark = smallToolbar._target;
        if (!mark) return;
        const hlId = parseInt(mark.dataset.hlId || "0", 10);
        const color = btn.dataset.color;
        const resp = await sendToBackground({ action: "updateHighlight", highlightId: hlId, color: color });
        if (resp && resp.success) {
          applyMarkColor(mark, color);
        } else {
          showToast(resp && resp.error ? resp.error : "修改高亮失败");
        }
        hideSmallToolbar();
      });
      smallToolbar.appendChild(btn);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "🗑";
    del.title = "删除高亮";
    del.style.cssText =
      "width:22px;height:22px;border:none;background:transparent;color:#cf222e;cursor:pointer;font-size:14px;line-height:1;";
    del.addEventListener("mousedown", (e) => e.preventDefault());
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const mark = smallToolbar._target;
      if (!mark) return;
      const hlId = parseInt(mark.dataset.hlId || "0", 10);
      const resp = await sendToBackground({ action: "deleteHighlight", highlightId: hlId });
      if (resp && resp.success) {
        mark.replaceWith(mark.textContent);
      } else {
        showToast(resp && resp.error ? resp.error : "删除高亮失败");
      }
      hideSmallToolbar();
    });
    smallToolbar.appendChild(del);
    document.body.appendChild(smallToolbar);
    return smallToolbar;
  }

  function applyMarkColor(mark, color) {
    const colors = HL_COLORS[color] || HL_COLORS.yellow;
    mark.className = "wm-hl wm-hl-" + color;
    mark.style.background = colors.bg;
    mark.style.borderBottom = "2px solid " + colors.border;
  }

  function positionToolbar(el, x, y) {
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.display = "flex";
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = x - rect.width / 2;
    let top = y - rect.height - 10;
    if (left < pad) left = pad;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top < pad) top = y + 14;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function hideToolbar() {
    if (toolbar) toolbar.style.display = "none";
  }

  function hideSmallToolbar() {
    if (smallToolbar) {
      smallToolbar.style.display = "none";
      smallToolbar._target = null;
    }
  }

  /** 轻提示（2.5s 自动消失）。 */
  let toastEl = null;
  let toastTimer = null;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText =
        "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(30,32,36,.92);color:#fff;padding:8px 16px;border-radius:8px;" +
        "font-size:13px;font-family:'Microsoft YaHei',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.display = "none";
    }, 2500);
  }

  /* ========== 事件监听 ========== */

  // 划词显示工具条（排除扩展自身 UI 区域与已有高亮）
  document.addEventListener("mouseup", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      hideToolbar();
      return;
    }
    // 点击扩展工具条自身时忽略
    const target = e.target;
    if (target && (target.closest("#" + TOOLBAR_ID) || target.closest("#" + TOOLBAR_SMALL_ID))) {
      return;
    }
    const toolbarEl = ensureToolbar();
    positionToolbar(toolbarEl, e.clientX, e.clientY);
  });

  // 点击已有高亮显示小工具条
  document.addEventListener("click", (e) => {
    const mark = e.target.closest ? e.target.closest("mark.wm-hl") : null;
    if (mark) {
      e.preventDefault();
      const tb = ensureSmallToolbar();
      tb._target = mark;
      positionToolbar(tb, e.clientX, e.clientY);
    } else {
      hideSmallToolbar();
    }
  });

  // 点击页面其他处隐藏主工具条
  document.addEventListener("mousedown", (e) => {
    const target = e.target;
    if (target && (target.closest("#" + TOOLBAR_ID) || target.closest("#" + TOOLBAR_SMALL_ID))) {
      return;
    }
    hideToolbar();
    hideSmallToolbar();
  });

  // 滚动/缩放时隐藏工具条
  window.addEventListener("scroll", hideToolbar, { passive: true });
  window.addEventListener("resize", hideToolbar);

  /* ========== background 消息响应 ========== */

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 全局提示：background 等通知在当前页面显示 toast
    if (request && request.type === "WM_SHOW_TOAST" && request.message) {
      showToast(request.message);
      return false;
    }

    // 快照抓取：background 请求页面 HTML
    if (request && request.type === "WM_GET_SNAPSHOT") {
      try {
        sendResponse({ success: true, html: document.documentElement.outerHTML });
      } catch (err) {
        sendResponse({ success: false, error: err.message, errorCode: "INTERNAL_ERROR" });
      }
      return false;
    }

    // 高亮跳转定位：管理面板点击高亮 → background 打开标签页后广播定位
    if (request && request.type === "WM_LOCATE_HIGHLIGHT" && request.quote) {
      const textNode = findTextNode(request.quote);
      const container = textNode ? textNode.parentElement : null;
      const range = container ? createQuoteRange(container, request.quote) : null;
      if (range) {
        const rect = range.getBoundingClientRect();
        if (rect && rect.top) {
          window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });
        }
        // 短暂闪烁定位
        const flash = document.createElement("span");
        flash.style.cssText = "position:absolute;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;background:rgba(255,213,79,.55);pointer-events:none;z-index:2147483646;transition:opacity .6s;";
        document.body.appendChild(flash);
        setTimeout(() => {
          flash.style.opacity = "0";
          setTimeout(() => flash.remove(), 700);
        }, 400);
      }
      sendResponse({ success: !!range });
      return false;
    }

    return false;
  });

  /* ========== 初始化 ========== */

  // 页面加载后还原高亮（document_idle 已保证 DOM 就绪，再等一拍让动态内容稳定）
  const initDelay = window.setTimeout(() => {
    restoreHighlights();
  }, 300);
  window.addEventListener("unload", () => clearTimeout(initDelay), { once: true });
})();
