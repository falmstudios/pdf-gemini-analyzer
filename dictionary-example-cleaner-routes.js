// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - DEFINITIVE BATCH VERSION WITH FULL CONTEXT
// File: dictionary-example-cleaner-routes.js
// ===============================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// === DATABASE & API CLIENTS ===
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);
const axiosInstance = axios.create({ timeout: 0 });

// === TUNING PARAMETERS (TIER 2) ===
const BATCH_SIZE = 3; 
const CONCURRENT_BATCHES = 10; 

// === STATE MANAGEMENT ===
let processingState = { isProcessing: false, progress: 0, status: 'Idle', details: '', logs: [], startTime: null, lastPromptUsed: null };

function addLog(message, type = 'info') {
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    processingState.logs.push(log);
    if (processingState.logs.length > 2000) processingState.logs.shift();
    console.log(`[DICT-EXAMPLE-CLEANER] [${type.toUpperCase()}] ${message}`);
}

// === API CALLER ===
async function callOpenAI_Api(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not set.");
    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    let attempts = 0;
    const maxAttempts = 4;
    let delay = 5000;
    while (attempts < maxAttempts) {
        try {
            const response = await axiosInstance.post(apiUrl, {
                model: "gpt-4-turbo",
                messages: [{ "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },{ "role": "user", "content": prompt }],
                response_format: { "type": "json_object" }
            }, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${apiKey}` } });
            if (response.data?.choices?.[0]) return JSON.parse(response.data.choices[0].message.content);
            throw new Error('Invalid response format from OpenAI API');
        } catch (error) {
            if (error instanceof SyntaxError) {
                addLog(`CRITICAL: OpenAI API returned non-JSON. Likely a network/firewall issue.`, 'error');
                throw new Error("OpenAI API returned invalid data (likely HTML block page).");
            }
            if (error.response?.status === 429) {
                attempts++;
                if (attempts >= maxAttempts) throw new Error('OpenAI API rate limit exceeded after multiple retries.');
                const waitTime = delay + (Math.random() * 1000);
                addLog(`Rate limit hit. Retrying in ${Math.round(waitTime/1000)}s...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= 2;
            } else { throw error; }
        }
    }
}

// === DATABASE HELPERS ===
async function fetchAllWithPagination(queryBuilder, limit) {
    const PAGE_SIZE = 1000;
    let allData = [];
    let page = 0;
    let fetchedData;
    do {
        const { data, error } = await queryBuilder.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (error) throw error;
        fetchedData = data;
        if (fetchedData?.length > 0) allData.push(...fetchedData);
        page++;
    } while (fetchedData && fetchedData.length === PAGE_SIZE && (!limit || allData.length < limit));
    return limit ? allData.slice(0, limit) : allData;
}

async function getWordContext(words) {
    if (!words || words.length === 0) return {};
    const uniqueWords = [...new Set(words)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');
    const query = sourceDbClient.from('new_terms').select(`
            term_text, new_concept_to_term!inner(
                pronunciation, gender, plural_form, etymology, note,
                concept:new_concepts!inner(primary_german_label, part_of_speech, german_definition)
            )
        `).or(orFilter).eq('language', 'hal');
    const termData = await fetchAllWithPagination(query);
    const wordContextMap = {};
    termData.forEach(term => {
        if (!wordContextMap[term.term_text.toLowerCase()]) wordContextMap[term.term_text.toLowerCase()] = [];
        term.new_concept_to_term.forEach(connection => {
            wordContextMap[term.term_text.toLowerCase()].push({
                german_equivalent: connection.concept.primary_german_label,
                part_of_speech: connection.concept.part_of_speech,
                german_definition: connection.concept.german_definition,
                pronunciation: connection.pronunciation, gender: connection.gender,
                plural_form: connection.plural_form, etymology: connection.etymology, note: connection.note,
            });
        });
    });
    return wordContextMap;
}

function chunkArray(array, size) {
    const chunked_arr = [];
    for (let i = 0; i < array.length; i += size) {
        chunked_arr.push(array.slice(i, i + size));
    }
    return chunked_arr;
}


// === MAIN PROCESSING LOGIC ===
async function runDictionaryExampleCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    addLog(`Starting... Batch Size: ${BATCH_SIZE}, Concurrent Batches: ${CONCURRENT_BATCHES}`, 'info');

    try {
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);
        addLog("Reset stale jobs.", 'info');

        const pendingQuery = sourceDbClient.from('new_examples').select(`*, concept:new_concepts!inner(*)`).eq('cleaning_status', 'pending');
        const pendingExamples = await fetchAllWithPagination(pendingQuery, limit);
        if (pendingExamples.length === 0) {
            processingState = { ...processingState, status: 'Completed (No new examples)', isProcessing: false };
            addLog('No pending examples found.', 'success');
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Batching and cleaning examples...';

        const batches = chunkArray(pendingExamples, BATCH_SIZE);
        let processedCount = 0;
        let firstPromptPrinted = false;

        const idiomQuery = sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation, tags').gte('relevance_score', 6);
        const knownIdioms = await fetchAllWithPagination(idiomQuery);
        addLog(`Loaded ${knownIdioms.length} known idioms from all pages.`, 'info');

        for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
            const concurrentBatchGroup = batches.slice(i, i + CONCURRENT_BATCHES);
            addLog(`Processing a block of ${concurrentBatchGroup.length} batches (starting at batch #${i + 1})...`, 'info');

            const batchPromises = concurrentBatchGroup.map((batch, index) => {
                const shouldPrintPrompt = !firstPromptPrinted && i === 0 && index === 0;
                return processBatch(batch, knownIdioms || [], shouldPrintPrompt)
                    .then(res => {
                        if (res.promptWasPrinted) firstPromptPrinted = true;
                        return res.processedCount;
                    });
            });

            const results = await Promise.allSettled(batchPromises);
            results.forEach(result => {
                if(result.status === 'fulfilled' && result.value) {
                    processedCount += result.value;
                }
            });

            processingState.details = `Processed ${processedCount} of ${totalToProcess} total examples.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
        }

        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        addLog(`Processing complete in ${processingTime}s.`, 'success');
        processingState.status = 'Completed';

    } catch (error) {
        addLog(`CRITICAL ERROR: ${error.message}`, 'error');
        processingState.status = 'Error';
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// Processes a batch of examples
async function processBatch(batch, knownIdioms, shouldPrintPrompt) {
    if (!batch || batch.length === 0) return { processedCount: 0, promptWasPrinted: false };
    const batchIds = batch.map(ex => ex.id);
    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).in('id', batchIds);
    
    try {
        const allWordsInBatch = batch.flatMap(ex => ex.halunder_sentence?.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
        const wordContext = await getWordContext(allWordsInBatch);
        
        const prompt = buildBatchCleaningPrompt(batch, wordContext, knownIdioms);
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            addLog('Printed first batch prompt to console.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        if (!aiResult.results || !Array.isArray(aiResult.results)) throw new Error("AI response did not contain 'results' array.");

        for (const processedItem of aiResult.results) {
            const originalExample = batch.find(ex => ex.id === processedItem.original_id);
            if (!originalExample) {
                addLog(`AI returned data for an unknown original_id ${processedItem.original_id}`, 'warning');
                continue;
            }

            try {
                const expansions = processedItem.expansions || [];
                const translationsToInsert = expansions.flatMap(exp => [
                    { original_example_id: originalExample.id, cleaned_halunder: exp.cleaned_halunder, cleaned_german: exp.best_translation, confidence_score: exp.confidence_score, ai_notes: exp.notes, alternative_translations: 'gpt4_best' },
                    ...(exp.alternative_translations || []).map((alt, i) => ({
                        original_example_id: originalExample.id, cleaned_halunder: exp.cleaned_halunder, cleaned_german: alt.translation,
                        confidence_score: alt.confidence_score || 0.8, ai_notes: alt.notes, alternative_translations: `gpt4_alternative_${i + 1}`
                    }))
                ]);
                
                if (translationsToInsert.length > 0) {
                    const { error } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
                    if (error) throw new Error(`Cleaned sentence insert failed: ${error.message}`);
                }

                const highlights = expansions.flatMap(exp => exp.discovered_highlights || []);
                if (highlights.length > 0) {
                    const highlightsToUpsert = highlights
                        .filter(h => typeof h.relevance_score === 'number')
                        .map(h => ({
                            halunder_term: h.halunder_phrase.trim(),
                            german_equivalent: h.german_meaning,
                            explanation: h.explanation_german,
                            feature_type: h.type,
                            source_table: 'new_examples',
                            relevance_score: h.relevance_score,
                            tags: [h.type],
                            // *** FIX: Pass the correct original example ID ***
                            source_ids: [originalExample.id] 
                        }));
                    
                    if (highlightsToUpsert.length > 0) {
                        const { error } = await sourceDbClient.from('cleaned_linguistic_examples').upsert(highlightsToUpsert, { onConflict: 'halunder_term' });
                        if (error) throw new Error(`Highlight upsert failed: ${error.message}`);
                    }
                }

                await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', originalExample.id);

            } catch (e) {
                 addLog(`Failed to save data for example ID ${originalExample.id}: ${e.message}`, 'error');
                 await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).eq('id', originalExample.id);
            }
        }
        
        addLog(`[OK] Processed batch of ${batch.length} items.`, 'success');
        return { processedCount: batch.length, promptWasPrinted: shouldPrintPrompt };
    } catch(e) {
        addLog(`[FAIL] A whole batch failed: ${e.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).in('id', batchIds);
        return { processedCount: 0, promptWasPrinted: false };
    }
}

// Builds a prompt for a batch of items with full context
function buildBatchCleaningPrompt(batch, wordContexts, knownIdioms) {
    const inputData = batch.map(example => ({
        original_id: example.id,
        halunder_sentence: example.halunder_sentence,
        german_sentence: example.german_sentence,
        note: example.note,
        headword_context: {
            headword: example.concept.primary_german_label,
            part_of_speech: example.concept.part_of_speech,
            german_definition: example.concept.german_definition,
        }
    }));

    return `You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process an array of raw dictionary example sentences, clean them meticulously, and provide high-quality, natural translations for AI training.

**CRITICAL INSTRUCTIONS FOR EVERY EXAMPLE:**

1.  **CAPITALIZATION & PUNCTUATION (MANDATORY):**
    - The final \`cleaned_halunder\` MUST start with a capital letter and end with appropriate punctuation (., ?, !).
    - The final \`best_translation\` and all \`alternative_translations\` in German MUST also start with a capital letter and end with proper punctuation. This is non-negotiable.

2.  **SENTENCE EXPANSION:**
    - If a Halunder sentence contains slashes (e.g., "man kiid di kiis/bitten/friis wuune"), you MUST expand this into multiple, separate sentence objects in the "expansions" array for that example. Each expansion should be a complete, valid sentence.

3.  **TRANSLATION HIERARCHY:**
    - \`best_translation\`: This MUST be the most natural, common, and idiomatic German translation. Improve the original German hint if it's awkward or too literal.
    - \`alternative_translations\`: Include other natural variations. If a literal translation exists and is different, you MUST include it here for linguistic analysis.

**MAIN TASK:**
For each item in the "input_examples" array, generate a corresponding object in the "results" array of your response.

**CONTEXT DATA FOR THE ENTIRE BATCH:**

**1. Dictionary Context for Individual Words:**
\`\`\`json
${JSON.stringify(wordContexts, null, 2)}
\`\`\`

**2. Known Idioms & Cultural References (for reference):**
\`\`\`json
${JSON.stringify(knownIdioms.slice(0, 100), null, 2)}
\`\`\`

**EXAMPLES TO PROCESS:**
\`\`\`json
${JSON.stringify(inputData, null, 2)}
\`\`\`

**YOUR JSON OUTPUT FORMAT:**
Your entire response must be a single JSON object. The "results" array order must match the "input_examples" order.

\`\`\`json
{
  "results": [
    {
      "original_id": "The UUID of the first input example",
      "expansions": [
        {
          "cleaned_halunder": "Hi froaget mi miin Grummen it.",
          "best_translation": "Er fragt mir ein Loch in den Bauch.",
          "confidence_score": 0.97,
          "notes": "Idiomatic translation is best for training. The literal meaning is included as an alternative.",
          "alternative_translations": [
            {"translation": "Er löchert mich mit seinen Fragen.", "confidence_score": 0.9, "notes": "Another natural variation."},
            {"translation": "Er fragt mich meine Eingeweide aus.", "confidence_score": 0.6, "notes": "Literal translation for linguistic analysis."}
          ],
          "discovered_highlights": [{"halunder_phrase": "miin Grummen it froage", "german_meaning": "jemandem Löcher in den Bauch fragen", "explanation_german": "Eine Redewendung für intensives Ausfragen.", "type": "idiom", "relevance_score": 9}]
        }
      ]
    }
  ]
}
\`\`\`
`;
}


// --- API ROUTES ---
router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) return res.status(400).json({ error: 'Processing is already in progress.' });
    const limit = parseInt(req.body.limit, 10) || 10000;
    runDictionaryExampleCleaner(limit).catch(err => console.error("Caught unhandled error in dictionary example cleaner:", err));
    res.json({ success: true, message: `Definitive cleaning started for up to ${limit} examples.` });
});
router.get('/progress', (req, res) => res.json(processingState));
router.get('/stats', async (req, res) => {
    try {
        const { count: total } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true });
        const { count: pending } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true }).eq('cleaning_status', 'pending');
        const { count: cleaned } = await sourceDbClient.from('ai_cleaned_dictsentences').select('*', { count: 'exact', head: true });
        const { count: features } = await sourceDbClient.from('cleaned_linguistic_examples').select('*', { count: 'exact', head: true }).eq('source_table', 'new_examples');
        res.json({ totalExamples: total || 0, pendingExamples: pending || 0, cleanedExamples: cleaned || 0, discoveredIdioms: features || 0 });
    } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/reset-all', async (req, res) => {
    try {
        const { data, error } = await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).neq('id', '00000000-0000-0000-0000-000000000000').select('id');
        if (error) throw error;
        res.json({ success: true, message: `Reset ${data.length} examples to pending`, resetCount: data.length });
    } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/clear-cleaned', async (req, res) => {
    try {
        await sourceDbClient.from('ai_cleaned_dictsentences').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await sourceDbClient.from('cleaned_linguistic_examples').delete().eq('source_table', 'new_examples');
        res.json({ success: true, message: 'Cleared all cleaned data and discovered linguistic features' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
