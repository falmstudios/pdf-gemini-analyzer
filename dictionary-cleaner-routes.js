const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// === DATABASE CONNECTIONS ===
// This is the ONLY database client we need for this script.
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
    console.log(`[DICT-CLEANER] [${type.toUpperCase()}] ${message}`);
}

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

// === THE MAIN PROCESSING FUNCTION ===
async function runDictionaryCleaner(limit) {
    processingState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [], startTime: Date.now() };
    let firstPromptPrinted = false;
    addLog(`Starting Dictionary Example Cleaner process...`, 'info');

    try {
        // --- FIX: Use the correct table name 'examples' ---
        addLog("Checking for any stale 'processing' jobs...", 'info');
        await dictionaryDbClient.from('examples').update({ cleaning_status: 'pending' }).eq('cleaning_status', 'processing');

        addLog(`Fetching up to ${limit} pending examples from the dictionary...`, 'info');
        
        // --- FIX: Use the correct table name and join syntax ---
        const { data: pendingExamples, error: fetchError } = await dictionaryDbClient
            .from('examples')
            .select(`
                *,
                concept:concepts!inner(
                    primary_german_label,
                    part_of_speech,
                    german_definition,
                    notes,
                    krogmann_info,
                    krogmann_idioms,
                    relations!source_concept_id(
                        relation_type,
                        target_concept:concepts!target_concept_id(primary_german_label)
                    )
                )
            `)
            .eq('cleaning_status', 'pending')
            .not('halunder_sentence', 'is', null)
            .not('german_sentence', 'is', null)
            .limit(limit);
        // --- END OF FIX ---

        if (fetchError) throw new Error(`Failed to fetch examples: ${fetchError.message}`);
        if (!pendingExamples || pendingExamples.length === 0) {
            addLog('No pending examples found to clean.', 'success');
            processingState.status = 'Completed (No new examples)';
            processingState.isProcessing = false;
            return;
        }

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Cleaning examples with AI...';
        let processedCount = 0;

        for (const example of pendingExamples) {
            addLog(`Processing example ${processedCount + 1} of ${totalToProcess}...`, 'info');
            try {
                await processSingleExample(example, !firstPromptPrinted);
                if (!firstPromptPrinted) firstPromptPrinted = true;
            } catch (e) {
                addLog(`Failed to process example ID ${example.id}: ${e.message}`, 'error');
                await dictionaryDbClient.from('examples').update({ cleaning_status: 'error' }).eq('id', example.id);
            }
            processedCount++;
            processingState.details = `Processed ${processedCount} of ${totalToProcess} examples.`;
            processingState.progress = totalToProcess > 0 ? (processedCount / totalToProcess) : 1;
            await new Promise(resolve => setTimeout(resolve, 500));
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

// === THE AI PIPELINE FOR A SINGLE EXAMPLE ===
async function processSingleExample(example, shouldPrintPrompt) {
    await dictionaryDbClient.from('examples').update({ cleaning_status: 'processing' }).eq('id', example.id);

    // Get Dictionary Data for all words in the sentence
    const words = [...new Set(example.halunder_sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || [])];
    let wordDictionaryData = null;
    if (words.length > 0) {
        const orFilter = words.map(word => `term_text.ilike.${word}`).join(',');
        const { data, error } = await dictionaryDbClient
            .from('terms')
            .select(`term_text, concept_to_term!inner(concept:concepts!inner(primary_german_label, part_of_speech, german_definition))`)
            .or(orFilter)
            .eq('language', 'hal');
        if (error) addLog(`Dictionary lookup failed for example ${example.id}: ${error.message}`, 'warning');
        else wordDictionaryData = data;
    }

    const prompt = buildExampleCleanerPrompt(example, wordDictionaryData);
    
    if (shouldPrintPrompt) {
        console.log('----------- DICTIONARY CLEANER PROMPT -----------');
        console.log(prompt);
        console.log('-------------------------------------------------');
        addLog('Printed full prompt to server console for verification.', 'info');
    }

    const aiResult = await callOpenAI_Api(prompt);

    const cleanedEntries = [];
    cleanedEntries.push({
        original_example_id: example.id,
        cleaned_halunder: aiResult.cleaned_halunder,
        cleaned_german: aiResult.best_translation,
        source: 'gpt-4.1_best',
        confidence_score: aiResult.confidence_score,
        ai_notes: aiResult.notes
    });
    if (aiResult.alternative_translations) {
        aiResult.alternative_translations.forEach(alt => {
            cleanedEntries.push({
                original_example_id: example.id,
                cleaned_halunder: aiResult.cleaned_halunder,
                cleaned_german: alt.translation,
                source: 'gpt-4.1_alternative',
                confidence_score: alt.confidence_score,
                ai_notes: alt.notes
            });
        });
    }

    const { error: insertError } = await dictionaryDbClient.from('cleaned_dictionary_examples').insert(cleanedEntries);
    if (insertError) throw new Error(`Failed to save cleaned example: ${insertError.message}`);

    await dictionaryDbClient.from('examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
    
    const logMessage = `[HAL-CLEANED] ${aiResult.cleaned_halunder} -> [DE] ${aiResult.cleaned_german}`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// === HELPER TO BUILD THE PROMPT ===
function buildExampleCleanerPrompt(example, wordDictionaryData) {
    const headwordContext = {
        headword: example.concept?.primary_german_label || "Unknown",
        word_type: example.concept?.part_of_speech,
        definition: example.concept?.german_definition,
        usage_notes: example.concept?.notes,
        krogmann_info: example.concept?.krogmann_info,
        krogmann_idioms: example.concept?.krogmann_idioms,
        related_words: example.concept?.relations?.map(r => r.target_concept?.primary_german_label).filter(Boolean) || []
    };

    return `
You are an expert linguist and data cleaner specializing in Heligolandic Frisian (Halunder) and German. Your task is to take a raw example sentence pair from a dictionary and normalize it into a high-quality, clean parallel sentence for machine learning.

**PRIMARY GOAL:**
Your main job is to "clean" both the Halunder and German sentences. This involves fixing obvious OCR errors and making the German translation sound natural and fluent, while explaining any idiomatic translations.

**INSTRUCTIONS:**
1.  **Analyze the Raw Pair:** Look at the provided Halunder and German example.
2.  **Use ALL Context:** Pay close attention to the full **Dictionary Headword Context** AND the **Word-by-Word Dictionary Entries**. This provides crucial information.
3.  **Correct the Halunder:** Create a clean, single-line version of the Halunder sentence. Fix OCR errors like "letj\\ninaptain" to "letj inaptain", misplaced punctuation, and incorrect spacing. Ensure the sentence starts with a capital letter and ends with appropriate terminal punctuation ('.', '!', '?'). **Do not change the original wording or grammar.**
4.  **Correct & Improve the German:** Create the best possible German translation. It should be grammatically correct and sound natural to a native speaker.
5.  **Explain Idioms:** In the "notes" field, explain *why* the translation is what it is, especially if it's not literal.
6.  **Provide Alternatives:** If other valid, high-quality German translations exist, provide them.
7.  **Output JSON:** Structure your entire response in the following JSON format ONLY.

**INPUT DATA:**

**1. Full Dictionary Headword Context (The entry this example belongs to):**
\`\`\`json
${JSON.stringify(headwordContext, null, 2)}
\`\`\`

**2. Word-by-Word Dictionary Entries for the Halunder sentence:**
\`\`\`json
${JSON.stringify(wordDictionaryData, null, 2)}
\`\`\`

**3. Raw Example Pair (may contain errors):**
- Halunder: "${example.halunder_sentence}"
- German: "${example.german_sentence}"

**4. Original Note on the Example (if any):**
"${example.note || 'N/A'}"

**YOUR JSON OUTPUT:**
\`\`\`json
{
  "cleaned_halunder": "The corrected, single-line version of the Halunder sentence.",
  "best_translation": "The best, most natural German translation.",
  "confidence_score": 0.95,
  "notes": "Explain why the translation is what it is. For example: 'The phrase X is an idiom meaning Y, so it was translated this way for naturalness.'",
  "alternative_translations": [
    {
      "translation": "A valid alternative translation.",
      "confidence_score": 0.80,
      "notes": "This is a more literal translation."
    }
  ]
}
\`\`\`
`;
}

// === API ROUTES ===
router.post('/start-cleaning', (req, res) => {
    if (processingState.isProcessing) {
        return res.status(400).json({ error: 'Processing is already in progress.' });
    }
    const limit = parseInt(req.body.limit, 10) || 100;
    runDictionaryCleaner(limit).catch(err => {
        console.error("Caught unhandled error in dictionary cleaner:", err);
    });
    res.json({ success: true, message: `Dictionary cleaning started for up to ${limit} examples.` });
});

router.get('/progress', (req, res) => {
    res.json(processingState);
});

module.exports = router;
