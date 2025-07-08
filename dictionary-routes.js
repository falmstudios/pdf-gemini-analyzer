const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// === FIX IS HERE: Use the correct environment variables for the SOURCE database ===
const supabase = createClient(
    process.env.SOURCE_SUPABASE_URL,
    process.env.SOURCE_SUPABASE_ANON_KEY
);

router.get('/search', async (req, res) => {
    try {
        const { term, letter, lang = 'both', page = 1 } = req.query;
        const limit = 20;
        const offset = (page - 1) * limit;
        
        // This query now correctly points to the 'new_' prefixed tables
        let query = supabase
            .from('new_concepts')
            .select(`
                id, primary_german_label, part_of_speech, notes, german_definition, krogmann_info, krogmann_idioms, sense_id, sense_number,
                new_concept_to_term:new_concept_to_term!inner(pronunciation, gender, plural_form, etymology, homonym_number, note, source_name, alternative_forms, term:new_terms!inner(term_text, language)),
                new_examples:new_examples(halunder_sentence, german_sentence, note, example_type),
                source_relations:new_relations!source_concept_id(relation_type, note, target_concept:new_concepts!target_concept_id(id, primary_german_label)),
                new_source_citations:new_source_citations(citation_text)
            `, { count: 'exact' })
            .order('primary_german_label');
        
        if (term) {
            if (lang === 'de') {
                query = query.ilike('primary_german_label', `%${term}%`);
            } else if (lang === 'hal') {
                query = query.filter('new_concept_to_term.new_terms.term_text', 'ilike', `%${term}%`);
            } else {
                query = query.or(
                    `primary_german_label.ilike.%${term}%`,
                    `new_concept_to_term.new_terms.term_text.ilike.%${term}%`
                );
            }
        } else if (letter) {
            query = query.ilike('primary_german_label', `${letter}%`);
        }
        
        const { data, error, count } = await query.range(offset, offset + limit - 1);
        if (error) throw error;
        
        const entries = data.map(concept => {
            const translationMap = new Map();
            concept.new_concept_to_term.filter(ct => ct.term.language === 'hal').forEach(ct => {
                const key = ct.term.term_text;
                if (!translationMap.has(key)) {
                    translationMap.set(key, { term: ct.term.term_text, pronunciation: ct.pronunciation, gender: ct.gender, plural: ct.plural_form, etymology: ct.etymology, note: ct.note, alternativeForms: ct.alternative_forms, sources: [] });
                }
                translationMap.get(key).sources.push(ct.source_name);
            });
            return {
                id: concept.id,
                headword: concept.primary_german_label,
                partOfSpeech: concept.part_of_speech,
                germanDefinition: concept.german_definition,
                ahrhammarNotes: concept.notes,
                krogmannInfo: concept.krogmann_info,
                krogmannIdioms: concept.krogmann_idioms,
                senseId: concept.sense_id,
                senseNumber: concept.sense_number,
                homonymNumber: concept.new_concept_to_term[0]?.homonym_number,
                translations: Array.from(translationMap.values()),
                examples: concept.new_examples.map(ex => ({ halunder: ex.halunder_sentence, german: ex.german_sentence, note: ex.note, type: ex.example_type })),
                relations: concept.source_relations.map(rel => ({ type: rel.relation_type.replace(/_/g, ' '), targetTerm: rel.target_concept.primary_german_label, targetId: rel.target_concept.id, note: rel.note })),
                citations: concept.new_source_citations.map(c => c.citation_text)
            };
        });
        
        res.json({ entries, totalEntries: count || 0, totalPages: Math.ceil((count || 0) / limit), currentPage: parseInt(page) });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
