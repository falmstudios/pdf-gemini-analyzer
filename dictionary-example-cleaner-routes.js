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

// Enhanced function to get comprehensive word context
async function getWordContext(words) {
    if (!words || words.length === 0) return [];

    const orFilter = words.map(word => `term_text.ilike.${word}`).join(',');
    
    const { data: termData, error } = await sourceDbClient
        .from('new_terms')
        .select(`
            term_text,
            language,
            new_concept_to_term!inner(
                pronunciation,
                gender,
                plural_form,
                etymology,
                note,
                source_name,
                alternative_forms,
                concept:new_concepts!inner(
                    id,
                    primary_german_label,
                    part_of_speech,
                    german_definition,
                    notes,
                    krogmann_info,
                    krogmann_idioms,
                    sense_number
                )
            )
        `)
        .or(orFilter)
        .eq('language', 'hal');

    if (error) {
        addLog(`Dictionary lookup error: ${error.message}`, 'warning');
        return [];
    }

    // Transform the data into a more usable format
    const wordContext = [];
    if (termData) {
        termData.forEach(term => {
            term.new_concept_to_term.forEach(connection => {
                const concept = connection.concept;
                wordContext.push({
                    halunder_word: term.term_text,
                    german_equivalent: concept.primary_german_label,
                    part_of_speech: concept.part_of_speech,
                    german_definition: concept.german_definition,
                    pronunciation: connection.pronunciation,
                    gender: connection.gender,
                    plural_form: connection.plural_form,
                    etymology: connection.etymology,
                    notes: concept.notes,
                    krogmann_info: concept.krogmann_info,
                    source_name: connection.source_name
                });
            });
        });
    }

    return wordContext;
}

