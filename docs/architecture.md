# 架构

## 数据流

每个账号按七个阶段运行：认证、任务发现与初始快照、网页奖励、App 任务、搜索、汇总领取、最终只读复核。账号逐个执行，mutation 串行，只读发现可以有限并行。

数据源按字段供证：RSC 提供任务与 Server Action，Bing flyout 提供 Rewards 身份、余额和搜索 counter，App Dashboard 提供 App 任务。旧 `getuserinfo` 仅作低优先级兼容回退。

字段必须携带来源、可信度、观测时间以及 `valid`、`missing`、`invalid` 或 `unknown`。余额合并同时比较来源可信度与观测时间，禁止旧移动快照覆盖新的桌面结果。

## 任务模型

稳定任务键由账号、本地业务日期和源任务 ID 组成。标准任务注册表保存任务类型、来源、展示名、执行能力和状态；无法识别的任务以 `unknown` 展示并禁止自动执行。

mutation 状态至少包括 `discovered`、`running`、`submitted`、`verification-pending`、`completed`、`skipped` 和 `failed`。提交后网络结果不明时不得再次提交。

## 持久化

SQLite 事务统一提交运行、任务和积分历史。加密 Session 独立存放。Schema 升级前创建一致性备份，恢复在临时位置通过完整性与版本校验后原子替换。

## 运行状态

账号状态优先级为 `action-required`、`failed`、`partial`、`success`。只有所有可执行任务完成或明确跳过且最终余额确认后，账号才可成功。
