const PLACEHOLDER_CITATIONS = [
    '10.1213/ane.0000000000000000',
    'https://pubmed.ncbi.nlm.nih.gov/',
    'http://pubmed.ncbi.nlm.nih.gov/',
];

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function referenceLabel(reference) {
    if (typeof reference === 'string') return text(reference);
    if (!reference || typeof reference !== 'object') return '';
    return text(reference.doi || reference.url || reference.title || reference.source);
}

export function validateQuestionForPublication(question) {
    const errors = [];
    const stem = text(question?.stem);
    const explanation = text(question?.explanation);
    const choices = Array.isArray(question?.choices) ? question.choices : [];
    const references = Array.isArray(question?.references) ? question.references : [];

    if (stem.length < 40) errors.push('Stem must contain a complete clinical vignette or question.');
    if (explanation.length < 40) errors.push('Explanation must teach the reasoning behind the answer.');
    if (choices.length < 4 || choices.length > 5) errors.push('Questions must contain four or five answer choices.');

    const correctIndexes = [];
    choices.forEach((choice, index) => {
        const choiceText = text(choice && typeof choice === 'object' ? (choice.text ?? choice.value) : choice);
        const rationale = text(choice && typeof choice === 'object' ? choice.rationale : '');
        if (choiceText.length < 2 && !/^\d$/.test(choiceText)) {
            errors.push(`Choice ${index + 1} is missing text.`);
        }
        if (rationale.length < 12) errors.push(`Choice ${index + 1} needs a specific teaching rationale.`);
        if (choice && typeof choice === 'object' && choice.correct === true) correctIndexes.push(index);
    });

    if (correctIndexes.length !== 1) errors.push('Exactly one choice must be marked correct.');
    const answer = text(question?.correct_answer).toUpperCase();
    const answerIndex = /^[A-E]$/.test(answer) ? answer.charCodeAt(0) - 65 : -1;
    if (answerIndex < 0 || answerIndex >= choices.length) errors.push('correct_answer must identify an in-range choice.');
    if (correctIndexes.length === 1 && answerIndex >= 0 && correctIndexes[0] !== answerIndex) {
        errors.push('correct_answer does not match the choice marked correct.');
    }

    if (!text(question?.domain_name || question?.category || question?.domain)) errors.push('A blueprint domain is required.');
    if (!text(question?.subtopic)) errors.push('A blueprint subtopic is required.');
    if (!references.length) errors.push('At least one defensible source is required.');
    references.forEach((reference, index) => {
        const label = referenceLabel(reference);
        if (label.length < 8) errors.push(`Reference ${index + 1} is incomplete.`);
        if (PLACEHOLDER_CITATIONS.includes(label.toLowerCase())) errors.push(`Reference ${index + 1} is a placeholder.`);
    });

    return { valid: errors.length === 0, errors };
}

function fieldIssue(issues, questionId, field, type, detail = '') {
    issues.push({ type, id: questionId || '(missing id)', field, detail });
}

