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

export function isCompletedReply(message, processor) {
    const start = new Date(message?.gen_started).getTime();
    const end = new Date(message?.gen_finished).getTime();
    return Boolean(assistant(message) && typeof message.mes === 'string'
        && message.mes.trim() && message.mes.trim() !== '...'
        && Number.isFinite(start) && Number.isFinite(end) && end > start
        && (!processor || (processor.isFinished === true && !processor.isStopped
            && !processor.abortController?.signal?.aborted && !processor.toolCalls?.length)));
}

export function outputThreshold(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return 3000;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 3000;
}

export function retryLimit(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : 3;
}

function retryReason(rate, output, threshold) {
    const reasons = [];
    if (Number.isFinite(rate) && rate > 80) reasons.push('速率超过 80');
    if (threshold > 0 && Number.isSafeInteger(output) && output >= 0 && output < threshold) reasons.push(`输出 token 少于 ${threshold}`);
    return reasons.join('，且');
}

export class AutoRetry {
    constructor({ context, enabled, limit = () => 3, minOutput = () => 3000, storage, busy, regenerate, notify, schedule = setTimeout }) {
        Object.assign(this, { context, enabled, limit, minOutput, storage, busy, regenerate, notify, schedule });
        this.run = null;
        this.automatic = 0;
        this.status = '等待新的回复';
        this.activeAttempt = null;
    }
    cancel() { this.run = null; this.automatic = 0; }
    start(type, dryRun) {
        if (dryRun || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        type ??= 'normal';
        const ctx = this.context();
        const retries = this.automatic;
        if (this.activeAttempt && !retries) this.activeAttempt.superseded = true;
        this.automatic = 0;
        this.run = !dryRun && TYPES.has(type) && !ctx?.groupId && ctx?.chatId != null
            ? { identity: identity(ctx), chat: ctx.chat, retries, ended: false, candidate: null, scheduled: false, busyChecks: 0 }
            : null;
        this.status = this.run ? '已记录本轮生成，等待回复完成' : '本轮类型或聊天不支持自动重生';
    }
    consider(run, messageId, message, rate, output) {
        if (!run || run !== this.run) { this.status = '未匹配到本轮生成，已跳过'; return; }
        if (!this.enabled()) { this.status = '自动重生开关已关闭'; return; }
        if (run.retries >= retryLimit(this.limit())) { this.status = '已达到本轮重试次数上限'; return; }
        const reason = retryReason(rate, output, outputThreshold(this.minOutput()));
        if (!reason) { this.status = '本轮未满足重生条件，或统计无法计算'; return; }
        this.status = `本轮${reason}，等待旧生成完全结束`;
        run.candidate = { messageId, message, text: replyIdentity(message), reason, rate, output };
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
        c.reason = retryReason(c.rate, c.output, outputThreshold(this.minOutput()));
        if (!c.reason) return;
        if (this.busy() || this.activeAttempt) {
            if (++run.busyChecks <= 40) this.schedule(() => this.execute(run), 250);
            else { this.status = '等待旧生成结束超时，未删除回复'; this.notify(this.status, true); }
            return;
        }
        try {
            const backup = backupReply(this.storage, ctx, c.messageId);
            const attempt = { ctx, identity: identity(ctx), backup, original: c.message, superseded: false };
            this.run = null;
            this.automatic = run.retries + 1;
            this.activeAttempt = attempt;
            this.status = `第 ${run.retries + 1} 条回复已生成，但${c.reason}，正在生成第 ${run.retries + 2} 条回复`;
            // Must be visible before native Generate deletes the old reply.
            this.notify(this.status);
            let result;
            try { result = this.regenerate(); }
            catch (error) { this.finishAttempt(attempt, error).catch(e => this.reportFailure(e)); return; }
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).then(
                    () => this.finishAttempt(attempt),
                    error => this.finishAttempt(attempt, error),
                ).catch(error => this.reportFailure(error));
            } else {
                // Compatibility with event-only generation adapters.
                this.activeAttempt = null;
            }
        } catch (error) {
            this.cancel();
            this.activeAttempt = null;
            this.status = `未自动删除：${error.message}`;
            this.notify(this.status, true);
        }
    }
    reportFailure(error) {
        this.status = `自动重生出错，原回复仍有备份：${error.message}`;
        this.notify(this.status, true);
    }
    async finishAttempt(attempt, error) {
        if (this.activeAttempt !== attempt) return;
        this.activeAttempt = null;
        const ctx = this.context();
        if (attempt.superseded || ctx?.chat !== attempt.ctx.chat || identity(ctx) !== attempt.identity) return;
        const id = attempt.backup.messageId;
        const tail = ctx.chat[id];
        if (ctx.chat.length > id + 1 || (tail && !assistant(tail))) return;
        const unchanged = tail === attempt.original;
        const empty = !tail || !String(tail.mes ?? '').trim() || String(tail.mes ?? '').trim() === '...';
        if (!error && !unchanged && !empty) return;
        this.cancel(); // An unsuccessful attempt must never start another retry.
        if (unchanged) {
            this.status = '重新生成未成功启动，原回复已保留，已停止自动重试';
        } else if (empty && JSON.stringify(ctx.chat[id - 1] ?? null) === attempt.backup.previous) {
            if (tail) backupReply(this.storage, ctx, id);
            ctx.chat[id] = cloneMessage(attempt.backup.message);
            await ctx.printMessages?.();
            await ctx.saveChat?.();
            this.status = '重新生成失败或返回空内容，已恢复原回复，已停止自动重试';
        } else {
            this.status = '重新生成失败，已保留现有内容；原回复可从备份恢复，已停止自动重试';
        }
        this.notify(this.status, true);
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
