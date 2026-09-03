# Agent Note: Web 后台任务的 pid 与人类停止

Status: implemented

[English](2026-09-03-web-background-job-pid-and-human-stop.md) | 中文

## 问题

[Web 后台任务展示](2026-08-08-web-background-job-display.zh.md)交付了一份人类能看不能操作的列表：会话头部显示本会话拥有的后台任务，而唯一的停止路径是模型的 `job_kill` 工具。盯着一条失控命令或卡死的构建的人，只能往 composer 里打一条指令，等模型把它翻译成工具调用。

同一份列表也说不出一行活跃任务对应哪个 OS 进程。subprocess 服务派生所有这些任务、按进程树根终止，但行上没有任何进程身份，拿任务列表去和任务管理器或 `ps` 输出对照时无物可对照。

展示笔记刻意推迟了停止动词：`kill()` 会把终态投递标为 `reported`，从而抑制 `dsh-tool-jobs` 的完成通告；照当前契约写出来的人类中断会让模型一直以为它的任务还在跑。本笔记解决这个决策。

## 决策

进程身份走既有的任务数据通道；停止动词是一个新的会话级 RPC，其宿主命令负责告知模型。

### 进程身份：从 `ShellProcess.pid` 到行

`SubprocessHandle.pid` 是被派生的树根——subprocess 服务终止动词所针对的身份——spawn 本身失败时为 `-1`。[`LocalBashExecutor`](../../../../packages/shell/bash-local/src/index.ts) 与 [`PwshLocalExecutor`](../../../../packages/shell/pwsh-local/src/index.ts) 把它发布为 `ShellProcess.pid`，spawn 失败时缺省，于是执行器 seam 的句柄携带与其 `kill()` 所终止的同一身份。

shell 工具把这个事实转发给它注册的 job：

```ts ignore-check
...proc.pid === undefined ? {} : { meta: { pid: proc.pid } }
```

`JobHooks` 为此增加一个开放字段：

```ts ignore-check
/**
 * JSON-safe producer facts captured at start, e.g. the spawned process's
 * tree-root pid. The registry copies them into every snapshot of the job;
 * the producer must not mutate the record after supplying it.
 */
meta?: Readonly<Record<string, JsonValue>>
```

`LocalJobRegistry` 存储该记录并把它复制进每个快照——每次快照一份新拷贝，仅在提供时存在——Session Controller 的 `jobView` 再把它投影到线路的 `SessionJob.meta`。该字段刻意是开放的 JSON 安全映射而非带类型的 `pid`：注册表不知道 pid 是什么，通道两种做法代价相同，一个生产者事实不值得换来一套封闭的线路词汇。

[ui-jobs](../../../../packages/client/ui-jobs/README.zh.md) 行只在活跃行把 `meta.pid` 渲染成 `#<pid>` 片，提示词由 locale 拥有（`Process {pid}` / `进程 {pid}`）。终态行即便快照仍携带 meta 也不渲染片；`pid` 非数字时什么都不渲染。

片是数据而非控制：停止按钮寻址的是 job id，没有任何路径把 pid 送去 kill。pid 被回收也不会误杀别的进程，因为没有任何路径读取它来做终止。

### 停止动词：`session.killJob`

Session Controller 在 `cancel` 之侧增加一个一元操作：

```ts ignore-check
killJob(request: SessionJobKillRequest): SessionJobKillValue
// SessionJobKillRequest { sessionId: SessionId; jobId: JobId }
// SessionJobKillValue   { result: 'requested' | 'already-finished' }
```

宿主命令解析会话的活体 `Agent`（未附加时 `session/not-found`），读 `ctx.get('jobs')`——组合未挂载注册表时给出点名缺失 `@deepseek-ai/dsh-jobs` 插件的 `gateway/internal`，因为它是可选 peer——然后调用 `jobs.kill(jobId, agent, 'stopped by the user')`。所有权由注册表自己的会话 id 检查围栏，跨会话 kill 得到注册表的 `job … belongs to another session` 错误，网关把它映射为 `gateway/internal`。与 `cancel` 不同，该命令没有 subagent 护栏：subagent 会话的活体子 agent 对其拥有的 job 就是合法调用方。

对已终态 job 的 kill 回答 `already-finished`，不投递任何东西。

### 模型通告

`kill()` 把记录标为 `reported`——[后台任务运行时](../architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)的抑制位——于是 `dsh-tool-jobs` 本应投递的完成通告被抑制。停止仍然到达模型，并以用户行为为框架：命令往拥有者 inbox 追加一条插件来源的 `form: 'notice'` 用户消息，投递条款是[完成唤醒决策](2026-08-11-background-job-completion-wakes-an-idle-owner.zh.md)给 tool-jobs 完成通告的那一套——空闲的拥有者被唤醒（`followup`），繁忙的拥有者在下一个步边界收到（`inject`）。

tool-jobs 对唤醒设预算，这里的唤醒无条件。预算是因为完成通告成批到达；人类停止是罕见的刻意行为，而未被认领的通告其失败模式正是被推迟的决策所点名的那个——模型一直以为任务还在跑。

消息点名该 job、其 kind 与 label、用户停止了它，并指向 `job_output`：

> background job bash-3 (bash: sleep 60) was stopped by the user. Read its output with job_output.

其 source summary 为 `<kind> <label> stopped by the user`。

该消息按所有会话内通告共用的机制满足 model-visible ⟺ logged：agent loop 在消费 inbox 消息的步边界把它接纳为 `user/message` 会话事件，于是日志在任何模型请求之前已携带它。不需要新的会话事件类型。停止的其余状态——job 以 `killed` 终态结算——是注册表状态，与所有 job 记录一样进程局部，拥有者通过 `job_output` 的状态行观察它。

