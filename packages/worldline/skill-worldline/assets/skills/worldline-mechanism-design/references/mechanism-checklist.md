# 机制闭包检查表

每个动作应能回答：谁可做、何时可做、参数是否合法、会占用什么、何时完成、成功与失败产生什么事件、如何观察、并发时谁先、等待多久算异常、如何恢复、恢复是否确定、如何追溯作者来源。缺一项就应产生诊断、问题或 Proposal，而非默默采用默认常识。

可运行规则只能来自 `mechanisms/*.md` 中以下当前格式代码块。角色自身状态路径用 `state.*`，世界共享状态用其他顶层路径；系统只能修改世界共享状态。

```worldline-action
{
  "id": "battle.strike",
  "description": "消耗一点体力发动攻击",
  "operator": "generic",
  "actorTypes": ["character"],
  "preconditions": [{ "op": "gt", "path": "state.stamina", "value": 0 }],
  "duration": 10,
  "maxWait": 60,
  "retryBudget": 2,
  "effects": [
    { "op": "increment", "path": "state.stamina", "amount": -1, "min": 0 },
    { "op": "increment", "path": "conflict.dragonWounds", "amount": 1, "min": 0 }
  ]
}
```

```worldline-system
{
  "id": "dragon.counterfire",
  "description": "恶龙周期性反击",
  "nextWake": 30,
  "interval": 30,
  "preconditions": [],
  "effects": [{ "op": "increment", "path": "conflict.heroWounds", "amount": 1, "min": 0 }]
}
```

```worldline-invariant
{
  "id": "battle.wounds.nonnegative",
  "description": "恶龙伤势不能为负",
  "expression": { "op": "gte", "path": "conflict.dragonWounds", "value": 0 }
}
```

完整闭环至少需要一个初始可达动作、一个能产生状态变化的周期系统和一个初始即成立的不变量。每个代码块只放一个对象；不要把它们合并成数组。
