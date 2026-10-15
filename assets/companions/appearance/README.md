# 大肥鱼姐妹的公开身份图

`deepseek-sister-orthographic.png` 是以用户确认的 `../deepseek.jpg` 为参考，使用内置 imagegen 独立绘制的姐姐正面、左侧面、背面等高正交图。姐姐为成熟正常比例蓝发鲸鱼女仆，长裙、白围裙、白袜与大鲸尾，不是妹妹的 Q 版身体。

`deepseek-flash-orthographic.png` 是用户最新提供的妹妹原始三视图，1260×703，完整保留 PNG 字节，**没有用生成板替换原身份**。SHA-256 为 `187836c4856532f8db0515c3c5820e2315fa616a4d92705265a239f4c74ccc27`。它采用细线平涂、约三头身、自然蓝眼和小嘴、单侧蓝蝴蝶结、白袜与小鲸尾；旧黑连裤袜和华丽婴儿脸设计已排除。

两张独立头像位于 `../portraits/`。各 31 组动作由内置 imagegen 分别生成，生产文件分别为 `public/companion-world/characters/{sister|flash}/actions/{action}.webp`，每个文件只含一个动作的三个连续帧，保留真实透明通道。没有复制、倒放或从多动作拼图中切分素材。

[manifest.json](manifest.json) 记录身份来源、正式头像和三视图的 SHA、每个资产实际的制作方式及整组尺度量测；完整动作意图、最后重绘修正和正式身份引用保存在生产动作清单。`input` 指向的 `.tools` 原始工作 PNG 与 Codex 生成目录属于本地制作证据，不随仓库分发，运行只需要交付的独立 WebP 和四张正式身份 PNG。

`neutralHeightPixels` 是同一动作三个帧共享的解剖尺度。带站立端点的过渡按该站立帧相对于 idle 的头顶至足底高度量测；纯坐卧按头帽至下巴和躯干参照量测，不以横躺外接框推算身高，也不逐帧缩放。逐帧 `seat/bed/foot` 接触点只控制对应家具或地面附着。

第三方角色设计的来源与授权范围见 [第三方说明](../../../THIRD_PARTY_NOTICES.md)，重绘不把底层角色设计纳入项目 MIT 代码许可。
