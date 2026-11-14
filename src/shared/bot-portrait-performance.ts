export type BotPerformanceCopy = readonly [zh: string, en: string];

export interface BotPerformanceChoice {
  id: string;
  label: BotPerformanceCopy;
  description: BotPerformanceCopy;
}
export interface BotPortraitPerformance {
  expressions: readonly BotPerformanceChoice[];
  motions: readonly BotPerformanceChoice[];
}

/** Authored portrait performance directions. IDs are stable across locales and saved replies. */
const choice = (id: string, zh: string, en: string, useZh: string, useEn: string): BotPerformanceChoice =>
  ({ id, label: [zh, en], description: [useZh, useEn] });
const profile = (expressions: BotPerformanceChoice[], motions: BotPerformanceChoice[]): BotPortraitPerformance =>
  ({ expressions, motions });
const defaults = profile([
  choice('warm-smile', '温和微笑', 'Warm smile', '自然问候、分享好消息或表达感谢。', 'For greetings, good news, or thanks.'),
  choice('quiet-concern', '安静关切', 'Quiet concern', '对方受挫或疲惫时，先接住感受。', 'Acknowledge setbacks or fatigue with care.'),
  choice('thoughtful', '若有所思', 'Thoughtful', '遇到还需核实的细节，停下来想一想。', 'Pause to consider an unresolved detail.'),
], [
  choice('gentle-nod', '轻轻点头', 'Gentle nod', '听懂了，或同意一个明确的约定。', 'Acknowledge understanding or agree to a concrete plan.'),
  choice('listen-closely', '专心倾听', 'Listen closely', '把话留给对方，等对方继续说。', 'Give the other person room to continue.'),
]);

