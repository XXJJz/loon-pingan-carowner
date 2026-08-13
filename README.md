# 平安好车主 Loon 签到与积分插件

这是一个面向 iOS Loon 的平安好车主签到与积分任务插件，包含：

- 自动抓取平安好车主相关请求中的 Cookie、Token、AopsID、SpartaID 与原请求模板；
- 可配置 cron 时间执行每日签到；
- 获取任务中心列表并领取已完成任务的积分；
- 可选尝试完成标题明确属于“浏览、查看、阅读、访问、逛一逛”的低风险任务；
- 默认排除购买、投保、支付、下单、充值、邀请、绑定、上传、评论、分享等任务。

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

1. 在 Loon 的“插件”页面点击右上角 `+`，粘贴上面的订阅地址并保存。插件会自动从本仓库加载脚本，无需单独导入 JavaScript。
2. 在 Loon 中生成并信任 MITM 证书，确认插件已启用。
3. 打开平安好车主 App，进入“签到领积分”页面；如果当天未签到，手动签到一次。
4. 进入“任务中心”，等待任务列表出现，再点一次“换一批”。
5. Loon 应分别通知抓到 `mainv1`、`toSign`、`taskMine` 或 `refreshRecommend`。通知只报告字段是否存在，不显示真实 Token。
6. 在插件参数中设置城市和 cron，例如每天 09:10 使用 `10 9 * * *`。

## 重要限制

平安好车主 App 会在原生层调用 `signHeaders` 动态生成签名头，并可能把 JSON 加密成 `m_content_data` / `m_content_type`。因此：

- “已抓到 Token”不代表定时请求一定能绕过动态签名校验；
- 脚本会先尝试 `secret_token` 明文模式；
- 若失败，只对签到首页、签到、任务列表这些请求尝试原请求降级重放；
- 原请求签名过期时，脚本会明确通知失败，不会把失败报告成成功；
- 动态任务 ID 不会使用旧加密请求强行重放。

首次部署后建议把 cron 临时设为未来 2–3 分钟，进行一次真实验收。只有通知中明确出现“签到成功/今天已签到”和任务列表数量，才算通过。

## 隐私

Cookie、Token 和请求模板只写入 Loon 的 `$persistentStore`，脚本不会上传到第三方。不要把 Loon 脚本存储、调试日志或抓包记录公开分享。
