# dsh-subagent-fleet

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**子智能体委派**提供模型队列、自动故障转移与实时用量遥测。

[English](README.md) · **简体中文**

子智能体是 DSH 里最能干活的部分，也是最不透明的那部分：它跑在哪个模型上、花了多少、额度耗尽之后会怎样——三件事你都看不见。这个插件逐一解决它们。

---

## 致谢

**这个插件之所以存在，是因为 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。**

它接入了十三个账号渠道——CodeBuddy、WorkBuddy、CodeArts、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax、ZCode、Gemini、LobsterAI，以及匿名免费通道——提供了几十个真正可用的模型。没有这份供给，就没有什么值得做负载均衡。

而「一个模型额度耗尽就导致子智能体整轮失败」这个问题，也只有在**路由足够多**的时候才会真正显现。dsh-our-free-model 把供给做大了，dsh-subagent-fleet 让需求侧扛得住。

感谢那个项目及其维护者。

---

## 它做什么

### 一、有优先级的模型队列，以及真正的故障转移

为子智能体挑选模型、拖动排序，之后每个子智能体沿队列依次使用：从第一个开始，只有当**这个模型的额度确实耗尽**时，才切到下一个——**同一个子智能体**继续跑，上下文、已完成的工具调用、已推进的进度全部保留。

会触发切换的失败：额度耗尽（`QUOTA_EXCEEDED`）、限流（`RATE_LIMIT`、HTTP 429）、鉴权失效（`AUTH`、`MISSING_CREDENTIAL`、401/402/403）、渠道排队（`QUEUE`）、超时。

队列**只前进、不回绕**，所以两个都坏掉的渠道无法把子智能体在彼此之间来回弹。每个子智能体各自维护队内位置，并发的多个子智能体不会抢占彼此的位置。

### 二、输入框旁的实时条带

一个紧凑的胶囊按钮：

```
⧉ 2/21  deepseek-v4.1-flash · buddy   ↑13.09M ↓2.09M
```

展开后一子一行，运行中的排在最前并渲染为深蓝色：

```
● 模拟器素材上公平跑分  运行中   deepseek-v4.1-flash · buddy
  515K (↑421K ↓94K)   226 tok/s   命中 97%   缓存 13.57M
```

- **`515K (↑421K ↓94K)`** —— 总 token，括号内是输入/输出拆分。总量**不含缓存读**：缓存读往往占九成以上，算进去会把真实花费淹没掉。
- **`226 tok/s`** —— 解码速度，不是墙钟速度。墙钟会把排队和工具执行时间算进去，让不同模型无法横向比较。
- **`命中 97%`** —— 输入中由提示缓存提供的比例。
- **`缓存 13.57M`** —— 缓存读取的原始体量，仅作参考。

已结束的子智能体**数字不会消失**：条带从宿主的投影检查点读取，所以离开内存的子智能体仍然报告它花了多少。

### 三、与实时目录保持一致，但不替你改主意

插件让子智能体的可用模型清单等于宿主真正能调用的路由，但**绝不添加你没有勾选的模型**——它只剔除已经没有渠道提供的条目，避免某个渠道下线后留下死路由。

---

## 安装

```bash
dsh plugin install /path/to/dsh-subagent-fleet
```

或用 `plugin_manager` 指向该目录。bundle patch 挂载一个 Host 行；浏览器半身由 `dsh.client` 声明。

安装后请**新建会话**。委派工具在会话组合时读取策略，已存在的会话会沿用当初构建时的参数。

---

## 配置

编辑 profile 的 `cordis.patch.yml` 中插入的那一行。**一行的 `config` 会整体替换，不是合并**，所以要保留的键必须全部重述。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `expand` | `false` | `false` 只剔除死路由；`true` 镜像整个实时目录（会破坏手工精选） |
| `includeProviders` | `[]` | 只从这些 provider 读取模型 |
| `excludeProviders` | `[]` | 永不读取这些 provider |
| `maxRoutes` | `400` | 白名单上限 |
| `providerTimeoutMs` | `8000` | 单个 provider 目录读取预算 |
| `debounceMs` | `1200` | 合并拓扑事件抖动 |
| `minPassIntervalMs` | `15000` | 两次扫描之间的最小间隔 |
| `retryDelaysMs` | `[0, 2000, 6000]` | 启动期设置行就绪前的重试节奏 |
| `respectSettingsEnabled` | `true` | 尊重设置页里的显式关闭 |
| `rotation` | `true` | 自动故障转移 |
| `defaultRoute` | `first` | `first` / `last` / `inherit` |
| `defaultRouteProvider` | `spawn` | 调整哪个委派 provider 的子会话默认路由 |
| `reportPath` | `''` | 可选的每轮 JSON 状态文件 |

---

## 实现要点

| 关注点 | 机制 |
|---|---|
| 子会话默认路由 | `spawn` provider 上的 `SubagentProvider.agentRouteDefaults` |
| 故障转移 | `agent/request-error` 返回 `{kind:'retry'}`；`agent/request` 改写路由 |
| 路由来源 | `llm.listProviders()` + `llm.listModels()` |
| 子会话消耗 | `tokenUsage` 投影；冷会话读检查点文件 |
| 缓存命中 | `cacheRead / (cacheRead + uncachedInput)` |
| 速度 | `decodeTokens / decodeMs` |
| 面板 | `conversation.input.right` 槽位 → `/api/subagent-queue/*` |

只对 `origin === 'subagent'` 的 Agent 生效，主 Agent 保持自己的模型选择。

---

## 测试

```bash
npm test
```

`rotation.test.mjs` 覆盖队列游标与失败分类；`selftest.mjs` 用假上下文驱动协调器，覆盖幂等性、精选清单保护、死路由剔除和 HMR 事务守卫。

---

## 已知边界

- **仅对新会话生效。** 委派工具在组合期安装参数集，所以队列改动只影响其后创建的会话。
- **所有路由都耗尽时子智能体仍会失败。** 区别在于它先把选中的路由全部试过一遍，并在日志里记下完整尝试链。
- **只覆盖直接子智能体。** 孙智能体不在范围内，它们属于子会话自己的 `subagentCatalog`。
- 条带在有子智能体运行时每 2 秒轮询一次，全部结束后退到 60 秒。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
