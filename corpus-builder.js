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

async function callGemini_2_5_Pro(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';
    let attempts = 0;
    const maxAttempts = 4;
    let delay = 5000;
    while (attempts < maxAttempts) {
        try {
            const response = await axiosInstance.post(
                apiUrl,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.9, maxOutputTokens: 20000 }
                },
                { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } }
            );
            if (response.data && response.data.candidates && response.data.candidates[0]) {
                const responseText = response.data.candidates[0].content.parts[0].text;
                const cleanedText = responseText.replace(/^```json\s*|```$/g, '').trim();
                return JSON.parse(cleanedText);
            }
            throw new Error('Invalid response format from Gemini 2.5 Pro API');
        } catch (error) {
            if (error.response && error.response.status === 429) {
                attempts++;
                if (attempts >= maxAttempts) {
                    addLog(`Max retry attempts reached for Gemini API. Giving up.`, 'error');
                    throw new Error('Gemini API rate limit exceeded after multiple retries.');
                }
                const jitter = Math.random() * 1000;
                const waitTime = delay + jitter;
                addLog(`Gemini API rate limit hit. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${attempts}/${maxAttempts})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= 2;
            } else {
                if (error.response) {
                    console.error("Gemini API Error Response:", error.response.data);
                    throw new Error(`Gemini API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
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
    addLog(`Starting corpus build process using Gemini 2.5 Pro...`, 'info');

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

        const DAILY_API_LIMIT = 950;
        addLog(`Using daily API budget of ${DAILY_API_LIMIT}.`, 'info');
        let requestsMadeThisRun = 0;

        for (let i = 0; i < totalToProcess; i += 5) {
            const chunk = pendingSentences.slice(i, i + 5);
            if (requestsMadeThisRun + chunk.length > DAILY_API_LIMIT) {
                addLog(`Daily API limit approaching. Stopping before this batch.`, 'warning');
                break;
            }

            addLog(`Processing batch of ${chunk.length} sentence pairs (starting with pair ${i + 1} of ${totalToProcess})...`, 'info');
            const processingPromises = chunk.map((sentence, index) => {
                return new Promise(resolve => setTimeout(resolve, index * 400))
                    .then(() => processSingleSentence(sentence, !firstPromptPrinted, allLinguisticExamples))
                    .then(promptWasPrinted => {
                        if (promptWasPrinted) firstPromptPrinted = true;
                    }).catch(e => {
                        addLog(`Failed to process sentence pair ID ${sentence.id}: ${e.message}`, 'error');
                        return sourceDbClient.from('source_sentences').update({ processing_status: 'error', error_message: e.message }).eq('id', sentence.id);
                    });
            });

            await Promise.all(processingPromises);

            requestsMadeThisRun += chunk.length;
            processedCount += chunk.length;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} sentence pairs. API calls today: ${requestsMadeThisRun}/${DAILY_API_LIMIT}.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            
            if (i + 5 < totalToProcess) {
                await new Promise(resolve => setTimeout(resolve, 1000));
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

    const words = [...new Set(sentence.halunder_sentence.toLowerCase().match(/[\p{L}0-9]+/gu) || [])];
    const { data: dictData, error: dictError } = await dictionaryDbClient.from('terms').select(`term_text, concept_to_term!inner(concept:concepts!inner(primary_german_label, part_of_speech, german_definition))`).filter('term_text', 'ilike.any', `{${words.join(',')}}`).eq('language', 'hal');
    if (dictError) addLog(`Dictionary lookup failed: ${dictError.message}`, 'warning');
    
    const foundLinguisticExamples = allLinguisticExamples?.filter(ex => sentence.halunder_sentence.toLowerCase().includes(ex.halunder_term.toLowerCase())) || [];

    const windowSize = 1;
    const fromIndex = Math.max(0, sentence.sentence_number - 1 - windowSize);
    const toIndex = sentence.sentence_number - 1 + windowSize;
    const { data: contextSentences } = await sourceDbClient.from('source_sentences').select('halunder_sentence').eq('text_id', sentence.text_id).order('sentence_number').range(fromIndex, toIndex);

    const prompt = buildGeminiPrompt(sentence.halunder_sentence, contextSentences, runpodTranslations, dictData, foundLinguisticExamples);
    
    if (shouldPrintPrompt) {
        console.log('----------- GEMINI PROMPT FOR FIRST SENTENCE PAIR -----------');
        console.log(prompt);
        console.log('-----------------------------------------------------------');
        addLog('Printed full Gemini prompt to server console for verification.', 'info');
    }

    const geminiResult = await callGemini_2_5_Pro(prompt);

    // --- UPDATED: Use the corrected Halunder sentence from Gemini ---
    const corpusEntries = [];
    corpusEntries.push({
        source_sentence_id: sentence.id,
        halunder_sentence: geminiResult.corrected_halunder_sentence, // Use the corrected version
        german_translation: geminiResult.best_translation,
        source: 'gemini_best',
        confidence_score: geminiResult.confidence_score,
        notes: geminiResult.notes
    });
    if (geminiResult.alternative_translations) {
        geminiResult.alternative_translations.forEach(alt => {
            corpusEntries.push({
                source_sentence_id: sentence.id,
                halunder_sentence: geminiResult.corrected_halunder_sentence, // Use the corrected version
                german_translation: alt.translation,
                source: 'gemini_alternative',
                confidence_score: alt.confidence_score,
                notes: alt.notes
            });
        });
    }

    const { error: corpusInsertError } = await sourceDbClient.from('ai_translated_corpus').insert(corpusEntries);
    if (corpusInsertError) throw new Error(`Failed to save to corpus: ${corpusInsertError.message}`);

    await sourceDbClient.from('source_sentences').update({ processing_status: 'completed' }).eq('id', sentence.id);
    
    // --- UPDATED: Log the corrected Halunder sentence ---
    const logMessage = `[HAL-CORRECTED] ${geminiResult.corrected_halunder_sentence} -> [DE] ${geminiResult.best_translation}`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// === HELPER TO BUILD THE PROMPT (IMPROVED) ===
function buildGeminiPrompt(targetSentence, context, proposals, dictionary, linguisticExamples) {
    return `
You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to create a perfect German translation for a given Halunder sentence pair, creating a high-quality parallel corpus for machine learning.

**PRIMARY GOAL:** Your first and most important task is to correct the **Target Halunder Sentence Pair**. It may contain obvious OCR errors, typos, or misplaced line breaks (like '\\n'). Your translation must be based on this corrected version.

**INSTRUCTIONS:**
1.  **Correct the Halunder:** Analyze the **Target Halunder Sentence Pair** and produce a clean, corrected version. This corrected version should be a single, flowing line of text.
2.  **Translate the Corrected Version:** Using all available context, create the most natural-sounding and contextually accurate German translation for the *entire corrected pair*.
3.  **Analyze Context:** Use the **Sentence Context** to understand the surrounding conversation.
4.  **Review Proposals:** Use the **Machine Translation Proposals** as a starting point, but do not trust them blindly.
5.  **Consult Dictionaries:** Use the **Dictionary Entries** and **Relevant Linguistic Phrases** to understand literal meanings and idioms.
6.  **Provide Alternatives:** If valid alternative translations exist (e.g., using different but equally accurate synonyms or slightly different wording), include them.
7.  **Output JSON:** Structure your entire response in the following JSON format ONLY. Do not include any other text.

**LINGUISTIC NUANCES & GUIDELINES:**
*   **Vocabulary:** Halunder has a smaller vocabulary. A single Halunder word might map to several German concepts. Choose the most contextually appropriate German word.
*   **Word Order:** Re-order the German translation to sound completely natural, even if it differs from the Halunder structure.
*   **Synonyms:** You are encouraged to use accurate German synonyms that fit the context better than a literal translation.

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
  "corrected_halunder_sentence": "This is the corrected, single-line version of the Halunder sentence pair.",
  "best_translation": "This is your single best and most natural German translation for the entire corrected sentence pair.",
  "confidence_score": 0.95,
  "notes": "Explain briefly why you chose this translation, e.g., 'Corrected '\\n' and translated idiom X.'",
  "alternative_translations": [
    {
      "translation": "This is a valid, but slightly less common or more literal alternative.",
      "confidence_score": 0.80,
      "notes": "This is a more literal translation."
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
    runCorpusBuilder(limit).catch(err => {
        console.error("Caught unhandled error in corpus builder:", err);
    });
    res.json({ success: true, message: `Processing started for up to ${limit} texts using Gemini 2.5 Pro.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
});

module.exports = router;
