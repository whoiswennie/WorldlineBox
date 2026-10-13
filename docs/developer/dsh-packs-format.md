# DSH 整合包与封存归档

`src/main/dsh/packs.ts` 管理整合包；`src/main/dsh/archive.ts` 提供整合包和私人备份共同使用的 ZIP 封存、流式读取与完整性检查。主路线使用官方 npm DSH 发行版，以私有 `web` profile 启动；旧 Desktop 导入仍兼容。

## Node 整合包 v2 与公开分发

新 Node 包采用 `worldlinebox-dshpack-v2`。除原来的全量 seal 外，运行锁要求官方源码 SHA-256、npm SHA-512 SRI、规范化依赖图 SHA-256、Node / npm 版本、Node 二进制 SHA-256 和真实运行 payload SHA-256。仅四个管理器生成的元数据文件不参与 payload 指纹，其余 SDK 源码、包描述和二进制全部参与；同版本、同来源声明但代码被改过的本地导入环境不能冒充兼容运行版本。

密封数据内包含 `runtime-lock/package-lock.json`。缺失运行版本时通过内置工具重放完整 `npm ci`，登记前检查来源、依赖图、解释器和实际 payload。不会按相同版本号或 `latest` 替代。旧 v1 包继续要求精确 `contentSha256`。

公开分发生成归档、`.manifest.json` 和 `.sha256` 三个文件。公开清单同时锁定归档大小 / SHA-256、内部文件清单和运行锁；下载完成后先比较内外清单，再交给正常包导入。GitHub 发布先创建草稿，完整上传三个资产并再次核查传输内容，最后才按用户明确选择发布。Token 不持久化，鉴权请求不走第三方镜像或重定向；不同内容的既有资产不被覆盖。

## 整合包内容

创建整合包要求实例停止，并持有实例操作锁。每个包绑定一个运行资源的完整 `contentSha256`、DSH 版本、平台及启动适配器。同一个版本号的不同构建不自动互换。

导出的可移植内容仅包括：

| 包内路径 | 来源 |
| --- | --- |
| `home/profiles/**` | profile manifest、patch、pnpm workspace、锁文件及已安装插件依赖 |
| `home/cordis.patch.yml` | 实例的 Home 配置覆盖 |
| `home/skills/**` | 实例的 DSH 技能 |
| `home/skills-disabled/**` | 已停用、可重新启用的私有技能 |
| `agents/skills/**` | 本实例的兼容技能 |

会话、storage、附件、凭据、`.env`、匿名身份、工作区和浏览器缓存不属于整合包。生成的 `cordis.yml` 与运行事务锁也不携带，启动时由 DSH 再生成。指向受管官方运行资源的 fallback 链接被排除；实例内部的插件依赖链接复制成普通文件，离开所复制数据根的链接和递归链接拒绝导出。安装整合包只创建新实例，不覆盖来源实例。

管理器的 `shared` 存档层不属于整合包。兼容的新实例按选定存档模式使用共享会话、默认工作区、账户和模型配置，
插件与技能来自包的私有环境。共享技术路由不应携带作者数据目录；模型共享协调不复制其它
插件配置，也不让安装一个包覆盖当前账户或全局模型选择。

整合包携带已安装插件树，安装时不执行 npm 或 pnpm 生命周期脚本。官方核心运行资源仍由启动器独立管理，包文件不内嵌整套 Electron/DSH 资源；离线安装前应先导入或保留匹配的运行版本。缺少精确运行资源时，导入和安装会显示缺失版本与内容指纹。

pnpm 生成的 `node_modules/.modules.yaml` 使用 JSON 或旧版 YAML 格式，包含实例专属 `storeDir` 与 `virtualStoreDir`。导出把它们替换成明确占位符，保留其它布局信息及 `v11`、`v3` 等 store 后缀；安装到新实例时再映射到其私有 store 和每个 profile 的 `node_modules/.pnpm`。含作者原始绝对 store 路径的包拒绝导入，外部自定义 virtual store 拒绝导出。这样也避免后续安装插件时触发 `ERR_PNPM_UNEXPECTED_STORE`。

## ZIP 布局与清单

```text
manifest.json
data/home/profiles/...
data/home/skills/...
data/agents/skills/...
```

整合包的 `manifest.json` 包含以下字段：

```json
{
  "format": "worldlinebox-dshpack-v1",
  "name": "示例整合包",
  "version": "1.0",
  "createdAt": "2026-10-12T00:00:00.000Z",
  "runtime": {
    "version": "0.2.0-rc.2",
    "platform": "win32-x64",
    "adapter": "desktop-cli-web-v1",
    "contentSha256": "<运行资源目录的 SHA-256 指纹>"
  },
  "files": [
    {"path": "home/profiles/web/package.json", "sha256": "<文件 SHA-256>", "size": 123}
  ],
  "contentSha256": "<JSON.stringify(files) 的 SHA-256>",
  "fileCount": 1,
  "byteLength": 123
}
```

