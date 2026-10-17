/**
 * WebAnnotator background service worker
 *
 * 核心职责（对应 design.md 2.4.3 / tasks.md T15）：
 * 1. Native Messaging 端口管理 —— 按需重连策略（非长连接保活）
 * 2. 活动标签页信息采集 —— chrome.tabs.query 获取 URL 与标题
 * 3. 请求转发 —— popup 请求经 Native Messaging 端口转发到本地程序
 * 4. URL 有效性校验 —— 过滤 chrome:// / edge:// / about: 等内部页
 * 5. 连接状态持久化 —— chrome.storage.session 记录端口状态
 *
 * MV3 约束：不使用 DOM API、不使用 setInterval 心跳保活、不依赖 window/localStorage。
 */

"use strict";

/* ================================================================== */
/* 常量定义                                                            */
/* ================================================================== */

/** Native Messaging host 名称，需与 host manifest 的 name 字段一致 */
const HOST_NAME = "com.codearts.webannotator";

/** chrome.storage.session 中记录连接状态的键名 */
const STATE_KEY_PORT = "nativePortConnected";

/** 消息类型：获取当前标签页信息（popup → background） */
const MSG_GET_TAB_INFO = "GET_TAB_INFO";

/** 不支持标注的 URL 协议前缀 */
const INVALID_URL_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "edge-extension://",
  "moz-extension://",
  "devtools://",
  "view-source:",
];

/* ================================================================== */
/* 端口管理（按需重连）                                                */
/* ================================================================== */

/** 当前 Native Messaging 端口，null 表示未连接 */
let nativePort = null;

/**
 * 等待响应的回调队列。
 *
 * 本地程序为单进程顺序处理请求（MessagePipe 阻塞读取 stdin），
 * 响应按请求顺序返回。因此用 FIFO 队列配对请求与响应。
 * @type {Array<function(object): void>}
 */
const pendingCallbacks = [];

/**
 * 确保与本地程序的 Native Messaging 端口已建立。
 *
 * 按需重连策略（design.md 2.1.3 关键决策）：
 * - port 存在则直接复用
 * - port 不存在则 connectNative 建立新端口
 * - 端口断开时 onDisconnect 回调置 port=null，下次请求自动重连
 *
 * @returns {Promise<chrome.runtime.Port>} 已建立的端口
 * @throws {Error} 连接失败时抛出（本地程序未注册/未启动）
 */
function ensureConnection() {
  if (nativePort) {
    return Promise.resolve(nativePort);
  }

  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      console.error("[WebAnnotator] connectNative 抛出异常:", err);
      updatePortState(false);
      reject(err);
      return;
    }

    // 端口对象创建即视为连接发起成功；
    // 若本地程序不存在，onDisconnect 会立即触发并清理。
    nativePort = port;

    // 接收本地程序响应：从队列头部取出回调并调用
    port.onMessage.addListener((response) => {
      const callback = pendingCallbacks.shift();
      if (callback) {
        callback(response);
      } else {
        console.warn("[WebAnnotator] 收到未匹配的响应，无等待中的回调:", response);
      }
    });

    // 端口断开：清理状态，记录日志，下次请求自动重连
    port.onDisconnect.addListener((disconnectedPort) => {
      console.warn("[WebAnnotator] Native Messaging 端口断开，将在下次请求时重连。");
      if (nativePort === disconnectedPort) {
        nativePort = null;
      }
      // 通知所有等待中的回调连接已断开
      let cb;
      while ((cb = pendingCallbacks.shift())) {
        cb({
          success: false,
          error: "与本地程序的连接已断开，请重试",
          errorCode: "HOST_DISCONNECTED",
        });
      }
      updatePortState(false);
    });

    updatePortState(true);
    resolve(port);
  });
}

/**
 * 更新 chrome.storage.session 中的端口连接状态。
 * SW 休眠重启后可据此判断上次连接状态。
 * @param {boolean} connected - 端口是否已连接
 */
function updatePortState(connected) {
  try {
    chrome.storage.session.set({ [STATE_KEY_PORT]: connected });
  } catch (err) {
    // storage.session 不可用时静默处理，不影响核心功能
    console.warn("[WebAnnotator] 更新端口状态失败:", err);
  }
}

/* ================================================================== */
/* URL 有效性校验                                                      */
/* ================================================================== */

