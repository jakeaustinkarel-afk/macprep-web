const DAY_MS = 86400000;
export const MAX_ADAPTIVE_PLAN_DAYS = 183;
export const DEFAULT_ADAPTIVE_PLAN_DAYS = 120;

const PHASES = {
    steady: { label: 'Steady practice', target: 20, focusShare: 0.35 },
    foundation: { label: 'Build your foundation', target: 15, focusShare: 0.35 },
    build: { label: 'Build and reinforce', target: 25, focusShare: 0.4 },
    final: { label: 'Focused review', target: 35, focusShare: 0.45 },
    taper: { label: 'Final review', target: 20, focusShare: 0.45 },
    expired: { label: 'Reset your exam plan', target: 15, focusShare: 0.35 },
};

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function localDateKey(date, timezoneOffset) {
    return new Date(date.getTime() - timezoneOffset * 60000).toISOString().slice(0, 10);
}

function addDays(dateKey, days) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function differenceInDays(laterDateKey, earlierDateKey) {
    return Math.round((Date.parse(`${laterDateKey}T00:00:00Z`) - Date.parse(`${earlierDateKey}T00:00:00Z`)) / DAY_MS);
}

function dayLabel(dateKey, todayKey) {
    const distance = differenceInDays(dateKey, todayKey);
    if (distance === 0) return 'Today';
    if (distance === 1) return 'Tomorrow';
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
        .format(new Date(`${dateKey}T12:00:00Z`));
}

function phaseFor(daysToExam) {
    if (daysToExam == null) return 'steady';
    if (daysToExam < 0) return 'expired';
    if (daysToExam <= 7) return 'taper';
    if (daysToExam <= 30) return 'final';
    if (daysToExam <= 90) return 'build';
    return 'foundation';
}

function normalizedDomains(rows) {
    return (Array.isArray(rows) ? rows : [])
        .map((row) => ({
            domain: String(row?.domain || row?.category || '').trim(),
            mastery: row?.mastery == null ? null : clamp(finiteNumber(row.mastery), 0, 100),
            attempts: Math.max(0, Math.round(finiteNumber(row?.attempts))),
        }))
        .filter((row) => row.domain)
        .sort((a, b) => {
            const aScore = a.mastery == null ? 55 : a.mastery;
            const bScore = b.mastery == null ? 55 : b.mastery;
            return aScore - bScore || a.attempts - b.attempts || a.domain.localeCompare(b.domain);
        });
}

function normalizeDueSchedule(rows, todayKey, horizon, timezoneOffset) {
    const byDate = new Map();
    const lastDate = addDays(todayKey, horizon - 1);
    for (const row of Array.isArray(rows) ? rows : []) {
        const dueAt = typeof row?.due_at === 'string' ? row.due_at : row?.dueAt;
        const questionId = String(row?.question_id || row?.questionId || '').trim();
        if (!dueAt || !questionId || !Number.isFinite(Date.parse(dueAt))) continue;
        let key = localDateKey(new Date(dueAt), timezoneOffset);
        if (key < todayKey) key = todayKey;
        if (key > lastDate) continue;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(questionId);
    }
    return byDate;
}

function task(kind, title, detail, count, extra = {}) {
    return { kind, title, detail, count: Math.max(0, Math.round(count)), ...extra };
}

function planWindowLabel(days) {
    if (days >= 90) return `${Math.max(3, Math.round(days / 30))}-month roadmap`;
    return `${Math.max(1, Math.ceil(days / 7))}-week roadmap`;
}

