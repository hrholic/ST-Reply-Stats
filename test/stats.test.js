import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRate, elapsedSeconds, formatBodyTags, makeBodyTagPattern, makeLabel, parseBodyTags, requestOutput, StreamTimer } from '../stats.js';

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
    const tags = parseBodyTags(' <answer.v2>，ANSWER.V2, <final+/> ');
    assert.deepEqual(tags, ['answer.v2', 'final+']);
    assert.equal(makeBodyTagPattern(tags).test('<answer.v2 mode="short">'), true);
    assert.equal(makeBodyTagPattern(tags).test('<answerXv2>'), false);
    assert.equal(makeBodyTagPattern(tags).test('<final+>'), true);
});

test('normalizes spaces and old comma separators for settings', () => {
    assert.equal(formatBodyTags(' content, context，<answer>\nCONTENT '), 'content context answer');
});

test('does not match words, partial tags, closing tags, or absent tags', () => {
    const pattern = makeBodyTagPattern(['content']);
    assert.equal(pattern.test('content <contentious> </content> <content'), false);
    const value = timer();
    value.update('plain answer without a body tag', 1000, 3);
    assert.deepEqual(value.take({ type: 'normal', chatId: 'chat-a', messageId: 3 }), {
        tagAt: null,
    });
});

test('accepts a tag in the first stream update when later stream evidence follows', () => {
    const value = timer();
    value.update('<content>answer', 1000, 5);
    value.update('<content>answer continues', 1200, 5);
    const result = value.take({ type: 'normal', chatId: 'chat-a', messageId: 5 });
    assert.equal(result.tagAt, 1000);
});

test('accepts empty body events from a separately streamed reasoning phase', () => {
    const value = timer();
    value.update('', 4000, 5);
    value.update('', 6000, 5);
    value.update('<content>正文开始', 8000, 5);
    assert.equal(value.take({ type: 'normal', chatId: 'chat-a', messageId: 5 }).tagAt, 8000);
});

test('freezes at the first complete tag across pre-tag, tag, post-tag, and final events', () => {
    const value = timer();
    value.update('池选取。\n-->', 4000, 5);
    value.update('池选取。\n-->\n\n<content>\n湘妃', 8000, 5);
    assert.equal(value.current.tagAt, 8000);
    value.update('池选取。\n-->\n\n<content>\n湘妃竹杆兼', 20000, 5);
    assert.equal(value.current.tagAt, 8000);
    value.update('池选取。\n-->\n\n<content>\n湘妃竹杆兼，正文结束。', 30000, 5);
    assert.equal(value.current.tagAt, 8000);
    const result = value.take({ type: 'normal', chatId: 'chat-a', messageId: 5 });
    assert.equal(elapsedSeconds(0, result.tagAt), 8);
});

test('does not use a lone final full-text event as the tag arrival time', () => {
    const value = timer();
    value.update('池选取。\n-->\n\n<content>\n完整正文', 30000, 5);
    assert.equal(value.take({ type: 'normal', chatId: 'chat-a', messageId: 5 }).tagAt, null);
});

test('cancel and a new generation prevent timing from leaking between turns', () => {
    const value = timer();
    value.update('old <content>', 1000, 1);
    value.cancel();
    assert.equal(value.take({ type: 'normal', chatId: 'chat-a', messageId: 1 }), null);
    value.start({ type: 'swipe', chatId: 'chat-b', tags: ['content'] });
    value.update('new <content>', 2000, 2);
    value.update('new <content> body', 2100, 2);
    assert.equal(value.take({ type: 'swipe', chatId: 'chat-b', messageId: 2 }).tagAt, 2000);
});

test('display keeps original metrics and adds thinking and total duration', () => {
    assert.equal(makeLabel({ input: 12000, output: 860, tps: 32, thinking: 8, total: 30 }),
        '≈入12k · 出860 · 流32t/s · 思8.0s · 总30.0s');
    assert.equal(makeLabel({ input: 1, output: 2, tps: 3, thinking: null, total: 30 }),
        '≈入1 · 出2 · 流3t/s · 思— · 总30.0s');
});

test('original elapsed, rate, and continuation token metrics remain unchanged', () => {
    assert.equal(elapsedSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z'), 2);
    assert.equal(computeRate(64, 2), 32);
    assert.equal(requestOutput(860, null, 'normal'), 860);
    assert.equal(requestOutput(1000, 860, 'continue'), 140);
    assert.equal(requestOutput(800, 860, 'continue'), null);
});
