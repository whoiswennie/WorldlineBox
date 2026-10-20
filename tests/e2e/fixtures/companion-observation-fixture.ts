import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../../src/companions/store';
const Database = BetterSqlite3 as { new (filename: string): CompanionConnection };

// Only this disposable test profile may be seeded. No production mutation IPC is exposed.
const profile = path.resolve(process.argv[2]!), root = path.dirname(profile), mode = process.argv[3], output = process.argv[4]!;
if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-social-observer-')) throw new Error('Unexpected observation fixture profile.');
const databasePath = path.join(profile, 'companions/messages.sqlite');
let store = new CompanionsStore(databasePath);
function seedActions() {
  const group = store.request({ type: 'conversation.create-group', title: '一起做点小事', memberIds: ['deepseek-sister', 'deepseek-flash'] }).conversation!;
  const source = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '这是独立界面验收用的合成任务记录。', replyDirective: 'none' });
  const specs = [
    { title: '整理周末的旅行清单', status: 'running' as const }, { title: '核对海边天气资料', status: 'running' as const },
    { title: '制作音乐播放列表', status: 'queued' as const }, { title: '整理散步照片', status: 'queued' as const },
    { title: '确认导出的位置', status: 'running' as const, stage: 'waiting_approval' },
    { title: '继续昨天的读书笔记', status: 'interrupted' as const },
    { title: '已经完成的小安排', status: 'succeeded' as const },
  ];
  const actions = specs.map(spec => store.createAction({ ...spec, companionId: 'deepseek-sister', conversationId: group.id, sourceMessageId: source.id },
    spec.status === 'interrupted' ? { prompt: '这是用于工作概览的合成恢复记录。', waitForActionIds: [], supplements: [] } : undefined));
  const other = store.createAction({ title: '妹妹自己的探索清单', status: 'running', companionId: 'deepseek-flash', conversationId: group.id, sourceMessageId: source.id });
  let orders = store.request({ type: 'work-order.list', companionId: 'deepseek-sister', conversationId: group.id, includeHistory: true }).workOrderPage!.items;
  // A synthetic interrupted task is inspected, never resumed by the real runner.
  for (const order of orders.filter(order => order.status === 'accepted')) store.request({ type: 'work-order.pause', companionId: order.companionId, conversationId: group.id, id: order.id, expectedRevision: order.revision, paused: true });
  orders = store.request({ type: 'work-order.list', companionId: 'deepseek-sister', conversationId: group.id, includeHistory: true }).workOrderPage!.items;
  return { fixtureKind: 'synthetic_action_fixture', conversationId: group.id, actions, orders, other };
}
function seedWorkLife() {
  for (const companion of store.request({ type: 'state' }).state!.companions) store.request({ type: 'companion.update', id: companion.id, companion: { name: companion.name, description: companion.description, persona: companion.persona, avatar: companion.avatar, model: companion.model, proactive: false } });
  const companionId = 'deepseek-sister', room = store.openPrivate(companionId);
  const order = store.request({ type: 'work-order.create', companionId, conversationId: room.id, title: '整理海边旅行手记', instruction: '按日期整理已有手记，保留原文引用与照片说明。\n这是只验证工作台界面的合成工作单，不代表任务已经执行。', clientId: 'work-life-player-order' }).workOrder!;
  const paused = store.request({ type: 'work-order.pause', companionId, conversationId: room.id, id: order.id, expectedRevision: order.revision, paused: true }).workOrder!;
  return { fixtureKind: 'synthetic_paused_work_order', companionId, conversationId: room.id, order: paused };
}
function seedSocial() {
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 1440, timeZone: 'UTC' } });
  store.close();
  // Seed only a stopped isolated clock anchor. Thereafter all calendar results use the real host clock.
  const db = new Database(databasePath), row = db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string };
  const state = JSON.parse(row.data), now = Date.now(); state.cursor = now; state.settings.revision++;
  state.anchors = [{ realAt: now, virtualAt: Date.parse('2032-04-12T09:00:00Z'), settings: state.settings }];
  db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(state)); db.close();
  store = new CompanionsStore(databasePath);
  const contacts = store.request({ type: 'state' }).state!.companions.map(item => item.id);
  const pair = ['deepseek-sister', 'deepseek-flash'];
  const room = (members: string[], title: string) => store.request({ type: 'social.conversation.ensure', companionId: members[0]!, memberIds: members, title }).socialConversation!;
  const append = (conversationId: string, authorId: string, content: string, virtualCreatedAt: string, clientId: string, replyToId?: string) => store.request({ type: 'social.message.append', conversationId, authorId, content, virtualCreatedAt, clientId, ...(replyToId ? { replyToId } : {}) }).socialMessage!;
  let count = 0;
  for (let left = 0; left < contacts.length && count < 22; left++) for (let right = left + 1; right < contacts.length && count < 22; right++) {
    const members = [contacts[left]!, contacts[right]!]; if (members.every(id => pair.includes(id))) continue;
    const conversation = room(members, '日常来信 ' + String(count + 1).padStart(2, '0'));
    append(conversation.id, members[0]!, ['今天整理了书架，翻到了以前很喜欢的那本书。', '刚听到一首合适放松的歌，下次一起听吧。', '我打算晚一点在自己的小屋读会儿书。', '今天做了新的小点心，下次有机会让你尝尝。', '刚刚看到一片很好看的云，想跟你分享。'][count % 5]!, '2032-04-12T08:00:00Z', 'fixture-list-' + count++);
  }
  const previous = room(['gpt', 'kimi'], '昨天的读书话题');
  append(previous.id, 'kimi', '昨天提到的那本书，我读到新的章节了。', '2032-04-11T16:00:00Z', 'fixture-previous-day');
  const privateRoom = room(pair, '海边散步与音乐');
  const first = append(privateRoom.id, pair[0]!, '我们可以先聊聊海边散步，再选一首音乐。', '2032-04-12T09:00:00Z', 'fixture-private-first');
  for (let index = 1; index <= 64; index++) append(privateRoom.id, pair[index % 2]!, index === 25 ? '风铃主题：我想在窗边挂一串小风铃。' : index % 2 ? '我找到了新的旋律，第 ' + index + ' 段想一起听听。' : '听起来不错，第 ' + index + ' 个小想法也记在自己的手帐里。', new Date(Date.parse('2032-04-12T09:00:00Z') + index * 60000).toISOString(), 'fixture-private-' + index);
  const group = room([...pair, 'gemini'], '周末的小小音乐会');
  for (const [index, authorId] of [...pair, 'gemini', pair[0]!].entries()) append(group.id, authorId!, ['周末想一起听听轻音乐。', '我来选一首轻快的！', '可以留一点安静的间奏。', '好呀，大家各自选自己喜欢的曲子。'][index]!, '2032-04-12T10:20:00Z', 'fixture-group-' + index);
  const latest = append(privateRoom.id, pair[1]!, '等风小一点，我们再沿着海边慢慢走。', '2032-04-12T10:30:00Z', 'fixture-private-last', first.message.id);
  const player = store.openPrivate(pair[0]!), privateFact = '有空的时候，记得给自己留一点放松的时间。';
  store.appendMessage({ conversationId: player.id, authorId: 'user', content: privateFact, replyDirective: 'none' });
  // This preview uses a real pending invitation, not a painted graph status. No model runs.
  store.setCompanionActive('deepseek-sister', true);
  const guest = store.openPrivate('deepseek-flash');
  const invitation = store.appendMessage({ conversationId: guest.id, authorId: 'user', content: '去找姐姐坐坐吧，先问问她是否方便。', replyDirective: 'none' });
  store.request({ type: 'world.tool', companionId: 'deepseek-flash', conversationId: guest.id, sourceMessageId: invitation.id, arguments: { action: 'visit', targetCompanionId: 'deepseek-sister', reason: '现在方便吗？想过来和你坐坐。' } });
  return { fixtureKind: 'synthetic_peer_records', virtualDay: '2032-04-12', previousDay: '2032-04-11', privateId: privateRoom.id, groupId: group.id, firstId: first.message.id, latestId: latest.message.id, privateFact };
}
function seedSocialScale() {
  seedSocial(); const template = store.request({ type: 'state' }).state!.companions[0]!;
  store.close();
  const db = new Database(databasePath), at = new Date().toISOString();
  db.transaction(() => {
    const person = db.prepare('INSERT INTO companions(id,data) VALUES(?,?)'), room = db.prepare("INSERT INTO conversations(id,kind,title,updated_at,hidden_at) VALUES(?,'group',?,?,?)"), member = db.prepare('INSERT INTO conversation_members VALUES(?,?)'), relation = db.prepare('INSERT INTO companion_social_conversations VALUES(?,?)');
    for (let index = 0; index < 20000; index++) {
      const id = 'scale_' + String(index).padStart(5, '0'), roomId = 'scale_room_' + index;
      person.run(id, JSON.stringify({ ...template, id, name: '关系对象 ' + index, description: '隔离测试用关系对象', avatar: 'custom', active: false, builtin: false, proactive: false }));
      room.run(roomId, '隔离压力测试关系 ' + index, at, at); member.run(roomId, 'deepseek-flash'); member.run(roomId, id); relation.run(roomId, 'deepseek-flash|' + id);
    }
  }).immediate(); db.close(); store = new CompanionsStore(databasePath);
  const graph = store.request({ type: 'social.graph', companionId: 'deepseek-flash' }).socialGraph!;
  store.request({ type: 'social.message.append', conversationId: 'scale_room_19999', authorId: 'scale_19999', content: '这条实际来信来自当前画布之外的关系对象。', virtualCreatedAt: graph.virtualNow, clientId: 'scale_latest_actual' });
  return { fixtureKind: 'synthetic_20000_relations', relationshipCount: graph.total! };
}
try { writeFileSync(output, JSON.stringify(mode === 'actions' ? seedActions() : mode === 'work-life' ? seedWorkLife() : mode === 'social-scale' ? seedSocialScale() : seedSocial())); }
finally { store.close(); }