function planSummary({ phase, daysToExam, dailyTarget, rawCoveragePace, remainingUnseen, horizon, continuesToExam }) {
    if (phase === 'expired') return 'Your saved exam date has passed. Update it when you know your next testing date.';
    const windowLabel = planWindowLabel(horizon).toLowerCase();
    if (daysToExam == null) return `A rolling ${windowLabel} built around a sustainable ${dailyTarget}-question rhythm. Add your exam date to anchor every phase to test day.`;
    if (remainingUnseen === 0) return `You have covered the bank. This ${windowLabel} prioritizes retention, weak areas, and checkpoints on the way to your exam.`;
    if (rawCoveragePace > dailyTarget) return `There are ${daysToExam} days left. The plan prioritizes your highest-value work instead of assigning an unrealistic ${rawCoveragePace} questions every day.`;
    if (continuesToExam) return `${daysToExam} days to your exam. This six-month adaptive window starts the work now and keeps rolling forward as you practice.`;
    return `${daysToExam} day${daysToExam === 1 ? '' : 's'} to your exam. This ${windowLabel} covers unseen material while protecting time for recall, checkpoints, and weak areas.`;
}

function roadmapFromDays(days) {
    const roadmap = [];
    for (let index = 0; index < days.length; index++) {
        const day = days[index];
        const previous = roadmap[roadmap.length - 1];
        if (previous && previous.phase === day.phase) {
            previous.end_date = day.date;
            previous.end_index = index;
            previous.days += 1;
            continue;
        }
        roadmap.push({
            phase: day.phase,
            label: day.phase_label,
            start_date: day.date,
            end_date: day.date,
            start_index: index,
            end_index: index,
            days: 1,
        });
    }
    return roadmap;
}

/**
 * Build a deterministic exam roadmap from the learner's current state.
 * The detailed calendar spans up to six months and recalculates on every profile
 * refresh, while the client presents one week at a time.
 */
