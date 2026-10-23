/** Authored identity facts are distinct from friendship, affection and model guesses. */
export const COMPANION_CHARACTER_RELATIONS = [
  { subjectId: 'deepseek-flash', relation: 'elder_sister', label: '姐姐', targetId: 'deepseek-sister', targetName: '大肥鱼' },
  { subjectId: 'deepseek-sister', relation: 'younger_sister', label: '妹妹', targetId: 'deepseek-flash', targetName: '小肥鱼' },
] as const;
