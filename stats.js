function collectText(value, output) {
    if (typeof value === 'string') {
        output.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectText(item, output);
        return;
    }
    if (!value || typeof value !== 'object') return;

    if (typeof value.text === 'string') output.push(value.text);
    if ('content' in value) collectText(value.content, output);
    if ('prompt' in value) collectText(value.prompt, output);
}

export function flattenPrompt(prompt) {
    const output = [];
    collectText(prompt, output);
    return output.join('\n');
}

export function formatCount(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return String(Math.round(value));
    const compact = value >= 100000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    return `${compact}k`;
}

export function formatRate(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value >= 100) return String(Math.round(value));
    if (value >= 10) return String(Math.round(value * 10) / 10);
    return String(Math.round(value * 100) / 100);
}

export function formatSeconds(value) {
    return Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)}s` : '—';
}

function metric(label, value) {
    return Number.isFinite(value) && value >= 0 ? `${label}≈${formatCount(value)}` : `${label}—`;
}

export function makeLabelParts(stats) {
    const input = metric(stats?.inputSource === 'rough' ? '入粗估' : '入', stats?.input);
    const output = metric(stats?.outputSource === 'rough' ? '出粗估' : stats?.outputSource === 'native-late' ? '出原生' : '出', stats?.output);
    const rate = formatRate(stats?.tps);
    const thinking = `思${formatSeconds(stats?.thinking)}`;
    const total = `总${formatSeconds(stats?.total)}`;
    const prefix = [input.replace('≈', ''), output.replace('≈', '')].join(' · ');
    return [`${stats ? '≈' : ''}${prefix} · ${stats?.rateSource === 'rough' ? '流粗估' : stats?.rateSource === 'native-late' ? '流原生' : '流'}`, rate, `t/s · ${thinking} · ${total}`];
}

export function makeLabel(stats) {
    return makeLabelParts(stats).join('');
}

export function makeTitle(stats) {
    if (!stats) return '无可用记录（缺失信息不是 0）';
    return (stats.inputSource === 'rough' || stats.outputSource === 'rough' ? '粗估：UTF-8 字节数 ÷ 3.35；并非模型分词。仅供显示，不用于自动重生。\n' : '') + (stats.outputSource === 'native-late' ? '原生补计：使用当前回复原生 token_count，仅补显示，不追溯触发重生。\n' : '') + '输入：SillyTavern 当前 itemization 本地估算\n'
        + '输出：SillyTavern 原生 token_count，可能包含思考\n'
        + '流速：原生输出 token ÷ 从请求开始到完成的全部时间\n'
        + '思：与流速相同的生成起点到完整正文开始标签到达；— 表示未观察到标签或没有流式时间证据\n'
        + '总：与流速相同的生成起点到整条回复完成\n'
        + '思是可观测标签前耗时，不是模型隐藏内部推理时间；≈ 表示估算';
}

export function elapsedSeconds(start, finish) {
    const startMs = new Date(start).getTime();
    const finishMs = new Date(finish).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return null;
    return (finishMs - startMs) / 1000;
}

export function computeRate(tokens, seconds) {
    if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round((tokens / seconds) * 10) / 10;
}

export function requestOutput(total, previousTotal, type) {
    if (!Number.isSafeInteger(total) || total < 0) return null;
    if (type !== 'continue') return total;
    return Number.isSafeInteger(previousTotal) && total >= previousTotal ? total - previousTotal : null;
}

export function parseBodyTags(value) {
    if (typeof value !== 'string') return [];
    const seen = new Set();
    return value.split(/[\s,，]+/u).map(tag => {
        const trimmed = tag.trim();
        return /^<\s*([^\s<>/]+)\s*\/?>$/u.exec(trimmed)?.[1] ?? trimmed;
    }).filter(tag => {
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function formatBodyTags(value) {
    return parseBodyTags(value).join(' ');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeBodyTagPattern(tags) {
    const names = tags.map(escapeRegExp).join('|');
    return names
        ? new RegExp(`<\\s*(?:${names})(?=\\s|/?>)(?:\\s[^<>]*?)?\\s*/?>`, 'iu')
        : null;
}

export class StreamTimer {
    current = null;

    start({ type, chatId, tags }) {
        this.current = {
            type,
            chatId,
            messageId: null,
            eventCount: 0,
            tagAt: null,
            text: '',
            lastValue: '',
            pattern: makeBodyTagPattern(tags),
        };
    }

    update(value, now = Date.now(), messageId = null) {
        const run = this.current;
        if (!run || typeof value !== 'string') return;

        run.eventCount += 1;
        if (Number.isSafeInteger(messageId) && messageId >= 0) run.messageId ??= messageId;
        if (!/\S/u.test(value) || run.tagAt !== null || !run.pattern) return;

        run.text = run.lastValue && value.startsWith(run.lastValue) ? value : run.text + value;
        run.lastValue = value;
        if (run.pattern.test(run.text)) {
            run.tagAt = now;
        }
    }

    take({ type, chatId, messageId }) {
        const run = this.current;
        this.current = null;
        if (!run || run.type !== type) return null;
        if (run.chatId != null && chatId != null && String(run.chatId) !== String(chatId)) return null;
        if (run.messageId != null && Number(run.messageId) !== Number(messageId)) return null;
        return { tagAt: run.eventCount > 1 ? run.tagAt : null };
    }

    cancel() {
        this.current = null;
    }
}

// Same deliberately coarse UTF-8 heuristic as stock ST 1.19 guesstimate.
// Display fallback only: never pass this value to automatic retry decisions.
export function roughTokenCount(text) {
    return typeof text === 'string' && text.length
        ? Math.ceil(new TextEncoder().encode(text).length / 3.35) : null;
}

export function statisticsView(stats, message) {
    const view = { ...stats };
    const sameReply = typeof stats?.displayKey === 'string' && stats.displayKey === messageDisplayKey(message);
    const knownRequest = sameReply && ['normal', 'regenerate', 'swipe', '', null].includes(stats?.requestType);
    const native = message?.extra?.token_count;
    if (!Number.isFinite(view.output) && knownRequest
        && Number.isSafeInteger(native) && native >= 0) {
        view.output = native;
        view.outputSource = 'native-late';
    }
    // A continuation's total text must not masquerade as its incremental output.
    if (!Number.isFinite(view.output) && knownRequest) {
        view.output = roughTokenCount(`${message?.extra?.reasoning ?? ''}${message?.mes ?? ''}`);
        if (view.output !== null) view.outputSource = 'rough';
    }
    if (sameReply && !Number.isFinite(view.input) && Number.isSafeInteger(stats?.roughInput)) {
        view.input = stats.roughInput;
        view.inputSource = 'rough';
    }
    if (!Number.isFinite(view.tps) && ['rough', 'native-late'].includes(view.outputSource)) {
        view.tps = computeRate(view.output, view.total);
        if (view.tps !== null) view.rateSource = view.outputSource;
    }
    return view;
}

export function messageDisplayKey(message) {
    const text = JSON.stringify([message?.mes, message?.extra?.reasoning, message?.swipe_id ?? 0, message?.gen_started, message?.gen_finished]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${hash >>> 0}`;
}
