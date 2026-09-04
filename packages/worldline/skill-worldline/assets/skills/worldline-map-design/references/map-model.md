# 地图结构检查

`maps/*.md` 只写地点、风貌、通路与旅行体验等可读设定。可运行地图必须通过 `worldline_map` 的 `validate/write` 操作写入项目隐藏运行模型；工具会完成校验与来源关联，Markdown 中禁止出现地图 JSON。

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
    { "id": "map-node:ash-world", "layerId": "ground", "kind": "world", "name": "灰烬边境", "description": "长年被火山灰覆盖的边境总域，天空、道路和聚落都受季风火山活动支配。", "position": { "x": 110, "y": 95 }, "permissions": [], "hazards": [], "entryNodeIds": [] },
    { "id": "map-node:dragon-lair", "parentId": "map-node:ash-world", "layerId": "ground", "kind": "building", "name": "赤焰龙巢", "description": "嵌在黑曜岩壁中的高温巢穴，硫磺气味、熔岩反光与狭窄入口构成主要感官和行动限制。", "position": { "x": 370, "y": 135 }, "permissions": [], "hazards": ["龙焰"], "entryNodeIds": [] }
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

## 首次建图必填字段

- 顶层：`id`、`version`、`name`、`rootNodeId`、`layers`、`nodes`、`edges`。
- 每个图层：`id`、`name`、`visible`、`locked`、`order`。
- 每个节点：`id`、`layerId`、`kind`、`name`、不少于 20 字且包含空间风貌、感官与用途的 `description`、`position`（含有限数值 `x/y`）、`permissions`、`hazards`、`entryNodeIds`；除根节点外通常还应有 `parentId`。
- 每条边：`id`、`from`、`to`、`bidirectional`、`distance`、`baseDuration`、`modes`、`permissions`、`hazards`。

首次建图不要调用 `worldline_map read`。直接复制上面的完整模板，批量替换地点和连接，先 `validate`，再进行两阶段 `write`。只有成功写入后，`read` 才用于读取现有运行地图。
