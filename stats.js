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

export function makeLabel(stats) {
    const input = metric('入', stats?.input);
    const output = metric('出', stats?.output);
    const rate = Number.isFinite(stats?.tps) && stats.tps >= 0
        ? `流${formatRate(stats.tps)}t/s`
        : '流—t/s';
    const thinking = `思${formatSeconds(stats?.thinking)}`;
    const values = [input.replace('≈', ''), output.replace('≈', ''), rate, thinking].join(' · ');
    return stats ? `≈${values}` : values;
}

export function makeTitle(stats) {
    if (!stats) return '无可用记录（缺失信息不是 0）';
    return '输入：SillyTavern 当前 itemization 本地估算\n'
        + '输出：SillyTavern 原生 token_count，可能包含思考\n'
        + '流速：原生输出 token ÷ 从请求开始到完成的全部时间\n'
        + '思：与流速相同的生成起点到完整正文开始标签到达；— 表示未观察到标签或没有流式时间证据\n'
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
    return value.split(/[,，]/u).map(tag => tag.trim()).filter(tag => {
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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
            tagAt: null,
            sawPreTagText: false,
            sawPostTagText: false,
            text: '',
            lastValue: '',
            pattern: makeBodyTagPattern(tags),
        };
    }

    update(value, now = Date.now(), messageId = null) {
        const run = this.current;
        if (!run || typeof value !== 'string') return;

        if (Number.isSafeInteger(messageId) && messageId >= 0) run.messageId ??= messageId;
        if (!/\S/u.test(value) || !run.pattern) return;

        const changed = value !== run.lastValue;
        run.text = run.lastValue && value.startsWith(run.lastValue) ? value : run.text + value;
        run.lastValue = value;
        if (run.tagAt !== null) {
            if (changed) run.sawPostTagText = true;
            return;
        }
        if (run.pattern.test(run.text)) {
            run.tagAt = now;
        } else {
            run.sawPreTagText = true;
        }
    }

    take({ type, chatId, messageId }) {
        const run = this.current;
        this.current = null;
        if (!run || run.type !== type) return null;
        if (run.chatId != null && chatId != null && String(run.chatId) !== String(chatId)) return null;
        if (run.messageId != null && Number(run.messageId) !== Number(messageId)) return null;
        const hasStreamEvidence = run.sawPreTagText || run.sawPostTagText;
        return { tagAt: hasStreamEvidence ? run.tagAt : null };
    }

    cancel() {
        this.current = null;
    }
}
