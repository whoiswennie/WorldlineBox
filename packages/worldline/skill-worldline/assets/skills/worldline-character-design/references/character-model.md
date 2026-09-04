# 可执行角色模型

角色正文同时保存人类可读设定和公开可编辑的 YAML 状态契约。不要生成隐藏 `worldline-facets` 注释，也不要手写运行时实体 ID；编译器会根据文档稳定 ID 生成。

````markdown
# 勇士艾琳

她以守护村庄为目标，知道龙巢入口的位置，但不知道恶龙守护龙卵的秘密。

## 可运行状态

```worldline-state-schema
locationId:
  type: string
  mutable: false
  label: 当前位置
emotion:
  type: string
  mutable: true
  label: 情绪
  participation:
    drivers: [director]
    meaning: 角色当前情绪会改变感知重点、语气与风险偏好
    narrative: 用身体反应、注意力和措辞呈现，不直接播报字段
    choices: 紧张时更重视确认与退路，平静时更愿意观察和协商
    bands:
      - equals: 警觉
        label: 警觉
        narrative: 注意力收窄到危险征兆，动作更克制
        choices: 优先核实威胁、保留退路，降低冒险倾向
inventory:
  type: array
  mutable: true
  label: 随身物品
  participation:
    drivers: [director]
    meaning: 当前实际持有物决定可以实施的手段
    narrative: 使用或失去物品必须在正文中可感知
    choices: 只能提出现有物品能够支撑的做法
```

```worldline-initial-state
locationId: map-node:village-gate
emotion: 警觉
inventory: []
```

`locationId` 必须是地图中真实存在的节点并带可读 label，只能由 Runtime 移动改变。每个字段都要有类型和 `mutable` 声明；除 locationId 外还要有 participation 参与契约，数值字段至少两个阈值 bands。`mutable` 只代表状态导演权限，动作或系统驱动字段应为 false。模型不得修改未声明字段。角色身份、目标、记忆、关系和资源仍可通过结构化运行模型补充，但不能覆盖这里的初始状态契约。`profile.gender` 与 `profile.pronouns` 只在作者明确时填写，绝不能由 Agent 猜测。
````

每个角色都必须拥有独立的资源索引，而不是把所有内容挤进一篇文档。二进制图像与音频统一保存到 `assets/files/characters/<角色目录>/`；可索引的 Markdown 资料应按其正典类型放入标准目录。只有真实存在的资源才可由运行模型引用：

```json
{
  "facets": {
    "profile": {
      "age": "成年",
      "gender": "女",
      "pronouns": "她",
      "identity": "村庄守卫",
      "personality": "坚定、谨慎"
    },
    "resources": {
      "knowledge": ["facts/ailin-dragon-notes.md"],
      "visual": {
        "portrait": "assets/files/characters/ailin/visual/portrait.png",
        "expressions": {
          "default": "assets/files/characters/ailin/visual/neutral.png",
          "happy": "assets/files/characters/ailin/visual/happy.png"
        },
        "cg": ["assets/files/characters/ailin/visual/cg-01.webp"]
      },
      "audio": {
        "voice": "assets/files/characters/ailin/audio/voice-intro.ogg",
        "theme": "assets/files/characters/ailin/audio/theme.ogg"
      }
    }
  }
}
```

这段对象只作为 `set-runtime` 的直接 `runtime` 参数，不得 stringify，也不得写进 Markdown。角色初始状态以 Markdown YAML 为准；运行模型只补充 profile、memory 与 resources。只有已成功导入项目的真实素材才能写入资源路径，严禁为了填满槽位而捏造不存在的 `assets/...` 路径。没有素材时保留槽位语义但省略路径；视觉演绎会优先使用立绘、表情、语音和角色曲，没有素材时使用内置类别默认形象降级。知识资源是角色可检索的私有背景资料，不等同于其已经知道的事实；角色真正知晓的内容仍必须进入 `memory.beliefs` 并遵守观察边界。

至少检查：稳定身份（包括作者明确的年龄、性别、称谓/代词与身份）、初始位置、可见属性、私有知识、库存或资源、关系边、目标、控制模式、立绘/表情/CG/音频资源索引、允许动作、动作参数、前置条件、持续时间、成本、效果、失败语义和来源。`initialState.locationId` 必须指向地图中真实存在的节点。任何会被动作递增或与数值比较的字段（例如 health、stamina、stress、infection、abilityLevel）都必须在每名匹配角色的 `initialState` 中使用数值初始化；人类可读的“正常”“偏低”等标签保留在 note/profile，不得代替运行数值。修订已有角色模型前先用 `worldline_query runtime` 读取完整对象并保留 profile/memory/resources 等未改字段。自然语言特征只有在作者明确授权时才映射成数值或规则。
