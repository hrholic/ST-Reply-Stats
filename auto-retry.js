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
export function backupReply(storage, ctx, messageId, backupRole = 'snapshot') {
    const key = `st_reply_stats_backups:${identity(ctx)}`;
    const entries = JSON.parse(storage.getItem(key) || '[]');
    const entry = {
        backupIndex: entries.length, backupRole, messageId, message: cloneMessage(ctx.chat[messageId]),
        previous: JSON.stringify(ctx.chat[messageId - 1] ?? null),
        at: Date.now(),
    };
    entries.push(entry); // Never overwrite an earlier deleted reply.
    const value = JSON.stringify(entries);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('备份校验失败');
    return entry;
}

function recordOutcome(storage, attempt, outcome) {
    const key = `st_reply_stats_backups:${attempt.identity}`;
    const entries = JSON.parse(storage.getItem(key) || '[]');
    const entry = entries[attempt.backup.backupIndex];
    if (!entry || entry.at !== attempt.backup.at) throw new Error('重试记录与备份不匹配');
    entry.autoRetryOutcome = outcome;
    entry.outcomeAt = Date.now();
    const value = JSON.stringify(entries);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('重试状态保存失败');
}

export function isActiveProcessor(processor) {
    // Successful processors still own cleanup until the pointer is cleared.
    // A caught stream failure can leave an aborted/stopped pointer in old ST.
    return Boolean(processor && !processor.isStopped && !processor.abortController?.signal?.aborted);
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

function retryReason(rate, output, threshold, maxOutput) {
    const reasons = [];
    if (Number.isFinite(rate) && rate > 80) reasons.push('速率超过 80');
    if (!(Number.isSafeInteger(maxOutput) && maxOutput > 0 && maxOutput < threshold)
        && threshold > 0 && Number.isSafeInteger(output) && output >= 0 && output < threshold) reasons.push(`输出 token 少于 ${threshold}`);
    return reasons.join('，且');
}

export class AutoRetry {
    constructor({ context, enabled, limit = () => 3, minOutput = () => 3000, storage, busy, regenerate, notify, onStatus, renderReply = () => {}, schedule = setTimeout }) {
        Object.assign(this, { context, enabled, limit, minOutput, storage, busy, regenerate, notify, onStatus, renderReply, schedule });
        this.run = null;
        this.automatic = 0;
        this.status = '等待新的回复';
        this.activeAttempt = null;
        this.revision = 0;
    }
    get status() { return this._status; }
    set status(value) {
        this._status = value;
        try { this.onStatus?.(value); } catch (error) { console.warn('[Reply Token Stats] Status display failed.', error); }
    }
    cancel() { this.revision++; this.run = null; this.automatic = 0; }
    stop() {
        const attempt = this.activeAttempt;
        const ctx = this.context();
        if (attempt && !attempt.superseded && ctx?.chat === attempt.ctx.chat && identity(ctx) === attempt.identity) {
            attempt.stopped = true;
            const message = ctx.chat[attempt.backup.messageId];
            if (message && assistant(message)) attempt.observed = { message, text: replyIdentity(message), complete: false };
        }
        this.cancel();
    }
    start(type, dryRun) {
        if (dryRun || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        type ??= 'normal';
        this.revision++;
        const ctx = this.context();
        const retries = this.automatic;
        if (this.activeAttempt && !retries) this.activeAttempt.superseded = true;
        this.automatic = 0;
        this.run = !dryRun && TYPES.has(type) && !ctx?.groupId && ctx?.chatId != null
            ? { identity: identity(ctx), chat: ctx.chat, retries, initialProcessor: ctx.streamingProcessor, ended: false, candidate: null, scheduled: false, busyChecks: 0 }
            : null;
        if (this.activeAttempt && retries) this.activeAttempt.run = this.run;
        this.status = this.run ? (retries ? `正在等待第 ${retries + 1} 条回复（第 ${retries}/${retryLimit(this.limit())} 次重试，原因：${this.activeAttempt?.reason ?? '已满足重试条件'}；原回复已有备份）` : '已记录本轮生成，等待回复完成') : '本轮类型或聊天不支持自动重生';
    }
    observeCompletion(run, messageId, message, complete, processor) {
        const attempt = this.activeAttempt;
        if (!attempt || attempt.superseded || run !== attempt.run || run !== this.run
            || messageId !== attempt.backup.messageId) return;
        attempt.observed = { message, text: replyIdentity(message), complete: complete === true, processor };
    }
    observeRequest(data) {
        // Observe the native request settings only; never mutate or wrap the request.
        if (!this.run || !TYPES.has(data?.type)) return;
        const cap = data.max_completion_tokens ?? data.max_tokens;
        this.run.maxOutput = Number.isSafeInteger(cap) && cap > 0 ? cap : null;
    }
    consider(run, messageId, message, rate, output) {
        if (!run || run !== this.run) { this.status = '未匹配到本轮生成，已跳过'; return; }
        if (!this.enabled()) { this.status = '自动重生开关已关闭'; return; }
        if (run.retries >= retryLimit(this.limit())) { this.status = '已达到本轮重试次数上限'; return; }
        const reason = retryReason(rate, output, outputThreshold(this.minOutput()), run.maxOutput);
        if (!reason) {
            this.status = Number.isSafeInteger(run.maxOutput) && run.maxOutput > 0 && run.maxOutput < outputThreshold(this.minOutput())
                ? `本轮输出上限 ${run.maxOutput} 低于短回复阈值，已跳过短回复重试`
                : '本轮未满足重生条件，或统计无法计算';
            return;
        }
        this.status = `本轮${reason}，等待旧生成完全结束`;
        run.candidate = { messageId, message, text: replyIdentity(message), reason, rate, output, maxOutput: run.maxOutput };
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
        c.reason = retryReason(c.rate, c.output, outputThreshold(this.minOutput()), c.maxOutput);
        if (!c.reason) return;
        if (this.busy() || this.activeAttempt) {
            if (++run.busyChecks <= 40) this.schedule(() => this.execute(run), 250);
            else { this.status = '等待旧生成结束超时，未删除回复'; this.notify(this.status, true); }
            return;
        }
        try {
            const backup = backupReply(this.storage, ctx, c.messageId, 'original');
            const attempt = { ctx, identity: identity(ctx), backup, original: c.message, reason: c.reason, superseded: false };
            this.run = null;
            this.automatic = run.retries + 1;
            this.activeAttempt = attempt;
            recordOutcome(this.storage, attempt, 'pending');
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
    saveOutcome(attempt, outcome) {
        try { recordOutcome(this.storage, attempt, outcome); }
        catch (error) {
            attempt.outcomeFailure = true;
            console.warn('[Reply Token Stats] Outcome write failed; recovery still proceeds from verified backup.', error);
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
        if (attempt.superseded || ctx?.chat !== attempt.ctx.chat || identity(ctx) !== attempt.identity) {
            this.saveOutcome(attempt, 'superseded');
            return;
        }
        const id = attempt.backup.messageId;
        const tail = ctx.chat[id];
        if (ctx.chat.length > id + 1 || (tail && !assistant(tail))) {
            this.saveOutcome(attempt, 'superseded');
            return;
        }
        const unchanged = tail === attempt.original;
        const empty = !tail || !String(tail.mes ?? '').trim() || String(tail.mes ?? '').trim() === '...';
        const observed = attempt.observed;
        const matchesObservation = Boolean(observed && tail && observed.message === tail && observed.text === replyIdentity(tail));
        if (!error && !unchanged && !empty && matchesObservation && observed.complete
            && !observed.processor?.isStopped && !observed.processor?.abortController?.signal?.aborted) {
            this.saveOutcome(attempt, 'completed');
            return;
        }
        this.saveOutcome(attempt, attempt.stopped ? 'stopped' : 'failed');
        this.cancel(); // An unsuccessful attempt must never start another retry.
        if (unchanged) {
            this.status = '重新生成未成功启动，原回复已保留，已停止自动重试';
        } else if ((empty || matchesObservation) && JSON.stringify(ctx.chat[id - 1] ?? null) === attempt.backup.previous) {
            if (tail) backupReply(this.storage, ctx, id, 'partial');
            const restored = cloneMessage(attempt.backup.message);
            ctx.chat[id] = restored;
            const revision = this.revision;
            const text = replyIdentity(restored);
            const stillOwned = () => this.revision === revision && !attempt.superseded
                && this.context()?.chat === ctx.chat && identity(this.context()) === attempt.identity
                && ctx.chat.length === id + 1 && ctx.chat[id] === restored && replyIdentity(restored) === text
                && JSON.stringify(ctx.chat[id - 1] ?? null) === attempt.backup.previous;
            await this.renderReply(ctx, id, restored);
            if (!stillOwned()) {
                this.status = '原回复已恢复到内存，但聊天随后变化；未继续保存，请在原聊天核对备份';
                return;
            }
            await ctx.saveChat?.();
            if (!stillOwned()) return;
            this.status = '重新生成未完整成功，已恢复原回复（未完成片段也已备份），已停止自动重试';
        } else {
            this.status = '重新生成没有有效完成记录，已保留现有内容；原回复可从备份恢复，已停止自动重试';
        }
        if (attempt.outcomeFailure) this.status += '（结果状态未写入，原回复备份仍在）';
        this.notify(this.status, true);
    }

    lastOutcome() {
        try {
            const entries = JSON.parse(this.storage.getItem(`st_reply_stats_backups:${identity(this.context())}`) || '[]');
            const outcome = entries.slice().reverse().find(entry => entry.autoRetryOutcome)?.autoRetryOutcome;
            return {
                pending: '上次自动重生未记录完成，原回复仍有备份',
                completed: '上次自动重生已确认完整完成',
                failed: '上次自动重生未完整成功，备份已保留',
                stopped: '上次自动重生已停止，原回复与片段备份均保留',
                superseded: '上次自动重生被停止或新操作取代，备份已保留',
            }[outcome] || '尚无自动重生记录';
        } catch { return '上次重生记录暂不可读取'; }
    }
    async restore() {
        this.cancel();
        const ctx = this.context();
        if (!ctx || ctx.groupId || this.busy()) throw new Error('请先停止生成，并在原来的单人聊天中恢复。');
        const entries = JSON.parse(this.storage.getItem(`st_reply_stats_backups:${identity(ctx)}`) || '[]');
        const entry = entries.slice().reverse().find(item => item.backupRole === 'original' || item.autoRetryOutcome) ?? entries.at(-1);
        if (!entry) throw new Error('当前聊天没有自动删除的备份。');
        const { messageId } = entry;
        if (![messageId, messageId + 1].includes(ctx.chat.length)
            || JSON.stringify(ctx.chat[messageId - 1] ?? null) !== entry.previous
            || (ctx.chat[messageId] && !assistant(ctx.chat[messageId]))) {
            throw new Error('聊天已继续或发生变更，为避免覆盖后续消息，未恢复。');
        }
        // Preserve the replacement as well, so restoring never loses a reply.
        if (ctx.chat[messageId]) backupReply(this.storage, ctx, messageId, 'displaced');
        const restored = cloneMessage(entry.message);
        ctx.chat[messageId] = restored;
        const revision = this.revision, chatIdentity = identity(ctx), text = replyIdentity(restored);
        const stillOwned = () => this.revision === revision && this.context()?.chat === ctx.chat
            && identity(this.context()) === chatIdentity && ctx.chat.length === messageId + 1
            && ctx.chat[messageId] === restored && replyIdentity(restored) === text
            && JSON.stringify(ctx.chat[messageId - 1] ?? null) === entry.previous;
        await this.renderReply(ctx, messageId, restored);
        if (!stillOwned()) throw new Error('聊天在恢复过程中变化，未继续保存；原回复仍有备份。');
        await ctx.saveChat();
    }
}
