import { FINAL_QUESTION_ID } from './core.mjs';

// IDs refer to the original bank. Text is always read from that bank, never
// copied or rewritten. These 98 questions form the fixed concise selection.
export const CONCISE_TOPICS = [
  { name: '日常与喜好', ids: ['1', '2', '6', '7', '15', '16', '18', '21', '29', '41', '106', '116'] },
  { name: '内心与情绪', ids: ['22', '26', '30', '34', '39', '47', '76', '79', '82', '90', '113', '119'] },
  { name: '心动与表达', ids: ['38', '50', '57', '62', '68', '87', '98', '117', '139', '171', '273', '298'] },
  { name: '沟通与冲突', ids: ['35', '71', '94', '128', '129', '158', '173', '190', '254', '282', '283', '291', '296', '317'] },
  { name: '独立与边界', ids: ['33', '55', '60', '72', '73', '89', '137', '148', '149', '150', '174', '269', '305', '309'] },
  { name: '现实与金钱', ids: ['107', '121', '151', '166', '205', '206', '208', '330', '333', '745', '749', '752'] },
  { name: '家庭与未来', ids: ['56', '84', '188', '189', '196', '319', '321', '324', '325', '725', '740', '809', '812'] },
  { name: '成长与承诺', ids: ['28', '49', '75', '88', '97', '180', '302', '315', '352'] }
];

export const CONCISE_QUESTION_IDS = [...CONCISE_TOPICS.flatMap(topic => topic.ids), FINAL_QUESTION_ID];
export const EDITION_PREFERENCE_KEY = 'before-we-become-us:edition:v1';
export const EDITIONS = {
  concise: {
    label: '精简版', count: 99,
    storageKey: 'before-we-become-us:progress:concise:v1',
    description: '精选 98 个问题，再留一句心意给最后。'
  },
  full: {
    label: '完整版', count: 999,
    // Keep the deployed key, question array and fingerprint unchanged so all
    // existing full-edition progress continues without a migration or reset.
    storageKey: 'before-we-become-us:progress:v2',
    description: '完整 998 个问题，把了解彼此的时间拉长。'
  }
};

export const isEdition = key => typeof key === 'string' && Object.hasOwn(EDITIONS, key);

export function initialEdition({ requested, remembered, hasLegacyProgress = false } = {}) {
  if (isEdition(requested)) return requested;
  if (isEdition(remembered)) return remembered;
  return hasLegacyProgress ? 'full' : 'concise';
}

export function editionBank(bank, edition) {
  if (!isEdition(edition)) throw new RangeError('Unknown question edition');
  if (edition === 'full') return bank;
  const byId = new Map(bank.questions.map(question => [question.id, question]));
  return {
    version: bank.version,
    title: '确定关系前的 99 问',
    questions: CONCISE_QUESTION_IDS.map(id => {
      const question = byId.get(id);
      if (!question) throw new Error(`精简版所需原题号 ${id} 不在题库中。`);
      return question;
    })
  };
}

export function questionNumber(questions, edition, question) {
  return edition === 'full' ? question.id : String(questions.findIndex(item => item.id === question.id) + 1);
}

export function questionTopic(id) {
  return CONCISE_TOPICS.find(topic => topic.ids.includes(id))?.name ?? '最后一份心意';
}
