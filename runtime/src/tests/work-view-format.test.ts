import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWorkView } from '../presentation/work-view-format.js';
import type { WorkView, WorkViewResult } from '../domain/work-view.js';

function fixture(): WorkViewResult & { kind: 'snapshot' } {
  return { kind: 'snapshot', cursor: 'opaque', view: {
    schemaVersion: 1, workId: 'work-local', revision: 4, goalRevision: 1, level: 'conversation', title: '문서 비교',
    mode: { requested: 'auto', strategy: 'direct', pending: null, revision: 1 }, reply: { channel: 'cli', observingPrimary: true },
    progress: { status: 'waiting', reason: '담당자 회신을 기다립니다.', updatedAt: 1000, activeAttempts: 0, activeModels: 0,
      analysisReady: true, resultReady: true, resultDelivery: 'unknown', pendingQuestions: 0 },
    messages: [{ id: 'result', kind: 'result', text: '근거를 확인했습니다.', deliveryStatus: 'unknown' }],
  } };
}

test('human work view labels prepared outputs and never turns unknown delivery into delivered or read', () => {
  for (const status of ['pending', 'sending', 'unknown', 'failed'] as const) {
    const value = fixture(); value.view.progress.resultDelivery = status; value.view.messages[0]!.deliveryStatus = status;
    const output = formatWorkView(value); assert.match(output, /준비된 답변/); assert.match(output, /근거를 확인했습니다/);
    assert.doesNotMatch(output, /전달 확인\]|읽음|전달 완료/);
    if (status === 'unknown') assert.match(output, /전달 여부 미확인/);
  }
  const question = fixture(); question.view.messages[0]!.kind = 'question';
  assert.match(formatWorkView(question), /준비된 질문 · 전달 여부 미확인/);
});

test('human work view keeps stored completion separate from a currently invalid result', () => {
  const value = fixture(); value.view.progress.status = 'completed'; value.view.progress.resultReady = false;
  value.view.progress.resultDelivery = 'unavailable'; value.view.messages = [];
  const output = formatWorkView(value); assert.match(output, /저장된 업무는 완료 · 현재 결과 재확인 필요/);
  assert.match(output, /현재 전달 정보 확인 불가/); assert.doesNotMatch(output, /결과 준비됨/);
});

test('human work view strips terminal controls and gives a bounded status reason without replaying diagnostics', () => {
  const value = fixture(); value.view.title = '\u001b]52;c;fixture\u0007\r\u202eevil'; value.view.progress.status = 'blocked';
  value.view.progress.reason = '추가 근거가 필요합니다.\u0000'; value.view.messages = [];
  const output = formatWorkView(value); assert.doesNotMatch(output, /[\u0000\u0007\u001b\r\u202e]/); assert.match(output, /확인할 사항: 추가 근거가 필요합니다/);
  assert.doesNotMatch(output, /실행 진단|activeAttempts|updatedAt/);
  const waiting = fixture(); waiting.view.progress.pendingQuestions = 1;
  waiting.view.messages = [{ id: 'question', kind: 'question', text: '확인할 기간을 알려주세요.', deliveryStatus: 'delivered' }];
  assert.match(formatWorkView(waiting), /확인할 기간을 알려주세요/); assert.doesNotMatch(formatWorkView(waiting), /확인할 사항:/);
});

test('human work view makes observing another reply route explicit and keeps unchanged output quiet', () => {
  const value = fixture(); value.view.reply = { channel: 'web', observingPrimary: false };
  value.view.mode.pending = 'deep'; assert.match(formatWorkView(value), /답변 채널: web/); assert.match(formatWorkView(value), /모드 변경 대기: 깊게/);
  assert.equal(formatWorkView({ kind: 'unchanged', cursor: 'opaque' }), '표시 내용에 변경이 없습니다.\n');
  const detail: NonNullable<WorkView['diagnostics']> = { events: [], omittedEvents: 0 }; value.view.diagnostics = detail;
  assert.match(formatWorkView(value), /실행 진단/);
});