/**
 * 校验 URL 是否为可标注的有效网页地址。
 *
 * 规则（design.md 2.4.3 / spec.md 5.1.3.3）：
 * - 必须为 http:// 或 https:// 协议
 * - chrome:// / edge:// / about: / 扩展页 / devtools 等内部页无效
 * - 空白页（URL 为空）无效
 *
 * @param {string} url - 待校验的 URL
 * @returns {boolean} true 表示可标注
 */
function isValidUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  const lower = url.toLowerCase();
  for (const prefix of INVALID_URL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return false;
    }
  }
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/* ================================================================== */
/* 标签页信息采集                                                      */
/* ================================================================== */

/**
 * 获取当前活动标签页的 URL 与标题。
 * @returns {Promise<{url: string, title: string}>}
 */
function getCurrentTabInfo() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.error("[WebAnnotator] 获取标签页失败:", chrome.runtime.lastError);
        resolve({ url: "", title: "" });
        return;
      }
      const tab = tabs && tabs[0];
      resolve({
        url: tab ? tab.url || "" : "",
        title: tab ? tab.title || "" : "",
      });
    });
  });
}

/* ================================================================== */
/* 请求转发到本地程序                                                  */
/* ================================================================== */

/**
 * 通过 Native Messaging 端口向本地程序发送请求并等待响应。
 *
 * @param {object} request - 请求对象（含 action 字段）
 * @returns {Promise<object>} 响应对象
 */
function sendToHost(request) {
  return ensureConnection().then((port) => {
    return new Promise((resolve) => {
      // 将回调加入队列，等待 port.onMessage 回调触发
      pendingCallbacks.push(resolve);
      try {
        port.postMessage(request);
      } catch (err) {
        // postMessage 失败：从队列移除刚加入的回调并返回错误
        pendingCallbacks.pop();
        nativePort = null;
        updatePortState(false);
        console.error("[WebAnnotator] postMessage 失败:", err);
        resolve({
          success: false,
          error: "发送请求到本地程序失败，请重试",
          errorCode: "HOST_NOT_FOUND",
        });
      }
    });
  }).catch((err) => {
    // connectNative 失败：本地程序未注册或未安装
    console.error("[WebAnnotator] 连接本地程序失败:", err);
    return {
      success: false,
      error: "未检测到本地程序，请先安装并运行配套程序",
      errorCode: "HOST_NOT_FOUND",
    };
  });
}

/* ================================================================== */
/* 消息监听（popup → background）                                      */
/* ================================================================== */

/**
 * 监听来自 popup 的消息。
 *
 * 消息类型：
 * 1. { type: "GET_TAB_INFO" } —— 获取当前标签页 URL 与标题
 * 2. { action: "get|save|search|...", ... } —— 数据操作请求，转发到本地程序
 *
 * 所有回调 return true 以保持异步响应通道开放（chrome.runtime.onMessage 要求）。
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. 获取当前标签页信息
  if (request && request.type === MSG_GET_TAB_INFO) {
    getCurrentTabInfo().then((tabInfo) => {
      const valid = isValidUrl(tabInfo.url);
      sendResponse({
        url: tabInfo.url,
        title: tabInfo.title,
        valid: valid,
        errorCode: valid ? null : "URL_INVALID",
      });
    });
    return true; // 异步响应
  }

  // 2. 数据操作请求，转发到本地程序
  if (request && typeof request.action === "string") {
    // 对需要 URL 的请求做前置校验（get / save）
    if ((request.action === "get" || request.action === "save") && request.url) {
      if (!isValidUrl(request.url)) {
        sendResponse({
          success: false,
          error: "当前页面不支持标注",
          errorCode: "URL_INVALID",
        });
        return true;
      }
    }

    sendToHost(request).then((response) => {
      sendResponse(response || { success: false, error: "空响应", errorCode: "INTERNAL_ERROR" });
    });
    return true; // 异步响应
  }

  // 3. 未知消息类型
  console.warn("[WebAnnotator] 收到未知消息类型:", request);
  sendResponse({
    success: false,
    error: "未知消息类型",
    errorCode: "UNKNOWN_ACTION",
  });
  return false;
});

/* ================================================================== */
/* Service Worker 生命周期                                             */
/* ================================================================== */

// SW 启动时记录日志（便于调试 SW 休眠/重启）
console.log("[WebAnnotator] background service worker 已启动。");

// 监听扩展安装/更新事件
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[WebAnnotator] 扩展已安装/更新:", details.reason);
  // 初始化端口状态
  updatePortState(false);
});