# WebMarker 功能扩展 · 技术设计（design.md）

> 依据 spec.md。架构沿用现有：Chrome MV3 扩展 ↔ Native Messaging Host（C#/.NET 8 + SQLite）。
> 现有基础：`annotations` / `tags` / `annotation_tags` / `config` / `schema_version` 表；action 路由在 `MessageRouter.cs`；扩展四页面 popup / newtab / options / background。
> v2.1 行为变更：`annotations.url` **不再唯一**（同一网页可保存多条标注）；`save` 无 `annotationId` → 总是 INSERT 新建，带 `annotationId`（>0）→ 按 id 更新该条；`get` 返回该 url 最新一条（id 倒序）。旧库自动迁移（去掉唯一索引）。

---

## 1 架构与模块划分

```
扩展层（MV3）
├── content.js        [新增] 划词高亮工具条、高亮还原、快照抓取、右键选中文本上报
├── background.js     [改]   contextMenus 注册、会话保存（tabs 查询）、高亮跳转
├── options.html/js/css [改] 高亮列表、标签图谱、导出按钮、会话管理、快照管理、暗黑主题
├── newtab.html/js/css  [改] 时钟小组件、暗黑主题
└── manifest.json     [改]   权限：content_scripts + contextMenus + tabs + scripting

Host 层（C#）
├── Services/HighlightService.cs  [新增] 高亮 CRUD
├── Services/SessionService.cs    [新增] 会话 CRUD
├── Services/SnapshotService.cs   [新增] 快照 CRUD
├── Services/AnnotationService.cs [改]   exportMarkdown/exportHtml/getTagGraph
├── NativeMessaging/MessageRouter.cs [改] 新增 action 路由
├── Models/Highlight.cs / Session.cs / SessionItem.cs / Snapshot.cs / TagGraph.cs [新增]
└── CreateSchemaSql [改] 追加新表（IF NOT EXISTS 幂等，老库自动建新表，无需迁移脚本）

存储：单一 webannotator.db（新增 4 表）；数据路径沿用 config.DataPath（便携目录）。
```

数据流：
- 高亮：content.js 划词 →（原生帧）→ Host `saveHighlight` → SQLite；页面加载 content.js → `getHighlightsByUrl` → 还原 `<mark>`。
- 会话：background.js `chrome.tabs.query` → Host `saveSession`；options 列表/恢复/删除。
- 快照：content.js 抓 `document.documentElement.outerHTML` → Host `saveSnapshot`。
- 图谱：options → Host `getTagGraph`（读 annotations+annotation_tags 共现）。
- 导出：options → Host `exportMarkdown/exportHtml` → 扩展端 Blob 下载。

## 2 数据模型（新增表，均 IF NOT EXISTS 幂等）

```sql
-- 高亮表
CREATE TABLE IF NOT EXISTS highlights (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    url_hash   TEXT NOT NULL,
    quote      TEXT NOT NULL,              -- 高亮原文（截断至 5000 字符）
    selector   TEXT NOT NULL,              -- 定位路径（CSS selector + 文本偏移，供跳转）
    color      TEXT NOT NULL DEFAULT 'yellow',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_url_hash ON highlights(url_hash);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- 会话条目表
CREATE TABLE IF NOT EXISTS session_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    url        TEXT NOT NULL,
    title      TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_items_session ON session_items(session_id);

-- 快照表
CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    url_hash   TEXT NOT NULL,
    title      TEXT,
    html       TEXT NOT NULL,              -- 截断至 10MB 上限
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_url_hash ON snapshots(url_hash);
```

schema_version 维持既有机制（CREATE TABLE IF NOT EXISTS 对新增表幂等；不升级版本号，避免老库迁移）。

## 3 API 设计（action / 参数 / 返回 / 错误码）

帧格式沿用：4 字节小端长度 + JSON，字段 camelCase。错误码统一 `{ success:false, error, message }`。

### 3.1 高亮
| action | 参数 | 返回 | 错误码 |
|---|---|---|---|
| `saveHighlight` | url, quote, selector, color, note | `{ highlight }` | HOST_NOT_INITIALIZED / URL_INVALID / QUOTE_EMPTY / SELECTOR_INVALID |
| `getHighlightsByUrl` | url | `{ highlights: [...] }` | HOST_NOT_INITIALIZED / URL_INVALID |
| `updateHighlight` | highlightId, color?, note? | `{ highlight }` | HIGHLIGHT_NOT_FOUND |
| `deleteHighlight` | highlightId | `{ deleted: true }` | HIGHLIGHT_NOT_FOUND |

### 3.2 会话
| action | 参数 | 返回 | 错误码 |
|---|---|---|---|
| `saveSession` | name, items:[{url,title}] | `{ session }` | HOST_NOT_INITIALIZED / ITEMS_EMPTY |
| `listSessions` | 无 | `{ sessions:[{id,name,itemCount,createdAt}] }` | HOST_NOT_INITIALIZED |
| `getSessionItems` | sessionId | `{ items:[{id,url,title,position}] }` | SESSION_NOT_FOUND |
| `deleteSession` | sessionId | `{ deleted: true }` | SESSION_NOT_FOUND |
| `deleteSessionItem` | itemId | `{ deleted: true }` | ITEM_NOT_FOUND |

