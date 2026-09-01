# 地图结构检查

地图必须写入 `maps/*.md` 中唯一的 `worldline-map` JSON 代码块。普通说明文字不会成为可运行地图。优先调用 `worldline_map` 的 `write` 操作；它会校验并写入下面这一种当前格式，不需要作者或 Agent 构造来源锚点。

```json
{
  "id": "map:ash-crown",
  "version": 1,
  "name": "灰烬边境",
  "rootNodeId": "map-node:ash-world",
  "layers": [
    { "id": "ground", "name": "地表", "visible": true, "locked": false, "order": 0 }
  ],
  "nodes": [
    { "id": "map-node:ash-world", "layerId": "ground", "kind": "world", "name": "灰烬边境", "position": { "x": 110, "y": 95 }, "permissions": [], "hazards": [], "entryNodeIds": [] },
    { "id": "map-node:dragon-lair", "parentId": "map-node:ash-world", "layerId": "ground", "kind": "building", "name": "赤焰龙巢", "position": { "x": 370, "y": 135 }, "permissions": [], "hazards": ["龙焰"], "entryNodeIds": [] }
  ],
  "edges": [
    { "id": "map-edge:road-to-lair", "from": "map-node:ash-world", "to": "map-node:dragon-lair", "bidirectional": true, "distance": 900, "baseDuration": 900, "capacity": 2, "modes": ["walk"], "permissions": [], "hazards": ["浓烟"] }
  ]
}
```

- 标识：地图、节点、边均为稳定 ID；展示名不是身份。
- 拓扑：端点存在，方向明确，重复边有意图，孤岛可解释。
- 语义：旅行时长、成本、条件和禁行理由可执行。
- 视觉：坐标、层、背景和视口仅用于展示，不暗改规则。
- 排布：同一图层的节点中心横向至少相隔 124、纵向至少相隔 64，避免节点和文字重叠。
- 大图：视口裁剪、空间索引和 LOD 只改变渲染工作量，不遗漏权威数据。
- 来源：每个可执行连接都有作者锚点或已批准 Proposal。
- 标识语法：地图使用 `map:*`，节点使用 `map-node:*`，边使用 `map-edge:*`；冒号后的稳定部分至少 6 个字符。
- 完成条件：至少一张地图、一个根节点；需要移动玩法时必须有一条 `baseDuration > 0` 的可达边。
