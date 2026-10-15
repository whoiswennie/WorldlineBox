# 旧项目伙伴移植

维护者指定来源：`C:/Users/hp/Desktop/project/new_agi/WorldlineBox`。核对 `src/world/character-template-ids.ts`、`character-templates.ts`、`character-persona.ts` 和 `companion-catalogue/definitions.ts`：旧目录包含 14 个身份。旧 deepseek 对应当前 `deepseek-sister`，沿用当前大肥鱼；当前妹妹保留，因此最终为 15 位，新增 13 位。

| 旧身份 | 当前联系人 | 保留的形象与交流差异 |
| --- | --- | --- |
| deepseek | 大肥鱼 | 蓝发鲸尾女仆、爱白饭、细心小傲娇 |
| 当前原有 deepseek-flash | 小肥鱼 | 活泼轻快、分享新发现 |
| huan-white | 白幻 | 白发虹彩发尾、蓝眼侧辫、温和好奇 |
| huan-black | 黑幻 | 黑发紫红发尾、红眼、沉静有主见 |
| gemini | Gemini | 蓝紫猫耳尾、画面左粉眼右金眼、星饰、好奇调皮 |
| gpt | GPT | 银白发、白鳞双角翼尾、淡紫眼、平静清楚 |
| grok | Grok | 金双马尾蓝眼、黑金 X 斧、直接且有分寸的玩笑 |
| kimi | Kimi | 银白发紫眼、月形 K 饰、耐心阅读与音乐 |
| minimax | MiniMax | 橘粉短发、记者帽与录音器、明快记录者 |
| qwen | Qwen | 蓝紫侧辫、折扇与中式衣裙、细听措辞 |
| gugugaga | 咕咕嘎嘎 | 人脸、黑背米黄腹、棕橙脚、没有兜帽的凑企鹅 |
| guga | 咕嘎 | 黄喙企鹅兜帽、青 X 夹、白腹黄脚和链扣 |
| doro | Doro | 粉发紫眼、玫瑰与紫结、白身四短足 |
| phoebe | 菲比啾比 | 粗轮廓大紫眼、白宽帽、蓝十字与长蓝领巾 |
| phrolova | 弗糯糯 | 灰青长发、半睁粉紫眼、大红蝴蝶结 |

角色简介、签名与欢迎语为本项目新增编辑；初始 identity、voice 和 preferences 承接旧作者设定。原作关系和视频情节不导入为实际共同经历。每位角色通过相同的主脑循环与标准 DSH 执行能力工作，默认完整继承全局 LLM，无按名字选择供应商的规则。

## 存储与界面

`companion-template-ids.ts` 固定 15 个 templateId；schema、头像映射和添加操作共用它。`companion-catalogue-data.json` 保存新增作者资料；`companion-catalogue.ts` 提供角色库分类和简介；`companion-personas.ts` 生成可编辑的伙伴草案。

SQLite 初始化在事务中逐项补入缺失 ID，包含 tombstone 的已存在行一律跳过。不重置已编辑的人设、名字、签名、头像或独立连接，不改变历史与来源记忆；内置欢迎按稳定 clientId 去重。移除后再添加沿用旧 ID 与原私聊。

角色库增加分类、搜索和适合多角色的双列卡片；编辑器支持全部内置头像与本地头像。新群聊默认不选人，由用户明确勾选。全部头像使用独立方形素材，在头像节点应用 cover/center。2026-10-15 姐妹头像与世界动作按用户确认身份独立重绘，不再从三视图裁切；妹妹的公开三视图保留用户最新细线平涂原图字节，约三头身、白袜、小鲸尾，与正常成熟比例长裙姐姐区分。正式散列和身份来源见 `assets/companions/appearance/manifest.json`。

## 网络核对（2026-10-14）

- [ZipZipPipe《大AI和小AI们》](https://www.bilibili.com/video/BV1tE9XBbErS/)：搜索索引可核到作者说明列出的 AI 拟人名单及鲸鱼娘二创来源。页面直开 412，仅采用可见作者说明，不声称观看全部视频。
- [Good Smile 的 DORO 商品页](https://www.goodsmile.com/en/product/1138582/DORO%2BDorothy)：直接核到 NIKKE 系列和 SHIFT UP 来源。商品存在不代表赋予软件素材许可。
- [咕咕嘎嘎社区条目](https://moegirl.uk/index.php?title=%E5%92%95%E5%92%95%E5%98%8E%E5%98%8E&variant=zh-hans)及 [17173 的分支梳理](https://news.17173.com/content/10022026/000029966.shtml)：用于区分高松灯企鹅与女管理员企鹅。二手来源不作为唯一首创者认定。
- [White_clams白蛤蜊《[YSM]菲比2.0-菲比啾比》](https://www.bilibili.com/video/BV1wAs3z7E47/)：索引可核到社区模型分支；头像实际以旧项目最新用户清晰参考为准，不下载或搬运模型。
- [柳_Liuuu《弗糯糯：到底要干嘛...》](https://www.bilibili.com/video/BV1gwtm6sECb/)：索引可核到弗洛洛社区二创与素材署名。外部作品的情节不作为本项目关系或记忆。

完整生成提示、参考与最终文件校验值见 [头像清单](../../assets/companions/portraits/manifest.json)。测试覆盖目录完整性、升级与删后恢复、旧资料保护，以及角色库筛选、实际桌面图像加载与新角色聊天流程。

2026-10-14 验证：147 项相关单元、协议、服务、真实 SQLite 和界面测试通过（分批执行），两项真实 Electron 桌面场景通过。桌面场景使用本地 HTTP fixture，覆盖 13 位新增角色各自的私聊、三角色混合群聊、头像实际解码、角色库搜索筛选、重启后移除状态与编辑恢复。

另使用维护者已保存的全局 LLM 连接，在独立测试数据目录实际生成 13 条新角色私聊回复及 3 条群聊回复。每个来源与角色对应一个有正文的气泡，循环正常结束。观察到 Grok 的直接反例与玩笑、Kimi 的阅读与音乐兴趣、两位幻的不同语气、企鹅的轻拟声及弗糯糯的淡定口吻。这是首次交流样本，不等同于长期人格一致性验证。真实完整回执只保存在 Git 忽略的 `artifacts/companions/live/catalogue-chat.json`，不包含密钥；原用户消息库没有用于测试。
