// public/export-script.js

document.addEventListener('DOMContentLoaded', () => {
    const corpusBtn = document.getElementById('exportCorpusBtn');
    const dictBtn = document.getElementById('exportDictBtn');
    const allBtn = document.getElementById('exportAllBtn');
    const statusEl = document.getElementById('statusMessage');

    const allButtons = [corpusBtn, dictBtn, allBtn];

    /**
     * Handles the download process for a given endpoint.
     * @param {string} endpoint The API endpoint to call.
     */
    const handleDownload = async (endpoint) => {
        allButtons.forEach(btn => btn.disabled = true);
        statusEl.textContent = 'Requesting data from server... This may take a while for large datasets.';
        statusEl.className = 'status';

        try {
            const response = await fetch(endpoint);

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `Server responded with status ${response.status}`);
            }

            statusEl.textContent = 'Data received. Preparing your file for download...';
            
            const disposition = response.headers.get('content-disposition');
            let filename = 'export.csv';
            if (disposition && disposition.indexOf('attachment') !== -1) {
                const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                const matches = filenameRegex.exec(disposition);
                if (matches != null && matches[1]) {
                    filename = matches[1].replace(/['"]/g, '');
                }
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();

            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);

            statusEl.textContent = `✅ Download complete: ${filename}`;

        } catch (error) {
            console.error('Download failed:', error);
            statusEl.textContent = `Error: ${error.message}`;
            statusEl.className = 'status error';
        } finally {
            allButtons.forEach(btn => btn.disabled = false);
        }
    };

    corpusBtn.addEventListener('click', () => handleDownload('/api/export/corpus'));
    dictBtn.addEventListener('click', () => handleDownload('/api/export/dict-sentences'));
    allBtn.addEventListener('click', () => handleDownload('/api/export/all-combined'));
});
