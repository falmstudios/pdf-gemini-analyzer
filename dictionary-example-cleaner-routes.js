// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - DEFINITIVE HYBRID VERSION
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
const CONCURRENT_REQUESTS = 15;
const STAGGER_DELAY_MS = 100;

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

// === MAIN PROCESSING LOGIC ===
async function runDictionaryExampleCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    addLog(`Starting... Concurrent Requests: ${CONCURRENT_REQUESTS}`, 'info');

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
        
        const groups = pendingExamples.reduce((acc, ex) => {
            if (ex.concept_id) {
                const key = ex.concept_id;
                if (!acc[key]) acc[key] = [];
                acc[key].push(ex);
            }
            return acc;
        }, {});
        const exampleGroups = Object.values(groups);

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples, forming ${exampleGroups.length} semantic concept groups.`, 'success');
        processingState.status = 'Processing examples...';
        
        let processedCount = 0;
        let firstPromptPrinted = false;

        for (let i = 0; i < exampleGroups.length; i += CONCURRENT_REQUESTS) {
            const concurrentGroupOfGroups = exampleGroups.slice(i, i + CONCURRENT_REQUESTS);
            addLog(`Processing a block of ${concurrentGroupOfGroups.length} concept groups in parallel...`, 'info');

            const promises = concurrentGroupOfGroups.map((group, index) => {
                 return processConceptGroup(group, !firstPromptPrinted && index === 0);
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

// Processes all examples within one concept group
async function processConceptGroup(group, shouldPrintPrompt) {
    const groupName = group[0]?.concept?.primary_german_label || 'Unknown Group';
    addLog(`Starting group for "${groupName}" with ${group.length} examples.`, 'info');

    const allWords = group.flatMap(ex => ex.halunder_sentence?.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
    const uniqueWords = [...new Set(allWords)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');

    const { data: termData } = orFilter ? await sourceDbClient.from('new_terms').select(`term_text, new_concept_to_term!inner(pronunciation, gender, plural_form, etymology, note, concept:new_concepts!inner(primary_german_label, part_of_speech, german_definition))`).or(orFilter).eq('language', 'hal') : { data: [] };
    
    const wordContextMap = {};
    (termData || []).forEach(term => {
        if (!wordContextMap[term.term_text.toLowerCase()]) wordContextMap[term.term_text.toLowerCase()] = [];
        term.new_concept_to_term.forEach(c => wordContextMap[term.term_text.toLowerCase()].push({ ...c.concept, ...c }));
    });
    
    const promises = group.map((example, index) => {
        return new Promise(resolve => setTimeout(resolve, index * STAGGER_DELAY_MS))
            .then(() => processSingleExample(example, group, shouldPrintPrompt && index === 0, wordContextMap));
    });

    await Promise.allSettled(promises);
    
    return { processedCount: group.length, promptWasPrinted: shouldPrintPrompt };
}

// Processes a single example, but with context from its group
async function processSingleExample(example, group, shouldPrintPrompt, wordContextMap) {
    try {
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);
        
        const wordsInSentence = example.halunder_sentence?.toLowerCase().match(/[\p{L}0-9']+/gu) || [];
        const relevantWordContext = wordsInSentence.reduce((acc, word) => {
            if (wordContextMap[word]) acc[word] = wordContextMap[word];
            return acc;
        }, {});
        
        const prompt = buildSingleItemPromptWithGroupContext(example, group, relevantWordContext);
        
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- FIRST PROMPT (HYBRID MODEL) -----------');
            console.log(prompt);
            console.log('--------------------------------------------------');
            addLog('Printed first hybrid prompt to console.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        const expansions = aiResult.expansions || [];
        if (expansions.length === 0) throw new Error("AI response did not contain valid 'expansions' array.");
        
        // --- Direct Database Operations Start ---
        const translationsToInsert = [];
        expansions.forEach(exp => {
            translationsToInsert.push({
                original_example_id: example.id, cleaned_halunder: exp.cleaned_halunder,
                cleaned_german: exp.best_translation, confidence_score: exp.confidence_score,
                ai_notes: exp.notes, alternative_translations: 'gpt4_best'
            });
            (exp.alternative_translations || []).forEach((alt, i) => {
                translationsToInsert.push({
                    original_example_id: example.id, cleaned_halunder: exp.cleaned_halunder,
                    cleaned_german: alt.translation, confidence_score: alt.confidence_score || 0.8,
                    ai_notes: alt.notes, alternative_translations: `gpt4_alternative_${i + 1}`
                });
            });
        });
        
        if (translationsToInsert.length > 0) {
            const { error: insertErr } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
            if (insertErr) throw new Error(`Cleaned sentence insert failed: ${insertErr.message}`);
        }

        const highlights = expansions.flatMap(exp => exp.discovered_highlights || []);
        if (highlights.length > 0) {
            const highlightsToUpsert = highlights.filter(h => typeof h.relevance_score === 'number').map(h => ({
                halunder_term: h.halunder_phrase.trim(), german_equivalent: h.german_meaning,
                explanation: h.explanation_german, feature_type: h.type,
                source_table: 'new_examples', relevance_score: h.relevance_score,
                tags: [h.type], source_ids: [example.id]
            }));
            const { error } = await sourceDbClient.from('cleaned_linguistic_examples').upsert(highlightsToUpsert, { onConflict: 'halunder_term' });
            if (error) addLog(`Warning: Highlight upsert failed - ${error.message}`, 'warning');
        }

        await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
        // --- Direct Database Operations End ---

        addLog(`[OK] ID ${example.id} -> Generated ${expansions.length} clean examples.`, 'success');
        return { promptWasPrinted: shouldPrintPrompt };

    } catch(e) {
        addLog(`[FAIL] ID ${example.id}: ${e.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).eq('id', example.id);
    }
}


