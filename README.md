# DSH Sidebrowser

让 Agent 直接读取和操作 **DSH Desktop 官方侧边栏的同一个网页**。以 web-access 的观察、操作、验证流程为指导，基于 dsh-agent-browser 的侧边栏接入代码开发。无需外部 Chrome、扩展、后台代理或桌面安装包补丁。

包名：`dsh-sidebrowser`，版本：`0.4.1`。普通工具使用 `browser_*`，开发诊断工具统一使用 `browser_dev_*`。旧的三个调试工具名已移除。

## 安装

```sh
dsh plugin --profile desktop add 'github:AsakuraAOI/dsh-sidebrowser'
```

安装后重启 DSH，让 Host 与 Client 同时加载插件。侧边栏浏览器使用桌面端的原生 guest；Web profile 的跨域 iframe 只能列出，不能操作。

请先停用其他注册相同 `browser_*` 工具的插件，避免同名工具冲突。本插件默认允许在目标网页内执行 JavaScript，可通过 `enableEval: false` 关闭。

## 开始使用

在当前对话右侧打开「浏览器」，手动登录后，在聊天中输入：

```text
/dsh-sidebrowser 读取当前侧边栏网页，先观察页面，再根据我的任务操作，每一步核对结果。
```

亦可直接要求 Agent 调用 `browser_tabs` 和 `browser_snapshot`。新建网页使用 `browser_navigate`。多个标签时明确 tabId。

## 看见 Agent 的操作

- Agent 第一次使用浏览器时，目标网页四周出现蓝色呼吸辉光；没有 Agent 标签、文字横条或提示气泡。
- 辉光属于整轮 Agent 运行状态：工具结束、思考或工具之间的间隔都不会关闭。通过 DSH 的 `api-session/status` 和会话状态同步确认运行结束、取消或停止后，再淡出并清理。
- 模拟光标跟随点击、输入等操作位置，点击有圆环反馈。光标按网页 CSS 坐标与实际显示比例换算，支持缩放后的侧边栏视口。
- 提示绘制在 DSH 界面层，始终允许鼠标事件穿透，不更改网页 DOM，也不会混入正文提取或网页截图。隐藏会话不会在另一页显示辉光。
- 尊重系统的减少动态效果设置；单次工具失败不会提前结束 Agent 的整轮提示。插件停用和会话移除会清理提示及监听器。

## 工具列表

| 工具 | 功能 |
| --- | --- |
| `browser_tabs` | 列出当前 DSH 会话所属标签、载体、加载和失败状态 |
| `browser_snapshot` | 组合正文、标题层级、链接、新元素引用、iframe 边界及能力状态 |
| `browser_read` | 定向读取文字、元素或 HTML |
| `browser_act` | click、type、press、scroll、select、reload、wait、click_xy |
| `browser_extract` | 按选择器提取 links、headings、tables、list 的有界 JSON |
| `browser_navigate` | 在所属会话创建页面，或导航已有标签 |
| `browser_screenshot` | 可视页截图，结果带真实视口尺寸；图片通过 DSH 附件服务交付。`preset` 只作用于本次截图，截完即还原，不改变标签的显示尺寸 |
| `browser_viewport` | 自适应、手机、平板、桌面和自定义视口 |
| `browser_close` | 关闭所属会话标签并核对已关闭 |
| `browser_eval` | 执行网页内 JS；支持 await Promise、明确返回截断信息 |
| `browser_dev_debug` | 启动、查询、清空或停止当前标签的调试采集，无需 DevTools 界面 |
| `browser_dev_console` | 原生日志文本、结构化参数、对象句柄展开、主文档异常和 Promise 拒绝 |
| `browser_dev_network` | Fetch/XHR、新建 WebSocket/SSE、Beacon 尝试、原生导航事件与资源计时；按 requestId 读详情 |
| `browser_dev_inspect` | 元素、父链、盒模型、计算/伪元素样式、遮挡及网页内外两层视口 |
| `browser_dev_styles` | 可读 CSSOM 匹配规则；临时样式补丁与保留冲突的恢复 |
| `browser_dev_performance` | 支持项检测、导航/资源计时、长任务、LCP/CLS/事件计时、帧间隔与可用堆汇总 |
| `browser_dev_storage` | 只读 LocalStorage、SessionStorage、IndexedDB 和 Cache Storage |
| `browser_dev_watch` | 指定元素的事件、DOM/尺寸变化；可选记录后续监听器登记调用 |
| `browser_dev_sources` | DOM 声明的脚本/样式源码；有权限时读取外部内容与 source map 声明 |

