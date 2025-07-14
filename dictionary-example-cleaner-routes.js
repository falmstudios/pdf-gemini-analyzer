// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - AI JUDGES RELEVANCE & EXPANDS SENTENCES
// File: dictionary-example-cleaner-routes.js
// ===============================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Database connection - using SOURCE database only
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

const axiosInstance = axios.create({ timeout: 0 });

// --- TUNING PARAMETERS ---
// How many sentences to include in a single API call. Smaller is better for prompt quality.
const BATCH_SIZE = 4;
// How many API calls (batches) to run in parallel.
// With a BATCH_SIZE of 4, 10 concurrent batches will process 40 source examples per cycle.
const CONCURRENT_BATCHES = 10;

// State management
let processingState = {
    isProcessing: false,
    progress: 0,
    status: 'Idle',
    details: '',
    logs: [],
    startTime: null,
    lastPromptUsed: null
};

function addLog(message, type = 'info') {
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    processingState.logs.push(log);
    if (processingState.logs.length > 2000) processingState.logs.shift();
    console.log(`[DICT-EXAMPLE-CLEANER] [${type.toUpperCase()}] ${message}`);
}

// OpenAI API caller
async function callOpenAI_Api(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not set.");
    const apiUrl = 'https://api.openai.com/v1/chat/completions';

    let attempts = 0;
    const maxAttempts = 5;
    let delay = 5000;

    while (attempts < maxAttempts) {
        try {
            const response = await axiosInstance.post(
                apiUrl,
                {
                    model: "gpt-4-turbo",
                    messages: [
                        { "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },
                        { "role": "user", "content": prompt }
                    ],
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

// Fetches word context for a batch of words
async function getWordContext(words) {
    if (!words || words.length === 0) return [];
    const uniqueWords = [...new Set(words)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');

    const { data: termData, error } = await sourceDbClient
        .from('new_terms')
        .select(`term_text, new_concept_to_term!inner(concept:new_concepts!inner(primary_german_label, part_of_speech, german_definition))`)
        .or(orFilter).eq('language', 'hal');

    if (error) {
        addLog(`Dictionary lookup error: ${error.message}`, 'warning');
        return [];
    }
    const wordContextMap = {};
    if (termData) {
        termData.forEach(term => {
            const contexts = term.new_concept_to_term.map(c => ({
                german_equivalent: c.concept.primary_german_label,
                part_of_speech: c.concept.part_of_speech,
                german_definition: c.concept.german_definition,
            }));
            wordContextMap[term.term_text.toLowerCase()] = contexts;
        });
    }
    return wordContextMap;
}

function chunkArray(array, size) {
    const chunked_arr = [];
    for (let i = 0; i < array.length; i += size) {
        chunked_arr.push(array.slice(i, i + size));
    }
    return chunked_arr;
}

// Main processing function - runs batches concurrently
async function runDictionaryExampleCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    addLog(`Starting BATCHED dictionary cleaning... Batch Size: ${BATCH_SIZE}, Concurrent Batches: ${CONCURRENT_BATCHES}`, 'info');

    try {
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);
        addLog("Reset any stale 'processing' jobs.", 'info');

        const { data: pendingExamples, error: fetchError } = await sourceDbClient
            .from('new_examples').select(`*, concept:new_concepts!inner(*)`).eq('cleaning_status', 'pending')
            .not('halunder_sentence', 'is', null).not('german_sentence', 'is', null).limit(limit);

        if (fetchError) throw new Error(`Failed to fetch examples: ${fetchError.message}`);
        if (!pendingExamples || pendingExamples.length === 0) {
            processingState = { ...processingState, status: 'Completed (No new examples)', isProcessing: false };
            addLog('No pending examples found to clean.', 'success');
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} source examples to process.`, 'success');
        processingState.status = 'Batching and cleaning examples...';

        const batches = chunkArray(pendingExamples, BATCH_SIZE);
        let processedCount = 0;
        let firstPromptPrinted = false;

        const { data: knownIdioms } = await sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation, tags').gte('relevance_score', 6);
        addLog(`Loaded ${knownIdioms?.length || 0} known idioms for context.`, 'info');

        for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
            const concurrentBatchGroup = batches.slice(i, i + CONCURRENT_BATCHES);
            addLog(`Processing batch group starting at index ${i} (${concurrentBatchGroup.length} batches in parallel)...`, 'info');

            const batchPromises = concurrentBatchGroup.map((batch, index) => {
                const shouldPrintPrompt = !firstPromptPrinted && i === 0 && index === 0;
                if (shouldPrintPrompt) firstPromptPrinted = true;
                return processBatch(batch, knownIdioms || [], shouldPrintPrompt);
            });

            const results = await Promise.allSettled(batchPromises);
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    processedCount += result.value.processed;
                } else if (result.status === 'rejected') {
                    addLog(`A batch failed catastrophically: ${result.reason.message}`, 'error');
                }
            });

            processingState.details = `Processed ${processedCount} of ${totalToProcess} original examples.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
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

// Processes a batch, handling the new AI response structure with expansions
async function processBatch(batch, knownIdioms, shouldPrintPrompt) {
    if (!batch || batch.length === 0) return { processed: 0, generated: 0 };

    const batchIds = batch.map(ex => ex.id);
    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).in('id', batchIds);

    let generatedCount = 0;
    try {
        const allWordsInBatch = batch.flatMap(ex => ex.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
        const wordContexts = await getWordContext(allWordsInBatch);

        const prompt = buildBatchCleaningPrompt(batch, wordContexts, knownIdioms);
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- BATCHED DICTIONARY EXAMPLE CLEANER PROMPT (TRUNCATED) -----------');
            console.log(prompt.substring(0, 4000) + "\n...");
            console.log('-------------------------------------------------------------------');
            addLog('Printed full batched prompt to server console for verification.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        if (!aiResult.results || !Array.isArray(aiResult.results)) throw new Error(`AI response is missing the 'results' array.`);

        for (const resultItem of aiResult.results) {
            const originalExample = batch.find(ex => ex.id === resultItem.original_id);
            if (!originalExample) {
                addLog(`Warning: AI returned result for an unknown original_id: ${resultItem.original_id}`, 'warning');
                continue;
            }

            if (!resultItem.expansions || resultItem.expansions.length === 0) {
                addLog(`Warning: No expansions provided by AI for original_id: ${originalExample.id}`, 'warning');
                await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: 'AI provided no expansions' }).eq('id', originalExample.id);
                continue;
            }

            for (const expansion of resultItem.expansions) {
                try {
                    // Create new rows for the best translation and all alternatives
                    const translationsToInsert = [{
                        original_example_id: originalExample.id,
                        cleaned_halunder: expansion.cleaned_halunder,
                        cleaned_german: expansion.best_translation,
                        confidence_score: expansion.confidence_score,
                        ai_notes: expansion.notes,
                        alternative_translations: 'gpt4_best',
                        openai_prompt: "omitted for brevity"
                    }];

                    if (expansion.alternative_translations) {
                        expansion.alternative_translations.forEach((alt, index) => {
                            translationsToInsert.push({
                                original_example_id: originalExample.id, cleaned_halunder: expansion.cleaned_halunder,
                                cleaned_german: alt.translation, confidence_score: alt.confidence_score || 0.8,
                                ai_notes: alt.notes || '', alternative_translations: `gpt4_alternative_${index + 1}`,
                                openai_prompt: "omitted for brevity"
                            });
                        });
                    }
                    const { error: insertError } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
                    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);
                    generatedCount += translationsToInsert.length;

                    // Save discovered linguistic highlights
                    if (expansion.discovered_highlights) {
                        for (const highlight of expansion.discovered_highlights) {
                            if (typeof highlight.relevance_score !== 'number') continue;
                            const linguisticEntry = {
                                halunder_term: highlight.halunder_phrase.trim(), german_equivalent: highlight.german_meaning,
                                explanation: highlight.explanation_german, feature_type: highlight.type, source_table: 'new_examples',
                                relevance_score: highlight.relevance_score, tags: [highlight.type], source_ids: [originalExample.id]
                            };
                            const { data: existing } = await sourceDbClient.from('cleaned_linguistic_examples').select('id, relevance_score').ilike('halunder_term', linguisticEntry.halunder_term).single();
                            if (existing) {
                                if (highlight.relevance_score > existing.relevance_score) {
                                    await sourceDbClient.from('cleaned_linguistic_examples').update({ relevance_score: highlight.relevance_score, german_equivalent: linguisticEntry.german_equivalent, explanation: linguisticEntry.explanation, processed_at: new Date().toISOString() }).eq('id', existing.id);
                                }
                            } else {
                                await sourceDbClient.from('cleaned_linguistic_examples').insert([linguisticEntry]);
                            }
                        }
                    }

                } catch (individualError) {
                    addLog(`Failed to process a single expansion for ID ${originalExample.id}: ${individualError.message}`, 'error');
                }
            }
            await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', originalExample.id);
        }

        addLog(`Successfully processed batch of ${batch.length} items, generating ${generatedCount} clean sentence rows.`, 'success');
        return { processed: batch.length, generated: generatedCount };

    } catch (batchError) {
        addLog(`A batch failed entirely: ${batchError.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error' }).in('id', batchIds);
        return { processed: 0, generated: 0 };
    }
}

// Instructs the AI to expand sentences and prioritize translations
function buildBatchCleaningPrompt(batch, wordContexts, knownIdioms) {
    const inputData = batch.map(example => ({
        id: example.id,
        halunder_sentence: example.halunder_sentence,
        german_sentence: example.german_sentence,
        note: example.note,
        headword_context: {
            headword: example.concept.primary_german_label,
            part_of_speech: example.concept.part_of_speech
        }
    }));

    return `
You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process an array of raw example sentences and normalize them with high accuracy for AI training.

**CRITICAL INSTRUCTION 1: SENTENCE EXPANSION**
If a Halunder sentence contains slashes indicating alternatives (e.g., "Hi froaget mi miin Grummen/Lüwwer/Melt it."), you MUST expand this into multiple, separate, complete sentences. For the example given, you would generate three full sentence objects in your response. If there are no slashes, you will generate just one sentence object.

**CRITICAL INSTRUCTION 2: TRANSLATION HIERARCHY**
For EACH expanded sentence, you must follow this translation priority:
1.  \`best_translation\`: This MUST be the most natural, idiomatic German translation that a native speaker would use. (e.g., "Er fragt mir ein Loch in den Bauch.")
2.  \`alternative_translations\`: This array should contain other natural variations. CRUCIALLY, if a literal, word-for-word translation exists and is different from the idiomatic one, you MUST include it here for linguistic analysis. (e.g., "Er fragt mich meine Eingeweide aus.")

**MAIN TASK:**
Process each JSON object in the "input_examples" array. For each object, generate a response containing its original ID and an "expansions" array.

**GLOBAL CONTEXT FOR THIS BATCH:**
${JSON.stringify({ wordContexts, knownIdioms }, null, 2)}

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
      "original_id": "495dc7ac-5d41-4e11-ad5f-dfa999...",
      "expansions": [
        {
          "cleaned_halunder": "Hi froaget mi miin Grummen it.",
          "best_translation": "Er fragt mir ein Loch in den Bauch.",
          "confidence_score": 0.97,
          "notes": "The idiomatic translation is best for training. The literal meaning is included as an alternative.",
          "alternative_translations": [
            {"translation": "Er löchert mich mit seinen Fragen.", "confidence_score": 0.9, "notes": "Another natural variation."},
            {"translation": "Er fragt mich meine Eingeweide aus.", "confidence_score": 0.6, "notes": "Literal translation for linguistic analysis."}
          ],
          "discovered_highlights": [{"halunder_phrase": "miin Grummen it froage", "german_meaning": "jemandem Löcher in den Bauch fragen", "explanation_german": "Eine Redewendung für intensives Ausfragen.", "type": "idiom", "relevance_score": 9}]
        },
        {
          "cleaned_halunder": "Hi froaget mi miin Lüwwer it.",
          "best_translation": "Er quatscht mir das Herz aus dem Leib.",
          "confidence_score": 0.95,
          "notes": "Idiomatic translation. The literal meaning is 'Er fragt mich meine Leber aus'.",
          "alternative_translations": [{"translation": "Er redet mir ein Ohr ab.", "confidence_score": 0.92, "notes": "Natural variation."}],
          "discovered_highlights": []
        }
      ]
    },
    {
      "original_id": "another-uuid-from-input...",
      "expansions": [
        {
          "cleaned_halunder": "En Hüs fan Liam.",
          "best_translation": "Ein Haus aus Lehm.",
          "confidence_score": 1.0,
          "notes": "Standard, literal translation.",
          "alternative_translations": [],
          "discovered_highlights": []
        }
      ]
    }
  ]
}
\`\`\`
`;
}

// --- API Routes (unchanged) ---

router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 1000;
    runDictionaryExampleCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary example cleaner:", err);
    });
    res.json({ success: true, message: `Enhanced dictionary example cleaning started for up to ${limit} examples.` });
});

router.get('/progress', (req, res) => {
    res.json({
        ...processingState,
        lastPromptUsed: processingState.lastPromptUsed
    });
});

router.get('/stats', async (req, res) => {
    try {
        const { count: totalExamples } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true });
        const { count: pendingExamples } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true }).eq('cleaning_status', 'pending');
        const { count: cleanedExamples } = await sourceDbClient.from('ai_cleaned_dictsentences').select('*', { count: 'exact', head: true });
        const { count: discoveredFeatures } = await sourceDbClient.from('cleaned_linguistic_examples').select('*', { count: 'exact', head: true }).eq('source_table', 'new_examples');
        res.json({ totalExamples: totalExamples || 0, pendingExamples: pendingExamples || 0, cleanedExamples: cleanedExamples || 0, discoveredIdioms: discoveredFeatures || 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/reset-all', async (req, res) => {
    try {
        const { data, error } = await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).neq('id', '00000000-0000-0000-0000-000000000000').select('id');
        if (error) throw error;
        res.json({ success: true, message: `Reset ${data.length} examples to pending`, resetCount: data.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/clear-cleaned', async (req, res) => {
    try {
        await sourceDbClient.from('ai_cleaned_dictsentences').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await sourceDbClient.from('cleaned_linguistic_examples').delete().eq('source_table', 'new_examples');
        res.json({ success: true, message: 'Cleared all cleaned data and discovered linguistic features' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
