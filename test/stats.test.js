import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRate, elapsedSeconds, makeBodyTagPattern, makeLabel, parseBodyTags, requestOutput, StreamTimer } from '../stats.js';

function timer(tags = ['content', 'context']) {
    const value = new StreamTimer();
    value.start({ type: 'normal', chatId: 'chat-a', tags });
    return value;
}

test('finds default tags across cumulative stream updates', () => {
    const value = timer();
    value.update('thinking <con', 1000, 7);
    value.update('thinking <content>', 2300, 7);
    assert.deepEqual(value.take({ type: 'normal', chatId: 'chat-a', messageId: 7 }), {
        firstAt: 1000,
        tagAt: 2300,
    });
});

test('finds context across incremental chunks, case-insensitively', () => {
    const value = timer();
    value.update('notes <CON', 1000, 7);
    value.update('TEXT data-x="1">body', 1600, 7);
    assert.equal(value.take({ type: 'normal', chatId: 'chat-a', messageId: 7 }).tagAt, 1600);
});

test('supports custom literal tags and escaped regular-expression characters', () => {
    const tags = parseBodyTags(' answer.v2，ANSWER.V2, final+ ');
    assert.deepEqual(tags, ['answer.v2', 'final+']);
    assert.equal(makeBodyTagPattern(tags).test('<answer.v2 mode="short">'), true);
    assert.equal(makeBodyTagPattern(tags).test('<answerXv2>'), false);
    assert.equal(makeBodyTagPattern(tags).test('<final+>'), true);
});

test('does not match words, partial tags, closing tags, or absent tags', () => {
    const pattern = makeBodyTagPattern(['content']);
    assert.equal(pattern.test('content <contentious> </content> <content'), false);
    const value = timer();
    value.update('plain answer without a body tag', 1000, 3);
    assert.deepEqual(value.take({ type: 'normal', chatId: 'chat-a', messageId: 3 }), {
        firstAt: 1000,
        tagAt: null,
    });
});

test('tag in the first non-empty stream update records zero observable thinking time', () => {
    const value = timer();
    value.update('   ', 900, 5);
    value.update('<content>answer', 1000, 5);
    const result = value.take({ type: 'normal', chatId: 'chat-a', messageId: 5 });
    assert.equal((result.tagAt - result.firstAt) / 1000, 0);
});

test('cancel and a new generation prevent timing from leaking between turns', () => {
    const value = timer();
    value.update('old <content>', 1000, 1);
    value.cancel();
    assert.equal(value.take({ type: 'normal', chatId: 'chat-a', messageId: 1 }), null);
    value.start({ type: 'swipe', chatId: 'chat-b', tags: ['content'] });
    value.update('new <content>', 2000, 2);
    assert.equal(value.take({ type: 'swipe', chatId: 'chat-b', messageId: 2 }).firstAt, 2000);
});

test('display keeps original metrics and adds compact first/thinking fields', () => {
    assert.equal(makeLabel({ input: 12000, output: 860, tps: 32, first: 1.24, thinking: 12.34 }),
        '≈入12k·出860·流32t/s·首1.2s·思 12.3s');
    assert.equal(makeLabel({ input: 1, output: 2, tps: 3, first: null, thinking: null }),
        '≈入1·出2·流3t/s·首—·思 —');
});

test('original elapsed, rate, and continuation token metrics remain unchanged', () => {
    assert.equal(elapsedSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z'), 2);
    assert.equal(computeRate(64, 2), 32);
    assert.equal(requestOutput(860, null, 'normal'), 860);
    assert.equal(requestOutput(1000, 860, 'continue'), 140);
    assert.equal(requestOutput(800, 860, 'continue'), null);
});
