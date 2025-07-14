// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - OPTIMAL SEMANTIC GROUPING VERSION
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
// How many concept GROUPS to process in parallel.
const CONCURRENT_GROUPS = 8;

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
            }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } });
            if (response.data?.choices?.[0]) return JSON.parse(response.data.choices[0].message.content);
            throw new Error('Invalid response format from OpenAI API');
        } catch (error) {
            if (error instanceof SyntaxError) {
                addLog(`CRITICAL: OpenAI API returned non-JSON. Likely a network/firewall issue. Response: ${error.message.slice(0,100)}`, 'error');
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
    while (true) {
        const { data, error } = await queryBuilder.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (error) throw error;
        if (data?.length > 0) {
            allData.push(...data);
            if (data.length < PAGE_SIZE || (limit && allData.length >= limit)) break;
            page++;
        } else { break; }
    }
    return limit ? allData.slice(0, limit) : allData;
}

// === MAIN PROCESSING LOGIC ===
async function runDictionaryExampleCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    addLog(`Starting... Concurrent Groups: ${CONCURRENT_GROUPS}`, 'info');

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

        // *** SEMANTIC GROUPING LOGIC ***
        const groups = pendingExamples.reduce((acc, ex) => {
            const key = ex.concept_id;
            if (!acc[key]) acc[key] = [];
            acc[key].push(ex);
            return acc;
        }, {});
        const exampleGroups = Object.values(groups);

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples, forming ${exampleGroups.length} semantic concept groups.`, 'success');
        processingState.status = 'Processing concept groups...';

        const idiomQuery = sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation').gte('relevance_score', 6);
        const knownIdioms = await fetchAllWithPagination(idiomQuery);
        addLog(`Loaded ${knownIdioms.length} known idioms.`, 'info');
        
        let processedCount = 0;
        let firstPromptPrinted = false;

        for (let i = 0; i < exampleGroups.length; i += CONCURRENT_GROUPS) {
            const chunk = exampleGroups.slice(i, i + CONCURRENT_GROUPS);
            addLog(`Processing a block of ${chunk.length} concept groups (starting at group #${i + 1})...`, 'info');

            const promises = chunk.map((group, index) => {
                return processConceptGroup(group, !firstPromptPrinted && index === 0, knownIdioms);
            });
            
            const results = await Promise.allSettled(promises);

            results.forEach(result => {
                if(result.status === 'fulfilled' && result.value) {
                     processedCount += result.value.processedCount;
                     if(result.value.promptWasPrinted) firstPromptPrinted = true;
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

// Processes a group of examples sharing the same concept_id
async function processConceptGroup(group, shouldPrintPrompt, knownIdioms) {
    const groupIds = group.map(ex => ex.id);
    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).in('id', groupIds);

    try {
        const prompt = buildGroupedPrompt(group, knownIdioms);
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- FIRST PROMPT (GROUPED) -----------');
            console.log(prompt);
            console.log('-------------------------------------------');
            addLog('Printed first grouped prompt to console.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        if (!aiResult.processed_examples || !Array.isArray(aiResult.processed_examples)) {
            throw new Error("AI response did not contain 'processed_examples' array.");
        }

        for (const processedItem of aiResult.processed_examples) {
            const originalExample = group.find(ex => ex.id === processedItem.original_id);
            if (!originalExample) {
                addLog(`AI returned data for an unknown original_id ${processedItem.original_id}`, 'warning');
                continue;
            }

            try {
                const cleaned_sentences = [];
                let linguistic_highlights = [];

                processedItem.expansions.forEach(exp => {
                    cleaned_sentences.push({
                        cleaned_halunder: exp.cleaned_halunder, cleaned_german: exp.best_translation,
                        confidence_score: exp.confidence_score, ai_notes: exp.notes,
                        alternative_translations: 'gpt4_best'
                    });
                    if (exp.alternative_translations) {
                        exp.alternative_translations.forEach((alt, i) => {
                            cleaned_sentences.push({
                                cleaned_halunder: exp.cleaned_halunder, cleaned_german: alt.translation,
                                confidence_score: alt.confidence_score || 0.8, ai_notes: alt.notes,
                                alternative_translations: `gpt4_alternative_${i + 1}`
                            });
                        });
                    }
                    if (exp.discovered_highlights) {
                        linguistic_highlights.push(...exp.discovered_highlights);
                    }
                });
                
                // Use the transactional RPC to save all data atomically
                const { error: rpcError } = await sourceDbClient.rpc('save_cleaned_example_data', {
                    p_original_example_id: originalExample.id,
                    p_cleaned_sentences: JSON.stringify(cleaned_sentences),
                    p_linguistic_highlights: JSON.stringify(linguistic_highlights)
                });
                if (rpcError) throw new Error(`RPC Error for ID ${originalExample.id}: ${rpcError.message}`);

            } catch (e) {
                 addLog(`Failed to save data for example ID ${originalExample.id}: ${e.message}`, 'error');
                 await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).eq('id', originalExample.id);
            }
        }
        
        addLog(`[OK] Processed concept group for "${group[0].concept.primary_german_label}" (${group.length} examples).`, 'success');
        return { processedCount: group.length, promptWasPrinted: shouldPrintPrompt };
    } catch(e) {
        addLog(`[FAIL] Group for "${group[0].concept.primary_german_label}" failed: ${e.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).in('id', groupIds);
        return { processedCount: 0, promptWasPrinted: false };
    }
}


// Builds a prompt for a group of items sharing a concept
function buildGroupedPrompt(group, knownIdioms) {
    const headwordConcept = group[0].concept;
    const inputExamples = group.map(ex => ({
        original_id: ex.id,
        halunder_sentence: ex.halunder_sentence
    }));

    return `You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to analyze a group of example sentences for a single dictionary headword to understand its semantic range, and then process each example.

**HEADWORD CONTEXT (applies to all examples below):**
- Headword: "${headwordConcept.primary_german_label}"
- Part of Speech: "${headwordConcept.part_of_speech}"
- German Definition: "${headwordConcept.german_definition}"

**CRITICAL INSTRUCTION 1: SENTENCE EXPANSION**
Within each example, if a Halunder sentence contains slashes (e.g., "A/B/C"), you MUST expand it into multiple, separate sentence objects in the "expansions" array for that example.

**CRITICAL INSTRUCTION 2: TRANSLATION HIERARCHY**
For EACH expanded sentence, you MUST follow this priority:
1.  \`best_translation\`: The most natural, idiomatic German translation.
2.  \`alternative_translations\`: Include other natural variations AND the literal, word-for-word translation if it's different.

**MAIN TASK:**
Analyze all the provided examples together for context. Then, for each item in the "input_examples" array, generate a corresponding object in the "processed_examples" array of your response.

**INPUT DATA:**

**1. Known Idioms (for reference):**
\`\`\`json
${JSON.stringify(knownIdioms.slice(0, 50), null, 2))}
\`\`\`

**2. Example Sentences for the headword "${headwordConcept.primary_german_label}":**
\`\`\`json
${JSON.stringify(inputExamples, null, 2)}
\`\`\`

**YOUR JSON OUTPUT FORMAT:**
Your entire response must be a single JSON object. The "processed_examples" array order must match the "input_examples" order.

\`\`\`json
{
  "processed_examples": [
    {
      "original_id": "The UUID of the first input example",
      "expansions": [
        {
          "cleaned_halunder": "Deät es dolung en bisterk Weder.",
          "best_translation": "Es ist heute ein böses Wetter.",
          "confidence_score": 0.98,
          "notes": "Standard translation for 'bad weather'.",
          "alternative_translations": [
            {"translation": "Es ist heute ein schlechtes Wetter.", "confidence_score": 0.9}
          ],
          "discovered_highlights": []
        }
      ]
    },
    {
      "original_id": "The UUID of the second input example",
      "expansions": [
        {
          "cleaned_halunder": "Hi es en bisterk Kearl.",
          "best_translation": "Er ist ein böser Kerl.",
          "confidence_score": 1.0,
          "notes": "Direct translation for 'a bad/mean guy'.",
          "alternative_translations": [
             {"translation": "Er ist ein fieser Kerl.", "confidence_score": 0.9}
          ],
          "discovered_highlights": []
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
    const limit = parseInt(req.body.limit, 10) || 25;
    runDictionaryExampleCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary example cleaner:", err);
    });
    res.json({ success: true, message: `Optimal cleaning started for up to ${limit} examples.` });
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
