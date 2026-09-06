# 官方知识本机协调器

`official-knowledge-coordinator.mjs` 默认运行影子模式。它校验当前 `published/manifest.json` 与归档 SHA-256，写入被 Git 忽略的 `临时文件/automation/` 状态和历史；不会联网刷新、发布或读取真实 Meta/Shopify 账户和经营数据。

## 已验证行为

- 独占锁：已有 `collector.lock` 时跳过；不会自动删除过期或畸形锁，避免并发时误启动第二个进程；
- 锁冲突只记录最小诊断信息（可解析性、年龄、启动时间、PID、模式），不回显锁文件任意内容；
- 本机 `run-history.ndjson` 原子保留最近 336 条（约 7 天、每 30 分钟一次），避免长期运行无限增长；
- 校验最后合格公开包的 Manifest 和归档 SHA-256；
- 记录 source floor 与可用官方来源数量；
- 成功校验后写入 `nextEligibleAt`；30 分钟窗口内再次触发会记录 `skipped_not_due`，不重复读取公开包；
- `active` 模式在创建运行目录、写日志、读取状态、尝试加锁或校验公开包前即显式阻止并返回非零退出码，防止未经影子观察直接联网刷新。

## 手动影子运行

```text
npm run automation:shadow
```

## 公开官方资料自动刷新

```text
npm run automation:public
```

该模式只刷新白名单中的 Meta、Facebook、Instagram 和 Shopify 官方公开资料，随后发布并校验公开知识包；单轮最长 55 分钟，遇到 401、403、429、登录页或异常正文时保留最后一次合格资料而不绕过限制。不读取真实账户、广告、客户、订单、Cookie、Token 或任何经营数据。私密 `active` 模式仍被显式阻止。

## 48 小时影子观察

```text
npm run automation:shadow-status
```

该命令只读取本机状态与历史，输出影子观察时长、合格运行次数、异常状态数和当前安全标志。通过 48 小时及 96 次合格运行不等于可以启用主动模式；来源分层、回归测试、恢复点和单独审批仍缺一不可。

## 任务计划脚本

`install-shadow-tasks.ps1` 创建当前 Windows 用户的交互式 30 分钟影子校验任务；`-Remove` 删除任务。它不提升权限，也不执行公开刷新。

当前自动注册曾被系统以 `Access is denied` 拒绝，因此必须由拥有任务计划权限的本机用户在 PowerShell 中执行。不要通过提权或修改目录 ACL 绕过该限制。

## 启用真实刷新前的硬条件

1. 完成至少 48 小时影子观察；
2. 来源分层（B0/B1/B2/B3）进入注册表并有测试；
3. 失败保留最后合格正文、确定性发布和 Manifest 校验持续通过；
4. 真实刷新改动单独审核与回滚。
