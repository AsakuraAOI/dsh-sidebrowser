# DSH Sidebrowser

让 Agent 直接读取和操作 **DSH Desktop 官方侧边栏的同一个网页**。以 web-access 的观察、操作、验证流程为指导，基于 dsh-agent-browser 的侧边栏接入代码开发。无需外部 Chrome、扩展、后台代理或桌面安装包补丁。

包名：`dsh-sidebrowser`，版本：`0.2.1`。工具统一使用 `browser_*`。

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

- 针对 DSH Desktop `0.2.0-rc.2` / Cordis `4.0.4` 开发，真实 Electron 验证使用本机 `44.0.0`。
- 使用官方侧边栏现有 guest；继承其权限、下载、登录态分区及重启行为，不额外持久化 Cookie。
- Web profile 的跨域 iframe 只会被列出，不能读取和操作。
- 不提供跨域 iframe DOM、完整浏览器无障碍树、网络响应抓取或自动文件上传；坐标输入能交给浏览器命中，但不宣称已验证所有跨进程 frame。
- 仍通过参考项目采用的 Client Inspect 通道承载交互；其官方定位为只读，未来若强制限制需要迁移传输。
- 多窗口 Inspect 仍有广播和首个有效回答的上游限制；建议先在单窗口使用。用户与插件共享页面，用户接手后需重新观察。
- 超时只能结束等待，不能取消已经交给 Electron 的底层操作；超时后先查看状态，不自动重复提交。
- HTML 与 eval 属于显式原始读取，可能返回站点中的敏感字段。快照遮蔽常见凭据字段值，不是通用隐私过滤器。

## 开发及验证

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
