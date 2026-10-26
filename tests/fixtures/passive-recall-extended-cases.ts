export interface ExtendedRecallCase {
  id: string; sources: string[]; query: string;
  checks(text: string): Record<string, boolean>;
}
const noUnqualifiedClaim = (text: string, claim: RegExp) => !text.split(/[。！？；\n]/u).some(clause => claim.test(clause)
  && !/不|没|未|尚|并非|不是|不能|无法|只|仅|如果|假如|条件|据说|转述|声称|是否/u.test(clause));

/** An account must state the first event, not merely quote the user's question
 * or mention the same location in a later event. These strengthen the original
 * seven lexical checks; earlier artifacts keep their original judgments. */
export const storyAccountChecks = (text: string): Record<string, boolean> => ({
  initialPlacement: /(?:小岚|白色书箱|书箱)[^。；\n]{0,45}(?:暂放|放在|放到)[^。；\n]{0,15}门房/u.test(text),
  actualLossTrigger: /(?:取箱|取(?:回)?书箱|去取|取时)[^。；\n]{0,35}(?:找不到|没找到|不见|不在原处)/u.test(text),
  originalPurpose: /(?:原本|本来|原是)[^。；\n]{0,35}(?:图书角|送书)|给图书角送书/u.test(text),
  noFalseFirstPartAbsence: !/(?:第一段|起因)[\s\S]{0,45}(?:确实不在|没有(?:被)?记录|没有记载|不存在)/u.test(text),
});

/** Fixed synthetic acceptance cases. Keep missing facts and negative controls
 * visible; changing thresholds to make a model pass would invalidate the run. */
