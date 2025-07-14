// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - AI JUDGES RELEVANCE
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
// With a BATCH_SIZE of 4, 10 concurrent batches will process 40 sentences per cycle.
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
    if (processingState.logs.length > 2000) processingState.logs.shift(); // Increased log size
    console.log(`[DICT-EXAMPLE-CLEANER] [${type.toUpperCase()}] ${message}`);
}

// OpenAI API caller (no temperature)
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
                    model: "gpt-4-turbo", // Using gpt-4-turbo is often a good balance of cost and performance
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

// Enhanced function to get comprehensive word context for a list of words
async function getWordContext(words) {
    if (!words || words.length === 0) return [];

    const uniqueWords = [...new Set(words)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');
    
    const { data: termData, error } = await sourceDbClient
        .from('new_terms')
        .select(`
            term_text,
            new_concept_to_term!inner(
                concept:new_concepts!inner(
                    primary_german_label,
                    part_of_speech,
                    german_definition
                )
            )
        `)
        .or(orFilter)
        .eq('language', 'hal');

    if (error) {
        addLog(`Dictionary lookup error: ${error.message}`, 'warning');
        return [];
    }

    const wordContextMap = {};
    if (termData) {
        termData.forEach(term => {
            const contexts = term.new_concept_to_term.map(connection => ({
                german_equivalent: connection.concept.primary_german_label,
                part_of_speech: connection.concept.part_of_speech,
                german_definition: connection.concept.german_definition,
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

// Main processing function - now runs batches concurrently
async function runDictionaryExampleCleaner(limit) {
    processingState = { 
        isProcessing: true, 
        progress: 0, 
        status: 'Starting...', 
        details: '', 
        logs: [], 
        startTime: Date.now(),
        lastPromptUsed: null
    };
    addLog(`Starting BATCHED dictionary cleaning...`, 'info');
    addLog(`Batch Size: ${BATCH_SIZE}, Concurrent Batches: ${CONCURRENT_BATCHES}`, 'info');

    try {
        addLog("Resetting any stale 'processing' jobs...", 'info');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);

        addLog(`Fetching up to ${limit} pending examples...`, 'info');
        const { data: pendingExamples, error: fetchError } = await sourceDbClient
            .from('new_examples')
            .select(`*, concept:new_concepts!inner(*)`)
            .eq('cleaning_status', 'pending')
            .not('halunder_sentence', 'is', null)
            .not('german_sentence', 'is', null)
            .limit(limit);

        if (fetchError) throw new Error(`Failed to fetch examples: ${fetchError.message}`);
        if (!pendingExamples || pendingExamples.length === 0) {
            processingState = { ...processingState, status: 'Completed (No new examples)', isProcessing: false };
            addLog('No pending examples found to clean.', 'success');
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Batching and cleaning examples...';

        const batches = chunkArray(pendingExamples, BATCH_SIZE);
        let processedCount = 0;
        let firstPromptPrinted = false;

        // Fetch all relevant idioms once to avoid re-fetching in every batch
        const { data: knownIdioms } = await sourceDbClient
            .from('cleaned_linguistic_examples')
            .select('halunder_term, german_equivalent, explanation, tags')
            .gte('relevance_score', 6);
        
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
                if(result.status === 'fulfilled' && result.value) {
                    processedCount += result.value;
                } else if (result.status === 'rejected') {
                    addLog(`A batch failed: ${result.reason.message}`, 'error');
                }
            });

            processingState.details = `Processed ${processedCount} of ${totalToProcess} examples.`;
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

// New function to process a whole batch of examples
async function processBatch(batch, knownIdioms, shouldPrintPrompt) {
    if (!batch || batch.length === 0) return 0;
    
    const batchIds = batch.map(ex => ex.id);
    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).in('id', batchIds);

    try {
        // Efficiently gather all context for the batch
        const allWordsInBatch = batch.flatMap(ex => ex.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
        const wordContexts = await getWordContext(allWordsInBatch);
        
        const prompt = buildBatchCleaningPrompt(batch, wordContexts, knownIdioms);
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- BATCHED DICTIONARY EXAMPLE CLEANER PROMPT -----------');
            console.log(prompt.substring(0, 4000) + "\n... (prompt truncated for console)"); // Avoid flooding console
            console.log('-------------------------------------------------------------------');
            addLog('Printed full batched prompt to server console for verification.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);

        if (!aiResult.results || !Array.isArray(aiResult.results) || aiResult.results.length !== batch.length) {
            throw new Error(`AI returned mismatched results count. Expected ${batch.length}, got ${aiResult.results?.length || 0}.`);
        }

        for (let i = 0; i < batch.length; i++) {
            const originalExample = batch[i];
            const cleanedData = aiResult.results[i];
            
            try {
                // Save cleaned translations
                const translationsToInsert = [{
                    original_example_id: originalExample.id,
                    cleaned_halunder: cleanedData.cleaned_halunder,
                    cleaned_german: cleanedData.best_translation,
                    confidence_score: cleanedData.confidence_score,
                    ai_notes: cleanedData.notes,
                    alternative_translations: 'gpt4_best',
                    openai_prompt: "omitted for brevity"
                }];

                if (cleanedData.alternative_translations) {
                    cleanedData.alternative_translations.forEach((alt, index) => {
                        translationsToInsert.push({
                            original_example_id: originalExample.id, cleaned_halunder: cleanedData.cleaned_halunder,
                            cleaned_german: alt.translation, confidence_score: alt.confidence_score || 0.7,
                            ai_notes: alt.notes || '', alternative_translations: `gpt4_alternative_${index + 1}`,
                            openai_prompt: "omitted for brevity"
                        });
                    });
                }
                const { error: insertError } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
                if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

                // Save discovered linguistic highlights
                if (cleanedData.discovered_highlights) {
                    for (const highlight of cleanedData.discovered_highlights) {
                        const relevanceScore = highlight.relevance_score;
                        if (typeof relevanceScore !== 'number') continue;

                        const linguisticEntry = {
                            halunder_term: highlight.halunder_phrase.trim(), german_equivalent: highlight.german_meaning,
                            explanation: highlight.explanation_german, feature_type: highlight.type,
                            source_table: 'new_examples', relevance_score: relevanceScore,
                            tags: [highlight.type], source_ids: [originalExample.id]
                        };
                        
                        // Upsert logic
                        const { data: existing } = await sourceDbClient.from('cleaned_linguistic_examples').select('id, relevance_score').ilike('halunder_term', linguisticEntry.halunder_term).single();
                        if (existing) {
                            if (relevanceScore > existing.relevance_score) {
                                await sourceDbClient.from('cleaned_linguistic_examples').update({ relevance_score: relevanceScore, german_equivalent: linguisticEntry.german_equivalent, explanation: linguisticEntry.explanation, processed_at: new Date().toISOString() }).eq('id', existing.id);
                            }
                        } else {
                            await sourceDbClient.from('cleaned_linguistic_examples').insert([linguisticEntry]);
                        }
                    }
                }
                
                await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', originalExample.id);

            } catch(individualError) {
                addLog(`Failed to process sub-item from batch (ID: ${originalExample.id}): ${individualError.message}`, 'error');
                await sourceDbClient.from('new_examples').update({ cleaning_status: 'error' }).eq('id', originalExample.id);
            }
        }
        addLog(`Successfully processed batch of ${batch.length} items.`, 'success');
        return batch.length;

    } catch (batchError) {
        addLog(`A batch failed entirely: ${batchError.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error' }).in('id', batchIds);
        return 0;
    }
}

// New prompt for handling batches of examples with full context
function buildBatchCleaningPrompt(batch, wordContexts, knownIdioms) {
    const inputData = batch.map(example => ({
        id: example.id,
        halunder_sentence: example.halunder_sentence,
        german_sentence: example.german_sentence,
        note: example.note,
        headword_context: {
            headword: example.concept.primary_german_label,
            part_of_speech: example.concept.part_of_speech,
            german_definition: example.concept.german_definition,
        }
    }));

    return `
You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process an array of raw example sentences and normalize them with high accuracy.

**INSTRUCTIONS:**
1.  **Use Global Context:** First, review the "Global Word Context" and "Known Idioms" provided below. This context applies to ALL examples in the batch.
2.  **Iterate through Examples:** Process each JSON object in the "input_examples" array.
3.  **For EACH example:**
    a.  **Correct Halunder:** Clean the Halunder sentence (fix OCR, punctuation, capitalization). DO NOT change the original wording or grammar.
    b.  **Improve German:** Create the best, most natural German translation, using all available context.
    c.  **Identify Highlights:** Find idioms, place names, cultural references, etc., in the Halunder sentence.
    d.  **Judge Relevance:** For each highlight, assign a \`relevance_score\` from 1-10 (10=most unique/important).
    e.  **Provide Alternatives:** Give 1-2 valid alternative German translations.
4.  **Output JSON Array:** Your entire response must be a single JSON object with one key: "results". The value must be an array of JSON objects.
5.  **The order of your output array MUST EXACTLY MATCH the order of the "input_examples" array.**

**GLOBAL CONTEXT FOR THIS BATCH:**

**1. Global Word Context (meanings for words that appear in this batch):**
\`\`\`json
${JSON.stringify(wordContexts, null, 2)}
\`\`\`

**2. Known Idioms:**
\`\`\`json
${JSON.stringify(knownIdioms, null, 2)}
\`\`\`

**EXAMPLES TO PROCESS:**
\`\`\`json
${JSON.stringify(inputData, null, 2)}
\`\`\`

**YOUR JSON OUTPUT FORMAT:**
Your entire output must be a single JSON object. The format for EACH item inside the "results" array is as follows:

\`\`\`json
{
  "results": [
    {
      "cleaned_halunder": "The corrected Halunder sentence for the first input example.",
      "best_translation": "The best German translation for the first input example.",
      "confidence_score": 0.95,
      "notes": "Your analysis notes for the first example, referencing context if needed.",
      "alternative_translations": [
        { "translation": "Alternative 1", "confidence_score": 0.9, "notes": "" }
      ],
      "discovered_highlights": [
        {
          "halunder_phrase": "beerigermarri",
          "german_meaning": "kleiner Penis",
          "explanation_german": "Eine humorvolle Umschreibung.",
          "type": "idiom",
          "relevance_score": 9
        }
      ]
    }
  ]
}
\`\`\`
`;
}


// API Routes (unchanged)
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
        lastPromptUsed: processingState.lastPromptUsed // Will show the last used prompt
    });
});

router.get('/stats', async (req, res) => {
    try {
        const { count: totalExamples } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true });
        const { count: pendingExamples } = await sourceDbClient.from('new_examples').select('*', { count: 'exact', head: true }).eq('cleaning_status', 'pending');
        const { count: cleanedExamples } = await sourceDbClient.from('ai_cleaned_dictsentences').select('*', { count: 'exact', head: true });
        const { count: discoveredFeatures } = await sourceDbClient.from('cleaned_linguistic_examples').select('*', { count: 'exact', head: true }).eq('source_table', 'new_examples');
        res.json({ totalExamples, pendingExamples, cleanedExamples, discoveredIdioms: discoveredFeatures });
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