export function buildAdaptiveStudyPlan(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const timezoneOffset = clamp(Math.round(finiteNumber(options.timezoneOffset)), -840, 840);
    const todayKey = localDateKey(now, timezoneOffset);
    const examDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.targetExamDate || ''))
        ? String(options.targetExamDate)
        : null;
    const daysToExam = examDate ? differenceInDays(examDate, todayKey) : null;
    const phase = phaseFor(daysToExam);
    const customHorizon = options.horizon !== undefined && options.horizon !== null && Number.isFinite(Number(options.horizon));
    const horizon = customHorizon
        ? clamp(Math.round(Number(options.horizon)), 1, MAX_ADAPTIVE_PLAN_DAYS)
        : daysToExam == null
            ? DEFAULT_ADAPTIVE_PLAN_DAYS
            : daysToExam < 0
                ? 14
                : clamp(Math.max(1, daysToExam), 1, MAX_ADAPTIVE_PLAN_DAYS);
    const totalQuestions = Math.max(0, Math.round(finiteNumber(options.totalQuestions)));
    const answeredQuestions = clamp(Math.round(finiteNumber(options.answeredQuestions)), 0, totalQuestions || Number.MAX_SAFE_INTEGER);
    const answeredToday = Math.max(0, Math.round(finiteNumber(options.answeredToday)));
    const remainingUnseen = Math.max(0, totalQuestions - answeredQuestions);
    const planningDays = daysToExam == null ? horizon : Math.max(1, daysToExam - (phase === 'taper' ? 1 : Math.min(7, Math.ceil(daysToExam * 0.1))));
    const rawCoveragePace = remainingUnseen ? Math.ceil(remainingUnseen / planningDays) : 0;
    const reviewPressure = Math.min(12, Math.ceil(Math.max(0, finiteNumber(options.dueCount)) / 3));
    const domains = normalizedDomains(options.byDomain);
    const dueByDate = normalizeDueSchedule(options.dueSchedule, todayKey, horizon, timezoneOffset);
    const missedCount = Math.max(0, Math.round(finiteNumber(options.missedCount)));
    const confidentMissedCount = Math.max(0, Math.round(finiteNumber(options.confidentMissedCount)));
    const days = [];

    for (let index = 0; index < horizon; index++) {
        const date = addDays(todayKey, index);
        const dayPhase = phaseFor(daysToExam == null ? null : daysToExam - index);
        const phaseConfig = PHASES[dayPhase];
        const dueIds = dueByDate.get(date) || [];
        const focus = domains.length ? domains[index % Math.min(3, domains.length)] : null;
        const phaseTarget = clamp(Math.max(phaseConfig.target, rawCoveragePace + (index === 0 ? reviewPressure : 0)), 10, 50);
        let target = phaseTarget;
        const tasks = [];

        if (dueIds.length) {
            const dueTarget = Math.min(dueIds.length, Math.max(5, Math.round(target * 0.4)));
            tasks.push(task(
                'due',
                index === 0 ? 'Clear due reviews' : 'Review what comes due',
                `${dueIds.length} spaced-repetition item${dueIds.length === 1 ? '' : 's'} ${index === 0 ? 'need attention now' : 'are scheduled for this day'}.`,
                dueTarget,
                { question_ids: dueIds.slice(0, dueTarget) }
            ));
        }

        const isCheckpoint = index > 0 && (index + 1) % 14 === 0;
        if (isCheckpoint) {
            // Due reviews still come first on checkpoint days. Keep the displayed
            // target equal to the work actually assigned instead of quietly adding
            // a 24-question checkpoint on top of an unrelated daily total.
            const dueWork = tasks.reduce((sum, entry) => sum + entry.count, 0);
            target = 24 + dueWork;
            tasks.push(task('diagnostic', 'Take a 24-question checkpoint', 'Measure all six NCCAA domains, then let the next week adjust to the result.', 24));
        } else {
            const used = tasks.reduce((sum, entry) => sum + entry.count, 0);
            let remaining = Math.max(0, target - used);
            if (index === 0 && confidentMissedCount > 0 && remaining >= 5) {
                const count = Math.min(confidentMissedCount, Math.max(5, Math.round(remaining * 0.3)));
                tasks.push(task('confident_missed', 'Correct a blind spot', 'Revisit answers you felt confident about but missed.', count));
                remaining -= count;
            } else if (index === 0 && missedCount > 0 && remaining >= 5) {
                const count = Math.min(missedCount, Math.max(5, Math.round(remaining * 0.25)));
                tasks.push(task('missed', 'Repair recent misses', 'Work the reasoning again before the mistake becomes familiar.', count));
                remaining -= count;
            }

            if (focus && remaining >= 5) {
                const focusCount = Math.min(remaining, Math.max(5, Math.round(target * phaseConfig.focusShare)));
                const mastery = focus.mastery == null ? 'not measured yet' : `${Math.round(focus.mastery)}% mastery`;
                tasks.push(task('focused', `Strengthen ${focus.domain}`, `${mastery}. Practice new questions at your current level.`, focusCount, { domain: focus.domain }));
                remaining -= focusCount;
            }

            if (remaining > 0) {
                tasks.push(task('recommended', 'Finish with an adaptive mix', 'Blend unseen questions, recent misses, and the domains that need the most work.', remaining));
            }
        }

        const completed = index === 0 ? Math.min(answeredToday, target) : 0;
        days.push({
            date,
            label: dayLabel(date, todayKey),
            target,
            completed,
            remaining: Math.max(0, target - completed),
            is_today: index === 0,
            phase: dayPhase,
            phase_label: phaseConfig.label,
            tasks,
        });
    }

    const dailyTarget = days[0]?.target || 0;
    const continuesToExam = daysToExam != null && daysToExam > horizon;

    return {
        generated_at: now.toISOString(),
        phase,
        phase_label: PHASES[phase].label,
        exam_date: examDate,
        days_to_exam: daysToExam,
        daily_target: dailyTarget,
        remaining_unseen: remainingUnseen,
        raw_coverage_pace: rawCoveragePace,
        weakest_domains: domains.slice(0, 3),
        plan_days: horizon,
        plan_end_date: days[days.length - 1]?.date || todayKey,
        window_label: planWindowLabel(horizon),
        continues_to_exam: continuesToExam,
        roadmap: roadmapFromDays(days),
        summary: planSummary({ phase, daysToExam, dailyTarget, rawCoveragePace, remainingUnseen, horizon, continuesToExam }),
        days,
    };
}