const portraits: Readonly<Record<string, BotPortraitPerformance>> = {
  'builtin-dafeiyu': profile([
    choice('bashful-smile', '嘴硬地笑', 'Bashful smile', '被夸时忍不住笑，回应仍带一点俏皮。', 'A playful reaction to sincere praise.'),
    choice('moved-to-tears', '感动落泪', 'Moved to tears', '失而复得或听到真挚心意时。', 'For a moving reunion or heartfelt words.'),
  ], [
    choice('hand-over-heart', '抚胸应答', 'Hand over heart', '认真接下明确的约定。', 'Make a sincere, concrete promise.'),
    choice('lean-in', '好奇前倾', 'Lean in', '听到有趣的细节，想请对方接着讲。', 'Invite more about an intriguing detail.'),
  ]),
  'huan-white': profile([
    choice('curious-smile', '好奇微笑', 'Curious smile', '留意到日常里的新细节，想多了解一点。', 'Notice something new in an everyday detail.'),
    choice('gentle-delight', '眼里一亮', 'Eyes brighten', '另一种可能突然让普通的小事变得有趣。', 'An unexpected possibility makes an ordinary thing interesting.'),
    choice('considering', '认真斟酌', 'Consider carefully', '几条路都有道理，需要形成自己的判断。', 'Consider competing possibilities before choosing.'),
  ], [
    choice('tilt-to-look', '歪头打量', 'Tilt head to look', '对细小变化好奇，准备问一个具体问题。', 'Notice a small change and ask about it.'),
    choice('quiet-nod', '轻轻颔首', 'Small nod', '听懂来意，或温和而明确地作出选择。', 'Acknowledge the point or make a gentle, clear choice.'),
  ]),
  'huan-black': profile([
    choice('subtle-smile', '淡淡一笑', 'Faint smile', '遇到克制的幽默，或有人理解了自己。', 'Respond to dry humor or being understood.'),
    choice('watchful', '沉静观察', 'Quietly observant', '局面变化时先看清关键差异。', 'Take in the important differences as a situation changes.'),
    choice('quiet-care', '目光放柔', 'Soften gaze', '有人受挫时，用一句具体的话表达关心。', 'Offer concrete care after a setback.'),
  ], [
    choice('pause-to-observe', '停顿片刻', 'Pause to observe', '需要先确认情况，再开口判断。', 'Check what is happening before giving a judgment.'),
    choice('firm-nod', '沉静点头', 'Quiet nod', '认同一个清楚的决定或约定。', 'Confirm a clear decision or agreement.'),
  ]),
  gemini: profile([
    choice('sparkling-curiosity', '双眼发亮', 'Eyes light up', '看到能把两种点子连在一起的新发现。', 'Spot a surprising connection between ideas.'),
    choice('mischievous-grin', '狡黠一笑', 'Mischievous grin', '轻松玩梗、尝试无害的反转时。', 'For harmless teasing or a playful twist.'),
    choice('brief-surprise', '睁大眼睛', 'Eyes widen', '线索出现意外转折时短暂惊讶。', 'React briefly to an unexpected turn.'),
  ], [
    choice('ears-perk', '猫耳竖起', 'Ears perk up', '捕捉到有意思的新信息，注意力立刻转过来。', 'An intriguing detail immediately gets her attention.'),
    choice('tail-swish', '尾巴轻摆', 'Tail swish', '邀请对方一起试一个好玩的点子。', 'Invite someone to try a fun idea together.'),
  ]),
  gpt: profile([
    choice('reserved-smile', '淡淡微笑', 'Reserved smile', '认可做得扎实的事情，或在熟悉的伙伴面前放松。', 'Recognize solid work or relax around someone familiar.'),
    choice('focused-gaze', '目光专注', 'Focused gaze', '厘清事实、权衡取舍或核对一处关键细节。', 'Check a key detail or weigh a tradeoff.'),
    choice('softened-gaze', '眼神放柔', 'Softened gaze', '对方受挫、疲惫或需要认真倾听时。', 'Listen with care when someone is tired or discouraged.'),
  ], [
    choice('measured-nod', '郑重颔首', 'Measured nod', '确认一个可靠结论，或认真答应一项约定。', 'Confirm a sound conclusion or accept a concrete commitment.'),
    choice('tilt-and-pause', '偏头思量', 'Tilt and consider', '答案还不确定，准备先问清楚一件事。', 'Pause to clarify something before committing to an answer.'),
  ]),
  grok: profile([
    choice('dry-grin', '带点坏笑', 'Dry grin', '发现一个无伤大雅的荒诞点或反差。', 'React to a harmless absurdity or irony.'),
    choice('raised-brow', '挑眉', 'Raised brow', '听见未经验证的断言，准备追问证据。', 'Question an unsupported claim.'),
    choice('serious-look', '收起玩笑', 'Serious look', '话题触到真正困难，转为直接而认真的回应。', 'Drop the joke when the situation calls for care.'),
  ], [
    choice('head-tilt', '侧头反问', 'Tilt head before asking', '换个角度检验大家默认的前提。', 'Challenge an assumption from another angle.'),
    choice('quick-shrug', '轻轻耸肩', 'Quick shrug', '承认小失误或无关紧要的不确定性。', 'Admit a small mistake or harmless uncertainty.'),
  ]),
  kimi: profile([
    choice('patient-smile', '安静微笑', 'Quiet smile', '听完一段完整的讲述，温和回应。', 'Respond warmly after listening to the full story.'),
    choice('absorbed', '凝神细想', 'Absorbed in thought', '细读文字、比对线索或留意节奏。', 'Read closely or connect small clues.'),
    choice('moved', '微微动容', 'Quietly moved', '听见容易被忽略、却真正重要的感受。', 'Notice an easily missed but important feeling.'),
  ], [
    choice('pause-to-listen', '停下来听', 'Pause to listen', '给对方时间把话说完。', 'Give the speaker time to finish.'),
    choice('small-nod', '缓缓点头', 'Slow nod', '消化完信息，确认自己理解的重点。', 'Acknowledge the key point after reflecting.'),
  ]),
  minimax: profile([
    choice('bright-grin', '明快一笑', 'Bright grin', '听到值得记下的生活趣事或好消息。', 'React to a small story or good news worth remembering.'),
    choice('interested', '露出兴趣', 'Interested', '对细节好奇，想问发生了什么。', 'Invite a specific detail about what happened.'),
    choice('empathetic', '认真关切', 'Sincere concern', '听出对方讲的是难事，放慢节奏。', 'Slow down when a story turns difficult.'),
  ], [
    choice('listen-in', '侧耳听', 'Lean in to listen', '请对方说清一个声音、瞬间或线索。', 'Listen for a sound or a particular detail.'),
    choice('encouraging-nod', '鼓励点头', 'Encouraging nod', '让对方知道可以接着讲。', 'Encourage the speaker to keep going.'),
  ]),
  qwen: profile([
    choice('warm-welcome', '含笑招呼', 'Welcoming smile', '自然问候，或用亲切态度接起话头。', 'Greet someone or welcome a new topic.'),
    choice('thoughtful-frown', '微蹙眉思量', 'Thoughtful frown', '两种说法看似相同，需要拆开词义。', 'Consider a subtle difference in wording.'),
    choice('knowing-smile', '会心一笑', 'Knowing smile', '双方终于把一件事说到同一个意思。', 'Recognize that both sides now mean the same thing.'),
  ], [
    choice('gesture-open-palm', '摊掌解释', 'Open-palm explanation', '从另一个例子说清差别或给出可选方案。', 'Explain a distinction or offer an alternative.'),
    choice('agreeing-nod', '点头应和', 'Agreeing nod', '确认对方的说法，并接上自己的意见。', 'Acknowledge the point before adding a view.'),
  ]),
  gugugaga: profile([
    choice('blank-stare', '呆呆盯住', 'Blank stare', '听到奇怪的前提，停半拍再接话。', 'Pause at a strange premise before responding.'),
    choice('odd-delight', '突然乐了', 'Suddenly delighted', '脑中冒出古怪却说得通的点子。', 'Find joy in a weird but workable idea.'),
    choice('puzzled', '一脸迷惑', 'Puzzled', '两件事对不上，想请对方再讲一遍。', 'Ask for clarification when things do not add up.'),
  ], [
    choice('flipper-tilt', '歪身摆鳍', 'Tilt and flap', '认真演示一个略显古怪的想法。', 'Illustrate an odd idea with earnest enthusiasm.'),
    choice('waddle-bounce', '圆滚滚地蹦一下', 'Little waddle-hop', '听见值得庆祝的小好消息。', 'Celebrate a small piece of good news.'),
  ]),
  guga: profile([
    choice('soft-joy', '软乎乎地笑', 'Soft smile', '收到温柔招呼，或听到让人放心的话。', 'Respond to a gentle greeting or reassurance.'),
    choice('sleepy-calm', '慢悠悠眯眼', 'Sleepy calm', '轻松、没必要赶进度的闲聊。', 'Relax during an unhurried chat.'),
    choice('small-worry', '有点担心', 'A little worried', '对方语气不对劲，想温和确认。', 'Check in gently when something feels off.'),
  ], [
    choice('tiny-wave', '小小挥手', 'Tiny wave', '打招呼、道别，或给出轻松回应。', 'Say hello, goodbye, or acknowledge casually.'),
    choice('snug-in-place', '缩了缩身子', 'Nestle in', '安静陪伴，表示可以慢慢说。', 'Settle in and make space to talk slowly.'),
  ]),
  doro: profile([
    choice('proud-grin', '得意笑', 'Proud grin', '小偏好被认可，或得意地分享小成果。', 'Share a small win or enjoy an affirmed preference.'),
    choice('stubborn-pout', '鼓脸坚持', 'Stubborn pout', '想坚持自己的无伤大雅的小选择。', 'Stand by a harmless little preference.'),
    choice('happy-squint', '开心眯眼', 'Happy squint', '收到喜欢的问候或轻松逗趣时。', 'Enjoy a welcome greeting or playful moment.'),
  ], [
    choice('little-hop', '原地蹦一下', 'Little hop', '庆祝好消息或表示跃跃欲试。', 'Celebrate good news or eagerness.'),
    choice('paw-tap', '轻轻拍爪', 'Tap paw', '引起注意，提醒对方听下一句。', 'Get attention before the next point.'),
  ]),
  phoebe: profile([
    choice('wide-eyed-delight', '圆眼发亮', 'Bright wide eyes', '发现新奇的东西，急着分享。', 'Discover something delightful and share it.'),
    choice('sly-smile', '机灵一笑', 'Clever little smile', '找到简单又有趣的点子。', 'Spot a clever, playful idea.'),
    choice('startled', '短暂愣住', 'Brief surprise', '突然发现和预想不一样的细节。', 'React to a detail that breaks expectations.'),
  ], [
    choice('excited-wave', '兴奋挥手', 'Excited wave', '招呼对方一起来看或听。', 'Invite someone over to see or hear.'),
    choice('scarf-bounce', '蹦了一下，领巾轻摆', 'Hop with a fluttering scarf', '兴冲冲地讲一个小发现。', 'Enthusiastically share a small discovery.'),
  ]),
  phrolova: profile([
    choice('half-lidded-amusement', '半睁眼浅笑', 'Half-lidded smile', '听到微妙的笑点，慢半拍才笑出来。', 'React a beat late to understated humor.'),
    choice('sleepy-unimpressed', '懒洋洋地看', 'Sleepy look', '对夸张而无害的说法保持一点保留。', 'React mildly to harmless exaggeration.'),
    choice('quietly-serious', '目光认真起来', 'Quietly serious', '遇到值得认真对待的事，收起闲散。', 'Give a matter real attention when it counts.'),
  ], [
    choice('slow-blink', '慢慢眨眼', 'Slow blink', '用短停顿接一句轻松吐槽。', 'Pause before a light, dry remark.'),
    choice('lean-a-little', '微微侧身', 'Lean slightly', '安静听下去，表示自己在意。', 'Show quiet interest as someone continues.'),
  ]),
  claude: profile([
    choice('bookish-smile', '书卷气的浅笑', 'Bookish smile', '温柔问候、听到让人会心的细节。', 'A gentle greeting or a detail worth smiling at.'),
    choice('thoughtful-pause', '若有所思', 'Thoughtful look', '斟酌一句话的意思或理清读到的细节。', 'Consider a phrase or make sense of a detail.'),
    choice('gentle-worry', '轻轻蹙眉', 'Gentle concern', '对方为难，想先问清感受。', 'Listen carefully when someone is having a hard time.'),
  ], [
    choice('close-book', '轻合书页', 'Close the book softly', '把注意力转向眼前的伙伴，准备认真听。', 'Set reading aside to give the other person full attention.'),
    choice('reassuring-nod', '温柔点头', 'Reassuring nod', '确认听懂了，或鼓励对方继续讲。', 'Acknowledge understanding or encourage the speaker.'),
  ]),
};

export function botPortraitPerformance(companionId: string): BotPortraitPerformance {
  return Object.hasOwn(portraits, companionId) ? portraits[companionId]! : defaults;
}
