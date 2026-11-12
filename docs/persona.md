# persona

给 [pi coding agent](https://github.com/earendil-works/pi) 换常驻人设：**彻底替换** pi 默认的 `You are a coding assistant running inside pi…`，并把工具提示、guidelines、`APPEND_SYSTEM.md`、`AGENTS.md`、`SYSTEM.md`、skills、cwd **全部变成 jinja 模板变量**，由人设文件决定要不要、放哪里。

针对 pi v1.5.2 实现。

- 源码：[`extensions/persona/index.ts`](../extensions/persona/index.ts)（接线层：fs / pi API / 状态 / UI）
  + [`extensions/persona/core.ts`](../extensions/persona/core.ts)（纯核心：无 fs、无网络、**无 pi 依赖**）
- 测试：
  [`test/persona.core.test.ts`](../test/persona.core.test.ts)（tier 1，不装 pi 也能跑）·
  [`test/persona.golden.test.ts`](../test/persona.golden.test.ts)（tier 1.5，对拍录下来的 pi prompt）·
  [`test/persona.session.test.ts`](../test/persona.session.test.ts)（tier 2）·
  [`test/real/persona.real.test.ts`](../test/real/persona.real.test.ts) ·
  [`test/real/persona.drift.real.test.ts`](../test/real/persona.drift.real.test.ts)（tier 3，活体漂移）
- 出厂人设：[`personas/`](../personas)（`_` 开头的是 `include()` 片段，不是人设）

## 目录

- [persona](#persona)
  - [目录](#目录)
  - [安装](#安装)
  - [快速开始](#快速开始)
  - [两种模式](#两种模式)
  - [sections 详解](#sections-详解)
    - [preamble](#preamble)
    - [tools](#tools)
    - [rules](#rules)
    - [docs](#docs)
    - [addendum](#addendum)
    - [project\_context](#project_context)
    - [skills](#skills)
    - [cwd](#cwd)
    - [自定义段](#自定义段)
    - [sections 的合并语义](#sections-的合并语义)
  - [模板变量](#模板变量)
  - [front-matter](#front-matter)
  - [include](#include)
  - [搜索路径与优先级](#搜索路径与优先级)
  - [命名规则](#命名规则)
  - [环境变量](#环境变量)
  - [命令](#命令)
  - [状态与持久化](#状态与持久化)
  - [渲染失败时会发生什么](#渲染失败时会发生什么)
  - [分段 patch 与缓存](#分段-patch-与缓存)
  - [验证与排错](#验证与排错)
  - [已知限制](#已知限制)
  - [设计决策](#设计决策)

## 安装

```bash
cd pi-stuff && npm install
```

`~/.pi/agent/settings.json`：

```json
{ "packages": ["/absolute/path/to/pi-stuff"] }
```

local package 的相对路径从**声明它的 settings.json 所在目录**解析（即 `~/.pi/agent/`），不是你的项目目录，所以写绝对路径最稳。local package pi 不会自动装依赖，`npm install` 要自己跑。

项目级安装用 `pi install ./pi-stuff --local`（写入 `.pi/settings.json`，需项目 trust）。

## 快速开始

```bash
pi --persona reviewer        # 命令行指定
pi --persona off             # 本次进程用 pi 原生
pi                           # 沿用上次记住的人设
```

终端内：

```
/persona                     选择器（Tab 补全）
/persona reviewer            切换，下一个 run 生效
/persona reviewer new        切换 + 开新会话
/persona off                 交还 pi 原生 prompt
/persona default             用出厂复刻人设
/persona dirs                看搜索路径
/persona prompt              导出最近一次 run 的 system 角色全貌（需先发过一条消息）
/persona status              当前人设 / mode / on_error / 缓存 / 最近一次错误
/persona golden              重录 <tools>/<rules> 基线（升级 pi 后跑，见「验证与排错」）
```

footer 常驻显示 `persona: xxx`。

## 两种模式

| | `sections`（默认） | `bare` |
|---|---|---|
| 机制 | 人设 → `preamble`，其余各块 → 独立 section | 整段渲染 → `forceSystemPrompt` |
| pi 自动追加 | 全部关闭，**只剩 `<cwd>`** | 一个字都没有 |
| 分段 patch | ✅ 保留，切人设通常只 patch `preamble` | ❌ 整段投影到请求 |
| 排版自由 | 段顺序由 pi 决定（自定义段在 `<cwd>` 之后） | 完全自由 |
| 适用 | 绝大多数人设 | 极个别要绝对干净的 |

`bare` 旧名 `force` 仍可用。

**什么时候必须用 bare**：你连 `<cwd>` 都不想要。`buildSystemPromptSections()` 无条件写 cwd 段，sections 模式删不掉。

**标签谁来包**——最容易搞错的一点：

- `sections` 模式：section 的值**不要写 XML 标签**，pi 自动包 `<tools>…</tools>`。
- `bare` 模式：正文就是整个 prompt，标签**自己写**（用 `include('_tools.md')` 这类片段）。

## sections 详解

pi 的 system prompt 是**有序命名段**，除 `preamble` 外每段包在同名 XML 标签里。原生顺序：

```
preamble → [tools → rules → docs] → addendum → project_context → skills → cwd → 自定义段
```

方括号那三段**只在没有 customPrompt 时才生成**——这正是"换人设后工具提示消失"的原因，也是本扩展要把它们模板化的原因。

### preamble

- **内容**：人设正文。唯一**不带** XML 标签的段，永远排第一。
- **来源**：`customPrompt`（`--system-prompt` > 项目 `.pi/SYSTEM.md`（需 trust）> `~/.pi/agent/SYSTEM.md`），否则 pi 默认那句 `You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.`
- **本扩展**：sections 模式下 = 人设文件正文的渲染结果；bare 模式下并入整段。
- **注意**：不能作为自定义 section 名（pi 会抛 `Invalid system prompt section name`）。

### tools

- **内容**：`- 工具名: 一句话描述` 列表，末尾固定一句 `Additional tools may be available.`；没有可见工具时是 `(none)`。
- **来源**：**结构化渲染**，不是抽字符串。用 handler 时刻的 `toolSnippets`（只保留有 snippet 的）× 实时 loadout（`pi.getActiveTools()` 减去 `hiddenTools`）。所以 `--system-prompt` / `SYSTEM.md` 在场时它照样有内容——那三段 pi 自己不生成，但我们不依赖它的文本。
- **变量**：`{{ tools }}`（渲染好的正文）、`{{ tool_names }}`、`{{ tool_snippets }}`。
- **默认注入**：是。
- **注意**：这只是**给模型看的说明书**。真正的工具名/描述/参数 schema 走 API 的 `tools` 字段，删掉这一段模型照样知道有哪些工具。要真的减少工具，用 front-matter 的 `tools:` 或 `--tools`。

### rules

- **内容**：bullet 规则列表，按顺序合并并去重：
  1. 当有 bash/powershell 且没有 grep/find/ls 时，加一条"用 shell 做文件操作"（bash / PowerShell / 两者都有，三个分支文案跟 pi 一致）
  2. 每个已声明工具贡献的 `toolGuidelines`
  3. 顶层 `promptGuidelines`（**pi 1.5.2 不填这个字段，恒为空**；扩展的补充走 addendum）
  4. 固定两条：`Be concise in your responses`、`Show file paths clearly when working with files`
- **变量**：`{{ rules }}`、`{{ tool_guidelines }}`、`{{ prompt_guidelines }}`。
- **默认注入**：是。
- **注意**：和 `tools` 一样是**结构化拼装**，所以设了 customPrompt、pi 不生成 rules 段时，其它工具贡献的 guidelines 仍然会出现。想追加自己的规则，在 front-matter 里写 `rules: "{{ rules }}\n- 你的规则"`。

### docs

- **内容**：pi 自身 README / docs / examples 的绝对路径，以及"只在用户问 harness 本身时才读"的指引。
- **来源**：**抽取优先**。能从 `event.systemPrompt` 里抽到 pi 本轮的 `<docs>` 就用它（行锚定 + 必须唯一，抽不准就不抽，见下）；抽不到而 pi 本来会生成这个段时，用一份**手抄文案**（内容取自 pi 1.5.2，路径用 `getReadmePath()` / `getDocsPath()` / `getExamplesPath()` 现算）并告警；pi 本来就不生成（`SYSTEM.md` / `--system-prompt` 在场）时给**空串**。
- **变量**：`{{ docs }}`（按上面规则，可能为空）、`{{ pi_docs }}`（严格抽取，抽不到保留字面量 `{{ pi_docs }}`，让问题可见）。
- **默认注入**：**否**（多数项目用不到，白占 token）。`default.md` 显式加了它以求还原。
- **注意**：因为 `docs` 可能为空，**正文里自己包 XML 标签时必须 `{% if docs %}` 护住**（出厂片段 `_docs.md` 就是这么写的），否则会留下一个 `<docs></docs>` 空壳——pi 自己在那个场景下根本不写这个段。

### addendum

- **内容**：全局/项目补充指令，即你的"补充军令"。
- **来源**：`--append-system-prompt`（可重复）；**只要 CLI 传了该 flag，`APPEND_SYSTEM.md` 就完全不读**。否则读 `.pi/APPEND_SYSTEM.md`（需 trust）> `~/.pi/agent/APPEND_SYSTEM.md`，同名不合并。
- **变量**：`{{ append_system }}`。
- **默认注入**：是。
- **注意**：这是 pirate 明明没写占位符却还知道"回复用中文 / Conventional Commits / TDD"的原因。

### project_context

- **内容**：`Project-specific instructions and guidelines:` 开头，每个上下文文件包成 `<project_instructions path="…">…</project_instructions>`。
- **来源**：`AGENTS.md` / `CLAUDE.md`（含 `AGENTS.override.md`），从 agent 目录、cwd 及**所有父目录**发现；`AGENTS.override.md` 只替换同目录的 AGENTS.md/CLAUDE.md。**上下文文件发现不需要 project trust**，`-nc` 可关闭。
- **变量**：`{{ project_context }}`（渲染好的整块）、`{{ agents }}`（`[{path, content}]`，想自己排版用它）。
- **默认注入**：是。
- **注意**：不注入就等于项目规则失效。

### skills

- **内容**：技能清单（名称/描述/路径）。技能全文是模型按需用 read 读的，所以清单是入口。
- **来源**：已发现技能，且 `read` 或 `bash` 可用（都被隐藏但 indirect 可达时措辞会点名不具工具）。
- **变量**：`{{ skills_prompt }}`（pi 原生渲染，`formatSkillsForPrompt`）、`{{ skills }}`（`[{name, description, path}]`）。
- **默认注入**：是。
- **注意**：不注入等于对模型隐藏所有技能。

### cwd

- **内容**：工作目录（反斜杠已归一为 `/`）。
- **来源**：session 的 cwd，**无条件生成**。
- **变量**：`{{ cwd }}`。
- **能否去掉**：sections 模式**不能**；bare 模式不写就没有。
- **注意**：工具内部按 session cwd 解析路径，但模型不知道自己在哪儿就会瞎猜相对路径。**大多数人设应该保留它。**

### 自定义段

- 任意名字，匹配 `^[a-z][a-z0-9_-]*$`，不能叫 `preamble`。
- 在 front-matter 的 `sections:` 里声明，值本身是 jinja 模板。
- 渲染结果为空的段会被跳过（不会留空标签）。
- 位置：排在 pi 的 `<cwd>` **之后**。在意顺序就用 bare。

### sections 的合并语义

| front-matter | 效果 |
|---|---|
| 省略 | 用默认集：`tools` `rules` `addendum` `project_context` `skills` |
| 给对象 | 与默认集**合并**，同名覆盖 |
| 某 key 值为 `null` 或 `""` | **删除**该段 |
| `sections: null` | 一个都不要（只剩 preamble + cwd） |

## 模板变量

所有变量都预置了空值（`""` / `[]` / `{}`），`{% if %}` 判空安全。

| 变量 | 类型 | 说明 |
|---|---|---|
| `persona` | string | 当前人设名 |
| `cwd` | string | 工作目录 |
| `now` | string | ISO 时间戳（渲染时刻） |
| `platform` | string | `darwin` / `linux` / `win32` |
| `tools` | string | **始终由结构化数据渲染**（`toolSnippets` + 实时 loadout），不做字符串抽取 |
| `rules` | string | 同上：`toolGuidelines` + `promptGuidelines` + 固定两条 + 实时 loadout |
| `docs` | string | **抽取优先**：能抽到 pi 本轮的 `<docs>` 就用它；pi 本来会生成但抽不到 → 内置兜底文案并告警；pi 本来不生成 → 空串 |
| `pi_docs` | string | **严格抽取**：抽不到就保留字面量 `{{ pi_docs }}` 并告警，让问题可见 |
| `project_context` | string | project_context 段正文 |
| `skills_prompt` | string | skills 段正文 |
| `append_system` | string | APPEND_SYSTEM.md / `--append-system-prompt` |
| `system_md` | string | SYSTEM.md / `--system-prompt`（pi 解析结果） |
| `tool_names` | string[] | 已声明工具名 |
| `tool_snippets` | object | `{工具名: 一句话描述}` |
| `tool_guidelines` | object | `{工具名: string[]}` |
| `prompt_guidelines` | string[] | 顶层 `promptGuidelines`——**pi 1.5.2 恒为空**，别指望它有内容 |
| `agents` | array | `[{path, content}]` 上下文文件 |
| `skills` | array | `[{name, description, path}]` |
| `include` | function | 见下节 |

## front-matter

```yaml
---
mode: sections        # sections（默认）| bare（旧名 force）
on_error: last        # last（默认）| native —— 渲染失败时怎么办，见「渲染失败时会发生什么」
tools: [read, bash]   # 可选，本人设的工具集
sections:             # 可选，见合并语义
  rules: "{{ rules }}\n- 额外规则"
  docs: null
description: 一句话说明，切换时显示
---
```

`mode` / `on_error` 写错值（`mode: section`、`on_error: abort`）会**报错并 notify**，不会静默当成默认值。front-matter 用的是 core 自带的 YAML 子集（标量 / 引号转义 / 流程数组 / 块数组 / 嵌套映射 / 块标量 `|` `>`）；锚点、流式映射、多文档这类 YAML 特性会明确报错。详见 [core.ts](../extensions/persona/core.ts) 的注释。

`tools:` 通过 `systemPromptOptions.selectedTools` 生效，**同时**改 prompt  contributions 和真实 `tools` 字段。它是每个 run 强制覆盖，会跟 `tool_search` / codemode 的动态加载打架——用动态工具的人设别写它。渲染失败走 `on_error: last` 回退时**不会**把旧决策的 `tools:` 写回去，工具集永远取实时值。

## include

jinja 引擎（`@isdk/template-engines` 的 `HFTemplate`）**没有语句级 `{% include %}` / `{% extends %}`**（词法层就没有这些关键字），但支持自定义函数，所以本扩展注册了 `include()`：

```jinja
{{ include('_tools.md') }}
{{ include('_tone_cn.md', { extra_var: 1 }) }}
```

- 按[搜索路径](#搜索路径与优先级)查找，`.md` 后缀可省。
- 同步渲染，共享当前全部变量，第二个参数可覆盖/追加变量。
- 被引入文件的 front-matter 会被剥掉。
- 有环检测：`a → b → a` 抛错并 notify，该轮回退 pi 原生 prompt。
- `_` 开头的文件不出现在 `/persona` 选择器里，适合放片段。
- 若函数调用形式异常，可用过滤器形式 `{{ '_tools.md' | include }}`。

引擎支持的语法：`{{ }}`、`{% if/elif/else %}`、`{% for %}`、`{% set %}`、`{% macro %}`、过滤器（含 `tojson`）、`is` 测试。**不支持** `include` / `extends` / `import` / `block` 语句。

## 搜索路径与优先级

`/persona dirs` 会打印实际路径与是否存在。顺序（先命中者胜）：

1. `PI_PERSONAS_PATH`（`:` 分隔，可选）
2. `<cwd>/.pi/personas/`
3. `~/.pi/agent/personas/`
4. 包内 `extensions/persona/personas/`（预留，把片段跟人设放一起时用）
5. 包内 `personas/`

同名人设：项目覆盖全局，全局覆盖包自带。`include()` 走同一套顺序，所以片段也能被项目覆盖。

人设文件由扩展直接用 `fs` 读，**不走 pi 的资源发现，因此不受 project trust 门控**。`cd` 到别人的仓库时，`.pi/personas/` 里的内容会直接进你的 system prompt——不可信项目里别随手切人设。（放在 `.pi/extensions/` 的扩展文件本身仍受 trust 约束。）

## 命名规则

人设名就是一个不带目录的文件名（`<name>.md`）。**拒绝**：空、`..`、`/`、`\`、`:`、控制字符、首尾点号、超过 64 字符。保留名（大小写不敏感）：`off` `dirs` `prompt` `status` `golden`。中文名可用。

- 输入可以带 `.md`，会自动剥掉（`/persona pirate.md` 等价于 `/persona pirate`）。
- `include()` 用同一套校验，所以片段也不能越出搜索目录、不能叫保留名。
- 名字**区分大小写**；macOS / Windows 文件系统不区分。跨平台协作建议统一小写文件名。
- `_` 开头的文件只在 `include()` 里用得到，不进 `/persona` 选择器与补全。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_PERSONA` | 人设名。空串 / 全空白 = 未设置；`off`（大小写不敏感）= 显式关闭 |
| `PI_PERSONAS_PATH` | `:` 分隔的额外搜索目录，**排在所有目录之前** |
| `PI_CODING_AGENT_DIR` | pi 自己的 agent 目录（`personas/` 与 `personas/current` 都落在它下面） |

优先级：`--persona` > `PI_PERSONA` > 会话条目 > `personas/current`。

**注意**：env 压过会话条目，所以在设了 `PI_PERSONA` 的 shell 里 resume 旧会话，会覆盖那个会话原本的人设；env 也会渗进该 shell 里所有 pi 子进程（比如测试启的真 pi 进程）。想临时试一下，用 `PI_PERSONA=x pi` 而不是 `export`。

## 命令

| 命令 | 说明 |
|---|---|
| `pi --persona <name>` | 启动时指定，优先级最高 |
| `pi --persona off` | 本次进程用 pi 原生 prompt |
| `/persona` | 选择器 |
| `/persona <name>` | 切换，下一个 run 生效 |
| `/persona <name> new` | 切换 + 开新会话（内部 `ctx.newSession()`） |
| `/persona off` | 交还 pi 原生 |
| `/persona dirs` | 打印搜索路径 |
| `/persona prompt` | 写两个文件到 `~/.pi/agent/personas/`：`.rendered.txt` = **逐字**的 system 角本文本；`.effective.txt` = 同一份文本 + 这次 run 真的声明给模型的工具（描述 + 参数摘要）+ 被切掉的工具名。本会话还没跑过 run 时拒绝导出，`/new` 后快照失效 |
| `/persona status` | 当前人设及来源（flag / env / 会话条目 / 文件）、mode、`on_error`、缓存、最近一次错误原文与时间 |
| `/persona golden` | 在**当前会话**里录一份 `<tools>`/`<rules>` 基线到 `test/fixtures/pi-sections.json`（升级 pi 后校准用） |

**为什么不是 `/new <人设>`**：`/new` 是内置命令且不接受参数（`BUILTIN_SLASH_COMMANDS` 里没有 `argumentHint`），扩展注册同名命令会触发 pi 的冲突告警并在自动补全里被跳过。所以用 `/persona <name> new`。

## 状态与持久化

优先级：`--persona` > `PI_PERSONA` > 会话内记录 > `~/.pi/agent/personas/current` 文件 > 不干预。`/persona status` 会打印这次到底是哪个来源定的。

- 每次切换写一条 `custom` 会话条目（`customType: "persona"`，**不进 LLM 上下文**），resume 时还原。
- 同时写 `personas/current` 文件，跨进程记忆；`/new` 之后仍然保留。
- **没选 persona 时扩展完全不干预**，`SYSTEM.md` / `--system-prompt` / `APPEND_SYSTEM.md` 照常生效。
- `/persona prompt` 导出的 `personas/.rendered.txt` 与 `personas/.effective.txt` 是**诊断产物**，每次写都覆写，不是状态。
- 改 `.md` 立即生效（每个 run 重新读文件）；改 `.ts` 需要 `/reload`。

## 渲染失败时会发生什么

模板报错、`include()` 找不到片段、front-matter 写错、人设文件被删——都是同一个姿态：

- 默认 `on_error: last`：复用**同一人设**上一次成功渲染的结果（preamble + sections），行为连续。若该人设从未成功过（比如刚切过去就写错了），降级为 pi 原生 prompt。**回退只复用 prompt 文本，不复用旧决策的 `selectedTools`**——旧决策可能来自另一个工具集，写回去会把中途新开的工具又关掉。
- `on_error: native`：总是直接降级为 pi 原生 prompt。
- 两种情况都会 notify（带错误原文），footer 标成 `persona: xxx (ERROR)`，`/persona status` 可查最近一次错误原文与时间。
- 回退是**进程内**的：重启 pi 后缓存是空的，第一次渲染失败就是原生 prompt。

**没有 `abort`**：`before_agent_start` 的返回值只有 `message` / `systemPrompt`，不支持取消；handler 抛错 pi 也只是记录到 `extension_error` 然后继续。真要硬阻断，得把渲染提前到 `input` 事件（那里能 `{ handled: true }` 拦下输入），但那个事件里没有 `systemPromptOptions`，是另一套设计，本扩展不做。所以写错 front-matter 只会看到报错通知 + 回退，不会看到 run 被拒。

## 分段 patch 与缓存

pi 不把 prompt 当一坨字符串存：首次请求落一条 system 消息带**全部** sections + `toolsAdded`；之后每次用 `diffSystemPromptSections()` 只把**变化的段**写进一条新 system 消息，删除的段写 `null`。重放所有 system 消息即还原当前 prompt。

```json
{"message":{"role":"system","content":"","sections":{"preamble":"You are a coding assistant…","tools":"<tools>…</tools>","cwd":"<cwd>~/proj</cwd>"},"toolsAdded":[{"name":"read"}]}}
… /persona reviewer …
{"message":{"role":"system","content":"","sections":{"preamble":"You are a senior code reviewer…"}}}
```

支持会话中途 system 消息的 provider 就地收到这一小段补丁，**缓存前缀不动**；不支持的收到重放后的完整 prompt，在该次变更 miss 一次。

`bare` 模式：forced text 被**投影到请求**上，变化时整段重发。**注意它不是"每轮都 miss"**——文本不变时前缀一致，缓存照常命中。

## 验证与排错

**不要问模型"你的 system prompt 是什么"**，它会复述、改写、编造。

1. `/persona prompt` → 两个文件：`~/.pi/agent/personas/.rendered.txt` 是逐字的 system 角本文本（直接 diff / 录 golden 用），`.effective.txt` 额外列出这次 run **真的声明给模型的工具**（描述 + 参数摘要）和被切掉的工具名——bare 模式没有 `<tools>` 段，工具信息只在这一条通道上，所以想知道模型被告知了什么，看 `.effective.txt`。（切了人设但还没跑，两份都还是**上一个** run 的——notify 会说清。）
2. `/persona dirs` → 确认人设文件被扫到。
3. 看请求 payload：临时加一个 `pi.on("before_provider_request", …)` 打印，或用本地 logging 代理 + `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`。
4. `/persona status` → 看当前人设、来源、mode/on_error、缓存和**最近一次错误原文**（渲染失败不会静默，但通知会过，status 里能回查）。

**与 pi 的漂移：`<tools>` / `<rules>` 是我们自己拼的，不是抄的。** pi 生成这两段的规则（有 snippet 才列、bash/PowerShell/搜索工具三条规则分支、固定两条）写在 `buildSystemPromptSections()` 里，而那个函数**不在 pi 的公开导出里**，抄一份无法编译期发现漂移。所以拿两层测试钉住：

| 测试 | 做什么 | 什么时候红 |
|---|---|---|
| `test/persona.golden.test.ts` | 比对 `test/fixtures/pi-sections.json`（一次真实 pi run 录的 facts + pi 原文）与 core 的渲染 | pi 升级后改了这两段的组成；或 fixture 的 piVersion 与 `devDependencies` 钉的版本不一致 |
| `test/real/persona.drift.real.test.ts` | 真 pi 进程里，在 handler 里把 loadout 改成 7 种变体（含 PowerShell / 两个 shell / 无 shell / 无工具 / 隐藏 grep），逐个比 pi 渲染 vs core 渲染 | 同上，而且**每个分支都覆盖**（一份 fixture 盖不住） |

**pi 升级后的校准流程**：先改 `package.json` 的 `devDependencies` + CI 的 pi pin → `npm install` → 跑 `npm run test:all`，看红的是哪段 → 在升级后的 pi 里执行 `/persona golden` 重录基线（前提：没有 `SYSTEM.md` / `--system-prompt`，否则 pi 压根不生成那两段）→ 按差异改 `core.ts` 的 `renderTools` / `renderRules` → 测试转绿后提交新 fixture。fixture 是**必需文件**：缺了它是红，不是跳过。

`/persona golden` 在开发 checkout 里直接写回 `test/fixtures/pi-sections.json`；从**已安装的包**里跑时写到 `~/.pi/agent/personas/pi-sections.json`（不往安装目录造文件），再手动复制回仓库。它录的是**当前会话**刚跑过的那个 run（`/new` 会清掉），所以先随便发一条消息。

`docs` 不在比对范围：它是抽取优先，本来就允许跟 pi 文案有出入，兜底文案漂移无关痛痒。

**⚠️ 不要用 session JSONL 的 sections 判断 bare 模式是否生效。** pi 源码明确：*"A forced prompt does not affect the transcript: the structured sections are still diffed and persisted, and the forced text is projected onto the request."* 所以 bare 模式下 JSONL 里照样有结构化 sections，它们描述的不是模型实际收到的东西。sections 模式看 JSONL 才是准的。

| 症状 | 原因 |
|---|---|
| `No such persona: x` | 人设不在搜索路径里，`/persona dirs` 看 |
| 切了人设但行为没变 | 人设是下一个 **run** 生效，发条消息试试；或看有没有 render error 通知 |
| 模板/front-matter 报错后行为回退 | 设计如此：`on_error: last` 复用同人设上一次成功结果，没得复用就原生。错误原文在通知和 `/persona status` 里 |
| 每次渲染都报 `on_error must be last \| native` | 写了 `abort` 之类的值。pi 的 `before_agent_start` 不能取消 run，所以没这个选项 |
| 海盗还是知道工具 | 工具走 API `tools` 字段，用 front-matter `tools:` 或 `--tools` |
| 海盗还是知道军令/cwd | 用了 sections 模式且没删对应段；要全干净用 `mode: bare` |
| `--persona` 没反应 | `pi -ne` 禁用了扩展；该 flag 由扩展注册，见 `pi --help` 的 Extension CLI Flags |

## 已知限制

1. **工具 schema 管不到**。prompt 模板无法隐藏 `tools` 字段里的工具。
2. **sections 模式删不掉 `<cwd>`**。
3. **每个 run 渲染一次**。`before_agent_start` 每个 run 触发一次，run 内多轮工具调用不会重渲染模板。
4. **`{{ tools }}` 对 `hiddenTools` 可能滞后**。工具名取的是 handler 时刻的 `pi.getActiveTools()`（跟 `--tools` / front-matter `tools:` / 其它扩展的收窄同步），但 pi 在**所有 handler 之后**才覆写 `options.hiddenTools`，所以 codemode `only` 模式或 `tool_search` 在同一轮里动态改声明时，人设里的工具清单可能与该次请求的真实声明不一致。这类场景建议不注入 `tools` 段。
5. **jinja 子集**。无 `include`/`extends`/`import`/`block` 语句（用 `include()` 函数替代）。
6. **只支持 jinja**。其它引擎（golang / f-string / env）没有扩展函数机制，`include()` 无法实现。
7. **front-matter 是 YAML 子集**。core 自带一个极小解析器（标量 / 引号转义 / 流程数组 / 块数组 / 嵌套映射 / 块标量 `|` `>`），为的是不依赖未声明的传递依赖。锚点、别名、流式映射、多文档会**明确报错**，不会静默解析成错的值。需要那些写法就把它们放进正文而不是 front-matter。
8. **`last` 回退不跳进程**。缓存是进程内的，重启后首次渲染失败就是 pi 原生 prompt。
9. **sections 名受 pi 约束**。自定义段名必须匹配 `/^[a-z][a-z0-9_-]*$/`，且 `preamble` 保留；写错会在切换时报错，不是静默丢掉。
10. **其它扩展的 section 会被保留**。注入默认段时会把 `options.sections` 里已有的同名段交回给那个扩展（merge，不是 overwrite），但**同名段只有一个**——两个扩展都想叫 `rules` 时仍是后者胜出，这是 pi 的数据结构，不是本扩展能修的。
11. **`/persona prompt` 报告的是过去，不是将来**。它导出的是 `turn_end` / `agent_end` 拍的快照。刚切人设还没跑，导出的仍是上一个 run 的 prompt；`/new` 会清掉快照。
12. **`.effective.txt` 里的参数是摘要，不是 schema 原文**。`parameters: path*: string, tags: string[]` 这种写法是为了可读；嵌套对象只写 `object`，`enum` 列值。要逐字的 tool 定义就得抓 `before_provider_request` 的 payload。工具名与描述取的是 `getActiveTools()` / `getAllTools()`，所以第 4 条的 `hiddenTools` 滞后在这里同样适用。

## 设计决策

- **为什么 `/persona prompt` 用快照而不是 `ctx.getSystemPrompt()`**：pi 只把 `before_agent_start` 的修改存在 run 作用域里（`_runSystemPromptOptions`，注释写着 "for the active run"，run 的 `finally` 里清成 `undefined`），而 `getSystemPrompt()` 是**现渲染**：`buildSystemPrompt(_runSystemPromptOptions ?? _baseSystemPromptOptions)`。斜杠命令必在 idle 时执行，所以命令里拿到的一律是 base options 的渲染 = pi 原生 prompt。于是只能在 run 里抓：`turn_end` / `agent_end` 抓的是 pi **定稿 `selectedTools` / `hiddenTools` 之后**的渲染，比 handler 时刻更接近模型真看到的。不取 `lastRendered`：那是我们自己设的 `customPrompt`，pi 还会在后面追加 `<cwd>` 等段，不是完整 prompt。
- **为什么 `.effective.txt` 要把工具声明一并导出**：system 角色不等于 system 文本。front-matter 的 `tools:` 走 `systemPromptOptions.selectedTools`，改的是**请求里的工具声明**；transcript 里那一条是 `{role:"system", content, toolsAdded:[…]}`，bare 模式下 `_installAgentForcedPromptProjection` 把 forced text 投影到这条 head 上、`toolsAdded` 原样带走。所以 `mode: bare` 的人设看起来“什么都没带”，其实模型拿到了整套工具 schema（真 pi 进程实测：`pirate` 的 system 文本 124 字，同一请求里声明了 4 个工具）。`.rendered.txt` 保持逐字不变（能 diff、能录 golden），多出来的视图另写一份。
- **为什么 `/persona prompt` 不自动发一条探针消息**：`pi.sendUserMessage()` 能做到，但那是一次真 run——花 provider 调用、往 transcript 里塞一条会被 pirate 认真回答的 "hi"、还得 `waitForIdle()`。而且信息量并不增加（任何 run 都会抓快照），失败时反而更糟：探针那轮如果渲染失败，快照就是回退后的原生 prompt，会被当成"生效 prompt"导出。也没有免模型的路子：`buildSystemPrompt` 不在包导出里，而 pi 的 `exports` 只允许 `.` 和 `./rpc-entry`（`ERR_PACKAGE_PATH_NOT_EXPORTED`），自己拼段就是再抄一遍 pi 的拼装规则。所以冷启动直接拒绝：“先发一条消息再试”。

- **为什么直接用 `HFTemplate` 而不是 `StringTemplate`**：后者是异步统一层，且默认 `expandValue: true` 会把注入值里的 `{{ }}` 当模板**二次渲染**（AGENTS.md、pi 文档里很容易出现），默认 `tagFinalString: true` 还可能返回 boxed `String`。直接用 `HFTemplate` 同步渲染，这三个问题一次消失。将来要加多引擎，再换 `StringTemplate.format` 并显式设 `expandValue: false, tagFinalString: false`。
- **为什么 sections 是默认**：保留 pi 的分段增量补丁，切人设通常只 patch `preamble`，缓存友好。
- **为什么 `include()` 而不是 `base` 继承**：组合比继承直观，且能带参数、能走优先级查找。
- **为什么要一个不带 pi 依赖的 `core.ts`**：`PromptFacts` 是本扩展自己的**窄 DTO**（只挑 `toolSnippets` / `toolGuidelines` / `toolNames` / `customPrompt` / cwd 等真正用得上的字段），不是 `BuildSystemPromptOptions` 的镜像。好处：tier 1 测试不装 pi 也能跑；pi 改签名时只有接线层碎；golden 测试能直接拿录下来的 facts 喂 core。pi 类型的转换全部关在 `index.ts` 的 `facts()` 里。
- **为什么 core 自带 YAML 子集而不依赖 `yaml`**：`yaml` 当时只是从 pi 依赖里白嫖来的传递依赖，`package.json` 里没有它——哪天 pi 换了依赖就碎。手写一个故意很窄的子集，并且**写不通就报错**（而不是默默解析成错值），比拼一个隐式依赖更可控。
- **为什么没有 `on_error: abort`**：pi 的 `BeforeAgentStartEventResult` 只有 `message` / `systemPrompt`，没有取消语义；handler 抛错也只是 `extension_error`，run 照旧。提供一个做不到的选项比不提供更坑。
- **为什么 `tools` / `rules` 是结构化渲染而不是抽字符串**：抽字符串在 `SYSTEM.md` / `--system-prompt` 在场时直接没有源（pi 不生成那三段），而 `toolSnippets` / `toolGuidelines` / `getActiveTools()` 这些结构化数据一直都在。代价是抄了 pi 的拼装规则，靠 golden + 活体 drift 测试兜漂移（见「验证与排错」）。
- **为什么 `docs` 不永远兜底**：`customPrompt` 在场时 pi 本来就没有 `<docs>` 段，无脑填一份文案会凭空造出一个 pi 没有的段。所以只在"pi 本来会生成但抽取失败"时兜底，其余情况给空串，并把严格抽取的版本另存为 `{{ pi_docs }}`。
- **为什么 fail-safe**：模板写错不该让你没法工作——默认复用同一人设上一次成功的渲染，没得复用才退回 pi 原生 prompt，两者都 notify。