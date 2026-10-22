// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeMessage } from './message.def';

// gugu-dev#181 ⑨:宿主替主人交来的回答(`<gugu_question_answer>`)在会话里是一行「你回答了：X」,❌ 原样的 XML 气泡。
const answered = '<gugu_question_answer>\n{"question_id":"agent-question:1","state":"answered","questions":["Which Node?"],"answers":[{"selected":["PATH"]},{"selected":[],"other":"node 24"}]}\n</gugu_question_answer>\nThe owner explicitly submitted these answers in Gugu.';

describe('the owner\'s answer to an agent\'s question', () => {
  it('is read off a user message as what was answered', () => {
    expect(normalizeMessage({ kind: 'message', id: 'm1', role: 'user', text: answered }).questionAnswer).toEqual({ answer: 'PATH / node 24' });
  });

  it('only from the user\'s side: an agent quoting the block is just its reply', () => {
    expect(normalizeMessage({ kind: 'message', id: 'm2', role: 'assistant', text: answered }).questionAnswer).toBeUndefined();
  });

  it('ordinary words stay ordinary', () => {
    expect(normalizeMessage({ kind: 'message', id: 'm3', role: 'user', text: 'PATH' }).questionAnswer).toBeUndefined();
  });
});
