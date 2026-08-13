# 平安好车主 Loon 签到与积分插件

这是一个面向 iOS Loon 的平安好车主原请求抓取与安全重放插件，包含：

- 被动保存平安好车主 App 自己发出的完整请求模板；
- 可配置 cron 时间，重放仍在设定有效期内的签到首页与任务列表请求；
- 模板过期时在联网前停止，避免重复发送已知会失败的请求；
- 不推算、生成、刷新或改写 App 的认证字段，也不改写任务 ID。

## 已核对的接口

基于 Pixel 9 Pro XL 上平安好车主 `6.03.1` 的当前 WebView 资源确认：

- 签到首页：`/micro-api/activity-sign/gw/signCall/mainv1`
- 签到：`/micro-api/activity-sign/gw/signCall/toSign`，前端参数为 `{ "oilFlag": 1 }`
- 任务列表：`/micro-api/activity-points-zone/gw/taskCall/taskMine`，前端参数包含城市
- 完成任务：`/micro-api/activity-points-zone/gw/taskCall/finish`，参数为 `task_id`
- 领取奖励：`/micro-api/activity-points-zone/gw/taskCall/reward`，参数为 `task_id`
- 批量领奖：`/micro-api/activity-points-zone/gw/taskCall/rewardBatch`，参数为 `taskIds`

## 安装与首次抓取

插件订阅地址：

```text
https://raw.githubusercontent.com/XXJJz/loon-pingan-carowner/main/PingAnCarOwner.plugin
```

插件图标取自 Apple App Store 当前 `6.03.1` 版平安好车主的官方应用图标，并托管在本仓库，供 Loon 的 `#!icon` 元数据加载。

1. 在 Loon 的“插件”页面点击右上角 `+`，粘贴上面的订阅地址并保存。插件会自动从本仓库加载脚本，无需单独导入 JavaScript。
2. 在 Loon 中生成并信任 MITM 证书，确认插件已启用。
3. 打开平安好车主 App，进入“签到领积分”页面；如果当天未签到，手动签到一次。
4. 进入“任务中心”，等待任务列表出现，再点一次“换一批”。
5. Loon 应分别通知抓到 `mainv1`、`toSign`、`taskMine` 或 `refreshRecommend`。通知只报告字段是否存在，不显示真实 Token。
6. 在插件参数中设置 cron 和模板有效秒数。有效秒数建议保持 30–120 秒。

## 重要限制

平安好车主 App 的请求包含短时认证信息，并可能把请求体封装为 `m_content_data` / `m_content_type`。因此：

- “已抓取”不代表模板可以长期使用；
- `v1.0.6` 只会原样重放，不再尝试明文 Token 或任何推算模型；
- 超过 `maxReplayAge` 后脚本会明确报告模板过期，并且不发起该请求；
- 当前安全模式可以验证签到首页和读取任务列表，但无法保证跨天自动签到；
- 自动完成任务和自动领奖需要生成与新任务 ID 对应的新认证请求，当前安全模式不会执行。

首次部署后建议把 cron 临时设为未来 30–90 秒，进行一次真实验收。只有通知中明确出现“原请求重放成功/今天已签到”和任务列表数量，才算通过。

## 查看运行结果

Loon 的脚本详情页只显示脚本通过 `console.log` 输出的内容，本地通知不会自动出现在该日志里。当前版本会在日志中显示：

- 是否进入定时任务模式；
- 是否已抓到原请求；
- 每个模板的秒级年龄以及是否仍可重放；
- 每个接口是否执行了原请求重放；
- HTTP 状态、业务码和最终汇总。
- 已保存请求体的字段名称（不显示字段值）。

日志不会打印 Cookie、Token 或完整响应。如果日志提示“未找到原请求模板”，必须在安装 Loon 的同一台 iPhone 上打开平安好车主签到页和任务中心；电脑连接的 Pixel 不能把登录状态自动传给 iPhone Loon。

更新插件后，日志第一行应包含当前脚本版本。若仍显示旧版日志，请在 Loon 中手动更新插件订阅后再运行。

## 隐私

Cookie、Token 和请求模板只写入 Loon 的 `$persistentStore`，脚本不会上传到第三方。不要把 Loon 脚本存储、调试日志或抓包记录公开分享。