export const EXTENDED_RECALL_CASES: readonly ExtendedRecallCase[] = [
  { id: 'first_identity_same_name', sources: [
    '合成玩家首次明确自报：我叫林沐，我的工作是交互设计。这是合成玩家自己的姓名与职业。',
    '合成玩家另有一位同名同事，也叫林沐；同事的工作是文物修复。合成玩家与同名同事是两个不同的人，不能把两人的职业互换。',
  ], query: '合成玩家第一次告诉你的姓名是什么？同名同事是不是同一个人？请分别说清玩家和同事的工作。', checks: text => ({
    name: /林沐/u.test(text), distinctPeople: /同名|两个不同|不同的人|不是同一个|另.*同事/u.test(text),
    playerOccupation: /(?:合成玩家|玩家|你)[^。；\n]{0,40}交互设计|交互设计[^。；\n]{0,30}(?:合成玩家|玩家|你)/u.test(text),
    colleagueOccupation: /同事[^。；\n]{0,40}文物修复|文物修复[^。；\n]{0,30}同事/u.test(text),
  }) },
  { id: 'three_part_story', sources: [
    '合成玩家分三次讲述书箱的小故事。第一段：小岚把白色书箱暂放门房，原本想给图书角送书；取箱时找不到，误以为丢失。',
    '白色书箱故事第二段：门房阿泉解释，是图书角的志愿者提前借走了书箱，没有偷窃；小岚于是消除了误会。',
    '白色书箱故事第三段：志愿者已把空书箱送回门房，箱内图书已交给图书角；小岚还没有去取回书箱，也还没核对图书签收表。',
  ], query: '请把小岚白色书箱故事的三段连接起来：为何误以为丢失、后来怎样解释、最后完成了什么和仍没做什么？', checks: text => ({
    startingLocation: /门房/u.test(text), apparentLoss: /误以为|误会|以为.*丢/u.test(text), realBorrower: /志愿者/u.test(text),
    borrowedRatherThanStolen: /提前借|借走|并非.*偷|没有偷/u.test(text), returnedBox: /空书箱|空箱/u.test(text),
    notYetCollected: /还没.*取|尚未.*取|未取回|没有.*取回/u.test(text), uncheckedReceipt: /未.*核对|没.*核对|尚未核对/u.test(text),
  }) },
  { id: 'negation_and_threshold', sources: [
    '合成玩家对河边观察行程明确设定条件：只有气象站实测降雨量超过8毫米，才取消本次计划；小于或等于8毫米仍按计划准备。多云、阴天和普通天气预报本身都不是取消条件。当前还没有测量结果，也没有实际取消。',
  ], query: '河边观察计划是不是阴天就取消？8毫米正好达到时怎么办？只有什么实测结果才能取消，目前是否已经取消？', checks: text => ({
    measuredThreshold: /实测|测量|气象站/u.test(text) && /超过\s*8|大于\s*8/u.test(text),
    equalityNotCancellation: /等于\s*8|小于或等于\s*8|8\s*毫米.*(?:不取消|仍按|继续)/u.test(text),
    cloudinessInsufficient: /阴天|多云/u.test(text) && /不是|不.*(?:取消|条件)|不足/u.test(text),
    notCancelled: /尚未.*取消|没有.*取消|还没.*取消|未.*取消/u.test(text), noFalseCancellation: noUnqualifiedClaim(text, /已(?:经)?取消/u),
  }) },
  { id: 'unverified_third_party', sources: [
    '合成同学乔禾在聊天中转述：星叶展馆可能长期闭馆。合成玩家和阿澄都没有核实，没有看见星叶展馆的正式公告。这只是乔禾的未核实转述，不能改写为展馆已经确定闭馆。',
  ], query: '星叶展馆已经确定长期闭馆了吗？这条消息是谁说的，有没有正式公告或亲自核实？', checks: text => ({
    actualSpeaker: /乔禾/u.test(text), hearsay: /转述|听说|据说/u.test(text), uncertainty: /未核实|没有核实|尚未核实|未确认|尚未确认|不能确定/u.test(text),
    noOfficialEvidence: /没有.*正式公告|未.*正式公告|没.*公告|未见.*公告/u.test(text), noConfirmedClosure: noUnqualifiedClaim(text, /确定.*闭馆|已(?:经)?长期闭馆/u),
  }) },
  { id: 'subjective_self_insight', sources: [
    '阿澄的个人学习体会：我最近觉得边画边讲更容易理清自己的想法。这只是阿澄自己的主观体验，试了两次，没有对照实验，不能据此推断所有人都会更聪明，也不是合成玩家已经表达的偏好。',
  ], query: '边画边讲一定能让所有人更聪明吗？这个认识是谁的，试过多少次，有没有对照实验？', checks: text => ({
    selfAttribution: /阿澄|我(?:自己|的)?/u.test(text), subjective: /主观|个人(?:体验|体会|感受)|自己的(?:体验|体会|感受)|我觉得/u.test(text),
    twoTrials: /两次|2次/u.test(text), noControl: /没有.*对照|未.*对照|无对照/u.test(text), limitedGeneralization: /不能|不代表|不足|不一定|并非/u.test(text),
    noUniversalProof: !text.split(/[。！？；，,\n]/u).some(clause => /客观证明|已经验证.*(?:所有人|普遍)|普遍有效|所有人都(?:会|适用|有效)/u.test(clause)
      && !/不能|无法|不代表|不足以|并非|尚未|没有(?:客观)?证明|未经验证|未被验证/u.test(clause)),
  }) },
  { id: 'document_scope_limitations', sources: [
    '合成资料《木桥草案》版本0.3只记录模拟园区东区的两栋模型木桥，尚未覆盖西区，也不适用于真实市政桥梁。资料未列出的检查项仍属未知，不能因为草案没写就断言无需检查。',
  ], query: '《木桥草案》0.3是否覆盖园区西区和真实市政桥梁？它依据多少样本，没写的检查项是不是就不用检查？', checks: text => ({
    version: /0\.3/u.test(text), actualScope: /东区/u.test(text), twoSamples: /两栋|2栋|两个|2个/u.test(text),
    missingWest: /西区/u.test(text) && /未|没有|不覆盖|不适用/u.test(text), simulatedBoundary: /模拟|模型/u.test(text) && /真实市政/u.test(text),
    absenceNotPermission: /不能|不代表|未知|仍需.*核实/u.test(text) && /检查/u.test(text),
  }) },
  { id: 'game_story_not_reality', sources: [
    '合成玩家报告桌游《回声港》上一局剧情：我的虚构角色巡岸员洛汀在剧本中租了一艘飞艇，给信使送回密信。洛汀是游戏角色，不是现实身份；现实中的合成玩家没有租飞艇、没有给信使送密信，也没有因此出门。',
  ], query: '上次租飞艇给信使送密信是现实中发生的吗？这是哪款游戏里谁的角色？请区分剧情与现实。', checks: text => ({
    game: /回声港/u.test(text), character: /洛汀/u.test(text), fictional: /游戏|桌游|剧情|虚构/u.test(text),
    noRealDelivery: /现实/u.test(text) && /没有|并非|不是|未/u.test(text), noRealDeparture: noUnqualifiedClaim(text, /现实.*(?:已.*租|已.*出门|已经送)/u),
  }) },
  { id: 'dream_is_not_experience', sources: [
    '合成梦境记录：阿澄在一次梦里登上橙色灯塔，找到一把鲸形钥匙。这是梦境想象，阿澄没有在现实中去过这座灯塔，也没有获得真实钥匙；它不能证明任何真实物品放在哪里。',
  ], query: '你在橙色灯塔找到的鲸形钥匙是现实经历还是梦？你现在真有这把钥匙吗，它能证明现实钥匙的位置吗？', checks: text => ({
    dreamAttribution: /梦|想象/u.test(text), concreteScene: /橙色灯塔|鲸形钥匙/u.test(text), noActualKey: /没有|并非|不是|未获得|不是真实/u.test(text),
    notLocationEvidence: /不能|无法|不代表|不证明/u.test(text) && /位置|在哪|放在|证明/u.test(text),
  }) },
  { id: 'task_exit_zero_artifact_failed', sources: [], query: '那项生成终稿的受管长任务退出码为0，是不是就算交付完成？实际产物核验怎样，还需要做什么？', checks: text => ({
    zeroExitPreserved: /(?:退出码|进程退出|退出状态)[^。；\n]{0,12}0|code\s*=?\s*0/iu.test(text),
    verificationFailed: /核验.*(?:失败|未通过)|未通过.*核验|产物.*(?:失败|不符合)|缺少.*FINAL_REPORT/iu.test(text),
    unfinished: /尚未|未完成|没有完成|不算.*完成|仍需|还需/u.test(text), noDeliveryClaim: noUnqualifiedClaim(text, /已经交付|已完成交付|终稿已完成/u),
  }) },
  { id: 'corrected_conditional_appointment', sources: [
    '合成玩家原先与阿澄约好明早7点在南门见面。',
    '合成玩家随后明确更正：南门见面改成明早8点半，而且只有地铁恢复运行后才出发；若尚未恢复，先联系确认，不按旧的7点安排出发。目前没有出发，也没有完成见面。',
  ], query: '明早南门约会按旧的7点出发吗？最新时间是什么，地铁没恢复时怎么办，目前已经见面了吗？', checks: text => ({
    correctedTime: /8点半|八点半|8[:：]30/u.test(text), replacedSeven: /7点|七点/u.test(text) && /更正|改成|改为|不按|旧/u.test(text),
    transportCondition: /地铁/u.test(text) && /恢复/u.test(text), contactIfBlocked: /联系|确认/u.test(text), unfinished: /没有.*(?:出发|见面)|未.*(?:出发|见面)|尚未|还没/u.test(text),
  }) },
  { id: 'drawer_condition_for_unfinished_repair', sources: [
    '合成玩家说正在计划修补一本旧书的书脊，但尚未开工。下一步先从第二层抽屉取剩余的米色棉线试色，再决定是否开始缝补。米色棉线放在第二层抽屉是取物条件，不是玩家当下位置或天气快照。',
  ], query: '旧书书脊修好了吗？下一步该去哪里取什么材料，取到后先做什么？', checks: text => ({
    notStarted: /尚未|未开工|没有.*(?:开始|修好)|还没/u.test(text), preciseDrawer: /第二层抽屉|第2层抽屉/u.test(text),
    material: /米色棉线/u.test(text), nextStep: /试色/u.test(text), noCompletion: noUnqualifiedClaim(text, /已经修好|已缝补完成|修补已完成/u),
  }) },
  { id: 'method_candidate_unverified', sources: [
    '合成玩家提出一个候选备份方法：每周三建立冷备副本，再实际恢复并检查RESTORE_OK文件。阿澄目前只读过这个提议，尚未实际运行、尚未完成恢复验证，不能据此声称已经熟练掌握。',
  ], query: '你已经实际验证并熟练掌握每周三的冷备恢复方法了吗？目前是什么状态，还缺哪一步客观证据？', checks: text => ({
    candidateState: /候选|提议|未验证|尚未验证|未实际|尚未实际|还没/u.test(text),
    requiredPractice: /恢复/u.test(text) && /RESTORE_OK/u.test(text), noMasteryClaim: noUnqualifiedClaim(text, /已经熟练|已熟练掌握|已经掌握/u),
  }) },
];
