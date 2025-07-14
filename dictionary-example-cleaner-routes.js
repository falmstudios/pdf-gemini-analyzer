// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - DEFINITIVE, NO-RPC VERSION
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
const PREFETCH_CHUNK_SIZE = 200;

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

async function getWordContextForChunk(sentences) {
    const allWords = sentences.flatMap(ex => ex.halunder_sentence?.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
    if (allWords.length === 0) return {};
    const uniqueWords = [...new Set(allWords)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');
    const query = sourceDbClient.from('new_terms').select(`
            term_text,
            new_concept_to_term!inner(
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
                plural_form: connection.plural_form, etymology: connection.etymology,
                note: connection.note,
            });
        });
    });
    return wordContextMap;
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

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Processing examples...';
        
        let processedCount = 0;
        let firstPromptPrinted = false;

        for (let i = 0; i < totalToProcess; i += PREFETCH_CHUNK_SIZE) {
            const prefetchChunk = pendingExamples.slice(i, i + PREFETCH_CHUNK_SIZE);
            addLog(`Pre-fetching word context for next ${prefetchChunk.length} sentences...`, 'info');
            const wordContextForChunk = await getWordContextForChunk(prefetchChunk);
            addLog(`Context loaded for ${Object.keys(wordContextForChunk).length} unique words.`, 'success');

            for (let j = 0; j < prefetchChunk.length; j += CONCURRENT_REQUESTS) {
                const concurrentChunk = prefetchChunk.slice(j, j + CONCURRENT_REQUESTS);
                addLog(`Processing a concurrent block of ${concurrentChunk.length} examples...`, 'info');

                const promises = concurrentChunk.map((example, index) => {
                    return new Promise(resolve => setTimeout(resolve, index * STAGGER_DELAY_MS))
                        .then(() => processSingleExample(example, !firstPromptPrinted && index === 0, wordContextForChunk));
                });
                
                const results = await Promise.allSettled(promises);
                results.forEach(result => {
                    if (result.status === 'fulfilled' && result.value) {
                         if(result.value.promptWasPrinted) firstPromptPrinted = true;
                    }
                });

                processedCount += concurrentChunk.length;
                processingState.details = `Processed ${processedCount} of ${totalToProcess} total examples.`;
                processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            }
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

// *** REVISED: Handles DB operations directly, NO RPC ***
async function processSingleExample(example, shouldPrintPrompt, wordContextForChunk) {
    try {
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);
        
        const wordsInSentence = example.halunder_sentence?.toLowerCase().match(/[\p{L}0-9']+/gu) || [];
        const relevantWordContext = wordsInSentence.reduce((acc, word) => {
            if (wordContextForChunk[word]) acc[word] = wordContextForChunk[word];
            return acc;
        }, {});
        
        const orFilter = wordsInSentence.map(w => `halunder_term.ilike.%${w}%`).join(',');
        const { data: relevantIdioms } = orFilter ? await sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation').or(orFilter).gte('relevance_score', 6) : { data: [] };

        const prompt = buildSingleItemPrompt(example, relevantIdioms || [], relevantWordContext);
        
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- FIRST PROMPT -----------');
            console.log(prompt);
            console.log('------------------------------------');
            addLog('Printed first prompt to console.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        const expansions = aiResult.expansions || [];
        if (expansions.length === 0) {
            throw new Error("AI response did not contain valid 'expansions' array.");
        }
        
        // --- Direct Database Operations Start ---

        // 1. Prepare all translation rows to insert
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
        
        // 2. Insert cleaned sentences
        if (translationsToInsert.length > 0) {
            const { error: insertErr } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
            if (insertErr) throw new Error(`Cleaned sentence insert failed: ${insertErr.message}`);
        }

        // 3. Upsert linguistic highlights
        const highlights = expansions.flatMap(exp => exp.discovered_highlights || []);
        if (highlights.length > 0) {
            const highlightsToUpsert = highlights
                .filter(h => typeof h.relevance_score === 'number')
                .map(h => ({
                    halunder_term: h.halunder_phrase.trim(), german_equivalent: h.german_meaning,
                    explanation: h.explanation_german, feature_type: h.type,
                    source_table: 'new_examples', relevance_score: h.relevance_score,
                    tags: [h.type], source_ids: [example.id]
                }));
            
            const { error: upsertErr } = await sourceDbClient.from('cleaned_linguistic_examples').upsert(highlightsToUpsert, { onConflict: 'halunder_term' });
            if (upsertErr) addLog(`Warning: Highlight upsert failed - ${upsertErr.message}`, 'warning'); // Non-critical
        }

        // 4. Mark original as completed
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);

        // --- Direct Database Operations End ---

        addLog(`[OK] ID ${example.id} -> Generated ${expansions.length} clean examples.`, 'success');
        return { promptWasPrinted: shouldPrintPrompt };

    } catch(e) {
        addLog(`[FAIL] ID ${example.id}: ${e.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).eq('id', example.id);
    }
}

// Builds a prompt for a single item with full context
function buildSingleItemPrompt(example, relevantIdioms, wordContext) {
    const detailedHeadwordContext = {
        headword: example.concept.primary_german_label,
        part_of_speech: example.concept.part_of_speech,
        german_definition: example.concept.german_definition,
        notes: example.concept.notes,
        krogmann_info: example.concept.krogmann_info,
        krogmann_idioms: example.concept.krogmann_idioms
    };

    return `You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process a raw example sentence, proofread it, and provide high-quality, multi-layered German translations.

**HEADWORD CONTEXT (the main dictionary entry this example belongs to):**
\`\`\`json
${JSON.stringify(detailedHeadwordContext, null, 2)}
\`\`\`

**CRITICAL INSTRUCTION 1: SENTENCE EXPANSION**
The provided sentence might contain slashes indicating alternatives (e.g., "A/B/C"). You MUST expand this into multiple, separate sentence objects in the "expansions" array. If no slashes, generate just one object.

**CRITICAL INSTRUCTION 2: TRANSLATION HIERARCHY**
For EACH expanded sentence, you MUST follow this priority:
1. \`best_translation\`: The most natural, idiomatic German translation.
2. \`alternative_translations\`: Include other natural variations AND the literal, word-for-word translation if it's different.

**MAIN TASK:**
Based on the input data below, generate a JSON response.

**INPUT DATA:**

**1. Raw Halunder Sentence (may contain OCR errors and alternatives):**
"${example.halunder_sentence}"

**2. Dictionary Context for Individual Words in this Sentence:**
\`\`\`json
${JSON.stringify(wordContext, null, 2)}
\`\`\`

**3. Known Idioms Found in this Sentence:**
\`\`\`json
${JSON.stringify(relevantIdioms, null, 2)}
\`\`\`

**YOUR JSON OUTPUT FORMAT:**
Your entire response must be a single JSON object with an "expansions" array.

\`\`\`json
{
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
