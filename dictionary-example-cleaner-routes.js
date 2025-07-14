// ===============================================
// FINAL FIXED DICTIONARY EXAMPLE CLEANER ROUTES
// File: dictionary-example-cleaner-routes.js
// Version: 2.1 (Fixes idiom filtering and foreign key validation)
// ===============================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Database connection - using SOURCE database only
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

// Use a long timeout for the OpenAI API calls
const axiosInstance = axios.create({ timeout: 0 });

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
    if (processingState.logs.length > 1000) processingState.logs.shift();
    console.log(`[DICT-EXAMPLE-CLEANER] [${type.toUpperCase()}] ${message}`);
}

// OpenAI API caller (no temperature)
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
                    model: "gpt-4.1-2025-04-14",
                    messages: [
                        { "role": "system", "content": "You are a helpful expert linguist. Your output must be a single, valid JSON object and nothing else." },
                        { "role": "user", "content": prompt }
                    ],
                    response_format: { "type": "json_object" }
                },
                { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } }
            );

            if (response.data && response.data.choices && response.data.choices[0]) {
                const content = response.data.choices[0].message.content;
                try {
                    return JSON.parse(content);
                } catch (jsonError) {
                    addLog(`Failed to parse JSON from OpenAI response. Content: ${content}`, 'error');
                    throw new Error('OpenAI returned invalid JSON.');
                }
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
                const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
                addLog(`OpenAI API Error: ${errorMessage}`, 'error');
                throw new Error(`OpenAI API error: ${errorMessage}`);
            }
        }
    }
}

// Fetches ALL pending examples from Supabase, handling pagination.
async function fetchAllPendingExamples() {
    let allExamples = [];
    let page = 0;
    const pageSize = 1000; // Supabase limit per query
    let hasMore = true;

    while(hasMore) {
        const { data, error } = await sourceDbClient
            .from('new_examples')
            .select(`
                *,
                concept:new_concepts!inner(
                    id, primary_german_label, part_of_speech, german_definition,
                    notes, krogmann_info, krogmann_idioms
                )
            `)
            .eq('cleaning_status', 'pending')
            .not('halunder_sentence', 'is', null)
            .not('german_sentence', 'is', null)
            .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) throw new Error(`Failed to fetch examples: ${error.message}`);

        if (data && data.length > 0) {
            allExamples = allExamples.concat(data);
            page++;
            if(data.length < pageSize) {
                hasMore = false;
            }
        } else {
            hasMore = false;
        }
    }
    return allExamples;
}

async function getWordContext(words) {
    if (!words || words.length === 0) return [];

    const orFilter = words.map(word => `term_text.ilike.${word}`).join(',');
    
    const { data: termData, error } = await sourceDbClient
        .from('new_terms')
        .select(`
            term_text,
            language,
            new_concept_to_term!inner(
                pronunciation, gender, plural_form, etymology, note, source_name, alternative_forms,
                concept:new_concepts!inner(id, primary_german_label, part_of_speech, german_definition, notes, krogmann_info, krogmann_idioms, sense_number)
            )
        `)
        .or(orFilter)
        .eq('language', 'hal');

    if (error) {
        addLog(`Dictionary lookup error: ${error.message}`, 'warning');
        return [];
    }
    
    const wordContext = [];
    if (termData) {
        termData.forEach(term => {
            term.new_concept_to_term.forEach(connection => {
                wordContext.push({
                    halunder_word: term.term_text,
                    german_equivalent: connection.concept.primary_german_label,
                    part_of_speech: connection.concept.part_of_speech,
                    german_definition: connection.concept.german_definition,
                    pronunciation: connection.pronunciation,
                    gender: connection.gender,
                    plural_form: connection.plural_form,
                    etymology: connection.etymology,
                    notes: connection.concept.notes,
                    krogmann_info: connection.concept.krogmann_info,
                    source_name: connection.source_name
                });
            });
        });
    }

    return wordContext;
}

