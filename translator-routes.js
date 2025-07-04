const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Use the same Supabase client as your other routes
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
        const words = [...new Set(sentence.toLowerCase().match(/\b(\w+)\b/g) || [])];
        let wordAnalysis = [];

        if (words.length > 0) {
            
            // --- THE DEFINITIVE QUERY FIX ---
            // Start from 'terms', then join forward to 'concept_to_term' and then to 'concepts'
            const dictionaryPromise = supabase
                .from('terms')
                .select(`
                    term_text,
                    concept_to_term!inner(
                        pronunciation, gender, plural_form, etymology, homonym_number, note, source_name, alternative_forms,
                        concept:concepts!inner(
                            id, primary_german_label, part_of_speech, notes, german_definition, krogmann_info, krogmann_idioms, sense_id, sense_number,
                            examples (halunder_sentence, german_sentence, note, example_type),
                            source_relations:relations!source_concept_id (relation_type, note, target_concept:concepts!target_concept_id (id, primary_german_label)),
                            source_citations (citation_text)
                        )
                    )
                `)
                .in('term_text', words)
                .eq('language', 'hal');

            const featuresPromise = supabase
                .from('cleaned_linguistic_examples')
                .select('halunder_term, explanation, feature_type')
                .in('halunder_term', words);
                
            const [dictionaryResults, featuresResults] = await Promise.all([dictionaryPromise, featuresPromise]);

            if (dictionaryResults.error) throw new Error(`Dictionary search error: ${dictionaryResults.error.message}`);
            if (featuresResults.error) throw new Error(`Linguistic features search error: ${featuresResults.error.message}`);
            
            // --- NEW DATA PROCESSING LOGIC FOR THE CORRECTED QUERY STRUCTURE ---
            const dictionaryMap = new Map();
            if (dictionaryResults.data) {
                // The result is a list of terms. Each term contains a list of its concept connections.
                dictionaryResults.data.forEach(termResult => {
                    const halunderWord = termResult.term_text.toLowerCase();
                    if (!dictionaryMap.has(halunderWord)) {
                        dictionaryMap.set(halunderWord, []);
                    }

                    termResult.concept_to_term.forEach(connection => {
                        const concept = connection.concept;
                        if (!concept) return;

                        // Format the concept data into a clean "entry" object. This is the same formatting
                        // logic as before, but now applied to the correctly fetched data.
                        const translationMap = new Map();
                        // This part is a bit redundant since we start from a term, but good for consistency
                        translationMap.set(termResult.term_text, {
                            term: termResult.term_text,
                            pronunciation: connection.pronunciation,
                            gender: connection.gender,
                            plural: connection.plural_form,
                            etymology: connection.etymology,
                            note: connection.note,
                            alternativeForms: connection.alternative_forms,
                            sources: [connection.source_name]
                        });
                        
                        const formattedEntry = {
                            id: concept.id,
                            headword: concept.primary_german_label,
                            partOfSpeech: concept.part_of_speech,
                            germanDefinition: concept.german_definition,
                            ahrhammarNotes: concept.notes,
                            krogmannInfo: concept.krogmann_info,
                            krogmannIdioms: concept.krogmann_idioms,
                            senseId: concept.sense_id,
                            senseNumber: concept.sense_number,
                            translations: Array.from(translationMap.values()),
                            examples: concept.examples.map(ex => ({ halunder: ex.halunder_sentence, german: ex.german_sentence, note: ex.note, type: ex.example_type })),
                            relations: (concept.source_relations || []).map(rel => ({ type: rel.relation_type.replace(/_/g, ' '), targetTerm: rel.target_concept.primary_german_label, targetId: rel.target_concept.id, note: rel.note })),
                            citations: (concept.source_citations || []).map(c => c.citation_text)
                        };
                        dictionaryMap.get(halunderWord).push(formattedEntry);
                    });
                });
            }

            const featuresMap = new Map((featuresResults.data || []).map(item => [item.halunder_term.toLowerCase(), item]));

            // Combine the results
            wordAnalysis = words.map(word => ({
                word: word,
                dictionaryEntries: dictionaryMap.get(word) || [],
                linguisticFeature: featuresMap.get(word) || null
            }));
        }

        // --- 2. EXTERNAL API TRANSLATION (Unchanged) ---
        const apiUrl = 'https://api.runpod.ai/v2/wyg1vwde9yva0y/runsync';
        const apiKey = process.env.RUNPOD_API_KEY;

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ input: { text: sentence, num_alternatives: 3 } })
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
