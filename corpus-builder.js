const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// === DATABASE CONNECTIONS ===
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);
const dictionaryDbClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const axiosInstance = axios.create({ timeout: 0 });

// === STATE MANAGEMENT ===
let processingState = {
    isProcessing: false,
    progress: 0,
    status: 'Idle',
    details: '',
    logs: [],
    startTime: null
};

function addLog(message, type = 'info') {
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    processingState.logs.push(log);
    if (processingState.logs.length > 1000) processingState.logs.shift();
    console.log(`[CORPUS-BUILDER] [${type.toUpperCase()}] ${message}`);
}

// === API CALLER FOR OPENAI ===
async function callOpenAI_Api(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not set.");
    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    
    let attempts = 0;
    const maxAttempts = 4;
    let delay = 5000;

    while (attempts < maxAttempts) {
        try {
            const response = await axiosInstance.post(
                apiUrl,
                {
                    model: "o3-2025-04-16", // Using the best value, high-quality model
                    messages: [
                        { "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },
                        { "role": "user", "content": prompt }
                    ],
                    temperature: 0.7,
                    response_format: { "type": "json_object" }
                },
                { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } }
            );

            if (response.data && response.data.choices && response.data.choices[0]) {
                return JSON.parse(response.data.choices[0].message.content);
            }
            throw new Error('Invalid response format from OpenAI API');
        } catch (error) {
            if (error.response && error.response.status === 429) {
                attempts++;
                if (attempts >= maxAttempts) {
                    addLog(`Max retry attempts reached for OpenAI API. Giving up.`, 'error');
                    throw new Error('OpenAI API rate limit exceeded after multiple retries.');
                }
                const jitter = Math.random() * 1000;
                const waitTime = delay + jitter;
                addLog(`OpenAI API rate limit hit. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${attempts}/${maxAttempts})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= 2;
            } else {
                if (error.response) {
                    console.error("OpenAI API Error Response:", error.response.data);
                    throw new Error(`OpenAI API error: ${error.response.status} - ${JSON.stringify(error.response.data.error)}`);
                }
                throw error;
            }
        }
    }
}

// === THE MAIN PROCESSING FUNCTION ===
async function runCorpusBuilder(textLimit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now() };
    let firstPromptPrinted = false;
    let allLinguisticExamples = [];
    addLog(`Starting corpus build process using OpenAI o3...`, 'info');

    try {
        addLog("Checking for any existing pending, stale, or errored jobs...", 'info');
        const { data: resetRows, error: resetError } = await sourceDbClient.from('source_sentences').update({ processing_status: 'pending', error_message: null }).in('processing_status', ['processing', 'error']).select('id');
        if (resetError) throw new Error(`Failed to reset stale jobs: ${resetError.message}`);
        if (resetRows && resetRows.length > 0) {
            addLog(`Reset ${resetRows.length} stale/errored jobs back to 'pending'.`, 'warning');
        }

        const { count: existingPendingCount, error: checkError } = await sourceDbClient.from('source_sentences').select('*', { count: 'exact', head: true }).eq('processing_status', 'pending');
        if (checkError) throw new Error(`Failed to check for pending jobs: ${checkError.message}`);
        
        let pendingSentences;

        addLog('Pre-fetching all linguistic examples...', 'info');
        let lingPage = 0;
        const lingPageSize = 1000;
        while (true) {
            const from = lingPage * lingPageSize;
            const to = from + lingPageSize - 1;
            const { data, error } = await sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation, feature_type').gte('relevance_score', 4).range(from, to);
            if (error) throw new Error(`Linguistic examples lookup failed: ${error.message}`);
            if (data && data.length > 0) allLinguisticExamples.push(...data);
            if (!data || data.length < lingPageSize) break;
            lingPage++;
        }
        addLog(`Successfully pre-fetched ${allLinguisticExamples.length} linguistic examples.`, 'success');

        if (existingPendingCount > 0) {
            addLog(`Found ${existingPendingCount} existing pending sentences. Entering RECOVERY MODE.`, 'warning');
            pendingSentences = [];
            let recoveryPage = 0;
            const recoveryPageSize = 1000;
            while(true) {
                const from = recoveryPage * recoveryPageSize;
                const to = from + recoveryPageSize - 1;
                const { data, error } = await sourceDbClient.from('source_sentences').select('*').eq('processing_status', 'pending').order('text_id').order('sentence_number').range(from, to);
                if (error) throw new Error(`Failed to fetch pending sentences for recovery: ${error.message}`);
                if (data && data.length > 0) pendingSentences.push(...data);
                if (!data || data.length < recoveryPageSize) break;
                recoveryPage++;
            }
            addLog(`Successfully loaded all ${pendingSentences.length} sentences for recovery.`, 'success');

        } else {
            addLog("No existing pending jobs found. Starting new text extraction.", 'info');
            addLog(`Fetching up to ${textLimit} new texts...`, 'info');
            const { data: texts, error: fetchError } = await sourceDbClient.from('texts').select('id, complete_helgolandic_text').or('review_status.eq.pending,review_status.eq.halunder_only').limit(textLimit);
            if (fetchError) throw new Error(`Source DB fetch error: ${fetchError.message}`);
            if (!texts || texts.length === 0) {
                addLog('No new texts found to process.', 'success');
                processingState.status = 'Completed (No new texts)';
                processingState.isProcessing = false;
                return;
            }
            
            const allSentencePairsToInsert = [];
            for (const text of texts) {
                const initialSegments = text.complete_helgolandic_text.match(/[^.?!]+[.?!]+/g) || [];
                const finalSentences = [];
                let sentenceBuffer = [];
                for (const segment of initialSegments) {
                    sentenceBuffer.push(segment.trim());
                    const currentBufferString = sentenceBuffer.join(' ');
                    if (currentBufferString.trim().split(/\s+/).length >= 5) {
                        finalSentences.push(currentBufferString);
                        sentenceBuffer = [];
                    }
                }
                if (sentenceBuffer.length > 0) {
                    const leftoverString = sentenceBuffer.join(' ');
                    if (finalSentences.length > 0) finalSentences[finalSentences.length - 1] += ' ' + leftoverString;
                    else finalSentences.push(leftoverString);
                }
                for (let i = 0; i < finalSentences.length; i += 2) {
                    let sentencePair = finalSentences[i];
                    if (finalSentences[i + 1]) sentencePair += ' ' + finalSentences[i + 1];
                    allSentencePairsToInsert.push({ text_id: text.id, sentence_number: i + 1, halunder_sentence: sentencePair.trim() });
                }
                await sourceDbClient.from('texts').update({ review_status: 'processing_halunder_only' }).eq('id', text.id);
            }

            if (allSentencePairsToInsert.length > 0) {
                addLog(`Extracted ${allSentencePairsToInsert.length} new sentence pairs. Inserting...`, 'info');
                const insertBatchSize = 500;
                for (let i = 0; i < allSentencePairsToInsert.length; i += insertBatchSize) {
                    const chunk = allSentencePairsToInsert.slice(i, i + insertBatchSize);
                    const { error: insertError } = await sourceDbClient.from('source_sentences').insert(chunk);
                    if (insertError) throw new Error(`Failed to insert sentence chunk: ${insertError.message}`);
                }
                addLog('All new sentence pairs saved successfully.', 'success');
            }
            const { data: newPending, error: newPendingError } = await sourceDbClient.from('source_sentences').select('*').in('text_id', texts.map(t => t.id)).eq('processing_status', 'pending');
            if (newPendingError) throw new Error(`Could not fetch newly inserted sentences: ${newPendingError.message}`);
            pendingSentences = newPending;
        }

        // --- AI PROCESSING STAGE ---
        processingState.status = 'Processing sentence pairs with AI...';
        let processedCount = 0;
        const totalToProcess = pendingSentences.length;
        if (totalToProcess === 0) {
             addLog('No sentence pairs to process with AI.', 'info');
        }

        // We can remove the daily limit check as o3 has a very high token-based limit
        // which is harder to track precisely. The RPM limit is the main concern.
        addLog(`Using model o3 with a 500 RPM limit.`, 'info');

        for (let i = 0; i < totalToProcess; i += 5) {
            const chunk = pendingSentences.slice(i, i + 5);
            addLog(`Processing batch of ${chunk.length} sentence pairs (starting with pair ${i + 1} of ${totalToProcess})...`, 'info');

            const processingPromises = chunk.map((sentence, index) => {
                return new Promise(resolve => setTimeout(resolve, index * 200)) // Stagger calls slightly
                    .then(() => processSingleSentence(sentence, !firstPromptPrinted, allLinguisticExamples))
                    .then(promptWasPrinted => {
                        if (promptWasPrinted) firstPromptPrinted = true;
                    }).catch(e => {
                        addLog(`Failed to process sentence pair ID ${sentence.id}: ${e.message}`, 'error');
                        return sourceDbClient.from('source_sentences').update({ processing_status: 'error', error_message: e.message }).eq('id', sentence.id);
                    });
            });

            await Promise.all(processingPromises);

            processedCount += chunk.length;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} sentence pairs.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            
            // A very short pause is sufficient due to the staggering and high RPM limit
            if (i + 5 < totalToProcess) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        addLog(`Processing complete for this run in ${processingTime}s.`, 'success');
        processingState.status = 'Completed';

    } catch (error) {
        addLog(`A critical error occurred: ${error.message}`, 'error');
        processingState.status = 'Error';
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// === THE AI PIPELINE FOR A SINGLE SENTENCE PAIR ===
async function processSingleSentence(sentence, shouldPrintPrompt, allLinguisticExamples) {
    await sourceDbClient.from('source_sentences').update({ processing_status: 'processing' }).eq('id', sentence.id);

    const runpodResponse = await fetch('https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}` }, body: JSON.stringify({ input: { text: sentence.halunder_sentence, num_alternatives: 3 } }) });
    if (!runpodResponse.ok) throw new Error('RunPod API failed.');
    const runpodData = await runpodResponse.json();
    const runpodTranslations = runpodData.output?.translations || [];
    await sourceDbClient.from('source_sentences').update({ runpod_translations: runpodTranslations }).eq('id', sentence.id);

    const words = [...new Set(sentence.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || [])];
    const orFilter = words.map(word => `term_text.ilike.${word}`).join(',');
    const { data: dictData, error: dictError } = await dictionaryDbClient.from('terms').select(`term_text, concept_to_term!inner(concept:concepts!inner(primary_german_label, part_of_speech, german_definition))`).or(orFilter).eq('language', 'hal');
    if (dictError) addLog(`Dictionary lookup failed: ${dictError.message}`, 'warning');
    
    const foundLinguisticExamples = allLinguisticExamples?.filter(ex => sentence.halunder_sentence.toLowerCase().includes(ex.halunder_term.toLowerCase())) || [];

    const { data: contextSentences } = await sourceDbClient.from('source_sentences').select('halunder_sentence').eq('text_id', sentence.text_id).lt('sentence_number', sentence.sentence_number).order('sentence_number', { ascending: false }).limit(1);

    const prompt = buildOpenAIPrompt(sentence.halunder_sentence, contextSentences, runpodTranslations, dictData, foundLinguisticExamples);
    
    if (shouldPrintPrompt) {
        console.log('----------- OPENAI PROMPT FOR FIRST SENTENCE PAIR -----------');
        console.log(prompt);
        console.log('-----------------------------------------------------------');
        addLog('Printed full OpenAI prompt to server console for verification.', 'info');
    }

    const aiResult = await callOpenAI_Api(prompt);

    const corpusEntries = [];
    corpusEntries.push({ source_sentence_id: sentence.id, halunder_sentence: aiResult.corrected_halunder_pair, german_translation: aiResult.best_translation_pair, source: 'o3_best_pair', confidence_score: aiResult.confidence_score, notes: aiResult.notes });
    if (aiResult.corrected_sentence_1 && aiResult.translation_sentence_1) {
        corpusEntries.push({ source_sentence_id: sentence.id, halunder_sentence: aiResult.corrected_sentence_1, german_translation: aiResult.translation_sentence_1, source: 'o3_best_sentence1', confidence_score: aiResult.confidence_score, notes: "Individual translation of the first sentence in the pair." });
    }
    if (aiResult.corrected_sentence_2 && aiResult.translation_sentence_2) {
        corpusEntries.push({ source_sentence_id: sentence.id, halunder_sentence: aiResult.corrected_sentence_2, german_translation: aiResult.translation_sentence_2, source: 'o3_best_sentence2', confidence_score: aiResult.confidence_score, notes: "Individual translation of the second sentence in the pair." });
    }
    if (aiResult.alternative_translations) {
        aiResult.alternative_translations.forEach(alt => {
            corpusEntries.push({ source_sentence_id: sentence.id, halunder_sentence: aiResult.corrected_halunder_pair, german_translation: alt.translation, source: 'o3_alternative_pair', confidence_score: alt.confidence_score, notes: alt.notes });
        });
    }

    const { error: corpusInsertError } = await sourceDbClient.from('ai_translated_corpus').insert(corpusEntries);
    if (corpusInsertError) throw new Error(`Failed to save to corpus: ${corpusInsertError.message}`);

    await sourceDbClient.from('source_sentences').update({ processing_status: 'completed' }).eq('id', sentence.id);
    
    const logMessage = `[HAL-CORRECTED] ${aiResult.corrected_halunder_pair} -> [DE] ${aiResult.best_translation_pair}`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// === HELPER TO BUILD THE PROMPT (UNCHANGED) ===
function buildOpenAIPrompt(targetSentence, context, proposals, dictionary, linguisticExamples) {
    return `
You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to proofread a raw Halunder text for OCR errors and then provide a high-quality, multi-layered German translation.

**TASK 1: PROOFREAD THE HALUNDER TEXT**
Your first and most important task is to correct the **Target Halunder Sentence Pair**. The source text may contain obvious, non-linguistic errors from scanning.
- **DO:** Fix misplaced line breaks (e.g., "letj\\ninaptain" -> "letj inaptain"), incorrect spacing, and obvious typos that make a word nonsensical (e.g., "Djanne" -> "Djenne"). Combine hyphenated words that were split across lines.
- **DO NOT:** Change grammar, word choice, or dialectal spellings. If a word is a valid, albeit archaic, Halunder word, **leave it as is**. Do not "modernize" the text. For example, do not change 'her' to 'har' even if 'har' seems more grammatically correct in the context. Preserve the original's linguistic character.

**TASK 2: TRANSLATE THE CORRECTED TEXT**
After proofreading, provide three distinct translations:
1.  A translation for the **entire corrected pair** as a whole.
2.  A separate translation for **only the first sentence** within the pair.
3.  A separate translation for **only the second sentence** within the pair.
The German translation should sound natural and fluent. Prioritize this over a stiff, literal translation.

**TASK 3: PROVIDE ALTERNATIVES**
If valid alternative translations exist for the *entire pair* (e.g., using different but equally accurate synonyms), include them.

**TASK 4: OUTPUT JSON**
Structure your entire response in the following JSON format ONLY. Do not include any other text, markdown, or explanations outside the JSON structure.

**INPUT DATA:**

**1. Sentence Context:**
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

**2. Target Halunder Sentence Pair (may contain errors):**
"${targetSentence}"

**3. Machine Translation Proposals (from RunPod):**
\`\`\`json
${JSON.stringify(proposals, null, 2)}
\`\`\`

**4. Dictionary Entries for words in the target sentence:**
\`\`\`json
${JSON.stringify(dictionary, null, 2)}
\`\`\`

**5. Relevant Linguistic Phrases found in the target sentence:**
\`\`\`json
${JSON.stringify(linguisticExamples, null, 2)}
\`\`\`

**YOUR JSON OUTPUT:**
\`\`\`json
{
  "corrected_halunder_pair": "The full, corrected version of the two sentences joined together, with only OCR/typo fixes.",
  "corrected_sentence_1": "The corrected version of only the first sentence.",
  "corrected_sentence_2": "The corrected version of only the second sentence (or null if there is no second sentence).",
  "best_translation_pair": "The single best and most natural German translation for the entire corrected pair.",
  "translation_sentence_1": "The German translation for only the first corrected sentence.",
  "translation_sentence_2": "The German translation for only the second corrected sentence (or null).",
  "confidence_score": 0.95,
  "notes": "Explain briefly why you chose this translation, e.g., 'Corrected '\\n' and translated idiom X.'",
  "alternative_translations": [
    {
      "translation": "A valid alternative translation for the entire pair.",
      "confidence_score": 0.80,
      "notes": "This is a more literal translation of the pair."
    }
  ]
}
\`\`\`
`;
}

// === API ROUTES ===
router.post('/start-processing', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 10;
    // Model is now hardcoded to o3, so we don't need to get it from the request
    runCorpusBuilder(limit).catch(err => {
        console.error("Caught unhandled error in corpus builder:", err);
    });
    res.json({ success: true, message: `Processing started for up to ${limit} texts using OpenAI o3.` });
});

router.post('/prepare-all-texts', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    runPreparationOnly().catch(err => {
        console.error("Caught unhandled error in preparation:", err);
    });
    res.json({ success: true, message: `Preparation of all remaining texts has started.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
});

module.exports = router;
