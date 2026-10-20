# WebMarker 功能扩展 · 需求规格（spec.md）

> EARS 格式：`THE SYSTEM SHALL`（无条件）/ `WHEN...THE SYSTEM SHALL`（事件）/ `WHILE...THE SYSTEM SHALL`（状态）/ `IF...THEN...SHALL`（异常防御）/ `WHERE...THE SYSTEM SHALL`（可选）
> 范围：P0 三项（文本多色高亮、暗黑模式、时钟小组件）+ P1 五项（会话保存、Markdown/HTML 导出、标签关系图谱、网页快照存档、划词右键快速标注）
> 用户硬约束（不可违反）：数据一律本地 SQLite 存储、不引入账号体系；换浏览器数据不丢；扩展 ID/注册逻辑遵循玄音铁律；每次改动三副本同步。

---

## P0-1 文本多色高亮（对标 Glasp / Diigo / Liner）

- THE SYSTEM SHALL 允许用户在任意可标注网页上用鼠标选中文本。
- WHEN 用户在网页选中文本 THE SYSTEM SHALL 在选区旁显示浮动工具条，提供颜色选择（黄/绿/蓝/红/紫）与"添加备注"入口。
- WHEN 用户选择颜色 THE SYSTEM SHALL 将选中文本包裹为高亮标记（`<mark class="wm-hl wm-hl-<color>">`），并立即持久化到本地数据库。
- WHEN 页面加载完成且当前 URL 存在已保存高亮 THE SYSTEM SHALL 还原全部高亮标记，保持可见与可交互。
- WHEN 用户点击某条已存在的高亮 THE SYSTEM SHALL 显示小工具条，允许删除该高亮或修改其颜色/备注。
- WHEN 用户删除高亮 THE SYSTEM SHALL 从页面移除标记并从数据库删除该条记录。
- IF 本地程序未初始化或未连接 THEN 高亮保存/删除操作 SHALL 弹出"本地服务未连接"提示且不改变页面。
- WHEN 管理面板展示某 URL 的详情 THE SYSTEM SHALL 列出该 URL 的高亮条目（引用文本、颜色、备注、时间）。
- WHEN 用户点击高亮列表条目 THE SYSTEM SHALL 在新标签页打开对应 URL 并滚动到该高亮所在位置。
- WHERE 页面为受限页（chrome://、edge://、about: 等）THEN 本功能 SHALL 不注入、不显示工具条。

## P0-2 暗黑模式（对标 Dark Reader / TheTab.Ninja）

- THE SYSTEM SHALL 提供主题三态：跟随系统 / 亮色 / 暗黑（复用 host 既有 `themeMode` 配置 0/1/2）。
- WHEN 用户在管理面板或新标签页切换主题 THE SYSTEM SHALL 将选择持久化（写入 host config）并即时生效。
- WHEN 主题为暗黑 THE SYSTEM SHALL 管理面板与新标签页的界面配色切换为暗黑变量集，保证可读性。
- IF 浏览器系统主题变化且当前为"跟随系统" THEN 界面 SHALL 自动跟随。

## P0-3 时钟小组件（对标 Momentum）

- WHERE 新标签页启用时钟 THE SYSTEM SHALL 在页面顶部显示当前时间（时:分:秒）。
- WHEN 用户点击时钟 THE SYSTEM SHALL 在 12 小时制与 24 小时制之间切换。
- WHEN 用户切换制式 THE SYSTEM SHALL 持久化该选择（本地存储），下次打开沿用。

---

## P1-1 会话保存（对标 OneTab / Session Buddy）

- THE SYSTEM SHALL 允许用户将当前浏览器窗口的全部标签页保存为一个"会话"。
- WHEN 用户保存会话 THE SYSTEM SHALL 记录每个标签的 URL、标题与排列顺序，并为会话命名（默认取保存时间）。
- WHEN 用户查看会话列表 THE SYSTEM SHALL 显示会话名、标签数量与保存时间。
- WHEN 用户展开某会话 THE SYSTEM SHALL 显示其中每个标签条目（标题 + URL）。
- WHEN 用户恢复某会话 THE SYSTEM SHALL 按保存顺序在新标签页中打开全部 URL。
- WHEN 用户删除会话 THE SYSTEM SHALL 删除该会话及其全部条目；不影响标注与高亮数据。
- WHEN 用户删除会话中单条标签项 THE SYSTEM SHALL 仅删除该项，其余项保留（单条粒度）。
- IF 当前窗口无任何标签页（仅剩一个空白页或全部为受限页）THEN 保存操作 SHALL 拒绝并提示"没有可保存的标签页"。
- IF 会话名为空 THEN 保存操作 SHALL 使用默认名称（当前时间）。

## P1-2 Markdown / HTML 导出（对标 Web Highlights / Glasp）

- THE SYSTEM SHALL 支持将全部标注导出为 Markdown 文本。
- THE SYSTEM SHALL 支持将全部标注（含高亮引用）导出为独立 HTML 文件。
- WHERE 某 URL 存在高亮 THE SYSTEM SHALL 在导出内容中附含高亮引用文本与颜色标注。
- WHEN 导出 THE SYSTEM SHALL 返回完整文本内容与条目计数，由扩展端触发下载。
- IF 无任何标注数据 THEN 导出 SHALL 返回空内容提示"暂无数据可导出"。

## P1-3 标签关系图谱（对标 Glasp Atomic Graph / TheTab.Ninja Canvas）

- THE SYSTEM SHALL 提供标签关系图谱视图：节点为标签，边为两标签在同一页面上共现（同标注）。
- WHEN 用户打开图谱视图 THE SYSTEM SHALL 从本地库读取全部标签及其共现关系并绘制。
- IF 标签数量少于 2 THEN 图谱视图 SHALL 显示空状态提示"至少需要 2 个标签才能生成图谱"。
- WHEN 用户点击图谱中的标签节点 THE SYSTEM SHALL 跳转到该标签的网页筛选列表。
- WHERE 图谱节点数超过阈值 THE SYSTEM SHALL 提供缩放/拖动浏览（静态可读为首要）。

## P1-4 网页快照存档（对标 Diigo 链接失效保护）

- THE SYSTEM SHALL 允许用户为当前页面保存 HTML 快照到本地数据库。
- WHEN 用户保存快照 THE SYSTEM SHALL 存储页面 HTML 全文、标题、URL 与保存时间。
- WHEN 用户查看快照列表 THE SYSTEM SHALL 显示 URL、标题与保存时间。
- WHEN 用户打开某快照 THE SYSTEM SHALL 在新标签页展示保存时的页面内容（只读）。
- WHEN 用户删除快照 THE SYSTEM SHALL 删除该条快照记录，不影响标注与高亮。
- IF 页面为受限页或快照内容为空 THEN 保存操作 SHALL 拒绝并提示原因。
- IF 快照内容体积超过单条阈值（如 10MB）THEN 保存 SHALL 截断存储并提示"页面过大，已截断保存"。

## P1-5 划词右键快速标注（对标 Todoist / Diigo）

- WHEN 用户在网页选中文本并点击右键 THE SYSTEM SHALL 在右键菜单提供"添加为页签标注"项。
- WHEN 用户点击该菜单项 THE SYSTEM SHALL 打开标注编辑面板，并自动将选中文本带入备注（作为引用原文）。
- IF 本地程序未连接 THEN 菜单点击 SHALL 提示"本地服务未连接"。
- WHERE 页面为受限页 THEN 右键菜单 SHALL 不显示该入口。
