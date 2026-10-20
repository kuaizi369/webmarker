# WebMarker 功能扩展 · 实现任务列表（tasks.md）

> 依据 spec.md / design.md。每项含依赖与验收；增删改查标注四态（空/单/多/全）。
> 完成顺序：Host（T1-T6）→ 扩展基础（T7-T9）→ 各功能 UI（T10-T15）→ 质量与验证（T16-T18）。
> 副本规则：host 源码在项目 `native-host` 目录，扩展多副本同步（主工作副本 / host 源码副本 / 浏览器加载副本 / Yandex 副本）。

## Host 端

### T1 新增数据表 + Models
- [ ] CreateSchemaSql 追加 highlights / sessions / session_items / snapshots 四表（IF NOT EXISTS 幂等）
- [ ] 新增 Models：Highlight.cs、Session.cs、SessionItem.cs、Snapshot.cs、TagGraph.cs（Node/Edge）
- 验收：老库打开自动建新表；新库建表完整；`PRAGMA table_info` 核对字段

### T2 HighlightService（CRUD 四态）
- [ ] `saveHighlight(url, quote, selector, color, note)`：quote 空拒绝；quote 截断 5000
- [ ] `getHighlightsByUrl(url)`：空 URL 返回空列表（不报错）；多条按 created_at 升序；无记录返回 []
- [ ] `updateHighlight(id, color?, note?)`：单条不存在抛 HighlightNotFoundException
- [ ] `deleteHighlight(id)`：单条删除；删除最后一条后列表为空（四态覆盖）
- 验收：空/单/多/全四态帧级测试（独立临时库）

### T3 SessionService（CRUD 四态）
- [ ] `saveSession(name, items)`：items 空拒绝；name 空用默认；批量写入 + 顺序 position
- [ ] `listSessions()`：空库返回 []；多条含 itemCount
- [ ] `getSessionItems(sessionId)`：单条会话明细；不存在抛 SessionNotFoundException
- [ ] `deleteSession(id)`：级联删 items（SQLite ON DELETE CASCADE）
- [ ] `deleteSessionItem(itemId)`：单条删除，不影响其余
- 验收：四态帧级测试；删除会话后 itemCount=0

### T4 SnapshotService（CRUD 四态）
- [ ] `saveSnapshot(url, title, html)`：html 空拒绝；>10MB 截断标记 truncated
- [ ] `listSnapshots(limit, offset)`：分页；空库返回 total=0
- [ ] `getSnapshot(id)`：不存在抛 SnapshotNotFoundException
- [ ] `deleteSnapshot(id)`：单条
- 验收：四态帧级测试；大 html 截断路径实测

### T5 AnnotationService 扩展（导出 + 图谱）
- [ ] `exportMarkdown()`：全部标注→Markdown；空库返回空串 count=0；含标签/备注/高亮引用
- [ ] `exportHtml()`：全部标注+高亮→HTML；空库返回空串
- [ ] `getTagGraph()`：节点=全部标签；边=共现（annotation_tags 自关联）；无标签返回空 nodes/edges
- 验收：与 CSV 导出并列核对 count 一致；图谱边权抽样复核

### T6 MessageRouter + 编译部署
- [ ] 新增 16 个 action 路由（3.1-3.5），错误码映射
- [ ] `dotnet publish -c Release -r win-x64 --self-contained`
- [ ] exe 同步三处，哈希一致
- 验收：全 action 帧级 ping/往返；`UNKNOWN_ACTION` 不崩溃

## 扩展端基础

### T7 manifest + content.js
- [ ] manifest 加 permissions（tabs/contextMenus/scripting）与 content_scripts
- [ ] content.js：划词工具条（5 色/备注/关闭）、高亮还原（selector→quote 兜底）、点击改色/删除、快照抓取
- 验收：Chrome 加载副本重载后划词可用；受限页不注入

### T8 background.js
- [ ] contextMenus「添加为页签标注」（selection 上下文）
- [ ] 点击菜单 → 打开 options 标注编辑并预填选中文本
- [ ] 高亮跳转通道（tabs.create + 定位参数）
- 验收：选中文本右键有菜单；受限页无菜单

### T9 三处同步（扩展）
- [ ] manifest / content.js / background.js / options.* / newtab.* 同步 WebAnnotator + Chrome插件副本
- 验收：三处文件哈希一致；node --check 语法通过

## 功能 UI

### T10 暗黑主题（options + newtab）
- [ ] CSS 变量化 + `[data-theme="dark"]` 变量集；启动读 getConfig.themeMode；切换 setConfig 持久化
- [ ] 跟随系统用 matchMedia 监听
- 验收：三态切换即时生效；暗黑下文字/边框可读

### T11 时钟小组件（newtab）
- [ ] 顶部时钟，秒级刷新；点击 12/24 切换；localStorage 持久化
- 验收：切换后刷新页面保持

### T12 高亮管理（options）
- [ ] 高亮列表视图（按 URL 分组/搜索）；删除单条；点击跳转 URL+滚动定位
- 四态：空列表空状态；单条删除后变空；多条删除；全删后空状态
- 验收：E2E 标注→高亮→列表→跳转→删除

### T13 会话管理（options + popup 入口）
- [ ] 保存当前窗口会话（popup 按钮）；会话列表（名/数量/时间）；展开条目；恢复（tabs.create 按序）；删会话/删单条（confirm）
- 四态：空窗口拒绝；单会话；多会话；删除全部
- 验收：E2E 保存→恢复→删除

### T14 导出（options 首页）
- [ ] Markdown / HTML 导出按钮；Blob 下载；无数据提示
- 验收：导出文件回读内容正确；与 CSV 并列

### T15 标签图谱 + 快照管理（options）
- [ ] 图谱视图（SVG：节点=标签圆，边=共现线，宽度=weight；点击节点→标签筛选；<2 标签空状态）
- [ ] 快照管理（列表/查看新标签/删除）
- 四态：图谱 0/1/多节点；快照空/单/多/全删
- 验收：图谱节点数与 getTagsWithCount 一致；快照查看还原内容

## 质量与交付

### T16 单元测试（host 帧级 + 扩展语法）
- [ ] Highlight/Session/Snapshot 四态与边界（空输入、超长、非法 id、重复保存）
- [ ] node --check 全部 js；图谱 SQL 抽样复核
- 验收：测试隔离临时库，不动真实数据

### T17 代码质量审查
- [ ] 绝对路径扫描（scan-absolute-paths.ps1 逻辑代码零命中）
- [ ] 清单字段小写、帧格式、残留引用 grep、死代码检查
- 验收：审查清单全过

### T18 功能验证 + 打包
- [ ] E2E：真实浏览器走通 8 功能；独立通道回读数据
- [ ] 打包便携包并回读（内含新 content.js / manifest 版本）
- [ ] 玄音自检清单逐条打勾；git add → commit → push（等用户验收确认后）
- 验收：用户验收满意后再推送

## 风险与依赖
- content_scripts 注入不改扩展 ID（ID 由加载路径决定）→ host 已注册免重跑（验证确认）
- 高亮定位在动态页面可能失效 → selector+quote 双兜底
- 快照体积 → 10MB 截断
- 图谱大规模节点 → SVG 静态渲染 + 缩放；超过 200 节点提示"仅显示前 200"
