document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const textLimitInput = document.getElementById('text-limit');
    const statusText = document.getElementById('status-text');
    const detailsText = document.getElementById('details-text');
    const progressBar = document.getElementById('progress-bar');
    const logContainer = document.getElementById('log-container');
    let progressInterval;

    startBtn.addEventListener('click', startProcessing);

    async function startProcessing() {
        if (startBtn.disabled) return;

        const limit = textLimitInput.value;
        // --- NEW: Get the selected model's value ---
        const selectedModel = document.querySelector('input[name="gemini-model"]:checked').value;
        
        startBtn.disabled = true;
        startBtn.textContent = 'Processing...';

        try {
            const response = await fetch('/corpus/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // --- NEW: Send the selected model to the backend ---
                body: JSON.stringify({ limit, model: selectedModel })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            
            progressInterval = setInterval(updateProgress, 1000);
        } catch (error) {
            alert(`Error starting process: ${error.message}`);
            resetUI();
        }
    }

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

            if (!data.isProcessing && statusText.textContent !== 'Idle') {
                clearInterval(progressInterval);
                resetUI();
                if (data.status !== 'Completed (No new texts)') {
                    alert(`Process finished with status: ${data.status}`);
                }
            }
        } catch (error) {
            console.error('Failed to fetch progress:', error);
            clearInterval(progressInterval);
            resetUI();
        }
    }
    
    function renderLogs(logs) {
        if (!logs) return;
        logContainer.innerHTML = logs.map(log => 
            `<div class="log-entry ${log.type}">${new Date(log.timestamp).toLocaleTimeString()} - ${log.message}</div>`
        ).join('');
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function resetUI() {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Batch';
    }
    
    updateProgress();
});