### 让 Agent 排查网页问题

让 Agent 在复现前调用 `browser_dev_debug`，随后照常操作同一个侧边栏网页，再读取 `browser_dev_console` 和 `browser_dev_network`。例如先启动正文采集：

```json
{"action":"start","captureBodies":true,"maxEntries":100}
```

`browser_dev_network` 不带 requestId 时列出请求；从结果复制完整 id，再传入 `requestId` 查看详情和最多 20 条连接消息预览。Console 可用 `level`、`source` 筛选，并用 `sinceId` / `nextSinceId` 分页。`source:structured` 返回包装后的参数，`source:native` 返回 Electron 文本；同一调用可能在两个来源中各出现一次。复制参数的 objectId 再调用同一工具即可按需展开对象；不会执行 getter，但 Proxy 反射陷阱可能运行。对象是有限保留的实时引用，不是日志时刻的深拷贝；导航、停止和淘汰后句柄失效。

调试完调用 `browser_dev_debug` 的 `stop`，恢复 Console/网络包装并丢弃历史；`clear` 清空并继续采集。性能、变化监听和样式补丁分别通过各自工具 stop/restore。它们独立于单次工具和 Agent 运行状态，直到明确停止、标签关闭、会话移除或插件卸载；记录只保留在内存中。调试记录每类默认 100 条、最多 200 条，Console 对象最多 200 个；样式补丁最多 20 个，watch 最多 10 个，其中监听器登记跟踪只能启用一个。溢出和输出截断会明确标记。

默认不采集网络正文/消息；开启后仅采集文本预览，每段最多 16 KiB，Fetch 响应读取最多等待 3 秒，不消费应用收到的原始 Response。WS/SSE 只覆盖探针启动后创建的连接，SSE 默认事件及随后登记/显式配置的命名事件可见，已存在的连接不可追回。Beacon 的 queued 只表示浏览器接受排队，不证明服务器收到了数据。网络中的常见敏感查询参数和 Authorization/Cookie 等头会遮蔽；正文、源码和日志仍可能包含业务数据。

排查布局时先 `browser_dev_inspect {selector:"目标选择器"}`：guest 内的 viewport 与宿主 hostViewport 分开报告，可区分网页响应式问题和外层缩放问题。`browser_dev_styles` 的 set 需要 CSS 属性/字符串值对象，返回 patchId；restore 按 patchId 恢复，仅还原未被后续独立修改的属性，其他属性列入 conflicts。可读 CSSOM 不等于完整层叠计算，跨域样式表可能不可读；以 inspect 的最终计算样式为准。

`browser_dev_performance` 返回实际支持项、可见性、采样区间和有界记录。观察到的最大交互耗时不是 INP，页面指标也不是 CPU profile/堆快照/完整 Trace。`browser_dev_storage` 不写入数据、不创建缺失数据库/缓存；缓存正文和源码默认预览最多 16 KiB，外部源码 get 会产生普通 GET，受页面权限和 CORS 约束。`browser_dev_watch` 不收集输入值；trackListeners 记录启动后的 add/remove 调用，不保证已有处理器或 once/AbortSignal 状态的完整清单。

这些能力不开放 CDP、断点、DevTools 窗口或调试端口，不修改桌面安装包。不能追回启动采集之前的日志和正文；刷新在 dom-ready 重新接入，早期脚本流量可能遗漏。Worker、跨域子框架、closed Shadow Root、低层协议帧、浏览器自动添加的头、完整重定向链不在覆盖范围。跨域正文、样式表、opaque 缓存仍受页面可见性限制。网页保留的旧引用可能绕过探针；工具报告 hooks 和失败原因。关闭 enableEval 仍可使用固定诊断工具，但它们也可能按明确参数改变临时样式或安装观察器。

`browser_act` 示例参数：

```json
{"action":"type","ref":"从刚才快照取得的完整ref","text":"Hello","inputMode":"auto"}
```

```json
{"action":"wait","selector":".result-list","state":"visible","timeoutMs":4000}
```

```json
{"action":"click_xy","x":200,"y":150,"inputMode":"native"}
```

