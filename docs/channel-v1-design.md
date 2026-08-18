# Channel-v1 第一轮设计与实现记录

## 目标

本轮把“发送前检查”提升为 broker 强制的本机逻辑信道层，解决同一目录多个 Pi 会话/任务之间的误投问题，同时保留现有 `intercom` 工具的调用形状。

## 已确定的语义

- 一条会话消息只有一个收件人；没有广播或多收件人事务。
- 首次发送先把目标解析为精确 `sessionId`，再执行 `channel_open`。
- `channel_open` 在 broker 内创建或复用一条 sender/target pair channel。
- `memberId` 是信道内稳定身份；`sessionId` 只是当前运行端点。
- 显式 agent 名称保留；未命名成员按加入成功顺序生成 `执行者-1`、`执行者-2`……，序号不回收。
- 默认信道为 `ephemeral`，空闲 TTL 到期；重新打开仍复用活动信道。`reusable` 可通过 `IntercomClient.openChannel()` 使用。
- broker 重启后只恢复 channel membership；当前 mailbox、message receipt route 与幂等记录不持久化，重启可能丢弃离线队列，也不会保留旧 broker 的 messageId 知识。单个 broker 生命周期内重连要使用相同稳定 `sessionId`，同名新会话不继承旧成员。
- 发送失败不自动无限重试。结果区分 `socket_delivered`、`queued`、`failed`；超时返回 `E_DELIVERY_TIMEOUT_UNKNOWN`，模型应先检查状态再决定是否用原 `messageId` 补发。
- 相同 `(channelId, fromMemberId, messageId)` 与相同 authored payload 幂等；内容/收件人改变返回 `E_MESSAGE_ID_REUSE`。

## 交付边界

```text
resolve target -> channel_open/reuse -> channel_send -> broker authorization -> socket/mailbox
```

broker 在实际投递前检查：

1. channel 存在且 epoch 为当前值；
2. sender member 与当前连接的 sessionId、bindingEpoch 对应；
3. target member 属于同一 channel，且目标 binding 未变化；
4. `replyTo`、`supersedes` 与原消息路由一致；
5. 单收件人投递。

旧 wire `send` 仅接受精确 session ID，并在 broker 内升级为 channel 投递；名称/前缀不会在旧路径上直接路由。

## 项目静态策略

`.pi/intercom-channel.json` 是可选的项目级 ACL。成员默认必须带稳定 `id`（session ID），按精确 ID 匹配；`name` 是信道逻辑身份。旧配置若明确写入 `allowNameOnly: true` 才启用较弱的在线同名匹配；`intended` 参数用于验证声明的身份是否绑定到同一 ID。该文件是客户端策略护栏，不取代 broker channel authorization。

## 第一轮非目标

- 真实 LAN TCP/UDP、TLS、跨机认证、分布式 broker/HA；
- 广播、群发事务、exactly-once 承诺；
- 无限自动重试和无界离线队列；
- 跨 broker 重启的完整消息日志/重放。

底层仍使用现有本机 Unix socket/pipe。TCP-like/UDP-like 应作为后续应用层 delivery mode：前者增加有序流、ACK window、backpressure 和 durable replay，后者保持单 datagram、尽力而为且不排队；两者都不能改变明确收件人约束。

## 源码基线

- upstream：`https://github.com/nicobailon/pi-intercom.git`
- 本地工作树基线：`d69854df09afcb1eab1329dddf35548d455b0c55`（`main`）
- 本机安装产物：npm `pi-intercom@0.10.1`；其 `gitHead` 为 `30dcbdd134e3b3236e50e02c31d25093360fe3fc`，与当前 main 不应混同。
- 本轮修改在独立工作树 `/Users/xbpd/Projects/pi-intercom`，不是 npm 安装目录。

## 后续迭代入口

1. 将 channel message record 与 bounded mailbox 一起做原子持久化/恢复；
2. 增加显式 channel listing/status 和 `channel_join`，再评估多成员信道；
3. 如确有需要，增加 client-side `sendMany`，每个目标独立 messageId/状态；
4. 增加 binding rebind、broker crash、queue full、stale epoch 的故障注入测试；
5. 以 upstream `main` 为基线生成独立 PR，不再直接修改 npm 安装产物。
