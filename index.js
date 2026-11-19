import { AutoRetry, retryLimit, isCompletedReply } from './auto-retry.js?v=0.2.12';
import { itemizedPrompts } from '../../../itemized-prompts.js';
import { computeRate, elapsedSeconds, flattenPrompt, formatBodyTags, makeLabelParts, makeTitle, parseBodyTags, requestOutput, StreamTimer } from './stats.js?v=0.2.12';

const META_KEY = 'reply_token_stats';
const SETTINGS_KEY = 'st_reply_stats';
const DEFAULT_BODY_TAGS = 'content context';
const IGNORED_TYPES = new Set(['impersonate', 'quiet', 'first_message']);
const streamTimer = new StreamTimer();
const autoRetry = new AutoRetry({
    context,
    enabled: () => settings().autoRetry,
    limit: () => settings().retryLimit,
    storage: {
        getItem: key => globalThis.localStorage.getItem(key),
        setItem: (key, value) => globalThis.localStorage.setItem(key, value),
    },
    busy: () => Boolean(
        context()?.streamingProcessor != null
        || document.body?.dataset.generating === 'true'
        || document.body?.dataset.swiping === 'true'
        || document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea')
    ),
    regenerate: () => {
        const generate = context()?.generate;
        if (typeof generate !== 'function') throw new Error('酒馆原生重生接口不可用');
        return generate('regenerate');
    },
    notify: notifyStatus,
});

function notifyStatus(text, error = false) {
    const toast = globalThis.toastr?.[error ? 'warning' : 'info'];
    if (typeof toast === 'function') { toast(text, '回复速率', { timeOut: 8000 }); return; }
    // Non-blocking fallback when a mobile theme/plugin does not expose toastr.
    const note = document.createElement('div');
    note.setAttribute('role', 'status');
    note.textContent = text;
    Object.assign(note.style, { position: 'fixed', bottom: '24px', left: '5%', width: '90%',
        zIndex: '2147483647', padding: '12px', background: '#252525', color: '#fff',
        borderRadius: '8px', pointerEvents: 'none' });
    document.body.append(note);
    setTimeout(() => note.remove(), 8000);
}

function context() {
    return globalThis.SillyTavern?.getContext?.();
}

function settings() {
    const all = context()?.extensionSettings;
    if (!all) return { bodyTags: DEFAULT_BODY_TAGS, showStats: true, autoRetry: false, retryLimit: 3 };
    const value = all[SETTINGS_KEY] ??= {};
    if (typeof value.bodyTags !== 'string') value.bodyTags = DEFAULT_BODY_TAGS;
    if (typeof value.showStats !== 'boolean') value.showStats = true;
    if (typeof value.autoRetry !== 'boolean') value.autoRetry = false;
    value.retryLimit = retryLimit(value.retryLimit);
    return value;
}

