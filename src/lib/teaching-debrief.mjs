function cleanText(value, maximum = 1600) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, maximum)
        : '';
}

export function normalizeTeachingDebrief(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawCorrections = source.distractor_corrections && typeof source.distractor_corrections === 'object'
        && !Array.isArray(source.distractor_corrections)
        ? source.distractor_corrections
        : {};
    const distractorCorrections = {};
    for (const label of ['A', 'B', 'C', 'D', 'E']) {
        const correction = cleanText(rawCorrections[label], 1200);
        if (correction) distractorCorrections[label] = correction;
    }
    return {
        key_takeaway: cleanText(source.key_takeaway, 1200),
        correct_principle: cleanText(source.correct_principle, 1800),
        distractor_corrections: distractorCorrections,
        source_verification: cleanText(source.source_verification, 1400),
    };
}

export function validateTeachingDebrief(value, choices = [], correctAnswer = '') {
    const debrief = normalizeTeachingDebrief(value);
    const errors = [];
    const choiceCount = Array.isArray(choices) ? Math.min(5, choices.length) : 0;
    const correct = String(correctAnswer || '').trim().toUpperCase();
    if (debrief.key_takeaway.length < 20) errors.push('Teach the Question needs a specific key takeaway.');
    if (debrief.correct_principle.length < 30) errors.push('Teach the Question needs a clear explanation of why the correct answer wins.');
    if (debrief.source_verification.length < 20) errors.push('Teach the Question needs a source-verification note.');
    for (let index = 0; index < choiceCount; index++) {
        const label = String.fromCharCode(65 + index);
        if (label !== correct && (debrief.distractor_corrections[label] || '').length < 20) {
            errors.push(`Choice ${label} needs the fact or change that would make it correct.`);
        }
    }
    return { valid: errors.length === 0, errors, debrief };
}
