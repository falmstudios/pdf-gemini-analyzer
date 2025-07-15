document.addEventListener('DOMContentLoaded', () => {
    // Get all DOM elements
    const uploadBtn = document.getElementById('upload-btn');
    const fileUploadInput = document.getElementById('file-upload-input');
    const startBtn = document.getElementById('start-btn');
    const prepareBtn = document.getElementById('prepare-btn');
    const textLimitInput = document.getElementById('text-limit');
    const statusText = document.getElementById('status-text');
    const detailsText = document.getElementById('details-text');
    const progressBar = document.getElementById('progress-bar');
    const logContainer = document.getElementById('log-container');
    let progressInterval;

    // Attach event listeners
    uploadBtn.addEventListener('click', uploadFile);
    startBtn.addEventListener('click', startAiProcessing);
    prepareBtn.addEventListener('click', startPreparation);

    function disableAllButtons() {
        uploadBtn.disabled = true;
        startBtn.disabled = true;
        prepareBtn.disabled = true;
        uploadBtn.textContent = 'Busy...';
        startBtn.textContent = 'Busy...';
        prepareBtn.textContent = 'Busy...';
    }

    function resetUI() {
        uploadBtn.disabled = false;
        startBtn.disabled = false;
        prepareBtn.disabled = false;
        uploadBtn.textContent = 'Upload File';
        startBtn.textContent = 'Start AI Batch';
        prepareBtn.textContent = 'Prepare All Texts';
    }

    // Handles file upload by reading the file and sending its content as JSON
    async function uploadFile() {
        if (uploadBtn.disabled) return;
        
        const file = fileUploadInput.files[0];
        if (!file) {
            alert('Please select a JSON file to upload.');
            return;
        }

        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';

        try {
            const fileContent = await readFileAsText(file);
            
            const response = await fetch('/corpus/upload-texts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileContent: fileContent }),
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Unknown upload error');

            alert(`Upload successful: ${result.message}`);
        } catch (error) {
            alert(`Error uploading file: ${error.message}`);
        } finally {
            fileUploadInput.value = ''; // Clear the file input
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload File';
        }
    }

    // Helper function to read a file using a Promise
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = event => resolve(event.target.result);
            reader.onerror = error => reject(error);
            reader.readAsText(file);
        });
    }

    // Starts the main AI processing batch
    async function startAiProcessing() {
        if (startBtn.disabled) return;
        disableAllButtons();
        
        const limit = textLimitInput.value;
        try {
            const response = await fetch('/corpus/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit })
            });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error);
            }
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting process: ${error.message}`);
            resetUI();
        }
    }

    // Starts the preparation-only process
    async function startPreparation() {
        if (prepareBtn.disabled) return;
        if (!confirm("This will prepare ALL remaining texts. This may take a while but will not use your AI budget. Continue?")) {
            return;
        }
        disableAllButtons();
        
        try {
            const response = await fetch('/corpus/prepare-all-texts', { method: 'POST' });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error);
            }
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting preparation: ${error.message}`);
            resetUI();
        }
    }

    // Periodically fetches and updates the progress UI
    async function updateProgress() {
        try {
            const response = await fetch('/corpus/progress');
            const data = await response.json();
            
            statusText.textContent = data.status || 'N/A';
            detailsText.textContent = data.details || '';
            const percentage = Math.round((data.progress || 0) * 100);
            progressBar.style.width = `${percentage}%`;
            progressBar.textContent = `${percentage}%`;

            renderLogs(data.logs);

            if (!data.isProcessing && (data.status !== 'Idle' && data.status !== 'Starting...')) {
                clearInterval(progressInterval);
                resetUI();
                if (data.status !== 'Completed (No new texts)') {
                    alert(`Process finished with status: ${data.status}`);
                }
            }
        } catch (error) {
            console.error('Failed to fetch progress:', error);
            statusText.textContent = 'Error fetching progress';
            clearInterval(progressInterval);
            resetUI();
        }
    }
    
    // Renders the logs from the server into the log container
    function renderLogs(logs) {
        if (!logs || logs.length === 0) {
            logContainer.innerHTML = '';
            return;
        }
        // Reverse the logs so the newest appear at the top
        const reversedLogs = logs.slice().reverse();
        logContainer.innerHTML = reversedLogs.map(log => 
            `<div class="log-entry ${log.type}">${new Date(log.timestamp).toLocaleTimeString()} - ${log.message}</div>`
        ).join('');
    }
    
    // Initial fetch to show current state on page load
    updateProgress();
});