// Main processing function - now runs concurrently on groups
async function runDictionaryExampleCleaner() {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now(), lastPromptUsed: null };
    let firstPromptPrinted = false;
    addLog(`Starting enhanced dictionary example cleaning process...`, 'info');

    try {
        addLog("Resetting any stale 'processing' or 'error' jobs to 'pending'...", 'info');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);

        addLog(`Fetching all pending examples from the dictionary (with pagination)...`, 'info');
        const pendingExamples = await fetchAllPendingExamples();

        if (!pendingExamples || pendingExamples.length === 0) {
            addLog('No pending examples found to clean.', 'success');
            processingState.status = 'Completed (No new examples)';
            processingState.isProcessing = false;
            return;
        }

        addLog(`Found ${pendingExamples.length} total examples. Grouping by concept ID...`, 'info');
        
        const exampleGroups = pendingExamples.reduce((acc, ex) => {
            const key = ex.concept.id;
            if (!acc[key]) acc[key] = [];
            acc[key].push(ex);
            return acc;
        }, {});

        const groupsToProcess = Object.values(exampleGroups);
        const totalGroups = groupsToProcess.length;
        addLog(`Created ${totalGroups} groups to process.`, 'success');
        
        processingState.status = 'Cleaning example groups with enhanced AI context...';
        let processedGroupCount = 0;

        const CONCURRENT_CHUNKS = 5;
        for (let i = 0; i < totalGroups; i += CONCURRENT_CHUNKS) {
            const chunk = groupsToProcess.slice(i, i + CONCURRENT_CHUNKS);
            
            const processingPromises = chunk.map((group, index) => {
                return new Promise(resolve => setTimeout(resolve, index * 200)) 
                    .then(() => processExampleGroup(group, !firstPromptPrinted && index === 0))
                    .catch(e => {
                        addLog(`Failed to process group for concept ID ${group[0].concept.id}: ${e.message}`, 'error');
                        const idsToUpdate = group.map(ex => ex.id);
                        return sourceDbClient.from('new_examples').update({ cleaning_status: 'error' }).in('id', idsToUpdate);
                    });
            });

            await Promise.all(processingPromises);
            
            if (!firstPromptPrinted && chunk.length > 0) firstPromptPrinted = true;

            processedGroupCount += chunk.length;
            processingState.details = `Processed ${processedGroupCount} of ${totalGroups} groups.`;
            processingState.progress = totalGroups > 0 ? (processedGroupCount / totalGroups) : 1;

            if (i + CONCURRENT_CHUNKS < totalGroups) {
                await new Promise(resolve => setTimeout(resolve, 500)); 
            }
        }
        
        const processingTime = Math.round((Date.now() - processingState.startTime) / 1000);
        addLog(`Processing complete for all ${totalGroups} groups in ${processingTime}s.`, 'success');
        processingState.status = 'Completed';

    } catch (error) {
        addLog(`A critical error occurred: ${error.message}`, 'error');
        processingState.status = 'Error';
        throw error;
    } finally {
        processingState.isProcessing = false;
    }
}

