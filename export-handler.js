// export-handler.js

const { createClient } = require('@supabase/supabase-js');
const Papa = require('papaparse');
require('dotenv').config();

// Use the SOURCE database client credentials from your .env file
const supabase = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

const BATCH_SIZE = 1000; // Fetch 1000 rows at a time

/**
 * Fetches all rows from a table, handling pagination automatically.
 * @param {string} tableName The name of the table to fetch from.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of all rows.
 */
async function fetchAllPaginatedData(tableName) {
    let allRows = [];
    let currentPage = 0;
    let hasMore = true;
    
    console.log(`[Export] Starting full data fetch for table: ${tableName}`);

    while (hasMore) {
        const from = currentPage * BATCH_SIZE;
        const to = from + BATCH_SIZE - 1;

        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .order('created_at', { ascending: true }) // Consistent ordering is good for pagination
            .range(from, to);

        if (error) {
            console.error(`[Export] Error fetching data for ${tableName} on page ${currentPage}:`, error.message);
            throw new Error(`Failed to fetch data from ${tableName}.`);
        }

        if (data && data.length > 0) {
            allRows.push(...data);
            console.log(`[Export] Fetched ${data.length} rows from ${tableName}. Total so far: ${allRows.length}`);
        }

        if (!data || data.length < BATCH_SIZE) {
            hasMore = false;
        } else {
            currentPage++;
        }
    }
    console.log(`[Export] ✅ Finished fetching. Total rows for ${tableName}: ${allRows.length}`);
    return allRows;
}

/**
 * Sends data back to the client as a downloadable CSV file.
 * @param {import('express').Response} res The Express response object.
 * @param {Array<Object>} data The data to convert to CSV.
 * @param {string} filename The desired filename for the download.
 */
function sendAsCsv(res, data, filename) {
    if (!data || data.length === 0) {
        return res.status(404).json({ message: 'No data found to export.' });
    }
    try {
        const csv = Papa.unparse(data);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(csv);
    } catch (err) {
        console.error('[Export] Error during CSV conversion:', err);
        res.status(500).json({ message: 'Failed to generate CSV file.' });
    }
}

// --- EXPORTED HANDLER FUNCTIONS ---

exports.exportCorpus = async (req, res) => {
    try {
        const corpusData = await fetchAllPaginatedData('ai_translated_corpus');
        sendAsCsv(res, corpusData, 'ai_translated_corpus_export.csv');
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.exportDictSentences = async (req, res) => {
    try {
        const dictData = await fetchAllPaginatedData('ai_cleaned_dictsentences');
        sendAsCsv(res, dictData, 'ai_cleaned_dictsentences_export.csv');
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.exportAllCombined = async (req, res) => {
    try {
        console.log("[Export] Fetching data for both tables concurrently...");
        const [corpusData, dictData] = await Promise.all([
            fetchAllPaginatedData('ai_translated_corpus'),
            fetchAllPaginatedData('ai_cleaned_dictsentences')
        ]);

        // Add a 'source_table' column to identify the origin of each row
        const corpusDataWithSource = corpusData.map(row => ({ ...row, source_table: 'ai_translated_corpus' }));
        const dictDataWithSource = dictData.map(row => ({ ...row, source_table: 'ai_cleaned_dictsentences' }));

        const combinedData = [...corpusDataWithSource, ...dictDataWithSource];
        
        console.log(`[Export] Total combined rows: ${combinedData.length}. Preparing CSV.`);
        sendAsCsv(res, combinedData, 'all_data_combined_export.csv');

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
