# 机制闭包检查表

每个动作应能回答：谁可做、何时可做、参数是否合法、会占用什么、何时完成、成功与失败产生什么事件、如何观察、并发时谁先、等待多久算异常、如何恢复、恢复是否确定、如何追溯作者来源。缺一项就应产生诊断、问题或 Proposal，而非默默采用默认常识。

`mechanisms/*.md` 只用自然语言解释规则、代价和玩家可理解的结果。旧的 `worldline-action` Markdown 代码块不得使用。可运行规则通过 `worldline_edit set-runtime` 写入该文档对应的隐藏运行模型；修订前必须先用 `worldline_query runtime` 读取目标文档以保留未改字段。下面对象直接放进 `runtime` 参数的 actions、systems、invariants 数组，不要 stringify，绝不能复制进 Markdown。

作用域必须与初始状态完全对齐：

- 动作中的 `state.foo` 会解析为当前角色 `facets.initialState.foo`；`target.state.foo` 解析为目标角色的同名字段。每个被前置条件、效果或不变量读取的字段，都必须在所有匹配角色的 `initialState` 中显式存在。
- 要递增、比较或设上下限的状态必须使用数值；“正常”“偏低”等可读文字放在 profile/note，不能代替运行数值。
- 共享世界状态必须由 Canon 文档的 `worldline-initial-world-state` YAML 显式 seed；状态导演允许修改的环境字段还必须出现在 `worldline-world-state-schema` 且 `mutable: true`。时间与位置不属于状态导演可变软状态。
- 周期系统只能使用世界作用域，不能使用 `state.*` 或 `target.state.*`。保底动作必须在初始状态对至少一名角色可达，执行后不违反任何不变量。
- `mutable` 只表示状态导演能否根据已保存正文提交该字段；动作、系统、时钟或移动驱动的字段通常应为 `false`，并由 `participation.drivers` 声明真正权威来源。每个 schema 字段还必须写 `label`、`participation.meaning`、`participation.narrative`、`participation.choices`。非时钟数值至少写两个阈值 `bands`，每段含 `label/narrative/choices` 与 `min/max/equals`，让正文与选项导演拿到当前命中区间，而不是只看到裸数值。
- 互动故事的 generic 动作必须显式写空间契约：`location: { "mode": "at", "nodeIds": ["map-node:dragon-lair"] }`，或确实不受地点限制时写 `location: { "mode": "anywhere" }`。描述不得暗含移动；从别处到龙巢必须先选择 Runtime 提供的 `move`，到达后攻击动作才会出现。

```json
{
  "id": "battle.strike",
  "description": "消耗一点体力发动攻击",
  "operator": "generic",
  "location": { "mode": "at", "nodeIds": ["map-node:dragon-lair"] },
  "actorTypes": ["character"],
  "preconditions": [{ "op": "gt", "path": "state.stamina", "value": 0 }],
  "duration": 10,
  "maxWait": 60,
  "maxRetries": 2,
  "effects": [
    { "op": "increment", "path": "state.stamina", "amount": -1, "min": 0 },
    { "op": "increment", "path": "conflict.dragonWounds", "amount": 1, "min": 0 }
  ]
}
```

```json
{
  "id": "dragon.counterfire",
  "description": "恶龙周期性反击",
  "nextWake": 30,
  "interval": 30,
  "preconditions": [],
  "effects": [{ "op": "increment", "path": "conflict.heroWounds", "amount": 1, "min": 0 }]
}
```

```json
{
  "id": "battle.wounds.nonnegative",
  "description": "恶龙伤势不能为负",
  "expression": { "op": "gte", "path": "conflict.dragonWounds", "value": 0 }
}
```

完整闭环至少需要一个初始可达动作、一个能产生状态变化的周期系统和一个初始即成立的不变量。提交时分别放入直接 `runtime` 对象的 `actions`、`systems` 和 `invariants`。
