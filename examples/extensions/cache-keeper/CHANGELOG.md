# Changelog

## 0.2.0

读引擎报的账号额度(listAgents 的 rateLimit):快满或用完就一直停到重置时刻,重置后自己把报错停下的会话错开续上。

## 0.1.1

ping 和续上不再往你和 agent 的私聊里写一行:改用 `gugu.send`,后台页不在任何 chat 里,就是会话直投(和 agent 的 `session_message` 同一条路)。会话改按 `user:<uuid>` 认,升级前勾上的开关要重新勾一次。

## 0.1.0

首次发布。
