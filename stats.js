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

function metric(label, value) {
    return Number.isFinite(value) && value >= 0 ? `${label}≈${formatCount(value)}` : `${label}—`;
}

export function makeLabel(stats) {
    const input = metric('入', stats?.input);
    const output = metric('出', stats?.output);
    const rate = Number.isFinite(stats?.tps) && stats.tps >= 0
        ? `流${formatRate(stats.tps)}t/s`
        : '流—t/s';
    const values = `${input.replace('≈', '')}·${output.replace('≈', '')}·${rate}`;
    return stats ? `≈${values}` : values;
}

export function makeTitle(stats) {
    if (!stats) return '无可用记录（缺失信息不是 0）';
    return '输入：SillyTavern 当前 itemization 本地估算\n'
        + '输出：SillyTavern 原生 token_count，可能包含思考\n'
        + '流速：原生输出 token ÷ 从请求开始到完成的全部时间\n'
        + '≈ 表示估算；未使用流式 chunk 数量代替 token 数量';
}

export function elapsedSeconds(start, finish) {
    const startMs = new Date(start).getTime();
    const finishMs = new Date(finish).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs <= startMs) return null;
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