function buildSingleItemPromptWithGroupContext(example, group, wordContext) {
    const headwordConcept = example.concept;
    const otherExamplesInGroup = group
        .filter(ex => ex.id !== example.id)
        .map(ex => ex.halunder_sentence);

    return `You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process a specific Halunder example sentence, providing the best possible translation by understanding its full context.

**CONTEXT FOR YOUR TASK:**

**1. Headword Context (The main dictionary entry this group of examples belongs to):**
- Headword: "${headwordConcept.primary_german_label}"
- Part of Speech: "${headwordConcept.part_of_speech}"
- German Definition: "${headwordConcept.german_definition}"

**2. Semantic Context (Other examples for the same headword to show its range of use):**
\`\`\`json
${JSON.stringify(otherExamplesInGroup, null, 2)}
\`\`\`

**3. Dictionary Context (Definitions for words in the target sentence):**
\`\`\`json
${JSON.stringify(wordContext, null, 2)}
\`\`\`

**YOUR SPECIFIC TASK:**
Now, focus *only* on the following target sentence.

**Target Halunder Sentence:** "${example.halunder_sentence}"
**Original German Hint:** "${example.german_sentence}"

**CRITICAL INSTRUCTIONS:**
1.  **Sentence Expansion:** If the **Target Sentence** contains slashes (e.g., "A/B/C"), you MUST expand it into multiple, separate sentence objects in the "expansions" array. If no slashes, generate just one object.
2.  **Translation Hierarchy:** For EACH expanded sentence, you MUST follow this priority:
    - \`best_translation\`: The most natural, idiomatic German translation. Improve the original German hint if it's awkward or too literal.
    - \`alternative_translations\`: Include other natural variations AND the literal, word-for-word translation if it's different.
3.  **Linguistic Highlights:** Identify any idioms or unique cultural terms in the target sentence and list them in \`discovered_highlights\`.

**YOUR JSON OUTPUT FORMAT:**
Your entire response must be a single JSON object with an "expansions" array.

\`\`\`json
{
  "expansions": [
    {
      "cleaned_halunder": "Hi es en bisterk Kearl.",
      "best_translation": "Er ist ein böser Kerl.",
      "confidence_score": 1.0,
      "notes": "Direct and natural translation, confirming the original hint.",
      "alternative_translations": [
        {"translation": "Er ist ein fieser Kerl.", "confidence_score": 0.9, "notes": "Slightly more colloquial alternative."}
      ],
      "discovered_highlights": []
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
    runDictionaryExampleCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary example cleaner:", err);
    });
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