export function auditQuestionTextQuality(questions) {
    const issues = [];
    const repeatedWord = /\b([a-z]{3,})\s+\1\b/i;
    const spaceBeforePunctuation = /\s+[,;.!?]/;
    const missingDirection = /\bplus lower esophageal sphincter tone\b/i;
    const wrongRationaleLead = /^(?:incorrect|wrong|this is false|not correct)(?:[.:]|$)/i;
    const correctRationaleLead = /^(?:correct|this is correct|yes)(?:[.:]|$)/i;

    const inspectText = (questionId, field, value) => {
        const normalized = typeof value === 'string' ? value : '';
        if (!normalized.trim()) {
            fieldIssue(issues, questionId, field, 'blank_text');
            return;
        }
        const repeat = normalized.match(repeatedWord);
        if (repeat) fieldIssue(issues, questionId, field, 'repeated_word', repeat[0]);
        if (normalized.includes('  ')) fieldIssue(issues, questionId, field, 'double_space');
        if (spaceBeforePunctuation.test(normalized)) fieldIssue(issues, questionId, field, 'space_before_punctuation');
        if ((normalized.match(/\(/g) || []).length !== (normalized.match(/\)/g) || []).length) {
            fieldIssue(issues, questionId, field, 'unbalanced_parentheses');
        }
        if ((normalized.match(/\[/g) || []).length !== (normalized.match(/\]/g) || []).length) {
            fieldIssue(issues, questionId, field, 'unbalanced_brackets');
        }
        if (missingDirection.test(normalized)) {
            fieldIssue(issues, questionId, field, 'missing_directional_modifier', 'Expected decreased lower esophageal sphincter tone.');
        }
    };

    for (const question of Array.isArray(questions) ? questions : []) {
        const questionId = text(question?.id);
        const answer = text(question?.correct_answer ?? question?.correctAnswer).toUpperCase();
        const choices = Array.isArray(question?.choices) ? question.choices : [];
        inspectText(questionId, 'stem', question?.stem);
        inspectText(questionId, 'explanation', question?.explanation);

        const labels = new Set();
        let markedCorrect = 0;
        let alignedCorrect = 0;
        choices.forEach((choice, index) => {
            const explicitLabel = text(choice?.label).toUpperCase();
            const label = explicitLabel || String.fromCharCode(65 + index);
            const choiceText = choice && typeof choice === 'object' ? (choice.text ?? choice.value) : choice;
            const rationale = choice && typeof choice === 'object' ? choice.rationale : '';
            inspectText(questionId, `choice_${label || index + 1}`, choiceText);
            inspectText(questionId, `rationale_${label || index + 1}`, rationale);
            if (!/^[A-E]$/.test(explicitLabel)) {
                fieldIssue(issues, questionId, `choice_${index + 1}`, 'missing_or_invalid_choice_label', explicitLabel);
            }
            if (label) labels.add(label);
            if (choice?.correct === true) {
                markedCorrect++;
                if (label === answer) alignedCorrect++;
            }

            const rationaleLead = text(rationale);
            if (label === answer && wrongRationaleLead.test(rationaleLead)) {
                fieldIssue(issues, questionId, `rationale_${label}`, 'correct_choice_marked_incorrect');
            }
            if (label !== answer && correctRationaleLead.test(rationaleLead)) {
                fieldIssue(issues, questionId, `rationale_${label}`, 'incorrect_choice_marked_correct');
            }
        });

        if (choices.length < 4 || choices.length > 5) {
            fieldIssue(issues, questionId, 'choices', 'invalid_choice_count', String(choices.length));
        }
        if (!/^[A-E]$/.test(answer)) fieldIssue(issues, questionId, 'correct_answer', 'invalid_answer_key', answer);
        if (labels.size !== choices.length) fieldIssue(issues, questionId, 'choices', 'duplicate_or_missing_labels');
        if (markedCorrect !== 1) fieldIssue(issues, questionId, 'choices', 'invalid_correct_flag_count', String(markedCorrect));
        if (alignedCorrect !== 1) fieldIssue(issues, questionId, 'choices', 'misaligned_correct_flag');
        if (!choices.some((choice, index) => text(choice?.label || String.fromCharCode(65 + index)).toUpperCase() === answer)) {
            fieldIssue(issues, questionId, 'correct_answer', 'missing_answer_label', answer);
        }
    }

    return { valid: issues.length === 0, issues };
}

function answerBatchId(id) {
    const value = text(id);
    return value.replace(/-\d+$/, '') || value;
}

export function auditAnswerPositionBalance(questions, options = {}) {
    const minBatchSize = Number.isInteger(options.minBatchSize) ? options.minBatchSize : 10;
    const maxDominantShare = Number.isFinite(options.maxDominantShare) ? options.maxDominantShare : 0.4;
    const maxRunLength = Number.isInteger(options.maxRunLength) ? options.maxRunLength : 4;
    const batches = new Map();
    const issues = [];

    for (const question of Array.isArray(questions) ? questions : []) {
        const id = text(question?.id);
        const answer = text(question?.correct_answer ?? question?.correctAnswer).toUpperCase();
        if (!id || !/^[A-E]$/.test(answer)) {
            issues.push({ type: 'invalid_answer_key', id: id || '(missing id)' });
            continue;
        }
        const batch = answerBatchId(id);
        if (!batches.has(batch)) batches.set(batch, []);
        batches.get(batch).push({ id, answer });
    }

    const summaries = [];
    for (const [batch, rows] of batches) {
        rows.sort((a, b) => a.id.localeCompare(b.id));
        const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
        let currentRun = 0;
        let longestRun = 0;
        let previousAnswer = null;

        for (const row of rows) {
            counts[row.answer]++;
            currentRun = row.answer === previousAnswer ? currentRun + 1 : 1;
            longestRun = Math.max(longestRun, currentRun);
            previousAnswer = row.answer;
        }

        const [dominantAnswer, dominantCount] = Object.entries(counts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        const dominantShare = rows.length ? dominantCount / rows.length : 0;
        const summary = {
            batch,
            questions: rows.length,
            counts,
            dominantAnswer,
            dominantCount,
            dominantShare,
            longestRun,
        };
        summaries.push(summary);

        if (rows.length >= minBatchSize && dominantShare > maxDominantShare) {
            issues.push({
                type: 'dominant_answer_position',
                batch,
                answer: dominantAnswer,
                count: dominantCount,
                questions: rows.length,
                share: dominantShare,
            });
        }
        if (rows.length >= minBatchSize && longestRun > maxRunLength) {
            issues.push({
                type: 'answer_position_run',
                batch,
                runLength: longestRun,
                limit: maxRunLength,
            });
        }
    }

    summaries.sort((a, b) => a.batch.localeCompare(b.batch));
    return { valid: issues.length === 0, issues, batches: summaries };
}
