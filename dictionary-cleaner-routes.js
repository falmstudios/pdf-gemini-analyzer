const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// === DATABASE CONNECTIONS ===
// This is the ONLY database client we need. It points to your unified SOURCE database.
const sourceDbClient = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

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
        addLog("Checking for any stale 'processing' jobs...", 'info');
        await sourceDbClient.from('dictionary_examples').update({ cleaning_status: 'pending' }).in('cleaning_status', ['processing', 'error']);

        addLog(`Fetching up to ${limit} pending examples from the dictionary...`, 'info');
        
        // Fetch all necessary data in two steps to avoid relationship errors.
        
        // Step 1: Get the pending examples.
        const { data: pendingExamples, error: fetchError } = await sourceDbClient
            .from('dictionary_examples')
            .select(`*`)
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

        // Step 2: Get all the related context data for the fetched examples.
        const entryIds = [...new Set(pendingExamples.map(ex => ex.entry_id))];
        const { data: entriesData, error: entriesError } = await sourceDbClient
            .from('dictionary_entries')
            .select(`id, german_word, word_type, etymology, additional_info, idioms, reference_notes, usage_notes`)
            .in('id', entryIds);
        if (entriesError) throw new Error(`Failed to fetch entry context: ${entriesError.message}`);
        const entriesMap = new Map(entriesData.map(entry => [entry.id, entry]));

        const totalToProcess = pendingExamples.length;
        addLog(`Found ${totalToProcess} examples to process.`, 'success');
        processingState.status = 'Cleaning examples with AI...';
        let processedCount = 0;

        for (const example of pendingExamples) {
            addLog(`Processing example ${processedCount + 1} of ${totalToProcess}...`, 'info');
            try {
                const entryContext = entriesMap.get(example.entry_id);
                await processSingleExample(example, entryContext, !firstPromptPrinted);
                if (!firstPromptPrinted) firstPromptPrinted = true;
            } catch (e) {
                addLog(`Failed to process example ID ${example.id}: ${e.message}`, 'error');
                await sourceDbClient.from('dictionary_examples').update({ cleaning_status: 'error' }).eq('id', example.id);
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
async function processSingleExample(example, entryContext, shouldPrintPrompt) {
    await sourceDbClient.from('dictionary_examples').update({ cleaning_status: 'processing' }).eq('id', example.id);

    const prompt = buildExampleCleanerPrompt(example, entryContext);
    
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

    const { error: insertError } = await sourceDbClient.from('cleaned_dictionary_examples').insert(cleanedEntries);
    if (insertError) throw new Error(`Failed to save cleaned example: ${insertError.message}`);

    await sourceDbClient.from('dictionary_examples').update({ cleaning_status: 'completed' }).eq('id', example.id);
    
    const logMessage = `[HAL-CLEANED] ${aiResult.cleaned_halunder} -> [DE] ${aiResult.cleaned_german}`;
    addLog(logMessage, 'success');
    
    return shouldPrintPrompt;
}

// === HELPER TO BUILD THE PROMPT ===
function buildExampleCleanerPrompt(example, entryContext) {
    const headwordContext = {
        headword: entryContext?.german_word || "Unknown",
        word_type: entryContext?.word_type,
        etymology: entryContext?.etymology,
        additional_info: entryContext?.additional_info,
        idioms: entryContext?.idioms,
        reference_notes: entryContext?.reference_notes,
        usage_notes: entryContext?.usage_notes,
        // Note: related_words are not included in this simplified version
        // to avoid complex multi-level joins that were causing issues.
        related_words: [] 
    };

    return `
You are an expert linguist and data cleaner specializing in Heligolandic Frisian (Halunder) and German. Your task is to take a raw example sentence pair from a dictionary and normalize it into a high-quality, clean parallel sentence for machine learning.

**PRIMARY GOAL:**
Your main job is to "clean" both the Halunder and German sentences. This involves fixing obvious OCR errors and making the German translation sound natural and fluent, while explaining any idiomatic translations.

**INSTRUCTIONS:**
1.  **Analyze the Raw Pair:** Look at the provided Halunder and German example.
2.  **Use ALL Context:** Pay close attention to the full **Dictionary Headword Context**. This provides crucial information about the main word the example illustrates.
3.  **Correct the Halunder:** Create a clean, single-line version of the Halunder sentence. Fix OCR errors like "letj\\ninaptain" to "letj inaptain", misplaced punctuation, and incorrect spacing. Ensure the sentence starts with a capital letter and ends with appropriate terminal punctuation ('.', '!', '?'). **Do not change the original wording or grammar.**
4.  **Correct & Improve the German:** Create the best possible German translation. It should be grammatically correct and sound natural to a native speaker.
5.  **Explain Idioms:** In the "notes" field, explain *why* the translation is what it is, especially if it's not literal.
6.  **Provide Alternatives:** If other valid, high-quality German translations exist, provide them.
7.  **Output JSON:** Structure your entire response in the following JSON format ONLY.

**INPUT DATA:**

**1. Full Dictionary Headword Context:**
\`\`\`json
${JSON.stringify(headwordContext, null, 2)}
\`\`\`

**2. Raw Example Pair (may contain errors):**
- Halunder: "${example.halunder_sentence}"
- German: "${example.german_sentence}"

**3. Original Note on the Example (if any):**
"${example.context_note || 'N/A'}"

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