### 3.3 导出
| action | 参数 | 返回 | 错误码 |
|---|---|---|---|
| `exportMarkdown` | 无 | `{ content, count }` | HOST_NOT_INITIALIZED |
| `exportHtml` | 无 | `{ content, count }` | HOST_NOT_INITIALIZED |

Markdown 格式：`## 标题` / `- URL: ...` / `- 标签: a, b` / `- 备注: ...` / `> 高亮: 引用（颜色）`，按 updated_at 倒序。
HTML 格式：独立文档，内联样式，标注卡片 + 高亮引用块。

### 3.4 图谱
| action | 参数 | 返回 | 错误码 |
|---|---|---|---|
| `getTagGraph` | 无 | `{ nodes:[{id,name,count}], edges:[{source,target,weight}] }` | HOST_NOT_INITIALIZED |

节点 = 全部标签；边 = 两标签共现于同一标注的次数（weight）。SQL：按 annotation_tags 按 annotation_id 自关联统计。

### 3.5 快照
| action | 参数 | 返回 | 错误码 |
|---|---|---|---|
| `saveSnapshot` | url, title, html | `{ snapshot }` | HOST_NOT_INITIALIZED / URL_INVALID / HTML_EMPTY / SNAPSHOT_TOO_LARGE |
| `listSnapshots` | limit?, offset? | `{ snapshots, total }` | HOST_NOT_INITIALIZED |
| `getSnapshot` | snapshotId | `{ snapshot }` | SNAPSHOT_NOT_FOUND |
| `deleteSnapshot` | snapshotId | `{ deleted: true }` | SNAPSHOT_NOT_FOUND |

HTML 上限 10MB，超出截断并标记 `truncated: true`。

### 3.6 划词右键（扩展内实现，无新 action）
background.js 注册 `contextMenus`（id=`wm-add-annotation`，contexts=["selection"]）；点击后打开 options 标注编辑并预填 note=选中文本。受限页不注入（content.js 过滤 URL）。

## 4 扩展端设计要点

### 4.1 content.js（新增，注入 all_urls 但运行时过滤 http/https）
- 划词监听 `mouseup` → 若选区非空且非扩展自身 UI 区域 → 浮动工具条（5 色 + 备注 + 关闭）。
- 高亮还原：`getHighlightsByUrl` → 对每条用 selector + 文本匹配定位，找不到则退化为在 document.body 文本中搜索 quote 包裹。
- 高亮标记：`<mark class="wm-hl wm-hl-<color>" data-hl-id>`；点击标记 → 小工具条（改色/删除/备注）。
- 高亮跳转（管理面板点击）：`chrome.tabs.create` 打开 URL → content.js 监听 storage/local 或 URL hash 参数定位到高亮（`scrollIntoView` + 短暂闪烁）。
- 快照：background 收到右键/页面操作 → content.js 返回 `document.documentElement.outerHTML`。
- 与 host 通信复用 popup/options 的 native 通道封装（独立 connect 实例，命名 `com.codearts.webannotator`）。

### 4.2 manifest.json 变更
```json
{
  "permissions": ["nativeMessaging","activeTab","storage","bookmarks","management","tabs","contextMenus","scripting"],
  "content_scripts": [{
    "matches": ["http://*/*","https://*/*"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }]
}
```
> 注意：新增 content_scripts 会使扩展 ID 不变（ID 由路径决定，与 manifest 内容无关），已注册 host 免重跑。

### 4.3 暗黑主题
- options/newtab 改用 CSS 变量；`[data-theme="dark"]` 覆盖变量集。
- 启动时读取 host `getConfig.themeMode`（0 跟随系统 / 1 亮 / 2 暗），跟随系统用 `matchMedia('(prefers-color-scheme: dark)')`。
- 切换即调 `setConfig {themeMode}` 持久化。

### 4.4 时钟
newtab.js 每秒更新时钟文本；点击在 12/24 制切换，存 `localStorage['wmClock24']`。

### 4.5 管理面板新增视图（options）
- 首页概览：标注数/标签数 + 导出按钮组（CSV / Markdown / HTML）+ 会话数 + 快照数。
- 标签管理：Tab 切换"标签列表 / 关系图谱"。
- 新增导航：高亮管理、会话管理、快照管理（各自列表 + 删除 + 详情跳转）。

## 5 运行期状态与安全

- 高亮定位 selector 可能因页面动态变化失效：还原时先按 selector，失败按 quote 文本兜底，仍失败则该条跳过并记录（不报错、不阻塞页面）。
- 快照/高亮涉及页面内容，只写本地 SQLite，不上传；导出文件由用户主动触发。
- 所有新 action 遵循既有错误处理：顶层 try-catch 兜底，绝不崩溃。
- 数据库写操作沿用 `using var db` + WAL，删除会话/快照为软确认（扩展端 confirm 弹窗）。
