const cloneMessage = value => JSON.parse(JSON.stringify(value));
const TYPES = new Set(['normal', 'regenerate', 'swipe']);
const assistant = m => m && !m.is_user && !m.is_system;
const identity = ctx => JSON.stringify([ctx?.characterId, ctx?.chatId]);
// Native rendering/save code mutates extra/swipe_info after MESSAGE_RECEIVED.
// Only text, selected alternative and generation identity indicate a different reply.
const replyIdentity = message => JSON.stringify([
    message.mes, message.swipe_id ?? 0, message.gen_started ?? null,
]);

// A synchronous, read-back-verified local copy is required before any deletion.
export function backupReply(storage, ctx, messageId) {
    const key = `st_reply_stats_backups:${identity(ctx)}`;
    const entries = JSON.parse(storage.getItem(key) || '[]');
    const entry = {
        messageId, message: cloneMessage(ctx.chat[messageId]),
        previous: JSON.stringify(ctx.chat[messageId - 1] ?? null),
        at: Date.now(),
    };
    entries.push(entry); // Never overwrite an earlier deleted reply.
    const value = JSON.stringify(entries);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('备份校验失败');
    return entry;
}

export function retryLimit(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : 3;
}

export class AutoRetry {
    constructor({ context, enabled, limit = () => 3, storage, busy, regenerate, notify, schedule = setTimeout }) {
        Object.assign(this, { context, enabled, limit, storage, busy, regenerate, notify, schedule });
        this.run = null;
        this.automatic = 0;
        this.status = '等待新的回复';
    }
    cancel() { this.run = null; this.automatic = 0; }
    start(type, dryRun) {
        if (dryRun || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        type ??= 'normal';
        const ctx = this.context();
        const retries = this.automatic;
        this.automatic = 0;
        this.run = !dryRun && TYPES.has(type) && !ctx?.groupId && ctx?.chatId != null
            ? { identity: identity(ctx), chat: ctx.chat, retries, ended: false, candidate: null, scheduled: false, busyChecks: 0 }
            : null;
        this.status = this.run ? '已记录本轮生成，等待回复完成' : '本轮类型或聊天不支持自动重生';
    }
    consider(run, messageId, message, rate) {
        if (!run || run !== this.run) { this.status = '未匹配到本轮生成，已跳过'; return; }
        if (!this.enabled()) { this.status = '自动重生开关已关闭'; return; }
        if (run.retries >= retryLimit(this.limit())) { this.status = '已达到本轮重试次数上限'; return; }
        if (!Number.isFinite(rate) || rate <= 80) { this.status = '本轮速率未超过 80 或无法计算'; return; }
        this.status = `本轮速率 ${rate}，等待旧生成完全结束`;
        run.candidate = { messageId, message, text: replyIdentity(message) };
        this.queue(run);
    }
    end() {
        if (!this.run) return;
        this.run.ended = true;
        this.queue(this.run);
    }
    queue(run) {
        // Some mobile themes hide #mes_stop, so core never emits GENERATION_ENDED.
        if (!run.candidate || run.scheduled) return;
        run.scheduled = true;
        this.schedule(() => this.execute(run), 250);
    }
    execute(run) {
        try { this.executeSafely(run); }
        catch (error) {
            this.cancel();
            console.warn('[Reply Token Stats] Automatic retry cancelled safely.', error);
        }
    }
    executeSafely(run) {
        const ctx = this.context();
        const c = run.candidate;
        if (run !== this.run || run.retries >= retryLimit(this.limit()) || !this.enabled() || ctx?.groupId
            || identity(ctx) !== run.identity || ctx.chat !== run.chat
            || c.messageId !== ctx.chat.length - 1 || ctx.chat[c.messageId] !== c.message
            || !assistant(c.message) || replyIdentity(c.message) !== c.text) return;
        if (this.busy()) {
            if (++run.busyChecks <= 40) this.schedule(() => this.execute(run), 250);
            else { this.status = '等待旧生成结束超时，未删除回复'; this.notify(this.status, true); }
            return;
        }
        try {
            backupReply(this.storage, ctx, c.messageId);
            this.run = null;
            this.automatic = run.retries + 1;
            const result = this.regenerate();
            Promise.resolve(result).catch(error => {
                if (this.run?.chat === run.chat && this.run.retries === run.retries + 1) this.cancel();
                this.notify(`自动重生失败，原回复已备份：${error.message}`, true);
            });
            this.status = `已启动第 ${run.retries + 1}/${retryLimit(this.limit())} 次自动重试`;
            this.notify(`速率超过 80，已备份并重新生成（第 ${run.retries + 1}/${retryLimit(this.limit())} 次自动重试）。`);
        } catch (error) {
            this.cancel();
            this.status = `未自动删除：${error.message}`;
            this.notify(this.status, true);
        }
    }
    async restore() {
        this.cancel();
        const ctx = this.context();
        if (!ctx || ctx.groupId || this.busy()) throw new Error('请先停止生成，并在原来的单人聊天中恢复。');
        const entries = JSON.parse(this.storage.getItem(`st_reply_stats_backups:${identity(ctx)}`) || '[]');
        const entry = entries.at(-1);
        if (!entry) throw new Error('当前聊天没有自动删除的备份。');
        const { messageId } = entry;
        if (![messageId, messageId + 1].includes(ctx.chat.length)
            || JSON.stringify(ctx.chat[messageId - 1] ?? null) !== entry.previous
            || (ctx.chat[messageId] && !assistant(ctx.chat[messageId]))) {
            throw new Error('聊天已继续或发生变更，为避免覆盖后续消息，未恢复。');
        }
        // Preserve the replacement as well, so restoring never loses a reply.
        if (ctx.chat[messageId]) backupReply(this.storage, ctx, messageId);
        ctx.chat[messageId] = cloneMessage(entry.message);
        await ctx.printMessages();
        await ctx.saveChat();
    }
}
