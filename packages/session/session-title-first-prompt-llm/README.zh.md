# @deepseek-ai/dsh-session-title-first-prompt-llm

[English](README.md) | 中文

根据第一条人类 Prompt 生成 Session 标题的 Cordis Provider 插件。

## 模型体验

### 首条 Prompt 标题请求

#### 模型看到什么

辅助标题模型只接收 `first-prompt` Provider 选择的第一条已记录人类消息，并由 `session-title-llm` 添加框架。

#### Token 影响

一次自动辅助请求会消耗共享的标题系统指令、JSON 包装的首条消息，以及不超过 `maxOutputTokens` 的输出。

#### KV Cache 影响

标题生成使用独立请求；稳定的系统前缀可能跨 Session 复用，JSON 包装的首条消息则随 Session 改变。

## 已知限制与延后工作

- **仅限第一条消息**——后续人类上下文无法改进自动生成的标题；多消息标题需要其他 Provider。
- **需要已配置路由**——没有显式 Provider/Model 配对且来源请求没有已记录路由时，生成失败。
