const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// === FIX IS HERE: Use the correct environment variables for the SOURCE database ===
const supabase = createClient(
    process.env.SOURCE_SUPABASE_URL,
    process.env.SOURCE_SUPABASE_ANON_KEY
);

// The main route that does all the work
router.post('/analyze-and-translate', async (req, res) => {
    const { sentence } = req.body;

    if (!sentence) {
        return res.status(400).json({ error: 'Sentence is required.' });
    }

    try {
        // --- 1. WORD-BY-WORD ANALYSIS ---
        const words = [...new Set(sentence.toLowerCase().match(/[\p{L}0-9']+/gu) || [])];
        let wordAnalysis = [];

        if (words.length > 0) {
            // This query now correctly joins through the 'new_concept_to_term' table in the SOURCE database
            const orFilter = words.map(word => `term_text.ilike.${word}`).join(',');
            const dictionaryPromise = supabase
                .from('new_terms')
                .select(`
                    term_text,
                    new_concept_to_term!inner(
                        concept:new_concepts!inner(primary_german_label)
                    )
                `)
                .or(orFilter)
                .eq('language', 'hal');
            
            const featuresPromise = supabase
                .from('cleaned_linguistic_examples')
                .select('halunder_term, explanation, feature_type')
                .in('halunder_term', words);

            const [dictionaryResults, featuresResults] = await Promise.all([dictionaryPromise, featuresPromise]);

            if (dictionaryResults.error) throw new Error(`Dictionary search error: ${dictionaryResults.error.message}`);
            if (featuresResults.error) throw new Error(`Linguistic features search error: ${featuresResults.error.message}`);

            const dictionaryMap = new Map();
            if (dictionaryResults.data) {
                dictionaryResults.data.forEach(item => {
                    const germanLabel = item.new_concept_to_term[0]?.concept?.primary_german_label;
                    if (germanLabel) {
                        dictionaryMap.set(item.term_text.toLowerCase(), germanLabel);
                    }
                });
            }

            const featuresMap = new Map();
            if (featuresResults.data) {
                featuresResults.data.forEach(item => {
                    featuresMap.set(item.halunder_term.toLowerCase(), item);
                });
            }

            wordAnalysis = words.map(word => ({
                word: word,
                dictionaryMeaning: dictionaryMap.get(word) || null,
                linguisticFeature: featuresMap.get(word) || null
            }));
        }

        // --- 2. EXTERNAL API TRANSLATION ---
        const apiUrl = 'https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync';
        const apiKey = process.env.RUNPOD_API_KEY;

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                input: {
                    text: sentence,
                    num_alternatives: 3
                }
            })
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            throw new Error(`Translation API failed with status ${apiResponse.status}: ${errorBody}`);
        }

        const translationData = await apiResponse.json();

        // --- 3. SEND COMBINED RESPONSE ---
        res.json({
            wordAnalysis: wordAnalysis,
            apiTranslation: translationData
        });

    } catch (error) {
        console.error('Translation/Analysis Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
