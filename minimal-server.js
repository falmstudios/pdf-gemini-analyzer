const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send(`
    <h1>PDF Analyzer App is Running!</h1>
    <p>Port: ${PORT}</p>
    <p>Time: ${new Date().toISOString()}</p>
    <p>Environment Variables:</p>
    <ul>
      <li>NODE_ENV: ${process.env.NODE_ENV || 'not set'}</li>
      <li>GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'Set' : 'Not set'}</li>
    </ul>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', port: PORT });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Minimal server running on port ${PORT}`);
});