// Processes a group of examples related to the same concept
async function processExampleGroup(exampleGroup, shouldPrintPrompt) {
    const concept = exampleGroup[0].concept;
    const groupIds = exampleGroup.map(ex => ex.id);
    const validOriginalIds = new Set(groupIds); // For validating AI response

    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).in('id', groupIds);

    const allSentencesText = exampleGroup.map(ex => ex.halunder_sentence).join(' ');
    const words = [...new Set(allSentencesText.toLowerCase().match(/[\p{L}0-9']+/gu) || [])];
    
    const [wordContexts, knownIdiomsResult] = await Promise.all([
        getWordContext(words),
        sourceDbClient.from('cleaned_linguistic_examples').select('halunder_term, german_equivalent, explanation, tags').gte('relevance_score', 6)
    ]);
    
    // **FIX 1: Filter known idioms to only include those relevant to the current sentence group.**
    const allKnownIdioms = knownIdiomsResult.data || [];
    const groupHalunderText = exampleGroup.map(ex => ex.halunder_sentence.toLowerCase()).join(' ');
    const relevantIdioms = allKnownIdioms.filter(idiom =>
        groupHalunderText.includes(idiom.halunder_term.toLowerCase())
    );

    const headwordContext = {
        headword: concept.primary_german_label,
        part_of_speech: concept.part_of_speech,
        german_definition: concept.german_definition,
        notes: concept.notes,
        krogmann_info: concept.krogmann_info,
        krogmann_idioms: concept.krogmann_idioms
    };

    const prompt = buildGroupCleaningPrompt(exampleGroup, headwordContext, wordContexts, relevantIdioms);
    
    processingState.lastPromptUsed = prompt;
    if (shouldPrintPrompt) {
        console.log('----------- ENHANCED DICTIONARY EXAMPLE CLEANER PROMPT -----------');
        console.log(prompt);
        console.log('-------------------------------------------------------------------');
        addLog('Printed full enhanced prompt to server console for verification.', 'info');
    }

    const aiResult = await callOpenAI_Api(prompt);
    if (!aiResult.processed_examples || !Array.isArray(aiResult.processed_examples)) {
        throw new Error("AI response did not contain a 'processed_examples' array.");
    }
    
    let totalCleanedSentences = 0;
    for (const cleanedExample of aiResult.processed_examples) {
        
        // **FIX 2: Validate the original_example_id provided by the AI before inserting.**
        if (!validOriginalIds.has(cleanedExample.original_example_id)) {
            addLog(`AI returned an invalid original_example_id: ${cleanedExample.original_example_id}. Skipping this record.`, 'warning');
            continue; // Skip this invalid record
        }

        // --- 1. Save Translations ---
        const translationsToInsert = [];
        translationsToInsert.push({
            original_example_id: cleanedExample.original_example_id,
            cleaned_halunder: cleanedExample.cleaned_halunder,
            cleaned_german: cleanedExample.best_translation,
            confidence_score: cleanedExample.confidence_score,
            ai_notes: cleanedExample.notes,
            alternative_translations: 'gpt4_best',
            openai_prompt: prompt
        });

        if (cleanedExample.alternative_translations && Array.isArray(cleanedExample.alternative_translations)) {
            cleanedExample.alternative_translations.forEach((alt, index) => {
                translationsToInsert.push({
                    original_example_id: cleanedExample.original_example_id,
                    cleaned_halunder: cleanedExample.cleaned_halunder,
                    cleaned_german: alt.translation,
                    confidence_score: alt.confidence_score || 0.7,
                    ai_notes: alt.notes || '',
                    alternative_translations: `gpt4_alternative_${index + 1}`,
                    openai_prompt: prompt
                });
            });
        }
        
        const { error: insertError } = await sourceDbClient.from('ai_cleaned_dictsentences').insert(translationsToInsert);
        if (insertError) {
             addLog(`Failed to save cleaned translation for original ID ${cleanedExample.original_example_id}: ${insertError.message}`, 'warning');
             continue; // Skip to next cleaned example
        }
        totalCleanedSentences += translationsToInsert.length;

        // --- 2. Save Discovered Highlights ---
        if (cleanedExample.discovered_highlights && cleanedExample.discovered_highlights.length > 0) {
            for (const highlight of cleanedExample.discovered_highlights) {
                if (!highlight.relevance_score) {
                    addLog(`Skipping highlight "${highlight.halunder_phrase}" because AI did not provide a relevance_score.`, 'warning');
                    continue;
                }

                const linguisticEntry = {
                    halunder_term: highlight.halunder_phrase.trim(),
                    german_equivalent: highlight.german_meaning,
                    explanation: highlight.explanation_german,
                    feature_type: highlight.type,
                    source_table: 'new_examples',
                    relevance_score: highlight.relevance_score,
                    tags: [highlight.type],
                    source_ids: [cleanedExample.original_example_id],
                    processed_at: new Date().toISOString()
                };

                try {
                    const { data: existingEntry } = await sourceDbClient
                        .from('cleaned_linguistic_examples')
                        .select('id, relevance_score, source_ids')
                        .ilike('halunder_term', linguisticEntry.halunder_term.trim())
                        .single();

                    if (existingEntry) {
                        if (linguisticEntry.relevance_score > existingEntry.relevance_score) {
                            const existingSourceIds = existingEntry.source_ids || [];
                            const newSourceId = linguisticEntry.source_ids[0];
                            const updatedSourceIds = [...new Set([...existingSourceIds, newSourceId])];

                            const updatePayload = {
                                german_equivalent: linguisticEntry.german_equivalent,
                                explanation: linguisticEntry.explanation,
                                relevance_score: linguisticEntry.relevance_score,
                                processed_at: new Date().toISOString(),
                                source_ids: updatedSourceIds
                            };

                            const { error: updateError } = await sourceDbClient.from('cleaned_linguistic_examples').update(updatePayload).eq('id', existingEntry.id);
                            if (updateError) throw updateError;
                            addLog(`Updated linguistic feature: ${linguisticEntry.halunder_term} (score: ${existingEntry.relevance_score} → ${linguisticEntry.relevance_score})`, 'success');
                        }
                    } else {
                        const { error: insertError } = await sourceDbClient.from('cleaned_linguistic_examples').insert([linguisticEntry]);
                        if (insertError) throw insertError;
                        addLog(`Saved new linguistic feature: ${linguisticEntry.halunder_term} (AI score: ${linguisticEntry.relevance_score})`, 'success');
                    }
                } catch (linguisticError) {
                     if (linguisticError.code !== 'PGRST116') { // Ignore 'exact one row' error for .single() when no entry is found
                        addLog(`Error processing linguistic feature "${highlight.halunder_phrase}": ${linguisticError.message}`, 'warning');
                    }
                }
            }
        }
    }

    await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).in('id', groupIds);
    addLog(`[GROUP PROCESSED] Concept ${concept.id} (${concept.primary_german_label}): Processed ${exampleGroup.length} raw examples into ${totalCleanedSentences} clean sentences.`, 'success');
}

// Enhanced AI prompt that processes groups and expects AI-judged relevance
function buildGroupCleaningPrompt(exampleGroup, headwordContext, wordContexts, knownIdioms) {
    const rawExamples = exampleGroup.map(ex => ({
        id: ex.id,
        halunder: ex.halunder_sentence,
        german: ex.german_sentence,
        note: ex.note || 'N/A'
    }));

    return `
You are an expert linguist and data cleaner specializing in Heligolandic Frisian (Halunder) and German. Your task is to process a batch of related example sentence pairs from a dictionary.

**PRIMARY GOALS:**
1.  **EXPAND & CLEAN:** For each raw example, clean it up (without changing spelling, etc.). If it contains variations (e.g., using "/"), you MUST expand it into multiple, separate, complete sentence objects. You shall also fix punctuation (?.!) and also make sure sentences are capitalized.
2.  **NATURAL TRANSLATION:** Your \`best_translation\` MUST be the most natural, idiomatic German a native speaker would use. Literal translations are valuable but should be put in \`alternative_translations\` or explained in the notes.
3.  **DISCOVER HIGHLIGHTS:** Identify idioms, cultural notes, place names, or other linguistically interesting elements.
4.  **JUDGE RELEVANCE:** For each discovered highlight, you MUST assign a \`relevance_score\` from 1 (very basic) to 10 (extremely rare and insightful).

**INSTRUCTIONS:**
- Analyze the entire group of \`Raw Example Pairs\` below. They are all related to the same headword.
- Use the provided \`Dictionary Context\` for individual words to understand their meaning.
- For EACH raw example, produce one or more cleaned objects in the output array.
- Your entire response MUST be a single JSON object with ONE key: \`processed_examples\`. This key holds an array of result objects.

**INPUT DATA:**

**1. Main Dictionary Headword Context (applies to all examples below):**
\`\`\`json
${JSON.stringify(headwordContext, null, 2)}
\`\`\`

**2. Dictionary Context for Individual Words (from all sentences):**
\`\`\`json
${JSON.stringify(wordContexts, null, 2)}
\`\`\`

**3. Already Known Idioms/Features (Only relevant items are shown):**
\`\`\`json
${JSON.stringify(knownIdioms, null, 2)}
\`\`\`

**4. Raw Example Pairs to Process (a group of related examples):**
\`\`\`json
${JSON.stringify(rawExamples, null, 2)}
\`\`\`

**YOUR JSON OUTPUT (STRUCTURE EXAMPLE):**
Your output must be a single JSON object. The \`processed_examples\` array should contain one object for each *final, expanded, and cleaned sentence*.

\`\`\`json
{
  "processed_examples": [
    {
      "original_example_id": "d201763a-f4a9-406e-a8b6-c8c5a248ff23",
      "cleaned_halunder": "Bisterk Locht.",
      "best_translation": "Schlechtes Wetter.",
      "confidence_score": 0.95,
      "notes": "This is the first variation expanded from 'bisterk Locht / Weder'. 'Locht' means 'air' and is used idiomatically for 'weather'.",
      "alternative_translations": [
        { "translation": "Garstiges Wetter.", "confidence_score": 0.85, "notes": "A strong alternative using 'garstig'." },
        { "translation": "böse Luft", "confidence_score": 0.70, "notes": "This is the literal, word-for-word translation, less natural in German." }
      ],
      "discovered_highlights": [
        {
          "halunder_phrase": "bisterk Locht",
          "german_literal": "böse Luft",
          "german_meaning": "schlechtes Wetter",
          "explanation_german": "Eine gebräuchliche Redewendung auf Helgoland, um schlechtes Wetter oder stürmische Bedingungen zu beschreiben. 'Locht' (Luft) wird hier synonym für Wetter verwendet.",
          "type": "idiom",
          "relevance_score": 7
        }
      ]
    },
    {
      "original_example_id": "d201763a-f4a9-406e-a8b6-c8c5a248ff23",
      "cleaned_halunder": "Bisterk Weder.",
      "best_translation": "Schlechtes Wetter.",
      "confidence_score": 0.98,
      "notes": "This is the second variation expanded from 'bisterk Locht / Weder'. 'Weder' is a direct cognate of German 'Wetter'.",
      "alternative_translations": [],
      "discovered_highlights": []
    }
  ]
}
\`\`\`

**Types for discovered_highlights:** "idiom", "place_name", "cultural_reference", "historical_reference", "maritime_term", "food_tradition", "religious_reference", "family_name".

**Relevance Score Guidelines:**
- **10**: Extremely rare idioms, deep cultural insights that would fascinate linguists.
- **8-9**: Important cultural markers, characteristic expressions, significant place names.
- **6-7**: Moderately interesting local terms, common idioms, maritime vocabulary.
- **4-5**: Common local expressions, basic dialectal differences.
- **1-3**: Very basic terms, obvious cognates, simple vocabulary variations.
`;
}


// --- API Routes ---

router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    runDictionaryExampleCleaner().catch(err => {
        console.error("Caught unhandled error in dictionary example cleaner:", err);
        processingState.status = 'Error';
        processingState.isProcessing = false;
    });
    res.json({ success: true, message: `Enhanced dictionary example cleaning started for ALL pending examples.` });
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

        res.json({
            totalExamples: totalExamples || 0,
            pendingExamples: pendingExamples || 0,
            cleanedExamples: cleanedExamples || 0,
            discoveredIdioms: discoveredFeatures || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/sample-prompt', (req, res) => {
    if (processingState.lastPromptUsed) {
        res.json({ prompt: processingState.lastPromptUsed });
    } else {
        res.json({ prompt: 'No prompt available yet. Start processing to see the latest prompt.' });
    }
});

router.post('/reset-all', async (req, res) => {
    try {
        const { error, count } = await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).neq('id', '00000000-0000-0000-0000-000000000000').select({count: 'exact'});
        if (error) throw error;
        res.json({ success: true, message: `Reset ${count} examples to pending status`, resetCount: count });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/clear-cleaned', async (req, res) => {
    try {
        const { error: cleanedError } = await sourceDbClient.from('ai_cleaned_dictsentences').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (cleanedError) throw cleanedError;

        const { error: linguisticError } = await sourceDbClient.from('cleaned_linguistic_examples').delete().eq('source_table', 'new_examples');
        if (linguisticError) throw linguisticError;

        res.json({ success: true, message: 'Cleared all cleaned data and discovered linguistic features' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
