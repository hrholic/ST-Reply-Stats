import { itemizedPrompts } from '../../../itemized-prompts.js';
import { computeRate, elapsedSeconds, flattenPrompt, makeLabel, makeTitle, requestOutput } from './stats.js';

const META_KEY = 'reply_token_stats';
const IGNORED_TYPES = new Set(['impersonate', 'quiet', 'first_message']);

function context() {
    return globalThis.SillyTavern?.getContext?.();
}

async function tokenCount(text) {
    if (!text) return null;
    try {
        const value = await context()?.getTokenCountAsync?.(text, 0);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch (error) {
        console.warn('[Reply Token Stats] Token estimate failed.', error);
        return null;
    }
}

async function estimateInput(messageId) {
    const prompt = Array.isArray(itemizedPrompts)
        ? itemizedPrompts.find(item => Number(item?.mesId) === Number(messageId))
        : null;
    if (!prompt) return null;

    if (Number.isSafeInteger(prompt.oaiTotalTokens) && prompt.oaiTotalTokens > 0) {
        return prompt.oaiTotalTokens;
    }

    const source = prompt.main_api === 'openai' ? prompt.rawPrompt : (prompt.finalPrompt ?? prompt.rawPrompt);
    const estimate = await tokenCount(typeof source === 'string' ? source : flattenPrompt(source));
    if (estimate === null) return null;

    // Chat framing varies by provider; a tiny overhead keeps this visibly an estimate.
    return Array.isArray(prompt.rawPrompt) ? estimate + prompt.rawPrompt.length * 4 + 3 : estimate;
}

function isAssistantMessage(message) {
    return message && !message.is_user && !message.is_system;
}

function store(message, stats) {
    message.extra ??= {};
    message.extra[META_KEY] = stats;

    const swipe = message.swipe_info?.[message.swipe_id];
    if (swipe) {
        swipe.extra ??= {};
        swipe.extra[META_KEY] = { ...stats };
    }
}

function renderMessage(messageId) {
    const message = context()?.chat?.[messageId];
    if (!isAssistantMessage(message)) return;

    const messageElement = document.querySelector(`.mes[mesid="${Number(messageId)}"]`);
    const name = messageElement?.querySelector('.name_text');
    if (!name) return;

    let slot = messageElement.querySelector('.reply-token-stats-slot');
    if (!slot) {
        slot = document.createElement('span');
        slot.className = 'reply-token-stats-slot';
        slot.setAttribute('role', 'note');
        const label = document.createElement('span');
        label.className = 'reply-token-stats';
        slot.append(label);
    }
    name.insertAdjacentElement('afterend', slot);
    const display = slot.querySelector('.reply-token-stats');

    const stats = message.extra?.[META_KEY] ?? null;
    display.textContent = makeLabel(stats);
    slot.title = makeTitle(stats);
    slot.setAttribute('aria-label', slot.title.replaceAll('\n', '；'));
}

function renderAll() {
    const chat = context()?.chat ?? [];
    chat.forEach((_, messageId) => renderMessage(messageId));
}

async function finalizeMessage(messageId, type) {
    const ctx = context();
    const message = ctx?.chat?.[messageId];
    if (!isAssistantMessage(message) || IGNORED_TYPES.has(type)) return;

    const previousStats = message.extra?.[META_KEY];
    const nativeOutput = message.extra?.token_count;
    const totalOutput = Number.isSafeInteger(nativeOutput) && nativeOutput >= 0
        ? nativeOutput
        : await tokenCount(`${message.extra?.reasoning ?? ''}${message.mes ?? ''}`);
    const output = requestOutput(totalOutput, previousStats?.totalOutput, type);
    const input = await estimateInput(messageId);
    const seconds = elapsedSeconds(message.gen_started, message.gen_finished);
    const stats = { v: 1, input, output, tps: computeRate(output, seconds), totalOutput };

    store(message, stats);
    renderMessage(messageId);
    Promise.resolve(ctx.saveChat?.()).catch(error => {
        console.warn('[Reply Token Stats] Could not persist message stats.', error);
    });
}

function deferRenderAll() {
    requestAnimationFrame(renderAll);
}

function init() {
    const ctx = context();
    if (!ctx?.eventSource || !ctx?.eventTypes) {
        console.warn('[Reply Token Stats] SillyTavern context is unavailable.');
        return;
    }

    const { eventSource, eventTypes } = ctx;
    eventSource.on(eventTypes.MESSAGE_RECEIVED, finalizeMessage);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, renderMessage);
    eventSource.on(eventTypes.MESSAGE_SWIPED, renderMessage);
    eventSource.on(eventTypes.MESSAGE_UPDATED, renderMessage);
    eventSource.on(eventTypes.CHAT_CHANGED, deferRenderAll);
    eventSource.on(eventTypes.CHAT_LOADED, deferRenderAll);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, deferRenderAll);
    renderAll();
}

init();
