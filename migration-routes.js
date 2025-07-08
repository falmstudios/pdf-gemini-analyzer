const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// === DATABASE CONNECTIONS ===
const sourceOfTruthDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const destinationDb = createClient(process.env.SOURCE_SUPABASE_URL, process.env.SOURCE_SUPABASE_ANON_KEY);

// === STATE MANAGEMENT ===
let migrationState = {
    isProcessing: false,
    progress: 0,
    status: 'Idle',
    details: '',
    logs: []
};

function addLog(message, type = 'info') {
    const log = { id: Date.now() + Math.random(), message, type, timestamp: new Date().toISOString() };
    migrationState.logs.push(log);
    if (migrationState.logs.length > 1000) migrationState.logs.shift();
    console.log(`[MIGRATION] [${type.toUpperCase()}] ${message}`);
}

// === MIGRATION LOGIC ===
async function migrateTable({ sourceTable, destTable, columns, renameMap = {} }) {
    addLog(`--- Starting migration for ${sourceTable} -> ${destTable} ---`, 'info');
    
    // Phase 1: Get the full list of IDs to migrate
    addLog(`Fetching all row IDs from source table '${sourceTable}'...`, 'info');
    const { data: allRows, error: idError } = await sourceOfTruthDb.from(sourceTable).select('id');
    if (idError) throw new Error(`Could not fetch IDs from ${sourceTable}: ${idError.message}`);
    
    const totalToMigrate = allRows.length;
    addLog(`Found ${totalToMigrate} total rows to migrate.`, 'success');
    let migratedCount = 0;

    // Phase 2: Migrate one row at a time for safety
    for (const row of allRows) {
        try {
            // Fetch the full data for this single row
            const { data: singleRowData, error: fetchError } = await sourceOfTruthDb
                .from(sourceTable)
                .select('*')
                .eq('id', row.id)
                .single();
            
            if (fetchError) throw new Error(`Failed to fetch row ${row.id}: ${fetchError.message}`);
            
            // Prepare the object for the destination table
            const dataToInsert = {};
            for (const col of columns) {
                const destCol = renameMap[col] || col; // Use renamed column if it exists
                if (singleRowData.hasOwnProperty(col)) {
                    dataToInsert[destCol] = singleRowData[col];
                }
            }
            
            // Insert the single row into the destination
            const { error: insertError } = await destinationDb.from(destTable).insert(dataToInsert);
            if (insertError) throw new Error(`Failed to insert row ${row.id} into ${destTable}: ${insertError.message}`);
            
            migratedCount++;
            migrationState.progress = totalToMigrate > 0 ? (migratedCount / totalToProcess) : 1;
            migrationState.details = `Migrated ${migratedCount} of ${totalToProcess} rows from ${sourceTable}.`;
            if (migratedCount % 25 === 0) { // Log every 25 rows
                addLog(migrationState.details, 'info');
            }

        } catch (e) {
            addLog(`CRITICAL ERROR on row ID ${row.id} from ${sourceTable}: ${e.message}. Skipping row.`, 'error');
        }
    }
    addLog(`--- Migration for ${sourceTable} -> ${destTable} COMPLETE. Migrated ${migratedCount} rows. ---`, 'success');
}


async function runFullMigration() {
    migrationState = { isProcessing: true, progress: 0, status: 'Starting...', details: '', logs: [] };

    try {
        // Migration for pdf_analyses -> ahrhammar_uploads
        await migrateTable({
            sourceTable: 'pdf_analyses',
            destTable: 'ahrhammar_uploads',
            columns: ['filename', 'result', 'processed_at', 'settings']
        });

        // Migration for krogmann_uploads
        await migrateTable({
            sourceTable: 'krogmann_uploads',
            destTable: 'krogmann_uploads',
            columns: ['filename', 'data', 'processed']
        });

        migrationState.status = 'Completed';
        addLog('✅ All migrations completed successfully!', 'success');

    } catch (error) {
        addLog(`A critical error stopped the migration: ${error.message}`, 'error');
        migrationState.status = 'Error';
    } finally {
        migrationState.isProcessing = false;
    }
}

// === API ROUTES ===
router.post('/start', (req, res) => {
    if (migrationState.isProcessing) {
        return res.status(400).json({ error: 'Migration is already in progress.' });
    }
    runFullMigration().catch(err => {
        console.error("Caught unhandled error in migration:", err);
    });
    res.json({ success: true, message: `Full data migration has started.` });
});

router.get('/progress', (req, res) => {
    res.json(migrationState);
});

module.exports = router;