### 客户端侧

ui-jobs 条目带一个注入面注册：

```ts ignore-check
killJob(jobId: string): Promise<RemoteResult<{ result: 'requested' | 'already-finished' }>>
```

apply 经 `ctx.sessions` 接线：注入的回调解析被寻址会话的 binding 并调用会话面的 `killJob`。停止失败经会话的 `promptError` 发布；行本身无需错误状态，因为任何已请求的 kill 都会得到注册表的 `stopping` 帧，生产者结算时得到 `killed` 帧。

活跃行渲染一个方形停止按钮，可访问名与提示词由 locale 拥有（`Stop job` / `停止任务`），行处于 `stopping` 或未注入回调时禁用。终态行不渲染按钮。

客户端 `Session` 面的 `killJob` 通过无 cordis 依赖的 `@deepseek-ai/dsh-jobs/brand` 叶子为其参数加品牌——与 `SessionJob` 线路类型既有的安排相同——于是 tsdown 客户端门禁的 `INLINE_SAFE` 清单恰好放行该锚定说明符，裸 `dsh-jobs` 根仍被拒绝（它达到 `dsh-agent`）。

## 备选方案

**让 tool-jobs 的完成通告捎带停止。** 用户 kill 不标 `reported`，让注册表结算投递普通的完成通告。因框架与时间被拒：通告措辞是结算（`killed`、信号细节）而非用户行为，且它在生产者的 `done` 结算后由结算监听器触发——存在一个窗口，模型可能对人类已停止的 job 继续行动。命令同时拥有框架与投递条款。

**为停止设专门的会话日志事件。** model-visible ⟺ logged 可被读作要求新事件类型。通告的 `user/message` 接纳已按所有会话内通告共用的载体把模型可见输入记入日志；第二个事件会对同一事实双录。

**把停止路由到 `cancel`。** `cancel` 中止会话的活跃回合——[composer 的停止按钮](../bug-fix/2026-07-31-web-stop-preserves-queue.zh.md)拥有那个控制；job 活过该回合，因为 job 属于 subprocess 服务而非回合。两个控制针对不同资源，互不共享。

**浏览器可达的注册表。** 浏览器没有 `ctx.jobs`，给它一个会把 job 所有权授权搬进新表面。所有 job 控制都经会话面过线，与 `cancel` 相同。

**读取 job 输出的停止流程。** web 路径从不调用 `ctx.jobs.read()`——展示笔记把该不变式钉死，因为单一输出游标属于模型。

## 测试

[`session-killjob.host.spec.ts`](../../../../packages/api/session-controller/tests/session-killjob.host.spec.ts) 在组合注册表上钉住宿主命令：空闲唤醒与繁忙步注入各携带确切的通告文本与 source；已终态的 kill 回答 `already-finished` 而无通告无 cancel；跨会话 kill 映射到注册表围栏错误；幽灵会话回答 `session/not-found`；未挂载注册表的组合响亮失败且消息中点名插件。

[`control-jobs.host.spec.ts`](../../../../packages/api/session-controller/tests/control-jobs.host.spec.ts) 钉住线路投影：以 `meta: { pid: 4321 }` 生产的行把 meta 带进帧，内部注册表字段仍被丢弃。

[`jobs-local`](../../../../packages/jobs/jobs-local/tests/jobs.spec.ts) 规格钉住拷贝语义：每个快照得到 meta 记录自己的拷贝，被改动的第一份快照从不渗入后续读取，缺省保持缺省。

执行器规格钉住身份来源：`ShellProcess.pid` 是被派生 shell 自己的 `$$` / `$PID`，spawn 失败不发布 pid。工具规格钉住交接：后台 `bash`/`pwsh` 注册携带 `meta.pid`，无 pid 的进程句柄完全不注册 `meta`。

ui-jobs 套件钉住呈现（活跃行带 locale 提示词的片；终态、缺失、非数字 pid 时抑制；按钮点击路由、stopping 中与无回调时禁用、终态行缺席）与 apply 侧路由（有 binding 的会话路由到会话面，无 binding 时是 no-op，拒绝由既定的 `promptError` 发布吞掉）。

无 key 的 [web e2e 场景](../../../../apps/web/tests/background-job-list.e2e.ts) 渲染新行：其 golden 携带 `{{pid}}` 脱敏的片与停止按钮。脱敏限定在该场景区域内——同样的 `#<digits>` 形态在别的 web golden 中是稳定的请求计数器，不得全局 token 化。

## 后果

**每一次人类停止都是一次模型可见的唤醒或注入。** 模型空闲时被停止 job 的会话，多付一次本来不会花的模型请求。接受：替代方案是模型永远不知道停止，且 tool-jobs 已对完成通告接受同样代价。

**`reported` 是整个设计的枢纽。** 若 kill 通告被丢弃，不存在其他报告者——模型对停止的唯一记录就是那条消息。killjob 规格同时断言通告与 `reported` 结算，于是该耦合响亮失败。

**线路的 `meta` 是开放通道。** 任何生产者都可声明任意 JSON 安全事实，每个消费者都会看到。pid 片是第一个读者；该字段的契约是生产者拥有的事实，不是进程身份。生产者在提供后改动其记录即违约，而每次快照的新拷贝正是阻止该违约静默扩散的机制。

**`stopping` 变成人类可停留的状态。** 该注册表转移原本为模型的 `job_kill` 存在；按钮的 stopping 中禁用状态意味着 UI 现在完整停留在 TERM-to-KILL 宽限期内——Windows 上即时，POSIX 上为宽限窗口。

**brand 叶子进入客户端内联集。** `INLINE_SAFE` 放行 `@deepseek-ai/dsh-jobs/brand$` 且仅此；根仍被拒绝。
