# Windows 消息通知（DSH 插件）

DSH 需要提权、等待你授权，或一轮任务正常结束时，弹出一条 Windows 通知（显示为 **DeepSeek Harness**）。
只有 **DSH 不是当前前台程序** 时才弹：你正盯着 DSH 界面时不打扰。
插件只做转发：不参与授权决策，不改变审批结果，也不做其它任何事情。

## 触发条件

| 触发 | 来源 | 标题 |
| --- | --- | --- |
| 有操作请求授权 | `approval/request`（兜底 `approval/asked`） | `DSH 需要提权` |
| 一轮任务正常结束 | `session/event` 的 `turn/end`，且 `reason.kind === 'completed'` | `DSH 任务完成` |

- 只有主会话才会提示任务完成；子代理（`header.parentSession` / `origin: 'subagent'`）的会话不提示。
- `turn/end` 的原因不是 `completed`（中止、报错、被拦截、超长截断等）时不提示，也不把中止说成“完成”。
- 前台抑制对两类通知都生效：前台窗口标题包含 `DeepSeek Harness` 时直接跳过，判定逻辑在 `foreground.ps1`。

## 实现

- 常驻一个 PowerShell 通知宿主，插件激活即预热；之后每条通知只写一行 JSON。
- PowerShell 侧先读前台窗口标题判断是否前台（Win32 `GetForegroundWindow` + `GetWindowText`），需要真正弹窗时才加载 WinRT Toast API。
- 弹窗延迟：预热后约 5–10ms；进程被回收/被杀时退化为一次性弹窗并退避重启宿主。
- 通知标签：授权 `dshApproval`、完成 `dshTaskDone`，同组 `dshNotify`；同类通知互相替换，不同类各自保留一条。

## 文案

- 授权正文优先用 DSH 自己的 `displayReason`（优先中文），其次 `reason`；都没有时显示 `<工具名> 正在请求你的授权`。
- 完成正文为 `「<会话标题>」已完成`，没有标题时显示 `当前会话的这一轮任务已完成`。
- 正文最多 220 字符，超出截断。

## 环境要求

- Windows 10/11，系统通知未关闭。
- `powershell.exe`（Windows 自带）。
- 通知宿主以 `com.deepseek.dsh`（DSH 桌面端的 AppUserModelID）发布，所以通知卡片显示为 DeepSeek Harness。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：事件监听 + 通知通道（常驻进程、失败退避重启、一次性兜底） |
| `notify-host.ps1` | 纯 ASCII 的 PowerShell 通知宿主，从 stdin 逐行读取 JSON，按需弹 Toast |
| `foreground.ps1` | 前台窗口标题匹配（判断 DSH 是不是当前主程序） |
| `cordis.patch.yml` | 插入 `windows-approval-notify` 行 |
| `locale/{en,zh}.json` | 插件管理器的标题/描述 |
| `icon.svg` | 插件图标 |

## 安装

把本仓库克隆（或解压发布包）到任意目录，在 DSH 里执行：

```text
plugin_manager install_bundle target = <本目录的绝对路径>
```

例如：

```text
plugin_manager install_bundle target = G:\DS-test\plugins\dsh-windows-approval-notify
```

安装后插件行立即生效，无需重启 DSH。卸载：

```text
plugin_manager remove_bundle target = @local/dsh-windows-approval-notify
```

## License

MIT，见 [LICENSE](LICENSE)。
