# @deepseek-ai/dsh-skill-agent-vault

[English](README.md) | 中文

八个渐进加载的方法论 Skill 指导 Agent 完成定位、短期记忆即时写入、有界批次整理、长期记忆治理、双速召回、稳定结构化自我成长、能力学习与测试以及自然资源表达。Provider 不调用模型，也不依赖 embedding。

## 模型体验

发现阶段只进入 Skill 摘要；Agent 或用户选中后才加载完整工作流正文。

#### KV 缓存影响

稳定目录影响前缀；工作流正文与数据无关，并且仅在调用时出现。

## 已知限制与待完成工作

- 特定专业领域的课程仍属于 Agent 自己的能力方法卡，不进入平台 Skill。
