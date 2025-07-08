document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const limitInput = document.getElementById('example-limit');
    const statusText = document.getElementById('status-text');
    const detailsText = document.getElementById('details-text');
    const progressBar = document.getElementById('progress-bar');
    const logContainer = document.getElementById('log-container');
    let progressInterval;

    startBtn.addEventListener('click', startProcessing);

    async function startProcessing() {
        if (startBtn.disabled) return;

        const limit = limitInput.value;
        startBtn.disabled = true;
        startBtn.textContent = 'Processing...';

        try {
            const response = await fetch('/dictionary-cleaner/start-cleaning', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting process: ${error.message}`);
            resetUI();
        }
    }

    async function updateProgress() {
        try {
            const response = await fetch('/dictionary-cleaner/progress');
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
                if (data.status !== 'Completed (No new examples)') {
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
        startBtn.textContent = 'Start Cleaning Batch';
    }
    
    updateProgress();
});