`files` 的路径相对于 ZIP 的 `data/`，不包含 `manifest.json` 本身。清单中的 SHA-256 均为小写 64 位十六进制。示例中的占位文本不是合法摘要。

通用归档写入接口 `writeSealedArchive(directory, filePath, metadata, signal?)` 会重新计算 `files`、`contentSha256`、`fileCount` 与 `byteLength`，调用方的同名字段不会覆盖这些计算结果。`extractSealedArchive(filePath, destination, signal?)` 只向空暂存目录写入 `data/`，在所有文件通过验证后返回清单；调用方另行验证产品格式，再提交暂存目录。私人备份有独立的格式标识和产品内容规则。

## 验证与限制

导入拒绝未列入清单的文件、缺失文件、修改过的文件、绝对路径、目录逃逸、Windows 设备名和 ADS、Unicode/大小写碰撞、重复条目、符号链接及其它特殊文件、加密或不支持的 ZIP 条目。清单总量和展开后的实际字节量都受限：最多 150,000 个文件、单文件 1 GiB、总内容 8 GiB、清单 32 MiB。流式读取与复制支持取消；失败的暂存内容不会注册成可用包。

可移植配置审查拒绝明显密钥和私钥、配置中的明确绝对路径、用户全局 Home 表达式，以及 `file:`、`link:`、`workspace:` 本地依赖引用。未知绝对路径、计算表达式、远程数据库和任意插件代码的运行行为无法仅靠静态扫描证明隔离；正常插件仍以受管 DSH 进程的原生权限执行。目录隔离不改变用户主动选择的外部项目，也不是系统文件访问沙箱。

清单摘要用于完整性检查，不提供作者身份认证。导出公共整合包前仍应审阅自定义配置和技能；包含会话与凭据的数据恢复请使用私人备份。

完整私人备份另含 `shared` 封存及其清单，导入导出前需停止全部实例。恢复会话和工作区时保留
已有目标与冲突来源；凭据通过原生共享存储合并，模型仅导入 allowlist namespace，冲突不覆盖
已有选择。快照保持实例环境边界，不回滚全局账户和会话。

## 验证命令

`tests/unit/dsh-pack.test.ts` 覆盖 ZIP 篡改、额外文件、链接、路径规则、会话/密钥排除、运行指纹匹配及创建新实例。默认测试不启动 DSH。

Windows 可指定已提取的官方完整程序目录，启用额外的真实启动验证：

```powershell
$env:WORLDLINEBOX_DSH_REAL_DIRECTORY = 'C:\path\to\DSH-program'
node node_modules/vitest/vitest.mjs run tests/unit/dsh-pack.test.ts
```

该验证创建独立临时 Home、agents、workspace，启动官方 CLI，验证认证重定向，停止后打包，安装到新实例再启动。它不读取用户默认 `.dsh`，不请求模型服务。这个单测的运行资源注册使用测试替身；实际运行资源封存、导入和 Electron 桌面交互由启动器的完整 E2E 验证覆盖。

`tests/unit/dsh-official-installer.test.ts` 另有两个显式启用的测试，覆盖当前官方 `0.2.0-rc.2` Windows SFX、随项目分发的 `7zip-bin` 提取工具、完整运行资源封存与服务重启，以及真实 HTTPS 下载。正常单元测试不会执行联网下载：

```powershell
$env:WORLDLINEBOX_DSH_REAL_INSTALLER = 'C:\path\to\dsh-latest-windows-x64.exe'
$env:WORLDLINEBOX_DSH_REAL_DOWNLOAD = '1'
node node_modules/vitest/vitest.mjs run tests/unit/dsh-official-installer.test.ts
```

下载器只读取并提取安装包，不运行安装器或修改用户 PATH。官方最新版本变化时，这两个快照验证中的预期版本也需要相应更新。

`tests/unit/dsh-official-plugins.test.ts` 的联网验证通过真实 `InstanceService` 调用官方随包 CLI/pnpm：安装精确官方插件、创建和安装离线整合包、在新实例追加/移除依赖，并检查来源实例、邻居实例及运行资源不被改写。启用时使用：

```powershell
$env:WORLDLINEBOX_DSH_REAL_DIRECTORY = 'C:\path\to\DSH-program'
$env:WORLDLINEBOX_DSH_REAL_PLUGINS = '1'
node node_modules/vitest/vitest.mjs run tests/unit/dsh-official-plugins.test.ts
```

随包 pnpm 11 的配置环境前缀是 `pnpm_config_`。启动器同时传递旧版本的 `npm_config_store_dir` 和新版的 `pnpm_config_store_dir`，将内容 store、pnpm 缓存和状态目录限制在当前实例；HOME、USERPROFILE、XDG 目录也独立。该验证不使用用户默认 `.dsh`，不调用模型。
