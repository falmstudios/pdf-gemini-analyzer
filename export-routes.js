// export-routes.js

const express = require('express');
const router = express.Router();
const exportHandlers = require('./export-handler.js'); // Use the handler from the root

// Endpoint to export only the ai_translated_corpus data
router.get('/corpus', exportHandlers.exportCorpus);

// Endpoint to export only the ai_cleaned_dictsentences data
router.get('/dict-sentences', exportHandlers.exportDictSentences);

// Endpoint to export both tables combined into one file
router.get('/all-combined', exportHandlers.exportAllCombined);

module.exports = router;