async function tokenCount(text) {
    if (!text) return null;
    try {
        const value = await Promise.race([
            Promise.resolve(context()?.getTokenCountAsync?.(text, 0)),
            new Promise(resolve => setTimeout(() => resolve(null), 3000)),
        ]);
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
    const total = elapsedSeconds(message.gen_started, message.gen_finished);
    const displayStats = (stats || total !== null) ? { ...stats, total: stats?.total ?? total } : null;
    const [beforeRate, rate, afterRate] = makeLabelParts(displayStats);
    const rateValue = document.createElement('span');
    rateValue.textContent = rate;
    if (Number.isFinite(displayStats?.tps) && displayStats.tps > 80) {
        rateValue.className = 'reply-token-stats-rate-high';
    }
    display.replaceChildren(beforeRate, rateValue, afterRate);
    slot.title = makeTitle(displayStats);
    slot.setAttribute('aria-label', slot.title.replaceAll('\n', '；'));
    slot.style.display = settings().showStats ? '' : 'none';
}

function renderAll() {
    const chat = context()?.chat ?? [];
    chat.forEach((_, messageId) => renderMessage(messageId));
}

async function finalizeMessage(messageId, type) {
    const ctx = context();
    const retryRun = autoRetry.run;
    const message = ctx?.chat?.[messageId];
    if (!isAssistantMessage(message) || IGNORED_TYPES.has(type)) return;

    const completed = isCompletedReply(message, ctx.streamingProcessor);
    const timing = streamTimer.take({ type, chatId: ctx.chatId, messageId });

    const originalReply = JSON.stringify([message.mes, message.swipe_id ?? 0, message.gen_started]);
    const previousStats = message.extra?.[META_KEY];
    const nativeOutput = message.extra?.token_count;
    const totalOutput = Number.isSafeInteger(nativeOutput) && nativeOutput >= 0
        ? nativeOutput
        : await tokenCount(`${message.extra?.reasoning ?? ''}${message.mes ?? ''}`);
    const output = requestOutput(totalOutput, previousStats?.totalOutput, type);
    const input = await estimateInput(messageId);
    const seconds = elapsedSeconds(message.gen_started, message.gen_finished);
    const thinking = timing?.tagAt == null ? null : elapsedSeconds(message.gen_started, timing.tagAt);
    const stats = { v: 3, input, output, tps: computeRate(output, seconds), thinking, total: seconds, totalOutput };

    if (context()?.chat !== ctx.chat || ctx.chat[messageId] !== message
        || JSON.stringify([message.mes, message.swipe_id ?? 0, message.gen_started]) !== originalReply) return;
    store(message, stats);
    renderMessage(messageId);
    if (completed) autoRetry.consider(retryRun, messageId, message, stats.tps);
    else autoRetry.status = '本轮未完整成功生成，不按超速删除或重试';
    Promise.resolve(ctx.saveChat?.()).catch(error => {
        console.warn('[Reply Token Stats] Could not persist message stats.', error);
    });
}

function deferRenderAll() {
    requestAnimationFrame(renderAll);
}

async function editBodyTags() {
    const ctx = context();
    if (!ctx?.Popup || !ctx?.POPUP_TYPE) return;
    const current = settings();
    const status = autoRetry.status.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const popup = new ctx.Popup(`回复统计 v0.2.12 · 正文标签（空格分隔）<br><small>${status}</small>`, ctx.POPUP_TYPE.INPUT, formatBodyTags(current.bodyTags), {
        placeholder: DEFAULT_BODY_TAGS,
        customInputs: [{
            id: 'reply-token-stats-show',
            label: '正文显示统计',
            type: 'checkbox',
            defaultState: current.showStats,
        }, {
            id: 'reply-token-stats-auto-retry',
            label: '超过 80 自动删除并重生（会额外消耗 API）',
            type: 'checkbox', defaultState: current.autoRetry,
        }, {
            id: 'reply-token-stats-retry-limit',
            label: '每轮最多自动重试次数（不含最初回复）',
            type: 'number', min: 1, step: 1, defaultState: String(current.retryLimit),
        }, {
            id: 'reply-token-stats-restore',
            label: '恢复上次自动删除的回复（替换当前末条；仅限未继续聊天时）',
            type: 'checkbox', defaultState: false,
        }],
    });
    const value = await popup.show();
    if (typeof value !== 'string') return;
    const limit = Number(popup.inputResults?.get('reply-token-stats-retry-limit'));
    if (!Number.isSafeInteger(limit) || limit < 1) {
        globalThis.toastr?.warning?.('重试次数请填写大于或等于 1 的整数；本次设置未保存。');
        return;
    }
    current.retryLimit = limit;
    current.bodyTags = formatBodyTags(value);
    current.showStats = popup.inputResults?.get('reply-token-stats-show') !== false;
    current.autoRetry = popup.inputResults?.get('reply-token-stats-auto-retry') === true;
    ctx.saveSettingsDebounced?.();
    if (popup.inputResults?.get('reply-token-stats-restore') === true) {
        try { await autoRetry.restore(); }
        catch (error) { globalThis.toastr?.warning?.(error.message); }
    }
    renderAll();
}

function initWandMenu() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu || document.querySelector('#reply-token-stats-wand-container')) return;

    const container = document.createElement('div');
    container.id = 'reply-token-stats-wand-container';
    container.className = 'extension_container';
    const item = document.createElement('div');
    item.id = 'reply-token-stats-body-tags';
    item.className = 'list-group-item flex-container flexGap5';
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-tag extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = '思考链时间';
    item.append(icon, label);
    item.addEventListener('click', editBodyTags);
    container.append(item);
    menu.prepend(container);
}

function init() {
    const ctx = context();
    if (!ctx?.eventSource || !ctx?.eventTypes) {
        console.warn('[Reply Token Stats] SillyTavern context is unavailable.');
        return;
    }

    const { eventSource, eventTypes } = ctx;
    // Core awaits event handlers. Stats must never become a dependency of generation.
    const on = (event, handler) => {
        if (!event) return;
        eventSource.on(event, (...args) => {
            try {
                Promise.resolve(handler(...args)).catch(error => {
                    console.warn('[Reply Token Stats] Listener failed; generation is unaffected.', error);
                });
            } catch (error) {
                console.warn('[Reply Token Stats] Listener failed; generation is unaffected.', error);
            }
            // Intentionally return undefined, never the observer's Promise.
        });
    };
    on(eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
        autoRetry.start(type, dryRun);
        if (dryRun || IGNORED_TYPES.has(type)) return;
        streamTimer.start({ type, chatId: context()?.chatId, tags: parseBodyTags(settings().bodyTags) });
    });
    on(eventTypes.STREAM_TOKEN_RECEIVED, text => {
        streamTimer.update(text, Date.now(), context()?.streamingProcessor?.messageId);
    });
    on(eventTypes.GENERATION_STOPPED, () => { streamTimer.cancel(); autoRetry.cancel(); });
    on(eventTypes.GENERATION_ENDED, () => autoRetry.end());
    on(eventTypes.MESSAGE_RECEIVED, finalizeMessage);
    on(eventTypes.CHARACTER_MESSAGE_RENDERED, renderMessage);
    on(eventTypes.MESSAGE_SWIPED, renderMessage);
    on(eventTypes.MESSAGE_UPDATED, renderMessage);
    on(eventTypes.CHAT_CHANGED, () => {
        streamTimer.cancel();
        autoRetry.cancel();
        deferRenderAll();
    });
    on(eventTypes.CHAT_LOADED, deferRenderAll);
    on(eventTypes.MORE_MESSAGES_LOADED, deferRenderAll);
    on(eventTypes.APP_READY, initWandMenu);
    initWandMenu();
    renderAll();
}

try { init(); }
catch (error) { console.warn('[Reply Token Stats] Initialization skipped.', error); }
