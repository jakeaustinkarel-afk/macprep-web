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
        if (choiceText.length < 2) errors.push(`Choice ${index + 1} is missing text.`);
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
