// ===============================================
// FINAL DICTIONARY EXAMPLE CLEANER ROUTES - TIER 2 OPTIMIZED
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
// How many individual API requests to have "in flight" at the same time.
// This is a safe but aggressive number for a 5,000 RPM limit.
const CONCURRENT_REQUESTS = 15;
// A small delay between firing each request in a concurrent group to be kind to the API.
const STAGGER_DELAY_MS = 100;

// === STATE MANAGEMENT ===
let processingState = {
    isProcessing: false, progress: 0, status: 'Idle', details: '', logs: [],
    startTime: null, lastPromptUsed: null
};

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
                messages: [
                    { "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },
                    { "role": "user", "content": prompt }
                ],
                response_format: { "type": "json_object" }
            }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } });

            if (response.data?.choices?.[0]) {
                return JSON.parse(response.data.choices[0].message.content);
            }
            throw new Error('Invalid response format from OpenAI API');
        } catch (error) {
            if (error instanceof SyntaxError) {
                addLog(`CRITICAL: OpenAI API returned non-JSON. Likely a network/firewall issue. Response: ${error.message.slice(0, 100)}`, 'error');
                throw new Error("OpenAI API returned invalid data (likely HTML block page).");
            }
            if (error.response?.status === 429) {
                attempts++;
                if (attempts >= maxAttempts) throw new Error('OpenAI API rate limit exceeded after multiple retries.');
                const waitTime = delay + (Math.random() * 1000);
                addLog(`Rate limit hit. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${attempts}/${maxAttempts})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= 2;
            } else {
                throw error;
            }
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
        } else {
            break;
        }
    }
    return limit ? allData.slice(0, limit) : allData;
}

async function getWordContextForBatch(sentences) {
    const allWords = sentences.flatMap(s => s.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || []);
    if (allWords.length === 0) return {};
    const uniqueWords = [...new Set(allWords)];
    const orFilter = uniqueWords.map(word => `term_text.ilike.${word}`).join(',');

    const query = sourceDbClient.from('new_terms')
        .select(`term_text, new_concept_to_term!inner(concept:new_concepts!inner(primary_german_label, part_of_speech))`)
        .or(orFilter).eq('language', 'hal');
    
    const termData = await fetchAllWithPagination(query);
    const wordContextMap = {};
    termData.forEach(term => {
        wordContextMap[term.term_text.toLowerCase()] = term.new_concept_to_term.map(c => c.concept);
    });
    return wordContextMap;
}

// === MAIN PROCESSING LOGIC ===
async function runDictionaryExampleCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    addLog(`Starting... Concurrent Requests: ${CONCURRENT_REQUESTS}, Stagger: ${STAGGER_DELAY_MS}ms`, 'info');

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

        const idiomQuery = sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation').gte('relevance_score', 6);
        const knownIdioms = await fetchAllWithPagination(idiomQuery);
        addLog(`Loaded ${knownIdioms.length} known idioms.`, 'info');
        
        const wordContext = await getWordContextForBatch(pendingExamples);
        addLog(`Pre-fetched dictionary context for ${Object.keys(wordContext).length} unique words.`, 'info');

        let processedCount = 0;
        let firstPromptPrinted = false;

        for (let i = 0; i < totalToProcess; i += CONCURRENT_REQUESTS) {
            const chunk = pendingExamples.slice(i, i + CONCURRENT_REQUESTS);
            addLog(`Processing chunk of ${chunk.length} (starting at #${i + 1})...`, 'info');

            const promises = chunk.map((example, index) => {
                return new Promise(resolve => setTimeout(resolve, index * STAGGER_DELAY_MS))
                    .then(() => processSingleExample(example, !firstPromptPrinted && index === 0, knownIdioms, wordContext))
                    .then(promptWasPrinted => { if (promptWasPrinted) firstPromptPrinted = true; });
            });
            
            await Promise.allSettled(promises);

            processedCount += chunk.length;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} examples.`;
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

// Processes a single example, called concurrently
async function processSingleExample(example, shouldPrintPrompt, knownIdioms, wordContext) {
    try {
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);
        
        const relevantIdioms = knownIdioms.filter(idiom => example.halunder_sentence.toLowerCase().includes(idiom.halunder_term.toLowerCase()));
        const relevantWords = (example.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || [])
            .reduce((acc, word) => {
                if (wordContext[word]) acc[word] = wordContext[word];
                return acc;
            }, {});

        const prompt = buildSingleItemPrompt(example, relevantIdioms, relevantWords);
        
        if (shouldPrintPrompt) {
            processingState.lastPromptUsed = prompt;
            console.log('----------- FIRST PROMPT -----------');
            console.log(prompt);
            console.log('------------------------------------');
            addLog('Printed first prompt to console.', 'info');
        }

        const aiResult = await callOpenAI_Api(prompt);
        if (!aiResult.expansions || aiResult.expansions.length === 0) {
            throw new Error("AI response did not contain 'expansions' array.");
        }
        
        for (const expansion of aiResult.expansions) {
            const translationsToInsert = [{
                original_example_id: example.id, cleaned_halunder: expansion.cleaned_halunder,
                cleaned_german: expansion.best_translation, confidence_score: expansion.confidence_score,
                ai_notes: expansion.notes, alternative_translations: 'gpt4_best'
            }];
            if (expansion.alternative_translations) {
                expansion.alternative_translations.forEach((alt, i) => {
                    translationsToInsert.push({
                        original_example_id: example.id, cleaned_halunder: expansion.cleaned_halunder,
                        cleaned_german: alt.translation, confidence_score: alt.confidence_score || 0.8,
                        ai_notes: alt.notes, alternative_translations: `gpt4_alternative_${i + 1}`
                    });
                });
            }
            await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);

            if (expansion.discovered_highlights) {
                for (const highlight of expansion.discovered_highlights) {
                    if (typeof highlight.relevance_score !== 'number') continue;
                    // Simplified upsert for brevity
                    await sourceDbClient.from('cleaned_linguistic_examples').upsert({
                        halunder_term: highlight.halunder_phrase.trim(), german_equivalent: highlight.german_meaning,
                        explanation: highlight.explanation_german, feature_type: highlight.type, source_table: 'new_examples',
                        relevance_score: highlight.relevance_score, tags: [highlight.type], source_ids: [example.id]
                    }, { onConflict: 'halunder_term' });
                }
            }
        }

        await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
        addLog(`[OK] ID ${example.id} -> Generated ${aiResult.expansions.length} clean examples.`, 'success');
        return shouldPrintPrompt;
    } catch(e) {
        addLog(`[FAIL] ID ${example.id}: ${e.message}`, 'error');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'error', note: e.message }).eq('id', example.id);
        // We don't re-throw the error, allowing Promise.allSettled to continue with other requests.
    }
}


// Builds a prompt for a single item, inspired by the other script's structure
function buildSingleItemPrompt(example, relevantIdioms, wordContext) {
    return `You are an expert linguist specializing in Heligolandic Frisian (Halunder) and German. Your task is to process a raw example sentence, proofread it, and provide high-quality, multi-layered German translations.

**CRITICAL INSTRUCTION 1: SENTENCE EXPANSION**
The provided sentence might contain slashes indicating alternatives (e.g., "A/B/C"). You MUST expand this into multiple, separate, complete sentence objects. For an input with 3 options, you must generate 3 full sentence objects in the "expansions" array. If there are no slashes, generate just one object. For this task, you are given a Halunder sentence like "Hi froaget mi miin Grummen/Lüwwer/Melt it.". Treat this as three separate sentences to process:
1. "Hi froaget mi miin Grummen it."
2. "Hi froaget mi miin Lüwwer it."
3. "Hi froaget mi miin Melt it."

**CRITICAL INSTRUCTION 2: TRANSLATION HIERARCHY**
For EACH expanded sentence, you MUST follow this priority:
1.  \`best_translation\`: This MUST be the most natural, idiomatic German translation.
2.  \`alternative_translations\`: This array should contain other natural variations. If a literal, word-for-word translation exists and is different, you MUST include it here.

**MAIN TASK:**
Based on the input data below, generate a JSON response.

**INPUT DATA:**

**1. Raw Halunder Sentence (may contain OCR errors and alternatives):**
"${example.halunder_sentence}"

**2. Dictionary Context for Words in this Sentence:**
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


// --- API ROUTES (unchanged from previous versions) ---
router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 10000;
    runDictionaryExampleCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary example cleaner:", err);
    });
    res.json({ success: true, message: `Tier 2 optimized cleaning started for up to ${limit} examples.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
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
