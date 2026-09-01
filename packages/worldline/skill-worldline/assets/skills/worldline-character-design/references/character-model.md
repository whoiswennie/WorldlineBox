# 可执行角色模型

角色正文负责可读设定，紧随正文的 `worldline-facets` 注释负责把作者明确给出的初始状态和记忆投射到运行时。不要手写运行时实体 ID；编译器会根据文档稳定 ID 生成。

```markdown
# 勇士艾琳

她以守护村庄为目标，知道龙巢入口的位置，但不知道恶龙守护龙卵的秘密。

<!-- worldline-facets {"initialState":{"locationId":"map-node:dragon-lair","stamina":5,"wounds":0},"memory":{"goals":["守护村庄"],"beliefs":{"龙巢入口":{"value":"已发现","confidence":1}},"episodic":["接受村民委托并抵达龙巢"]}} -->
```

至少检查：稳定身份、初始位置、可见属性、私有知识、库存或资源、关系边、目标、控制模式、允许动作、动作参数、前置条件、持续时间、成本、效果、失败语义和来源。`initialState.locationId` 必须指向地图中真实存在的节点。自然语言特征只有在作者明确授权时才映射成数值或规则。