// Main processing function
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
    let firstPromptPrinted = false;
    addLog(`Starting enhanced dictionary example cleaning process...`, 'info');

    try {
        // Reset any stale processing records
        addLog("Checking for any stale 'processing' jobs...", 'info');
        await sourceDbClient.from('new_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);

        addLog(`Fetching up to ${limit} pending examples from the dictionary...`, 'info');
        
        // Fetch pending examples with their concept data
        const { data: pendingExamples, error: fetchError } = await sourceDbClient
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
            .limit(limit);

        if (fetchError) throw new Error(`Failed to fetch examples: ${fetchError.message}`);
        if (!pendingExamples || pendingExamples.length === 0) {
            addLog('No pending examples found to clean.', 'success');
            processingState.status = 'Completed (No new examples)';
            processingState.isProcessing = false;
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Cleaning examples with enhanced AI context...';
        let processedCount = 0;

        for (const example of pendingExamples) {
            addLog(`Processing example ${processedCount + 1} of ${totalToProcess}...`, 'info');
            try {
                await processSingleExample(example, !firstPromptPrinted);
                if (!firstPromptPrinted) firstPromptPrinted = true;
            } catch (e) {
                addLog(`Failed to process example ID ${example.id}: ${e.message}`, 'error');
                await sourceDbClient.from('new_examples').update({ cleaning_status: 'error' }).eq('id', example.id);
            }
            processedCount++;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} examples.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            
            // Add a small delay to be nice to the API
            await new Promise(resolve => setTimeout(resolve, 1000));
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

// =========================================================================================
// REPLACED SECTION START
// =========================================================================================

// Enhanced single example processing - AI JUDGES RELEVANCE
async function processSingleExample(example, shouldPrintPrompt) {
    await sourceDbClient.from('new_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);

    // Extract words from the Halunder sentence
    const words = [...new Set(example.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || [])];
    
    // Get comprehensive context for each word
    const wordContexts = await getWordContext(words);
    
    // Main headword context
    const headwordContext = {
        headword: example.concept.primary_german_label,
        part_of_speech: example.concept.part_of_speech,
        german_definition: example.concept.german_definition,
        notes: example.concept.notes,
        krogmann_info: example.concept.krogmann_info,
        krogmann_idioms: example.concept.krogmann_idioms
    };

    // Look up known idioms and linguistic features
    const { data: knownIdioms } = await sourceDbClient
        .from('cleaned_linguistic_examples')
        .select('halunder_term, german_equivalent, explanation, tags')
        .gte('relevance_score', 6);

    // Filter idioms that appear in this sentence
    const foundIdioms = knownIdioms?.filter(idiom => 
        example.halunder_sentence.toLowerCase().includes(idiom.halunder_term.toLowerCase())
    ) || [];

    const prompt = buildEnhancedCleaningPrompt(example, headwordContext, wordContexts, foundIdioms);
    
    // Store the prompt for display
    processingState.lastPromptUsed = prompt;
    
    if (shouldPrintPrompt) {
        console.log('----------- ENHANCED DICTIONARY EXAMPLE CLEANER PROMPT -----------');
        console.log(prompt);
        console.log('-------------------------------------------------------------------');
        addLog('Printed full enhanced prompt to server console for verification.', 'info');
    }

    const aiResult = await callOpenAI_Api(prompt);

    // Create separate rows for each translation
    const translationsToInsert = [];
    
    // 1. Best translation (primary)
    translationsToInsert.push({
        original_example_id: example.id,
        cleaned_halunder: aiResult.cleaned_halunder,
        cleaned_german: aiResult.best_translation,
        confidence_score: aiResult.confidence_score,
        ai_notes: aiResult.notes,
        alternative_translations: 'gpt4_best',
        openai_prompt: prompt
    });

    // 2. Alternative translations (separate rows)
    if (aiResult.alternative_translations && Array.isArray(aiResult.alternative_translations)) {
        aiResult.alternative_translations.forEach((alt, index) => {
            translationsToInsert.push({
                original_example_id: example.id,
                cleaned_halunder: aiResult.cleaned_halunder,
                cleaned_german: alt.translation,
                confidence_score: alt.confidence_score || 0.7,
                ai_notes: alt.notes || '',
                alternative_translations: `gpt4_alternative_${index + 1}`,
                openai_prompt: prompt
            });
        });
    }

    // Insert all translation rows
    const { error: insertError } = await sourceDbClient
        .from('ai_cleaned_dictsentences')
        .insert(translationsToInsert);
    
    if (insertError) throw new Error(`Failed to save cleaned example: ${insertError.message}`);

    // Save discovered highlights using AI-provided relevance scores
    if (aiResult.discovered_highlights && aiResult.discovered_highlights.length > 0) {
        for (const highlight of aiResult.discovered_highlights) {
            // Use AI-provided relevance score.
            const relevanceScore = highlight.relevance_score;
            
            // Add a check to ensure the score is a valid number before proceeding.
            if (typeof relevanceScore !== 'number') {
                addLog(`Skipping highlight "${highlight.halunder_phrase}" due to missing or invalid relevance_score.`, 'warning');
                continue; // Skip to the next highlight
            }

            const linguisticEntry = {
                halunder_term: highlight.halunder_phrase.trim(),
                german_equivalent: highlight.german_meaning,
                explanation: highlight.explanation_german,
                feature_type: highlight.type,
                source_table: 'new_examples',
                relevance_score: relevanceScore,
                tags: [highlight.type],
                source_ids: [example.id],
                processed_at: new Date().toISOString()
            };

            try {
                // Check if it already exists first
                const { data: existingEntry, error: selectError } = await sourceDbClient
                    .from('cleaned_linguistic_examples')
                    .select('id, relevance_score')
                    .ilike('halunder_term', linguisticEntry.halunder_term.trim())
                    .single();

                // Handle potential error from .single() if more than one row is found
                if (selectError && selectError.code !== 'PGRST116') { // PGRST116 = 0 or 1 rows found, which is ok
                     throw selectError;
                }

                if (existingEntry) {
                    // Update if our relevance score is higher
                    if (relevanceScore > existingEntry.relevance_score) {
                        const { error: updateError } = await sourceDbClient
                            .from('cleaned_linguistic_examples')
                            .update({
                                german_equivalent: linguisticEntry.german_equivalent,
                                explanation: linguisticEntry.explanation,
                                relevance_score: relevanceScore,
                                processed_at: new Date().toISOString()
                            })
                            .eq('id', existingEntry.id);
                        
                        if (updateError) {
                            addLog(`Failed to update linguistic feature "${highlight.halunder_phrase}": ${updateError.message}`, 'warning');
                        } else {
                            addLog(`Updated linguistic feature: ${highlight.halunder_phrase} (score: ${existingEntry.relevance_score} → ${relevanceScore})`, 'success');
                        }
                    } else {
                        addLog(`Linguistic feature "${highlight.halunder_phrase}" already exists with higher/equal score (${existingEntry.relevance_score})`, 'info');
                    }
                } else {
                    // Insert new entry
                    const { error: insertError } = await sourceDbClient
                        .from('cleaned_linguistic_examples')
                        .insert([linguisticEntry]);
                    
                    if (insertError) {
                        addLog(`Failed to save linguistic feature "${highlight.halunder_phrase}": ${insertError.message}`, 'warning');
                    } else {
                        addLog(`Saved new linguistic feature: ${highlight.halunder_phrase} (AI score: ${relevanceScore})`, 'success');
                    }
                }
            } catch (linguisticError) {
                addLog(`Error processing linguistic feature "${highlight.halunder_phrase}": ${linguisticError.message}`, 'warning');
            }
        }
        addLog(`Processed ${aiResult.discovered_highlights.length} linguistic features`, 'success');
    }

    await sourceDbClient.from('new_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
    
    const logMessage = `[CLEANED] ${aiResult.cleaned_halunder} -> ${aiResult.best_translation} (+${translationsToInsert.length - 1} alternatives)`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// UPDATED AI prompt - AI now provides relevance scores
function buildEnhancedCleaningPrompt(example, headwordContext, wordContexts, knownIdioms) {
    return `
You are an expert linguist and data cleaner specializing in Heligolandic Frisian (Halunder) and German. Your task is to take a raw example sentence pair from a dictionary and normalize it into a high-quality, clean parallel sentence for machine learning. You also act as a cultural and linguistic highlight discovery engine.

**PRIMARY GOAL:**
Your main job is to "clean" both the Halunder and German sentences, and to identify any cultural highlights, idioms, place names, personal names, or other linguistically interesting elements within the sentence.

**INSTRUCTIONS:**
1. **Analyze the Raw Pair:** Look at the provided Halunder and German example.
2. **Use ALL Context:** Pay close attention to the **Dictionary Context for Individual Words** - this gives you the meaning of each word in the sentence.
3. **Correct the Halunder:** Create a clean, single-line version of the Halunder sentence. Fix OCR errors, misplaced punctuation, and incorrect spacing. Ensure the sentence starts with a capital letter and ends with appropriate terminal punctuation. **Do not change the original wording or grammar.**
4. **Correct & Improve the German:** Create the best possible German translation. It should be grammatically correct and sound natural to a native speaker.
5. **IDENTIFY HIGHLIGHTS:** Look for any of these in the Halunder sentence:
   - **Idioms**: Non-literal expressions (e.g., "beerigermarri" = kleiner Penis)
   - **Place names**: Local Helgoland locations
   - **Cultural references**: Traditions, customs, local practices
   - **Historical references**: People, events, old practices
   - **Metaphorical expressions**: Colorful language unique to Helgoland
6. **JUDGE RELEVANCE:** For each discovered highlight, assign a relevance score 1-10:
   - **10**: Extremely unique idioms, deep cultural insights, rare expressions
   - **8-9**: Important cultural references, characteristic local expressions
   - **6-7**: Moderately interesting terms, place names, maritime terms
   - **4-5**: Common expressions, basic vocabulary variations
   - **1-3**: Very basic terms, obvious translations
7. **Provide Multiple Valid Translations:** Give 2-3 different ways to translate the German that are all correct but use different words or styles.
8. **Output JSON:** Structure your entire response in the following JSON format ONLY.

**INPUT DATA:**

**1. Main Dictionary Headword Context:**
\`\`\`json
${JSON.stringify(headwordContext, null, 2)}
\`\`\`

**2. Dictionary Context for Individual Words in Sentence:**
\`\`\`json
${JSON.stringify(wordContexts, null, 2)}
\`\`\`

**3. Already Known Idioms/Features:**
\`\`\`json
${JSON.stringify(knownIdioms, null, 2)}
\`\`\`

**4. Raw Example Pair (may contain errors):**
- Halunder: "${example.halunder_sentence}"
- German: "${example.german_sentence}"

**5. Original Note on the Example (if any):**
"${example.note || 'N/A'}"

**YOUR JSON OUTPUT:**
\`\`\`json
{
  "cleaned_halunder": "The corrected, single-line version of the Halunder sentence.",
  "best_translation": "The best, most natural German translation.",
  "confidence_score": 0.95,
  "notes": "Explain why the translation is what it is, especially referencing the individual word contexts provided.",
  "alternative_translations": [
    {
      "translation": "Wahr werden.",
      "confidence_score": 0.90,
      "notes": "More literal translation focusing on 'becoming true'."
    },
    {
      "translation": "Es wird Realität.",
      "confidence_score": 0.85,
      "notes": "Alternative emphasizing the reality aspect."
    }
  ],
  "discovered_highlights": [
    {
      "halunder_phrase": "beerigermarri",
      "german_literal": "Konfirmandenwurst",
      "german_meaning": "kleiner Penis",
      "explanation_german": "Auf Helgoländisch sagt man 'beerigermarri' (wörtlich: Konfirmandenwurst) umgangssprachlich für einen kleinen Penis. Dies ist eine metaphorische und humorvolle Umschreibung, die in der lokalen Kultur verwurzelt ist.",
      "type": "idiom",
      "relevance_score": 9
    },
    {
      "halunder_phrase": "Nathurnstak",
      "german_literal": "Nordspitze",
      "german_meaning": "Lange Anna",
      "explanation_german": "Das Wahrzeichen Helgolands ist die Lange Anna, welche auf Halunder 'Nathurnstak' heißt. Die Bezeichnung bezieht sich auf die Nordspitze der Insel.",
      "type": "place_name",
      "relevance_score": 7
    }
  ]
}
\`\`\`

**Types for discovered_highlights:**
- "idiom" - Non-literal expressions, metaphors, slang
- "place_name" - Locations on or around Helgoland
- "cultural_reference" - Traditions, customs, local practices
- "historical_reference" - Historical people, events, old practices
- "maritime_term" - Sea-related terminology specific to Helgoland
- "food_tradition" - Local food names or cooking practices
- "religious_reference" - Church or religious terminology
- "family_name" - Traditional Helgolandic family names

**Relevance Score Guidelines:**
- **10**: Extremely rare idioms, deep cultural insights that would fascinate linguists
- **8-9**: Important cultural markers, characteristic expressions, significant place names
- **6-7**: Moderately interesting local terms, maritime vocabulary, regional variations
- **4-5**: Common local expressions, basic dialectal differences
- **1-3**: Very basic terms, obvious cognates, simple vocabulary variations
`;
}

// =========================================================================================
// REPLACED SECTION END
// =========================================================================================

// API Routes (unchanged)
router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 100;
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
        const { count: totalExamples } = await sourceDbClient
            .from('new_examples')
            .select('*', { count: 'exact', head: true });
        
        const { count: pendingExamples } = await sourceDbClient
            .from('new_examples')
            .select('*', { count: 'exact', head: true })
            .eq('cleaning_status', 'pending');
        
        const { count: cleanedExamples } = await sourceDbClient
            .from('ai_cleaned_dictsentences')
            .select('*', { count: 'exact', head: true });

        const { count: discoveredFeatures } = await sourceDbClient
            .from('cleaned_linguistic_examples')
            .select('*', { count: 'exact', head: true })
            .eq('source_table', 'new_examples');

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
        const { data: resetData, error } = await sourceDbClient
            .from('new_examples')
            .update({ cleaning_status: 'pending' })
            .neq('id', '00000000-0000-0000-0000-000000000000')
            .select('id');

        if (error) throw error;

        const resetCount = resetData ? resetData.length : 0;
        res.json({ 
            success: true, 
            message: `Reset ${resetCount} examples to pending status`,
            resetCount 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/clear-cleaned', async (req, res) => {
    try {
        const { error: cleanedError } = await sourceDbClient
            .from('ai_cleaned_dictsentences')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000');

        if (cleanedError) throw cleanedError;

        const { error: linguisticError } = await sourceDbClient
            .from('cleaned_linguistic_examples')
            .delete()
            .eq('source_table', 'new_examples');

        if (linguisticError) throw linguisticError;

        res.json({ 
            success: true, 
            message: 'Cleared all cleaned data and discovered linguistic features'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