### 原生输入与操作后观察

- auto 为默认：点击和按键优先使用 `sendInputEvent`，文本输入使用 `insertText` 和原生编辑命令；缺少能力或页面尚未绘制时明确返回 DOM 后端及回退原因。
- native 为严格模式，不会偷偷换成脚本点击；dom 为明确选择脚本后端。坐标点击仅支持 native。
- 原生鼠标/按键前进行有界的本地绘制检查；画面未就绪时不盲发事件。检查用的图片不发送给模型。
- 默认为每次动作附加一次新的 `observation`；读取失败会保留动作结果并附 `observationError`，不会重放写操作。
- `actionDispatched` 代表已派发；`verificationRequired` 提醒仍需核对页面/业务结果。不会把页面加载完毕当作任务完成。
- 新 snapshot 或 elements 读取会更换全部 ref；过期 ref、歧义选择器、遮挡或禁用控件会明确拒绝。输入结果不回显用户填写的文本。

### 提取范围

提取当前已渲染的主文档 DOM。表格返回行和单元格文本；列表、链接和标题也可限制数量与字符数。所有截断有标记。分页、未加载数据和虚拟列表之外的记录需要继续操作页面获取。

## 配置

安装后的 bundle 条目可以使用：

```yaml
- id: dsh-sidebrowser
  name: 'dsh-sidebrowser'
  config:
    enableEval: true
    observeAfterAction: true
    maxReadChars: 20000
    snapshotMaxChars: 8000
    screenshotMaxWidth: 1568
```

## 兼容性与边界

- 初始适配 DSH Desktop `0.2.0-rc.2` / Cordis `4.0.4`；当前本机安装版为 `0.2.1-rc.2`，真实 Electron 验证使用 `44.7.0`。
- 使用官方侧边栏现有 guest；继承其权限、下载、登录态分区及重启行为，不额外持久化 Cookie。
- Web profile 的跨域 iframe 只会被列出，不能读取和操作。
- 不提供跨域 iframe DOM、完整浏览器无障碍树、完整浏览器级网络抓取或自动文件上传；页面权限可读的响应预览由 browser_dev_network 提供。坐标输入能交给浏览器命中，但不宣称已验证所有跨进程 frame。
- 仍通过参考项目采用的 Client Inspect 通道承载交互；其官方定位为只读，未来若强制限制需要迁移传输。
- 多窗口 Inspect 仍有广播和首个有效回答的上游限制；建议先在单窗口使用。用户与插件共享页面，用户接手后需重新观察。
- 超时只能结束等待，不能取消已经交给 Electron 的底层操作；超时后先查看状态，不自动重复提交。
- HTML 与 eval 属于显式原始读取，可能返回站点中的敏感字段。快照遮蔽常见凭据字段值，不是通用隐私过滤器。

## 开发及验证

两组工具直接复用 `src/page-core.js` 的无状态函数：元素解析、可见性/禁用状态、敏感字段识别、矩形和尺寸、视口、目标点及命中检测、URL 脱敏与有界 Response 克隆读取。`browser_read`/`snapshot`/`extract`/`act`/`viewport` 与 `browser_dev_inspect`/网络/源码/缓存等在底层共享实现，没有嵌套调用公开工具。普通浏览不会因此开启诊断采集或创建诊断 store。

共享基础计算不改变各路径的策略：原生输入采用可见交集中心且拒绝遮挡，检查和光标反馈保留夹到视口内的元素中心；等待保留首个匹配的判断方式，动作和诊断要求唯一目标；诊断可以默认检查根元素，动作仍要求明确目标。正文读取共用克隆、字节上限、超时及取消清理；网络保留 3 秒预算，源码/缓存保留 1.5 秒预算，不消费应用原始响应。

```powershell
npm ci --legacy-peer-deps --ignore-scripts
npm run build
npm test
node scripts/check-installed-contracts.mjs
node scripts/electron-smoke.mjs
```

前两项为构建及 DOM/传输测试。contract 检查使用已安装 DSH 的真实 schema 和 lossless-JSON 校验器；Electron smoke 使用独立测试目录和隐藏窗口、临时回环网页，验证真实输入事件、提取及会话边界，不操作用户现有浏览器。

测试通过并不代表真实站点的登录、复杂控件或模型视觉路径均已验收。目标站点应继续做一次用户实测。

许可与来源见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
