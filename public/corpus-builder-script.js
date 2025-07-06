document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const prepareBtn = document.getElementById('prepare-btn'); // New button
    const textLimitInput = document.getElementById('text-limit');
    const statusText = document.getElementById('status-text');
    const detailsText = document.getElementById('details-text');
    const progressBar = document.getElementById('progress-bar');
    const logContainer = document.getElementById('log-container');
    let progressInterval;

    startBtn.addEventListener('click', startAiProcessing);
    prepareBtn.addEventListener('click', startPreparation); // New event listener

    function disableButtons() {
        startBtn.disabled = true;
        prepareBtn.disabled = true;
        startBtn.textContent = 'Processing...';
        prepareBtn.textContent = 'Processing...';
    }

    function resetUI() {
        startBtn.disabled = false;
        prepareBtn.disabled = false;
        startBtn.textContent = 'Start AI Batch';
        prepareBtn.textContent = 'Prepare All Texts';
    }

    async function startAiProcessing() {
        if (startBtn.disabled) return;
        disableButtons();
        
        const limit = textLimitInput.value;
        try {
            const response = await fetch('/corpus/start-processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit })
            });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting process: ${error.message}`);
            resetUI();
        }
    }

    async function startPreparation() {
        if (prepareBtn.disabled) return;
        if (!confirm("This will prepare ALL remaining texts. This may take a while but will not use your AI budget. Continue?")) {
            return;
        }
        disableButtons();
        
        try {
            const response = await fetch('/corpus/prepare-all-texts', { method: 'POST' });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
            progressInterval = setInterval(updateProgress, 2000);
        } catch (error) {
            alert(`Error starting preparation: ${error.message}`);
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
    
    updateProgress();
});
