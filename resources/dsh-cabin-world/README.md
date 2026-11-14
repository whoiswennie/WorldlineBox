# 小屋世界 · WorldlineBox 的 DSH 插件

WorldlineBox 把聊天消息投递给当前伙伴的原生 DSH 会话。伙伴通过该会话的 MCP 工具 `mcp__cabin_world__cabin_*` 操作游戏，并把游戏回执带回聊天。小屋世界公开版的一份运行实例提供一位游戏住户。使用同一个桥的伙伴操作的是同一个小鲸鱼和存档。

## WorldlineBox 内置版

在 Windows x64 的启动器中打开「小屋世界」。WorldlineBox 启动游戏和本机桥，把 MCP 插件装到当前默认 DSH 实例，并保存连接配置。已安装的外部小屋世界有独立的存档。内置世界的进度写入 WorldlineBox 用户数据目录的 `cabin-world/saves`。

在角色卡「日程」中启用总开关，再开启、修改或添加每天或固定间隔的计划。小屋世界预设默认暂停，可像其他日程一样编辑。也可以在用户私聊中请伙伴创建、修改、启停或删除日程。到点时小屋世界离线则跳过该次运行，日程会显示原因和下一次触发时间。WorldlineBox 关闭时暂停调度，重新打开后每个过期计划最多补跑一次。在线触发时在同一伙伴私聊下开独立话题。

开发时运行 `node scripts/stage-cabin-world.mjs` 获取内置资源，可传入已下载的官方 ZIP。Windows 安装包构建会自动准备并校验该版本。升级上游时更新 `resources/cabin-world-release.json` 中的版本、下载地址和 SHA-256，再运行实机测试。上游游戏和桥的源文件随原版发布包使用。

## 外部小屋世界和独立 DSH

1. 双击小屋世界目录的 `start.cmd`，等待游戏显示在线。
2. 打开 WorldlineBox「DSH 启动器」，选择伙伴使用的默认实例，打开它的终端。先运行以下 PowerShell 命令。将示例路径换成实际路径。

   ```powershell
   $cabinBridge = 'C:/Users/hp/Desktop/project/new/CabinWorld/data/bridge.json'
   $cabinPlugin = 'C:/Users/hp/Desktop/project/new/WorldlineBox/resources/dsh-cabin-world'
   $cabinConfig = Join-Path $env:DSH_HOME 'plugin-data/worldlinebox-cabin-world'
   New-Item -ItemType Directory -Path $cabinConfig -Force | Out-Null
   @{ bridgeJson = $cabinBridge } | ConvertTo-Json |
     Set-Content -LiteralPath (Join-Path $cabinConfig 'config.json') -Encoding utf8
   dsh plugin --profile web add "file:$cabinPlugin"
   ```

   安装版也可用其 `resources/dsh-cabin-world` 目录作为安装来源。在原生 DSH 插件页安装时填写同一个 `file:` 地址。
3. 如果 DSH 提示重启，在 WorldlineBox 启动器中重启该实例。用伙伴的能力列表搜索 `cabin_world`，或者给该伙伴发「用小屋世界工具看看小鲸鱼现在在哪儿」。
4. 想试游戏动作，可以发「让小鲸鱼去公园荡秋千，等动作完成再告诉我」。Worker 在收到 `running` 时可以用原 `taskId` 查询进度，完成时游戏会返回 `done`。

插件每次调用时读取当前桥接地址和 token。重启小屋世界后继续使用同一个 `bridge.json` 路径即可。要切换到另一份小屋世界，修改该实例的 `config.json`，再重启 DSH 实例。
